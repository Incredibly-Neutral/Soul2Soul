// s2s-app.ts
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import './s2s-deals-tab.js';
import './s2s-init.js';
import './s2s-button.js';
import './s2s-confirm-modal.js';
import './s2s-init-progress-modal.js';
import './s2s-whitelist-tab.js';
import './s2s-records-tab.js';
import './s2s-storage-tab.js';
import './s2s-website-tree-tab.js';
import { ProtocolIntegration } from '@/lib/protocol-integration.js';
import { store } from '@/state/store.js';
import { LitService } from '@s2s/soul2soul-shared';
import { FilecoinStorage } from '@s2s/soul2soul-shared/filecoin';
import { mainStyles } from '@/styles/main-styles.js';
import { pillStyles } from '@/styles/pill-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { buildDeletePublicationBatch } from '../lib/publication-init.js';
import {
  INIT_SESSION_KEY,
  clearInitSession,
  isConfigPhase,
  loadInitSession,
  saveInitSession,
  type InitPhase,
  type InitSession,
} from '../lib/init-session.js';
import { evmRead } from '@/lib/evm.js';
import { CID } from 'multiformats';
import './copy-link.js';
import './copy-hash.js';
import './copy-module.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { tabStyles } from '@/styles/tab-styles.js';
import { browserFilecoinBuilder } from '@s2s/soul2soul-shared/filecoin/car-builder/browser';

const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value) nonpayable',
];

@customElement('s2s-app')
export class S2SApp extends LitElement {
  private safeIntegration: SafeIntegration;
  private protocolIntegration: ProtocolIntegration;
  private lit: LitService;
  private filecoinStorage: FilecoinStorage;
  private fcInitPromise: Promise<void> | null = null;

  @state() private currentTab: 'deals' | 'whitelist' | 'records' | 'storage' | 'websiteTree' =
    'deals';
  @state() private fetching = false;

  // Reset/teardown: opens a confirmation modal → propose the disable+deleteRecord
  // batch, then watch for its execution and reload the app fresh. On load the
  // Safe is re-read from scratch (module check re-runs), so once the teardown
  // executes the app returns to the no-modules state and the 2-proposal init
  // flow comes back.
  @state() private resetState: 'idle' | 'confirming' | 'proposing' | 'waiting' = 'idle';
  @state() private resetError: string | null = null;

  // Guards the reset-execution poll (one active poll per element) and cancels
  // it when the element is torn down mid-wait (test unmount, tab close).
  private resetPollActive = false;
  private resetPollCancelled = false;

  // Host-owned config step (step 3): guards re-entry and cancels the config
  // wait loop when the element is torn down mid-poll.
  private configStepActive = false;
  private configPollCancelled = false;

  // Init progress: the publication-creation flow (live or recovered from local
  // storage after a reload) drives this progress modal. Both the live init
  // component (s2s-init-progress events) and the reload-recovery path open it;
  // it closes on error/done. There is no success banner: once the modules are
  // live the app simply switches to its normal UI.
  @state() private initPhase: InitPhase | null = null;
  @state() private initModalOpen = false;

  private unsubscribers: Array<() => void> = [];

  static styles = [
    mainStyles,
    tabStyles,
    typograhyStyles,
    pillStyles,
    buttonStyles,
    css`
      .reset-button {
        /* Push the reset action to the right end of the module-status row. */
        margin: auto 0 auto auto;
      }
      .reset-button.armed {
        /* Intensify the warning accent while the reset is armed for confirm. */
        --gb-accent: rgba(219, 66, 51, 0.95);
      }
      .reset-status {
        margin-top: 1rem;
        font-family: var(--font-mono);
        font-size: 0.82rem;
        letter-spacing: 0.04em;
        color: var(--gray-300);
      }
      .reset-status.error {
        color: var(--color-red);
      }
    `,
  ];

  constructor() {
    super();
    this.safeIntegration = new SafeIntegration();
    this.protocolIntegration = new ProtocolIntegration();
    this.lit = new LitService({ environment: 'prod' });
    this.filecoinStorage = new FilecoinStorage({}, browserFilecoinBuilder);
    this.fcInitPromise = this.initFC();
  }

