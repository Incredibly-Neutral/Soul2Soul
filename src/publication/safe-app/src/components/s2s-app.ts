// s2s-app.ts
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import './s2s-deals-tab.js';
import './s2s-init.js';
import './ens-name-step.js';
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
  readEnsRegistration,
  subdomainLabelError,
  suffixOfPublicationName,
  type EnsRegistrationState,
} from '../lib/ens-registration.js';
import { findPublicationName } from '../lib/ens-step.js';
import { ENS_REGISTRY_ADDRESS } from '../lib/domain-validation.js';
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

/**
 * The records-tab surface the host's config step (step 3) drives. Duck-typed so
 * the shell never imports the tab's heavy module graph (and component tests can
 * stub it). `updateConfig` builds the publication config and proposes the
 * config record to the Safe; it returns the proposed config CID.
 * `suppressQueueOpen` stops the tab from opening the Safe queue itself — the
 * host owns the progress modal here.
 */
interface ConfigTab {
  updateConfig(
    aliasesOverride?: string[],
    options?: { suppressQueueOpen?: boolean },
  ): Promise<string>;
}

/** Narrow an unknown throwable to a message for the modal's error line. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The stage `s2s-records-tab.updateConfig()` tags a rejection with. */
type ConfigFailureStage = 'build' | 'propose';

/**
 * Read the stage the records tab tags a `updateConfig()` rejection with, when it
 * tags one. Duck-typed on purpose: the component is not imported here (it is a
 * separate owner's module), and an older/foreign throwable simply has no stage.
 */
function configFailureStage(err: unknown): ConfigFailureStage | null {
  const stage = (err as { stage?: unknown } | null | undefined)?.stage;
  return stage === 'build' || stage === 'propose' ? stage : null;
}

/**
 * Message for a failed step-3 build+propose. The tab builds AND proposes inside
 * one `updateConfig()` call, so the stage is only known when the tab tagged the
 * rejection — name it when it did, stay neutral when it did not. Never guess: a
 * wrong stage sends the user to fix the repo for a rejected Safe proposal (the
 * crash history: a concurrent initialize() blanked s2sRecords, so the proposal
 * went out with `to: ''` and the SDK rejected it).
 */
function describeConfigFailure(err: unknown): string {
  const stage = configFailureStage(err);
  const reason = describeError(err);
  if (stage === 'build') {
    return `Building the configuration failed: ${reason}. That stage covers the repo/branch/assets, the chain reads and the IPFS uploads — fix what the reason says, then Retry.`;
  }
  if (stage === 'propose') {
    return `Proposing the configuration record failed: ${reason}. If the Safe app shows no queued transaction, Retry re-sends it.`;
  }
  return `Building or proposing the configuration record failed: ${reason}. Fix the reason above (repo, branch, assets or the Safe proposal), then Retry.`;
}

/**
 * Drop `undefined` entries so a spread can't overwrite a persisted/known value
 * with `undefined` (the caller's fallback would be lost).
 */