  async initFC() {
    const skRes = await fetch('/session-key.json');
    const skData = await skRes.json();
    // Same RPC sourcing as the 0xobsidian plugin (settings.rpc_key → DRPC lb,
    // glif fallback) — keeps the Filecoin RPC endpoint configurable instead of
    // a hardcoded API key baked into the bundle.
    const rpcKey = import.meta.env.VITE_DRPC_API_KEY as string | undefined;
    const rpcUrl = rpcKey
      ? `https://lb.drpc.live/filecoin/${rpcKey}`
      : 'https://api.node.glif.io/rpc/v1';
    await this.filecoinStorage.initWithSessionKey(skData, rpcUrl);
  }

  connectedCallback() {
    super.connectedCallback();
    // Subscribe to every store slice that affects the view;
    // each setter in fetchFreshData will trigger re-renders automatically.
    this.unsubscribers = [
      store.subscribeToSafeInfo(() => this.requestUpdate()),
      store.subscribeToProtocolInfo(() => this.requestUpdate()),
      store.subscribeToRoot(() => this.requestUpdate()),
      store.subscribeToRecords(() => this.requestUpdate()), // covers publication (name record)
    ];

    // Phase 2 — fetch fresh data; store updates drive subsequent renders
    this.fetchFreshData();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
    // Stop any reset-execution / config-wait poll mid-flight (test teardown,
    // tab close) so no dangling loop outlives the element.
    this.resetPollCancelled = true;
    this.configPollCancelled = true;
  }

  private async fetchFreshData() {
    this.fetching = true;

    try {
      const safeInfo = await this.safeIntegration.initialize();
      store.setSafeInfo(safeInfo);

      // If a publication-init session was persisted, surface its progress (or
      // clear it once everything is on-chain).
      this.syncInitProgress(safeInfo);

      const protocolInfo = await this.protocolIntegration.initialize();
      store.setProtocolInfo(protocolInfo);
      console.log(protocolInfo);

      const [keys, values] = await this.safeIntegration.getAllRecords();
      store.setAllRecords(
        keys.map((key: string, index: number) => ({
          key,
          value: values[index],
          type: 'metadata',
        })),
      );

      const publication = store.getRecord('name');

      if (publication && protocolInfo) {
        const node = window.ethers.namehash(publication);
        const onchainHash = await evmRead(
          8453,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'getText',
          [node, 'contenthash_wrapped'],
        );

        const hex = onchainHash.slice(6); // strip 0x + ipfs-ns(0xe3) + contenthash-version(0x01)
        const bytes = window.ethers.getBytes('0x' + hex);
        const rootCid = CID.decode(bytes).toV1().toString();
        store.setRoot(rootCid);
      }

      // === Fetch Filecoin storage pieces (store already has cache from constructor) ===
      if (this.filecoinStorage) {
        // Wait for FC init to complete before using storage
        await this.fcInitPromise;

        try {
          const pubAddress = this.safeIntegration.getSafeInfo().s2sPublication?.toLowerCase() ?? '';
          const freshPieces = await this.filecoinStorage.listPublicationStorage(
            this.filecoinStorage.walletAddress.toLowerCase(),
          );
          // listPublicationStorage returns every wallet piece regardless of
          // attribution, so scope the Storage tab to THIS publication: keep only
          // pieces attributed to the current publication module (the config-update
          // flow attributes uploads to it).
          const scoped = freshPieces.filter((p) => {
            const raw = p.metadata.attributedTo;
            if (!raw) return false;
            try {
              const owners: unknown = JSON.parse(raw);
              return (
                Array.isArray(owners) &&
                owners.map((o) => String(o).toLowerCase()).includes(pubAddress)
              );
            } catch {
              return false;
            }
          });
          const typed = scoped.map((p) => ({ ...p, confirmed: true }));
          store.setPieces(typed);

          // Derive datasets from pieces (one pass, no extra chain call)
          const datasetMap = new Map<
            string,
            {
              dataSetId: string;
              provider: string;
              pieceCount: number;
              pdpEndEpoch: bigint | null;
              isLive: boolean;
              metadata: Record<string, string>;
            }
          >();
          for (const p of typed) {
            if (!datasetMap.has(p.dataSetId)) {
              datasetMap.set(p.dataSetId, {
                dataSetId: p.dataSetId,
                provider: p.provider,
                pieceCount: 0,
                pdpEndEpoch: p.pdpEndEpoch,
                isLive: p.isLive,
                metadata: p.dataSetMetadata,
              });
            }
            datasetMap.get(p.dataSetId)!.pieceCount++;
          }
          store.setDataSets(Array.from(datasetMap.values()));
        } catch (e) {
          console.warn('[storage] chain fetch failed, keeping cache:', e);
        }
      }
    } catch (error) {
      console.error('Failed to fetch fresh data:', error);
    }

    this.fetching = false;
  }

  private switchTab(tab: 'deals' | 'whitelist' | 'records' | 'storage' | 'websiteTree') {
    this.currentTab = tab;
  }

  /**
   * Reset/start-over: propose the teardown batch (disable both S2S modules +
   * records.deleteRecord("name")). Only runs from the confirmation modal's
   * confirm action — the modal stays open, busy, while the batch is proposed.
   * Human-in-the-loop, like the init flow — the batch lands in the Safe queue
   * and needs an owner signature + execution. Once proposed we watch the Safe
   * for the execution and then reload the app, which re-initializes everything
   * (fresh module check → no modules → init flow available again).
   */
  private async handleReset(): Promise<void> {
    if (this.resetState !== 'confirming') return;

    const safeInfo = store.safeInfo;
    if (!safeInfo) return;

    this.resetState = 'proposing';
    this.resetError = null;
    this.resetPollCancelled = false;
    try {
      const safeModules = await this.safeIntegration.fetchSafeModules();
      // deleteRecord('name') reverts KeyNotFound() when the record was never
      // written on-chain, and the teardown batch is an atomic MultiSend — so
      // gate the deletion on the name record actually existing, mirroring how
      // disableModule is already gated by the fresh enabled-module list.
      let nameRecorded = false;
      if (this.safeIntegration.hasRecordsModule()) {
        try {
          nameRecorded = (await this.safeIntegration.getRecord('name')) !== '';
        } catch {
          nameRecorded = false;
        }
      }
      const batch = buildDeletePublicationBatch(
        safeInfo.safeAddress,
        {
          recordsModule: safeInfo.s2sRecords ?? '',
          publicationModule: safeInfo.s2sPublication ?? '',
        },
        safeModules,
        { deleteName: nameRecorded },
      );
      await this.safeIntegration.proposeBatch(batch);
      // Proposed — hold the modal open and wait for the teardown to execute,
      // then reload. Same host-mediated channel (SDK module read) the reload
      // path uses, not a raw RPC poll.
      this.resetState = 'waiting';
      void this.waitForResetExecution(safeInfo);
    } catch (e) {
      this.resetError = e instanceof Error ? e.message : String(e);
      this.resetState = 'idle';
    }
  }