function definedOnly<T extends object>(values: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(values) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

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
  // The refresh pass currently running. Concurrent callers join it instead of
  // starting their own. History (fixed at the payload seam: initialize() now
  // publishes one atomic snapshot): two passes meant two initialize() calls,
  // the second of which blanked safeInfo.s2sRecords mid-flight, so a config
  // proposal from the other pass went out with `to: ''` and the Safe SDK
  // rejected it. Joining is no longer a correctness requirement — it just keeps
  // the store from being read half-refreshed.
  private fetchInFlight: Promise<void> | null = null;
  // Upper bound on joining that pass from step 3 (see waitForRefresh): the pass
  // ends with the Filecoin init + list calls, which can stall rather than fail.
  // Readonly by contract; the component test narrows it through a cast so the
  // suite does not have to wait the production value.
  private readonly configRefreshJoinMs = 20_000;

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

  // Host-owned config step (step 3): one active step + one wait poll, both
  // stopped by disconnectedCallback.
  private configStepActive = false;
  private configPollCancelled = false;
  /** A config-phase session is being resumed (syncInitProgress → resumeConfigStep)
   *  but has not set `initPhase` yet. See the guard in
   *  maybeRepairEnsRegistration: the ENS repair must not seed over that session
   *  in the window before the resume marks the step as in flight. */
  private configResumePending = false;
  // Guards the config-record wait loop (retry can re-enter it while the
  // previous poll is still in flight).
  private configWaitActive = false;
  // True when the current step-3 failure is a build/propose error, i.e. nothing
  // was queued — the user may dismiss the modal and fix the config themselves.
  // A wait timeout is NOT dismissible: a transaction may be in the Safe queue.
  private configDismissible = false;

  // Init progress: the publication-creation flow (live or recovered from local
  // storage after a reload) drives this progress modal. Both the live init
  // component (s2s-init-progress events) and the reload-recovery path open it;
  // it closes on error/idle. There is no success banner: once the modules are
  // live the app simply switches to its normal UI.
  @state() private initPhase: InitPhase | null = null;
  @state() private initModalOpen = false;
  /** Step 1's L1 call, forwarded from the init component so the modal can show
   *  the exact `to`/`data` the human has to execute from the L1 twin Safe. */
  @state() private ensCall?: { to: string; data: string };
  // Failure/timeout reason for the progress modal, which shows only the step
  // markers otherwise. It is the ONLY failure surface for the host-owned config
  // step, so it must be explicit — a silent skip would leave the user staring
  // at a spinner that never ends.
  @state() private initError = '';

  /** Safes whose pre-ENS publication has already been checked by the repair
   *  path in this page load (one check per Safe, whatever its outcome). */
  private ensRepairDone = new Set<string>();
  /** Set once the user dismissed an init flow: never re-seed a repair over it. */
  private ensRepairSuppressed = false;

  /** The standalone ENS step's L1 read for this page's Safe. Set once per Safe
   *  per page load by maybeCheckEnsStep; the card owns polling after that. */
  @state() private ensStepState: EnsRegistrationState | null = null;
  /** Safes whose standalone ENS step has already been read this page load. */
  private ensStepChecked = new Set<string>();
  /** True once the standalone step has a verdict for this Safe. The init-flow
   *  repair must then defer to it instead of seeding step 1 over a live
   *  publication (the two surfaces answer the same question). */
  private ensStepClaimed = false;
  /** The user closed the card: keep it closed for the rest of this page load. */
  private ensStepDismissed = false;

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

  /**
   * Refresh every store slice from the chain. SINGLE-FLIGHT: concurrent callers
   * get the pass already in flight, never a second one — one initialize() per
   * burst, one set of store updates.
   */
  private fetchFreshData(): Promise<void> {
    if (this.fetchInFlight) {
      console.log('[app] fetchFreshData: joining the refresh already in flight');
      return this.fetchInFlight;
    }
    const pass = this.runFetchFreshData().finally(() => {
      // Cleared after the pass settles, so an awaiter that resumes below sees
      // "nothing in flight" and can start its own pass if it needs to.
      this.fetchInFlight = null;
    });
    this.fetchInFlight = pass;
    return pass;
  }

  private async runFetchFreshData(): Promise<void> {
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

      // The standalone ENS step for an ALREADY LIVE publication. Deliberately
      // AFTER the record load: the optional card must never hold the app's
      // first paint behind a chain read nobody asked for. Reads the name
      // cross-chain (Base modules) and the L1 registration once per Safe per
      // page load, then gives the legacy repair path the same chance.
      await this.maybeCheckEnsStep(safeInfo, store.getRecord('name') ?? '');

      // A publication created BEFORE the ENS step existed has modules + a name
      // record but no registrable subnode: seed the flow at step 1 so the name
      // can start resolving (see maybeRepairEnsRegistration). Runs AFTER the
      // protocol info is in the store — the repair reads the ENS registry through
      // it, and a hardcoded fallback there would repair against the wrong
      // registry on any deployment whose registry address differs.
      await this.maybeRepairEnsRegistration(safeInfo);

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

  /** This app's own URL, for the "same Safe + app on mainnet" deep link. */
  private get ensStepAppUrl(): string {
    return `${window.location.origin}${window.location.pathname}`;
  }

  /**
   * Drive the init progress modal from a persisted session. Called once on
   * page load (after the Safe is connected). Opens the modal for a
   * reload-recovery while the init component (mounted whenever an init phase
   * is still in flight — see the render gate) resumes the flow itself.
   *
   * "The modules are installed" is NOT the same as "the flow finished":
   * adopting freshly-created module addresses flips hasRecordsModule() true
   * while the modules are only DEPLOYED (the enable proposal is still pending),
   * and the config record (step 3) is still missing even after it executes.
   * Any init phase is kept and handed back to the init component; a config
   * phase is resumed by the host.
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

    const modulesInstalled = this.safeIntegration.hasRecordsModule();

    if (isConfigPhase(session.phase)) {
      if (modulesInstalled) {
        // The finalize batch executed but the config record is still pending
        // (or was never proposed) — the host's step 3. Resume it: reopen the
        // modal at that step and drive it to completion via the records tab's
        // updateConfig (the config record gets its own Safe signature).
        console.log('[app] syncInitProgress: config phase -> resume config step');
        // Marked until the resume settles: its first await (getRecord('config'))
        // leaves a window in which `initPhase` is still null, and the ENS repair
        // below must not mistake that for "no flow here" and seed step 1 over
        // the config-phase session.
        this.configResumePending = true;
        void this.resumeConfigStep(session.phase).finally(() => {
          this.configResumePending = false;
        });
        return;
      }
      // A config-phase session with no installed modules is stale on LOAD (config
      // implies the modules were once live — i.e. a reset wiped them). Drop it so
      // the recovery modal doesn't wedge on a step nothing can drive — but never
      // drop a session this page is already driving: it is the step's only record
      // (identity included), and the missing module is what the step reports.
      // Only the "modules vanished mid-step" case reaches this: every live step
      // has initPhase set to a config phase already, so the session is kept.
      if (
        (this.initPhase !== null && isConfigPhase(this.initPhase)) ||
        this.configStepActive ||
        this.configWaitActive
      ) {
        console.log('[app] syncInitProgress: config step driven here -> keep the session');
        return;
      }
      console.log('[app] syncInitProgress: config session, modules dead -> drop');
      clearInitSession(window.localStorage, INIT_SESSION_KEY);
      this.initPhase = null;
      this.initModalOpen = false;
      return;
    }

    // An init phase (creating … awaiting-finalize) is never cleared here — even
    // if the module addresses were adopted (modules deployed ≠ enabled). The
    // init component stays mounted for these phases and plans the next action
    // itself (→ done → onInitComplete → step 3); the modal is its banner. The
    // actual bug this replaces was here: "records module present" used to mean
    // "flow finished", which silently dropped a session whose enable proposal
    // (and config record) had not executed yet.
    console.log(
      `[app] syncInitProgress: init phase ${session.phase} kept -> open recovery modal (modulesInstalled=${String(modulesInstalled)})`,
    );
    this.initModalOpen = true;
    this.initPhase = session.phase;
  }

  /** The card hid itself because the subnode now reads back as this Safe. */
  private readonly onEnsStepDone = (): void => {
    this.ensStepState = null;
  };

  /** The user dismissed the card: keep it closed for this page load. */
  private readonly onEnsStepDismiss = (): void => {
    this.ensStepState = null;
    this.ensStepDismissed = true;
  };

  /**
   * Read the standalone ENS step for a live publication.
   *
   * Deliberately independent of any init session and of the session's chain:
   * the publication's name is read from its modules on Base, so this works on
   * the L1 twin Safe too (where the module list is empty). The `checked` key
   * is recorded only after a COMPLETED read: a 429/transport failure must not
   * suppress the card for the rest of the page load.
   */
  private async maybeCheckEnsStep(
    safeInfo: { chainId: number; safeAddress: string },
    expectedName: string,
  ): Promise<void> {
    // An init flow / host-owned config step owns the modal: it always wins.
    // Or the user closed the card for this page load.
    if (
      this.ensStepDismissed ||
      this.initPhase !== null ||
      this.configResumePending ||
      this.configStepActive ||
      this.configWaitActive
    ) {
      return;
    }

    // The protocol registry is required: this card sends a real L1 transaction.
    // Never propose against the hardcoded constant when the deployment's
    // registry could not be read (ProtocolIntegration returns undefined).
    const registry = store.protocolInfo?.ensRegistry;
    if (!registry) {
      console.log('[app] ens step skipped: protocol registry is not available');
      return;
    }

    // Scope the cache by publication name AND registry too: an in-page
    // rename/reconfigure must get a fresh read, while a plain refresh of the
    // same publication does not touch the chain again.
    const key = `${safeInfo.chainId}:${safeInfo.safeAddress.toLowerCase()}:${registry.toLowerCase()}:${expectedName
      .trim()
      .toLowerCase()}`;
    if (this.ensStepChecked.has(key)) return;

    let publicationName = '';
    try {
      publicationName = await findPublicationName(
        (chainId, contractAddress, abi, method, args) =>
          this.safeIntegration.evmRead(chainId, contractAddress, abi, method, args),
        safeInfo.safeAddress,
        { expectedName, throwOnError: true },
      );
    } catch (e) {
      // Do NOT record the key: a later refresh may get a clean read.
      console.log(`[app] ens step skipped: publication name read failed (${describeError(e)})`);
      return;
    }

    publicationName = (publicationName ?? '').trim();
    if (!publicationName) {
      this.ensStepChecked.add(key);
      return;
    }
    const label = (publicationName.split('.')[0] ?? '').trim();
    if (!label || subdomainLabelError(label)) {
      this.ensStepChecked.add(key);
      return;
    }

    let state: EnsRegistrationState;
    try {
      state = await readEnsRegistration(
        {
          evmRead: (chainId, contractAddress, abi, method, args) =>
            this.safeIntegration.evmRead(chainId, contractAddress, abi, method, args),
        },
        {
          registry,
          label,
          safeAddress: safeInfo.safeAddress,
          suffix: suffixOfPublicationName(publicationName, label) || undefined,
        },
      );
    } catch (e) {
      // Do NOT record the key: an L1 429 must not hide the step until reload.
      console.log(`[app] ens step skipped: ENS read failed (${describeError(e)})`);
      return;
    }

    this.ensStepChecked.add(key);
    this.ensStepClaimed = true;
    this.ensStepState = state;
    console.log(
      `[app] ens step: ${state.name} registered=${String(state.registered)} owner=${state.owner} chain=${safeInfo.chainId}`,
    );
  }

  /**
   * Repair path for a publication created before the ENS step existed.
   *
   * Such a publication has both modules installed and its name/config records
   * on Base, but no `registerSubdomain` call ever went out (the registry has
   * code on ETH L1 only, and the old flow never proposed it). `ownerOf` on the
   * subnode is therefore 0x0, `resolvePublicationSafe` returns 0x0 and the
   * publication is unreachable by name — with no session to resume and the
   * modules live, nothing would ever notice.
   *
   * When exactly that state is detected the flow is seeded at step 1 and the
   * progress modal opens; the init component then proposes (on L1) or surfaces
   * the call, and polls until the name resolves to this Safe.
   *
   * Deliberately narrow: one check per Safe per page load, never while a flow is
   * active, never after the user dismissed one, never without a name record, and
   * never on a failed read — an unrequested repair must not hijack the page. It
   * also only seeds when the subnode genuinely NEEDS a registration: a name that
   * is owned by somebody else (a third-party registration, or a publication
   * name reused from elsewhere) is not a legacy publication of this app, and a
   * desynced registry entry is a chain-1 repair no flow can make — both are
   * logged and otherwise left alone.
   */
  private async maybeRepairEnsRegistration(
    safeInfo: {
      chainId: number;
      safeAddress: string;
      s2sRecords?: string;
      s2sPublication?: string;
    },
    opts: {
      /** The caller IS the config step's tail (see finishConfigStep): it has
       *  already cleared the session and the modal, and its own flags are still
       *  set until it returns. */
      fromFinishedConfigStep?: boolean;
    } = {},
  ): Promise<void> {
    if (this.initPhase !== null) return; // a live flow (or step 3) owns the modal
    // The standalone ENS step already has a verdict for this Safe: it is the
    // first-class surface for a live publication, and seeding step 1 over it
    // would replace the card with the old propose-only modal.
    if (this.ensStepClaimed) return;
    // A config-phase session is host-owned and is being resumed right now; the
    // repair would overwrite its phase with 'ens' before resumeConfigStep gets
    // to set initPhase, and (with the module pair mid-enable) could read a
    // fresh, not-yet-executed name as a "legacy publication".
    if (
      !opts.fromFinishedConfigStep &&
      (this.configStepActive || this.configWaitActive || this.configResumePending)
    ) {
      return;
    }
    if (this.ensRepairSuppressed) return;
    const key = `${safeInfo.chainId}:${safeInfo.safeAddress.toLowerCase()}`;
    if (this.ensRepairDone.has(key)) return;

    // Every return below is a "not this pass" answer, so the key is NOT
    // recorded yet: a legacy publication whose config step is still finishing on
    // this page load (or whose registry read was rate-limited) must still get
    // its step 1 once the obstruction is gone. Only an actual verdict about the
    // name (owned / needs no registration / seeded) is recorded.

    // Any session on disk belongs to some flow: the same Safe's is already
    // owned by the init component / step 3 above, and another Safe's must not be
    // overwritten (the key is global, so seeding here would strand its only
    // resume record). A legacy publication has no session at all.
    const existing = loadInitSession(window.localStorage, INIT_SESSION_KEY);
    if (existing) {
      console.log(
        `[app] ens repair skipped: session for ${existing.safeAddress} is ${existing.phase}`,
      );
      return;
    }

    if (!this.safeIntegration.hasRecordsModule() || !this.safeIntegration.hasPublicationModule()) {
      return;
    }

    let publicationName = '';
    try {
      publicationName = await this.safeIntegration.getRecord('name');
    } catch {
      return;
    }
    const label = (publicationName.split('.')[0] ?? '').trim();
    if (!label) return;
    // The registry reverts outside its alphabet: seeding a flow whose step 1 can
    // never be proposed would open the recovery modal on an unfixable step.
    const labelError = subdomainLabelError(label);
    if (labelError) {
      console.log(`[app] ens repair skipped: ${labelError}`);
      return;
    }

    let state;
    try {
      state = await readEnsRegistration(
        {
          evmRead: (chainId, contractAddress, abi, method, args) =>
            this.safeIntegration.evmRead(chainId, contractAddress, abi, method, args),
        },
        {
          registry: store.protocolInfo?.ensRegistry ?? ENS_REGISTRY_ADDRESS,
          label,
          safeAddress: safeInfo.safeAddress,
          suffix: suffixOfPublicationName(publicationName.trim(), label) || undefined,
        },
      );
    } catch (e) {
      console.log(`[app] ens repair skipped: ENS read failed (${describeError(e)})`);
      return;
    }
    if (state.ownedBySafe) {
      this.ensRepairDone.add(key);
      return;
    }
    if (!state.needsRegistration) {
      // Desynced, or owned by somebody else: not the state this repair exists
      // for. Seeding here would open the recovery modal on a name this Safe can
      // never claim and hijack a page whose publication works fine.
      console.log(
        `[app] ens repair skipped: ${state.name} needs no registration (registered=${String(state.registered)} owner=${state.owner})`,
      );
      this.ensRepairDone.add(key);
      return;
    }

    // Decided: seed once per Safe per page load (until a config step finishes
    // and clears the mark — see finishConfigStep).
    this.ensRepairDone.add(key);
    console.log(
      `[app] ens repair: ${state.name} is not owned by this Safe (owner=${state.owner}) -> seeding the flow at step 1`,
    );
    saveInitSession(window.localStorage, INIT_SESSION_KEY, {
      version: 3,
      chainId: safeInfo.chainId,
      safeAddress: safeInfo.safeAddress,
      phase: 'ens',
      name: label,
      publicationName: publicationName.trim(),
      repo: '',
      branch: '',
      authors: [],
      proposals: [],
      // The modules are already DEPLOYED — that is the whole premise of this
      // repair. Seed their addresses, or the seeded session plans step 2 and
      // the factories (plain CREATE, non-idempotent) would deploy a SECOND pair
      // over a live publication. Detection cannot recover them either: a
      // deployed-but-not-yet-enabled module is invisible to
      // `hasRecordsModule()`/the Safe's enabled-module list.
      ...(safeInfo.s2sRecords ? { recordsModule: safeInfo.s2sRecords } : {}),
      ...(safeInfo.s2sPublication ? { publicationModule: safeInfo.s2sPublication } : {}),
      ensProposed: false,
      updatedAt: Date.now(),
    });
    this.ensCall = undefined;
    this.initPhase = 'ens';
    this.initModalOpen = true;
  }

  /**
   * Fresh publication proposed by the init flow. The name/repo/branch records
   * are proposed but still pending Safe execution, so the chain read in
   * fetchFreshData cannot see them yet — write them to the store optimistically
   * so the title + web-status populate immediately (no reload needed), clear
   * any stale root from a previous publication, then run the config step.
   *
   * The config step is step 3 of the flow (owned by the host, since the init
   * component is done once the modules go live): the config record is a THIRD
   * Safe execution (build + propose via the records tab, then wait for it to be
   * recorded on-chain). The progress modal stays open on that step so the flow
   * can't be lost, and its phase is persisted for reload-resume.
   */
  private readonly onInitComplete = async (e: Event): Promise<void> => {
    const detail = (
      e as CustomEvent<
        | {
            recordsModule?: string;
            publicationModule?: string;
            name?: string;
            repo?: string;
            branch?: string;
            authors?: string[];
            proposals?: string[];
          }
        | undefined
      >
    ).detail;
    const { name, repo, branch, authors, proposals, recordsModule, publicationModule } =
      detail ?? {};
    console.log(
      `[app] onInitComplete name=${name ?? 'undefined'} repo=${repo ?? 'undefined'} branch=${branch ?? 'undefined'}`,
    );
    // The init element's listener is never detached (lit keeps the EventPart on
    // the node), so a stale instance can deliver this event twice. A second
    // complete during/after the config step must not re-fetch and re-persist
    // over the step that is already running.
    if (this.initPhase !== null && isConfigPhase(this.initPhase)) {
      console.log(`[app] onInitComplete ignored: config phase already active (${this.initPhase})`);
      return;
    }

    // The two S2S init proposals are done; the configuration record is not —
    // keep the modal open on step 3 while the host drives it.
    this.initPhase = 'configuring';
    this.initModalOpen = true;

    // The host OWNS the config-phase session from this moment: the init element
    // drops its own copy around the dispatch, so there is no session on disk to
    // merge from — every field comes from the event detail. (Optional ones are
    // only written when present, so hasRecordsModule()/safeInfo stay the
    // fallback.) Persisted SYNCHRONOUSLY, before anything awaits: a reload
    // during the refresh below would otherwise find no session at all — the
    // live UI with no config record and no resume path.
    this.persistInitPhase(
      'configuring',
      definedOnly({
        recordsModule,
        publicationModule,
        name: name ?? '',
        publicationName: name ?? '',
        repo: repo ?? '',
        branch: branch ?? '',
        authors,
        proposals,
      }),
    );

    // Surface the Config tab — the immediate config build below runs there.
    this.currentTab = 'records';
    // The ENS-only repair path (maybeRepairEnsRegistration) resumes a publication
    // whose modules, name AND config record are already on chain — it seeds step
    // 1 on a FINISHED publication. Running the config step there would propose a
    // second configuration record over the user's existing one. Read the record
    // before closing the step: when it is already on-chain the flow is complete.
    let configOnChain = '';
    try {
      configOnChain = await this.safeIntegration.getRecord('config');
    } catch {
      configOnChain = '';
    }
    if (configOnChain !== '') {
      console.log('[app] onInitComplete: config record already on-chain -> flow complete');
      await this.finishConfigStep();
      return;
    }

    // Bring the store up to date before the optimistic re-apply below, but
    // never at the cost of hanging the flow: the init element's complete() can
    // fire from INSIDE a refresh (its maybeResume runs off the setProtocolInfo
    // store update), so a pass is usually already running — join it (bounded)
    // or start one when there is none. Single-flight means this never doubles
    // the pass.
    await this.waitForRefresh(true);

    // Re-apply the pending (not-yet-executed) records on top of the chain read.
    if (name) store.setRecord({ key: 'name', value: name, type: 'metadata' });
    if (repo) store.setRecord({ key: 'repo', value: repo, type: 'metadata' });
    if (branch) store.setRecord({ key: 'branch', value: branch, type: 'metadata' });
    // A brand-new publication has no content published yet — drop any root that
    // still points at a previous publication's content.
    if (name) store.setRoot('');

    // The session was already persisted above (synchronously, with the same
    // identity), so nothing is written again here: runConfigStep re-persists
    // 'configuring' when it starts.
    await this.updateComplete;
    await this.runConfigStep();
  };

  // ── Host-owned config step (step 3) ───────────────────────────────────────

  /** Persist (or refresh) the init session with a new phase, keeping known fields. */
  private persistInitPhase(phase: InitPhase, extra: Partial<InitSession> = {}): void {
    // `prev` is often gone (the init element clears its own session around the
    // completion dispatch), so callers must pass what the flow needs rather than
    // relying on a merge.
    //
    // DELIBERATELY NOT MONOTONIC (unlike the init component's `persist`, which
    // applies `maxPhase`): this writer records FAILURE states, where moving a
    // step back is the point — a failed config build must say 'configuring'
    // ("nothing is queued, retry rebuilds") instead of a forward-only
    // 'awaiting-config' that claims a proposal exists. See the contract in
    // `lib/init-session.ts`.
    const prev = loadInitSession(window.localStorage, INIT_SESSION_KEY);
    const safeInfo = store.safeInfo;
    saveInitSession(window.localStorage, INIT_SESSION_KEY, {
      version: 3,
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
    // Only a page load resumes step 3. syncInitProgress also runs inside
    // fetchFreshData, and onInitComplete persists 'configuring' BEFORE fetching
    // (so a reload there can resume) — without this guard the fetch would resume
    // the step the host is already driving, re-proposing after a failure.
    if (this.initPhase !== null && isConfigPhase(this.initPhase)) {
      console.log(
        `[app] resumeConfigStep: already driving step 3 here (${this.initPhase}) -> skip`,
      );
      return;
    }
    let value = '';
    try {
      value = await this.safeIntegration.getRecord('config');
    } catch {
      value = '';
    }
    console.log(`[app] resumeConfigStep getRecord('config') -> '${value}'`);
    if (value !== '') {
      console.log('[app] resumeConfigStep: config already on-chain -> flow complete');
      await this.finishConfigStep();
      return;
    }
    this.initPhase = phase;
    this.initModalOpen = true;
    // The config step renders inside the Config tab: without selecting it the
    // records tab is not in the DOM and the step has nothing to drive. This WAS
    // the silent-skip bug — set it before awaiting anything.
    this.currentTab = 'records';
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
   * recorded on-chain before clearing the session and closing the modal (see
   * finishConfigStep: the refresh that lands the record in the store runs
   * BEFORE the modal is cleared).
   *
   * Every failure keeps the modal OPEN with an error + Retry: the config record
   * is the last thing standing between the user and a usable publication, so
   * dropping the session (or silently skipping the build) is never acceptable.
   */
  private async runConfigStep(): Promise<void> {
    if (this.configStepActive) {
      // Explicit, not silent: a re-entry means something dispatched twice
      // (retry click during a live build, resume after onInitComplete).
      console.log('[app] runConfigStep: already active -> ignoring re-entry');
      return;
    }
    this.configStepActive = true;
    this.configDismissible = false;
    try {
      this.initPhase = 'configuring';
      this.initModalOpen = true;
      this.initError = '';
      this.persistInitPhase('configuring');
      // Select the Config tab so the records tab element is actually rendered
      // (activeTabTemplate renders nothing for a non-active tab).
      this.currentTab = 'records';
      // Courtesy join of a refresh already in flight — BOUNDED, so the step can
      // never stall here: the pass ends with the Filecoin init/list calls, which
      // can hang on a bad network.
      // Historically this wait mattered (a second initialize() blanked
      // s2sRecords and the proposal went out with `to: ''`); now that the
      // payload seam is atomic, proceeding without it is safe — the wait only
      // avoids building on a half-refreshed store.
      await this.waitForRefresh();
      await this.updateComplete;

      const tab = this.renderRoot.querySelector('s2s-records-tab') as ConfigTab | null;
      if (typeof tab?.updateConfig !== 'function') {
        // Retry cannot fix this one (the tab does not render at all), so the
        // message names the recoveries that do exist: dismiss and the init form
        // comes back (no session is kept, so the flow starts over), or reopen
        // the app. It must NOT point at the Records table — activeTabTemplate
        // renders nothing for 'records' without the records module, which is
        // exactly the state that fired this.
        this.failConfigStep(
          'The Config tab is not available, so the configuration record was not proposed. Close this and start the initialization again, or reopen the app.',
        );
        return;
      }

      let configCid = '';
      try {
        configCid = await tab.updateConfig(undefined, { suppressQueueOpen: true });
      } catch (err) {
        this.failConfigStep(describeConfigFailure(err));
        return;
      }
      console.log(`[app] config proposal sent cid=${configCid}`);
      if (!configCid) {
        // Per the pinned contract an empty CID means the tab proposed NOTHING.
        // Continuing into 'awaiting-config' would wait ten minutes for a
        // transaction that does not exist and then report a false reason, and
        // the persisted phase would stop a reload from re-proposing. Fail at
        // 'configuring' instead so Retry rebuilds.
        this.failConfigStep(
          'The Config tab did not propose a configuration record. Retry to rebuild it.',
        );
        return;
      }

      this.initPhase = 'awaiting-config';
      this.persistInitPhase('awaiting-config');
      await this.waitForConfigRecord();
    } finally {
      this.configStepActive = false;
    }
  }

  /**
   * Bring the store up to date before step 3 builds, without ever hanging the
   * modal: join the refresh in flight (or start one when `start`), for at most
   * `configRefreshJoinMs`. Courtesy, not a dependency — with the atomic payload
   * seam a concurrent pass can no longer produce a `to: ''` proposal, so if the
   * pass overshoots its bound we simply proceed — the step markers keep
   * spinning, and a stall can never leave the flow wedged.
   */
  private async waitForRefresh(start = false): Promise<boolean> {
    if (start && !this.fetchInFlight) void this.fetchFreshData();
    const pass = this.fetchInFlight;
    if (!pass) return true;
    console.log('[app] joining the refresh in flight (bounded)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pass.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            console.warn('[app] refresh did not settle in time -> proceeding');
            resolve(false);
          }, this.configRefreshJoinMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Poll the chain until the config record exists (the 3rd Safe execution). */
  private async waitForConfigRecord(): Promise<void> {
    if (this.configWaitActive) return;
    this.configWaitActive = true;
    const startedAt = Date.now();
    const timeoutMs = 10 * 60_000;
    try {
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
          await this.finishConfigStep();
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          // Timeout: KEEP the session (the proposal is still queued — a retry
          // must not re-propose it) and surface the reason in the modal.
          console.error('[app] timed out waiting for the config record to be executed');
          this.initError =
            'The configuration proposal is still pending in the Safe queue. Execute it, then retry.';
          this.initModalOpen = true;
          // NOT dismissible: a Safe transaction may be queued for this record.
          this.configDismissible = false;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      this.configWaitActive = false;
    }
  }

  /** Config record is on-chain: clear the session, refresh so the Config tab
   * shows the record it just built, and only then close the modal — the modal
   * must not disappear onto a Config tab that is still empty. */
  private async finishConfigStep(): Promise<void> {
    // The session is done as soon as the record is on-chain: clear it first so a
    // reload during the refresh below cannot resume a finished flow.
    clearInitSession(window.localStorage, INIT_SESSION_KEY);
    // A repair skipped earlier in this page load (the config step owned the
    // session then) must get its chance now: the flow is over and the refresh
    // below will run the repair again. Without this a legacy publication whose
    // config step finished late never reaches its ENS step until a reload.
    this.ensRepairDone.clear();
    try {
      // Close only once the record is BOTH on-chain and in the store. Settle any
      // pass that started BEFORE the record landed (bounded — a Filecoin stall
      // must not park the refresh forever), then start a fresh read: joining the
      // old pass would let the modal close onto a Config tab that still shows
      // the pending state.
      await this.waitForRefresh();
      await this.fetchFreshData();
    } finally {
      // A stuck modal must never be the outcome: a failed/hung refresh still
      // hands the page back (the Config tab re-reads on the next pass).
      this.initPhase = null;
      this.initModalOpen = false;
      this.initError = '';
      this.configDismissible = false;
    }
    // The refresh above ran while this step still owned the modal (`initPhase`
    // is only cleared in the finally), so the ENS repair could not run in it.
    // Now that the flow is over, give the repair its chance: this is the last
    // step, so a publication created before the ENS step existed would otherwise
    // never reach step 1 until a reload.
    const safeInfo = store.safeInfo;
    if (safeInfo) {
      await this.maybeRepairEnsRegistration(safeInfo, { fromFinishedConfigStep: true });
    }
  }

  /**
   * Build/propose failure of step 3. Keeps everything needed to retry — the
   * session stays at 'configuring', the modal stays open with the reason — and
   * additionally offers a DISMISS path: this class of failure is deterministic
   * (bad repo URL, no assets/, wrong branch), so Retry alone can trap the user
   * behind a full-screen overlay that covers the Config tab where the repo and
   * branch are fixed. Nothing was queued at this point, so walking away is safe
   * — the publication is half-initialized (modules enabled, no config record),
   * which is exactly what the records tab's "Initialize configuration" is for.
   */
  private failConfigStep(message: string): void {
    console.error(`[app] config step failed: ${message}`);
    this.initPhase = 'configuring';
    this.initModalOpen = true;
    this.initError = message;
    this.configDismissible = true;
    this.persistInitPhase('configuring');
  }

  /**
   * Dismiss a failed step 3 and hand the user back the app. Only offered for
   * build/propose failures (nothing queued, `configDismissible`): after the
   * proposal was sent a pending Safe transaction must stay in sight, so the
   * timeout state has no dismiss.
   */
  private readonly onInitDismiss = (): void => {
    // Re-entrancy guard: a dismiss must never clear the session while a build
    // is in flight (the button is only rendered once the run has failed, but a
    // queued click can outlive the error).
    if (this.configStepActive) {
      console.log('[app] onInitDismiss ignored: config step in flight');
      return;
    }
    console.log(`[app] onInitDismiss phase=${this.initPhase ?? 'none'}`);
    clearInitSession(window.localStorage, INIT_SESSION_KEY);
    this.initPhase = null;
    this.initModalOpen = false;
    this.initError = '';
    this.configDismissible = false;
    this.ensCall = undefined;
    // Dismissed means the user does not want this flow driven: do not re-seed
    // an ENS repair over it until the page is reloaded.
    this.ensRepairSuppressed = true;
    // Land where the user can actually act: the Config tab when it exists (fix
    // repo/branch in the Records table, then re-run the config from there),
    // else the first tab that renders — 'records' renders nothing without the
    // records module, i.e. a blank page under the tabs. With no modules at all
    // neither applies: the init form comes back, which is the real restart.
    this.currentTab = this.safeIntegration.hasRecordsModule()
      ? 'records'
      : this.safeIntegration.hasPublicationModule()
        ? 'deals'
        : 'storage';
  };

  /**
   * Retry from the modal's Retry action. A step that already proposed its
   * config record ('awaiting-config') only re-waits — re-proposing would
   * duplicate the Safe transaction. Anything else re-runs the build+propose.
   */
  private readonly onInitRetry = (): void => {
    console.log(`[app] onInitRetry phase=${this.initPhase ?? 'none'}`);
    this.initError = '';
    if (this.initPhase === 'awaiting-config') {
      void this.waitForConfigRecord();
      return;
    }
    void this.runConfigStep();
  };

  /** Live progress from the init component while a flow is running. */
  private readonly onInitProgress = (e: Event): void => {
    const detail = (
      e as CustomEvent<
        | {
            step: string;
            phase: InitPhase;
            proposals: string[];
            name?: string;
            ensCall?: { to: string; data: string };
          }
        | undefined
      >
    ).detail;
    if (!detail) return;
    console.log(
      `[app] onInitProgress step=${detail.step} phase=${detail.phase} name=${detail.name ?? 'undefined'}`,
    );
    // The element emits 'idle' (reset/cancel) and 'error'; it never emits a
    // 'done' progress step — completion arrives as s2s-init-complete.
    //   - 'idle': nothing is running, so there is nothing to show and no
    //     overlay to keep (an overlay with no progress and no action is a dead
    //     end over a reachable form).
    //   - 'error' is a failure INSIDE the element (e.g. waitForEnabled timed
    //     out): the element owns the only error surface (message + Try again /
    //     Start over), so its phase must be kept or the gate would unmount it
    //     and leave the user with nothing at all — in exactly the create→enable
    //     window where the module addresses are already adopted. The overlay is
    //     closed so it cannot cover that inline error.
    // Any other step opens the modal: it is the progress surface for both the
    // live flow and the reload-recovery.
    this.initError = '';
    this.ensCall = detail.ensCall;
    if (detail.step === 'idle') {
      // The user walked away from the flow (Start over / cancel): never re-seed
      // a repair over their decision in this page load.
      this.ensRepairSuppressed = true;
      this.ensCall = undefined;
      this.initPhase = null;
      this.initModalOpen = false;
      return;
    }
    if (detail.step === 'error') {
      this.initPhase = detail.phase;
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
    // An init phase that is still in flight (creating … awaiting-finalize) keeps
    // the init component mounted even once the module addresses are adopted:
    // freshly-created modules flip hasRecordsModule() true while they are only
    // DEPLOYED, not enabled. (This is not about event delivery — lit keeps an
    // @listener bound to the node, so a detached instance still delivers
    // s2s-init-complete — it is about one instance instead of unmount/remount
    // re-planning, and about not lying in the UI.) Config phases (host-owned
    // step 3) are not init flow — they need the tabs, so the Config tab can
    // drive updateConfig.
    const initFlowRunning = this.initPhase !== null && !isConfigPhase(this.initPhase);
    // The "live" UI (module badges, Reset, tabs) is only truthful once no init
    // phase is pending: the enable proposal must have executed. An 'error' inside
    // the init element keeps its phase for this reason — the element owns the
    // inline error + Try again/Start over, and it must stay on screen.
    const live = hasModules && !initFlowRunning;
    const publicationActive = live && this.safeIntegration.hasPublicationModule();
    const recordsActive = live && this.safeIntegration.hasRecordsModule();

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
              class="pill module-badge ${publicationActive ? 'module-active' : 'module-inactive'}"
            >
              <copy-module
                .value=${safeInfo?.s2sPublication ?? ''}
                label="Publication Module"
              ></copy-module>
            </div>
            <div class="pill module-badge ${recordsActive ? 'module-active' : 'module-inactive'}">
              <copy-module
                .value=${safeInfo?.s2sRecords ?? ''}
                label="Records Module"
              ></copy-module>
            </div>
            ${live
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

          ${live
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

        ${this.initPhase === null &&
        !this.configStepActive &&
        !this.configResumePending &&
        this.resetState === 'idle'
          ? html`
              <s2s-ens-step
                .state=${this.ensStepState}
                .safeInfo=${safeInfo}
                .safeIntegration=${this.safeIntegration}
                .appUrl=${this.ensStepAppUrl}
                @s2s-ens-done=${this.onEnsStepDone}
                @s2s-ens-dismiss=${this.onEnsStepDismiss}
              ></s2s-ens-step>
            `
          : ''}
        ${!live
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
        ${live
          ? html`
              <div class="tabs">
                <button
                  class="tab ${this.currentTab === 'deals' ? 'active' : ''}"
                  id="deals-tab"
                  ?disabled=${!this.safeIntegration.hasPublicationModule()}
                  @click=${() => this.switchTab('deals')}
                >
                  Agreements
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
        .error=${this.initError}
        .ensCall=${this.ensCall}
        .canDismiss=${this.initPhase === 'configuring' && this.configDismissible}
        @s2s-init-retry=${this.onInitRetry}
        @s2s-init-dismiss=${this.onInitDismiss}
      ></s2s-init-progress-modal>
    `;
  }
}