  /**
   * Watch the Safe's installed-module list until the teardown batch executes
   * (both S2S modules gone), then reload the app. On reload, initialize()
   * re-reads the Safe from scratch: no modules → s2s-publication-init mounts
   * and the 2-proposal init flow is available again. Times out (leaves the
   * error in place) if the owner never executes it in the Safe queue.
   */
  private async waitForResetExecution(safeInfo: {
    s2sRecords?: string;
    s2sPublication?: string;
  }): Promise<void> {
    if (this.resetPollActive) return;
    this.resetPollActive = true;
    const recordsModule = safeInfo.s2sRecords ?? '';
    const publicationModule = safeInfo.s2sPublication ?? '';
    const stillInstalled = (mods: string[]): boolean =>
      (recordsModule !== '' && mods.includes(recordsModule)) ||
      (publicationModule !== '' && mods.includes(publicationModule));
    const startedAt = Date.now();
    const timeoutMs = 10 * 60_000;
    try {
      // First check immediately (the tx may already have executed), then poll.
      for (;;) {
        if (this.resetPollCancelled) return;
        let modules: string[] = [];
        try {
          modules = await this.safeIntegration.fetchSafeModules();
        } catch {
          modules = [];
        }
        console.log(
          `[app] waitForResetExecution modules=${String(modules.length)} stillInstalled=${String(stillInstalled(modules))}`,
        );
        if (!stillInstalled(modules)) {
          console.log('[app] reset executed -> reloading to re-initialize');
          this.reloadApp();
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          this.resetError =
            'The reset proposal is still pending in the Safe queue. Execute it, then reload to run a new publication.';
          this.resetState = 'idle';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      this.resetPollActive = false;
    }
  }

  /** Separate seam so tests can intercept the reload without touching location. */
  private reloadApp(): void {
    window.location.reload();
  }

  /**
   * Drive the init progress modal from a persisted session. Called once on
   * page load (after the Safe is connected). Opens the modal for a
   * reload-recovery while the init component (mounted below when modules
   * aren't live yet) resumes the flow itself. When the finalize batch has
   * already executed (modules live on a reload), the session is cleared
   * silently — the live app UI is the completion signal.
   */
  private syncInitProgress(safeInfo: { chainId: number; safeAddress: string }): void {
    const session = loadInitSession(window.localStorage, INIT_SESSION_KEY);
    console.log(
      `[app] syncInitProgress session=${session ? session.phase : 'none'} hasRecordsModule=${String(this.safeIntegration.hasRecordsModule())}`,
    );
    if (!session) return;

    // A session from another Safe or chain must not hijack this page.
    if (
      session.chainId !== safeInfo.chainId ||
      session.safeAddress.toLowerCase() !== safeInfo.safeAddress.toLowerCase()
    ) {
      return;
    }

    if (session.phase === 'done') {
      clearInitSession(window.localStorage, INIT_SESSION_KEY);
      this.initPhase = null;
      this.initModalOpen = false;
      return;
    }

    if (this.safeIntegration.hasRecordsModule()) {
      if (isConfigPhase(session.phase)) {
        // The finalize batch executed but the config record is still pending
        // (or was never proposed) — the host's step 3. Resume it: reopen the
        // modal at that step and drive it to completion via the records tab's
        // updateConfig (the config record gets its own Safe signature).
        console.log('[app] syncInitProgress: config phase -> resume config step');
        void this.resumeConfigStep(session.phase);
        return;
      }
      // The finalize batch enables the modules AND records the name in one
      // atomic transaction, so once the records module is live the flow is
      // finished. Clear the session silently — no banner; the app is now in
      // its normal live state. Modules live with NO name record is a legacy
      // half-init the merged flow can't resume — dropped the same way.
      console.log('[app] syncInitProgress: records module LIVE -> silent clear');
      clearInitSession(window.localStorage, INIT_SESSION_KEY);
      this.initPhase = null;
      this.initModalOpen = false;
      return;
    }

    // Modules not live yet: the init component (mounted below) resumes the
    // merged flow itself; the modal is the banner while it catches up.
    console.log('[app] syncInitProgress: modules not live -> open recovery modal');
    if (isConfigPhase(session.phase)) {
      // A config-phase session with no live modules is stale (config implies
      // the modules were once live — i.e. a reset wiped them). Drop it so the
      // recovery modal doesn't wedge on a step nothing can drive.
      console.log('[app] syncInitProgress: config session, modules dead -> drop');
      clearInitSession(window.localStorage, INIT_SESSION_KEY);
      this.initPhase = null;
      this.initModalOpen = false;
      return;
    }
    this.initModalOpen = true;
    this.initPhase = session.phase;
  }

  /**
   * Fresh publication proposed by the init flow. The name/repo/branch records
   * are proposed but still pending Safe execution, so the chain read in
   * fetchFreshData cannot see them yet — write them to the store optimistically
   * so the title + web-status populate immediately (no reload needed), clear
   * any stale root from a previous publication, then run the config step.
   *
   * The config step is step 3 of the flow (owned by the host, since the init
   * component unmounts once the modules go live): the config record is a THIRD
   * Safe execution (build + propose via the records tab, then wait for it to be
   * recorded on-chain). The progress modal stays open on that step so the flow
   * can't be lost, and its phase is persisted for reload-resume.
   */
  private readonly onInitComplete = async (e: Event): Promise<void> => {
    const detail = (e as CustomEvent<{ name?: string; repo?: string; branch?: string } | undefined>)
      .detail;
    const { name, repo, branch } = detail ?? {};
    console.log(
      `[app] onInitComplete name=${name ?? 'undefined'} repo=${repo ?? 'undefined'} branch=${branch ?? 'undefined'}`,
    );

    // The two S2S init proposals are done; the configuration record is not —
    // keep the modal open on step 3 while the host drives it.
    this.initPhase = 'configuring';
    this.initModalOpen = true;

    // Surface the Config tab — the immediate config build below runs there.
    this.currentTab = 'records';
    await this.fetchFreshData();

    // Re-apply the pending (not-yet-executed) records on top of the chain read.
    if (name) store.setRecord({ key: 'name', value: name, type: 'metadata' });
    if (repo) store.setRecord({ key: 'repo', value: repo, type: 'metadata' });
    if (branch) store.setRecord({ key: 'branch', value: branch, type: 'metadata' });
    // A brand-new publication has no content published yet — drop any root that
    // still points at a previous publication's content.
    if (name) store.setRoot('');

    // Persist the config phase (with the fresh publication identity) before
    // running the step, so a reload during it can resume.
    this.persistInitPhase('configuring', {
      name: name ?? '',
      publicationName: name ?? '',
      repo: repo ?? '',
      branch: branch ?? '',
    });

    await this.updateComplete;
    await this.runConfigStep();
  };

  // ── Host-owned config step (step 3) ───────────────────────────────────────

  /** Persist (or refresh) the init session with a new phase, keeping known fields. */
  private persistInitPhase(phase: InitPhase, extra: Partial<InitSession> = {}): void {
    const prev = loadInitSession(window.localStorage, INIT_SESSION_KEY);
    const safeInfo = store.safeInfo;
    saveInitSession(window.localStorage, INIT_SESSION_KEY, {
      version: 2,
      chainId: safeInfo?.chainId ?? 0,
      safeAddress: safeInfo?.safeAddress ?? '',
      name: '',
      publicationName: '',
      repo: '',
      branch: '',
      authors: [],
      proposals: [],
      recordsModule: safeInfo?.s2sRecords,
      publicationModule: safeInfo?.s2sPublication,
      ...(prev ?? {}),
      ...extra,
      phase,
      updatedAt: Date.now(),
    });
  }

  /**
   * Resume a config-phase session after a reload. If the config record is
   * already on-chain the flow is actually done (clear + close); otherwise
   * reopen the modal at step 3 and drive the step — re-proposing the config
   * record only when it was never proposed ('configuring'), mere-waiting when
   * it was ('awaiting-config', proposal still pending in the Safe queue).
   */
  private async resumeConfigStep(phase: InitPhase): Promise<void> {
    let value = '';
    try {
      value = await this.safeIntegration.getRecord('config');
    } catch {
      value = '';
    }
    console.log(`[app] resumeConfigStep getRecord('config') -> '${value}'`);
    if (value !== '') {
      console.log('[app] resumeConfigStep: config already on-chain -> flow complete');
      this.finishConfigStep();
      return;
    }
    this.initPhase = phase;
    this.initModalOpen = true;
    if (phase === 'awaiting-config') {
      // Proposed but not executed — just wait for it, never duplicate it.
      await this.waitForConfigRecord();
    } else {
      await this.runConfigStep();
    }
  }

  /**
   * Drive the config step to completion: persist 'configuring', propose the
   * config record through the records tab (its updateConfig builds + proposes
   * the config DAG), persist 'awaiting-config', then wait for the record to be
   * recorded on-chain before clearing the session and closing the modal.
   */
  private async runConfigStep(): Promise<void> {
    if (this.configStepActive) return;
    this.configStepActive = true;
    try {
      this.initPhase = 'configuring';
      this.initModalOpen = true;
      this.persistInitPhase('configuring');
      await this.updateComplete;
      const tab = this.renderRoot.querySelector('s2s-records-tab') as {
        updateConfig?: () => Promise<unknown>;
      } | null;
      if (tab?.updateConfig) {
        try {
          await tab.updateConfig();
        } catch (err) {
          // A build/propose failure (e.g. the base repo has no assets/) must
          // not wedge the modal: stop, close and log so the user can retry
          // from the Config tab instead of being stuck behind a modal.
          console.error('[app] config update failed, closing the config step:', err);
          this.resetConfigStep();
          return;
        }
      }
      this.initPhase = 'awaiting-config';
      this.persistInitPhase('awaiting-config');
      await this.waitForConfigRecord();
    } finally {
      this.configStepActive = false;
    }
  }

  /** Poll the chain until the config record exists (the 3rd Safe execution). */
  private async waitForConfigRecord(): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = 10 * 60_000;
    for (;;) {
      if (this.configPollCancelled) return;
      let value = '';
      try {
        value = await this.safeIntegration.getRecord('config');
      } catch {
        value = '';
      }
      console.log(`[app] waitForConfigRecord getRecord('config') -> '${value}'`);
      if (value !== '') {
        console.log('[app] configuration record on-chain -> flow complete');
        this.finishConfigStep();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        console.error('[app] timed out waiting for the config record to be executed');
        this.resetConfigStep();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  /** Config record is on-chain: clear the session, close the modal, refresh so
   * the Config tab shows the record it just built. */
  private finishConfigStep(): void {
    clearInitSession(window.localStorage, INIT_SESSION_KEY);
    this.initPhase = null;
    this.initModalOpen = false;
    void this.fetchFreshData();
  }

  /** Stop the config step without completing it (failure/timeout). */
  private resetConfigStep(): void {
    clearInitSession(window.localStorage, INIT_SESSION_KEY);
    this.initPhase = null;
    this.initModalOpen = false;
  }

  /** Live progress from the init component while a flow is running. */
  private readonly onInitProgress = (e: Event): void => {
    const detail = (
      e as CustomEvent<
        { step: string; phase: InitPhase; proposals: string[]; name?: string } | undefined
      >
    ).detail;
    if (!detail) return;
    console.log(
      `[app] onInitProgress step=${detail.step} phase=${detail.phase} name=${detail.name ?? 'undefined'}`,
    );
    // 'error' / 'done' end the flow — close the progress modal so the inline
    // result is visible. Any other step opens it: the modal is the primary
    // progress surface for both the live flow and the reload-recovery.
    if (detail.step === 'error' || detail.step === 'done') {
      this.initPhase = null;
      this.initModalOpen = false;
      return;
    }
    this.initPhase = detail.phase;
    this.initModalOpen = true;
  };

  private activeTabTemplate() {
    switch (this.currentTab) {
      case 'deals':
        return this.safeIntegration.hasPublicationModule()
          ? html`<s2s-deals-tab
              .safeIntegration=${this.safeIntegration}
              .protocolIntegration=${this.protocolIntegration}
              .lit=${this.lit}
            ></s2s-deals-tab>`
          : html``;
      case 'whitelist':
        return this.safeIntegration.hasPublicationModule()
          ? html`<s2s-whitelist-tab .safeIntegration=${this.safeIntegration}></s2s-whitelist-tab>`
          : html``;
      case 'records':
        return this.safeIntegration.hasRecordsModule()
          ? html`<s2s-records-tab
              .safeIntegration=${this.safeIntegration}
              .protocolIntegration=${this.protocolIntegration}
              .lit=${this.lit}
              .storage=${this.filecoinStorage}
            ></s2s-records-tab>`
          : html``;
      case 'storage':
        return html`<s2s-storage-tab
          .storage=${this.filecoinStorage}
          .safeIntegration=${this.safeIntegration}
          .protocolIntegration=${this.protocolIntegration}
        ></s2s-storage-tab>`;
      case 'websiteTree':
        return this.safeIntegration.hasRecordsModule()
          ? html`<s2s-website-tree-tab
              .safeIntegration=${this.safeIntegration}
              .lit=${this.lit}
            ></s2s-website-tree-tab>`
          : html``;
    }
  }

  render() {
    // All view values come exclusively from the store
    const safeInfo = store.safeInfo;
    const rootCid = store.getRoot() ?? '';
    const publication = store.getRecord('name') ?? '';
    const hasCache = !!safeInfo;
    // The init flow is the whole screen until both modules are installed:
    // header status, tabs and tab content are all hidden while it runs.
    const hasModules =
      this.safeIntegration.hasPublicationModule() || this.safeIntegration.hasRecordsModule();

    if (!hasCache && this.fetching) {
      return html`
        <div class="loading">
          <div class="spinner"></div>
          <p>Loading Soul2Soul Safe App...</p>
        </div>
      `;
    }

    return html`
      <div class="container">
        <div class="header">
          <div class="module-status">
            <div
              class="pill safe-status ${this.safeIntegration.isConnected()
                ? 'module-active'
                : 'module-inactive'}"
            >
              ${this.safeIntegration.isConnected() ? 'Connected to Safe' : 'Not Connected'}
            </div>
            <div
              class="pill module-badge ${this.safeIntegration.hasPublicationModule()
                ? 'module-active'
                : 'module-inactive'}"
            >
              <copy-module
                .value=${safeInfo?.s2sPublication ?? ''}
                label="Publication Module"
              ></copy-module>
            </div>
            <div
              class="pill module-badge ${this.safeIntegration.hasRecordsModule()
                ? 'module-active'
                : 'module-inactive'}"
            >
              <copy-module
                .value=${safeInfo?.s2sRecords ?? ''}
                label="Records Module"
              ></copy-module>
            </div>
            ${hasModules
              ? html`
                  <s2s-button
                    type="warning"
                    class="reset-button"
                    id="reset-publication"
                    ?disabled=${this.resetState === 'proposing' || this.resetState === 'waiting'}
                    title="Disable the S2S modules and clear the publication name so you can start a new publication."
                    @click=${() => (this.resetState = 'confirming')}
                  >
                    Reset
                  </s2s-button>
                `
              : ''}
          </div>

          ${this.resetError
            ? html`
                <div class="reset-status error" id="reset-error">
                  Reset failed: ${this.resetError}
                </div>
              `
            : ''}

          <h1 class="title">${publication}</h1>

          ${hasModules
            ? html`
                <div class="web-status">
                  ${rootCid
                    ? html`
                        <div><copy-hash .value=${rootCid}></copy-hash></div>
                        <div>
                          <a href="https://${rootCid}.preview.transport-union.dev" target="_blank"
                            >preview</a
                          >
                        </div>
                      `
                    : ''}
                  <div>
                    <a href="https://${publication}.limo" target="_blank">${publication}.limo</a>
                  </div>
                </div>
              `
            : ''}
        </div>

        ${!hasModules
          ? html`
              <s2s-publication-init
                .safeIntegration=${this.safeIntegration}
                .protocolInfo=${store.protocolInfo}
                .safeInfo=${safeInfo}
                @s2s-init-complete=${this.onInitComplete}
                @s2s-init-progress=${this.onInitProgress}
              ></s2s-publication-init>
            `
          : ''}
        ${hasModules
          ? html`
              <div class="tabs">
                <button
                  class="tab ${this.currentTab === 'deals' ? 'active' : ''}"
                  id="deals-tab"
                  ?disabled=${!this.safeIntegration.hasPublicationModule()}
                  @click=${() => this.switchTab('deals')}
                >
                  Deals
                </button>
                <button
                  class="tab ${this.currentTab === 'whitelist' ? 'active' : ''}"
                  id="whitelist-tab"
                  ?disabled=${!this.safeIntegration.hasPublicationModule()}
                  @click=${() => this.switchTab('whitelist')}
                >
                  Whitelists
                </button>
                <button
                  class="tab ${this.currentTab === 'records' ? 'active' : ''}"
                  id="records-tab"
                  ?disabled=${!this.safeIntegration.hasRecordsModule()}
                  @click=${() => this.switchTab('records')}
                >
                  Config
                </button>
                <button
                  class="tab ${this.currentTab === 'storage' ? 'active' : ''}"
                  id="storage-tab"
                  @click=${() => this.switchTab('storage')}
                >
                  Storage
                </button>
                <button
                  class="tab ${this.currentTab === 'websiteTree' ? 'active' : ''}"
                  id="website-tree-tab"
                  ?disabled=${!this.safeIntegration.hasRecordsModule()}
                  @click=${() => this.switchTab('websiteTree')}
                >
                  Tree
                </button>
              </div>

              <div class="tab-content" id="tab-content">${this.activeTabTemplate()}</div>
            `
          : ''}
      </div>

      <s2s-confirm-modal
        .open=${this.resetState === 'confirming' ||
        this.resetState === 'proposing' ||
        this.resetState === 'waiting'}
        headline="Reset publication?"
        message="This disables the S2S Records and Publication modules on this Safe and clears the publication name record. It creates a Safe proposal you must execute — once executed it cannot be undone."
        confirmLabel=${this.resetState === 'proposing'
          ? 'Proposing…'
          : this.resetState === 'waiting'
            ? 'Waiting for execution…'
            : 'Confirm reset'}
        .busy=${this.resetState === 'proposing' || this.resetState === 'waiting'}
        variant="warning"
        @s2s-confirm=${() => void this.handleReset()}
        @s2s-cancel=${() => (this.resetState = 'idle')}
      ></s2s-confirm-modal>

      <s2s-init-progress-modal
        .open=${this.initModalOpen}
        .phase=${this.initPhase ?? 'creating'}
      ></s2s-init-progress-modal>
    `;
  }
}
