// s2s-init.ts — "New publication" component (SPEC-hosts.md AD-3).
//
// Shown by <s2s-app> when the loaded Safe has neither the records nor the
// publication module. It drives the DIRECT-SEQUENCE init flow end-to-end
// (PR #158) using the exported building blocks of publication-init.ts (the
// pure lib, PR #147):
//
//   1. propose create-batch  (buildCreateModuleBatch)      → Safe queue
//   2. await execution, detect module addresses           (detectModuleAddresses)
//   3. propose the MERGED enable+name batch (buildFinalizeBatch) → Safe queue
//   4. await execution (modules enabled AND name recorded) → done
//
// Only two proposals, only two Safe executions. The module addresses are
// unknowable until the create batch executes (plain CREATE, non-idempotent
// factories), so a single-proposal init is impossible without a protocol
// change; the merged finalize batch is the floor for the safe-app-only flow.
//
// The component deliberately drives the steps itself (rather than calling the
// single-shot initializePublication) so each Safe-proposal queue URL can be
// surfaced the moment it is created — a human has to open the Safe app and
// execute each proposal before the next step can run.
//
// The component deliberately drives the steps itself (rather than calling the
// single-shot initializePublication) so each Safe-proposal queue URL can be
// surfaced the moment it is created — a human has to open the Safe app and
// execute each proposal before the next step can run.
//
// It depends on the SafeIntegration only through a small duck-typed surface
// (proposeBatch / getProvider / fetchFactoryModuleCreatedLogs /
// readIsModuleEnabled / getRecord) so component tests can hand-roll a mock —
// the same pattern as the other tabs.
//
// # Crash-safe resume (init-session.ts)
//
// The flow is human-in-the-loop, so the page can reload at any point (the
// human navigates to the Safe app to execute a proposal, and comes back to a
// fresh page load). To survive that, every phase transition is persisted to
// local storage via init-session.ts (phase, form values, proposal URLs,
// learned module addresses). On connect the component restores a matching
// session and auto-resumes the plan loop; the loop is driven by
// `planNextAction`, which never re-proposes a batch that was already sent —
// if a proposal is still pending it waits instead. When the flow finishes the
// session is cleared.

import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import {
  buildCreateModuleBatch,
  buildFinalizeBatch,
  detectModuleAddresses,
  waitForModulesEnabled,
  type MetaTransactionData,
  type ProtocolInfo,
} from '../lib/publication-init.js';
import {
  INIT_SESSION_KEY,
  clearInitSession,
  isConfigPhase,
  loadInitSession,
  planNextAction,
  saveInitSession,
  type InitPhase,
  type InitSession,
  type InitSessionStorage,
  type ResumeAction,
} from '../lib/init-session.js';
import './s2s-sliding-add-button.js';
import './s2s-button.js';
import './pet-name.js';
import type { SafeInfo } from '@/types/index.js';

/**
 * Smallest SafeIntegration surface the init flow needs. The component never
 * imports safe-integration.ts — it is driven by whatever object s2s-app (or a
 * test) hands it, as long as it satisfies this shape.
 */
interface InitSafeIntegration {
  proposeBatch(txs: MetaTransactionData[]): Promise<string>;
  getProvider(): { getBlockNumber(): Promise<number> };
  fetchFactoryModuleCreatedLogs(
    factoryAddress: string,
    safeAddress: string,
    topic0: string,
    fromBlock: number,
  ): Promise<{ topics: string[] }[]>;
  readIsModuleEnabled(moduleAddress: string): Promise<boolean>;
  getRecord(key: string): Promise<string>;
  /** Make getRecord / module reads work for freshly-created modules. */
  adoptModules(recordsModule?: string, publicationModule?: string): void | Promise<void>;
}

/** How long to keep polling for the create-batch execution (human-in-the-loop). */
const DEFAULT_DETECTION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LOOKBACK_BLOCKS = 10_000;

/** How long to wait for the enable batch to be executed in the Safe app. */
const DEFAULT_ENABLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ENABLE_POLL_INTERVAL_MS = 2_000;

/** Suffix appended to the publication name (displayed and recorded). */
const SOUL2SOUL_ETH = '.soul2soul.eth';

/** Starter template the config build pulls from (prefilled, overridable). */
const DEFAULT_REPO = 'https://github.com/Joera/website-starter';
const DEFAULT_BRANCH = 'main';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const WORKING_STEPS = ['creating', 'detecting', 'finalizing', 'awaiting-finalize'] as const;

type Step = 'idle' | (typeof WORKING_STEPS)[number] | 'done' | 'error';

/** Sentinel thrown when a human-in-the-loop wait timed out (fail() already ran). */
class InitTimeoutError extends Error {}

@customElement('s2s-publication-init')
export class S2SPublicationInit extends LitElement {
  /** Duck-typed SafeIntegration (see InitSafeIntegration). */
  @property({ attribute: false }) safeIntegration?: InitSafeIntegration;

  /** Deployed factory addresses (recordsFactory + publicationFactory). */
  @property({ attribute: false }) protocolInfo?: ProtocolInfo;

  /** How long to wait for the enable batch to be executed in the Safe app. */
  @property({ type: Number }) enableTimeoutMs = DEFAULT_ENABLE_TIMEOUT_MS;
  /** Poll interval while waiting for the enable batch to be executed. */
  @property({ type: Number }) enablePollIntervalMs = DEFAULT_ENABLE_POLL_INTERVAL_MS;

  /** The current Safe (safeAddress / chainId / owners). */
  @property({ attribute: false }) safeInfo?: SafeInfo;

  /**
   * Where the flow's state is persisted between page loads (injected so unit
   * tests can pass a fake; defaults to the real localStorage).
   */
  @property({ attribute: false }) storage: InitSessionStorage = window.localStorage;

  /** Publication name label (the .soul2soul.eth suffix is appended). */
  @state() private name = '';
  @state() private nameError = '';
  /** Starter repo the config build pulls from — recorded on-chain, then edited in the Config tab. */
  @state() private repo = DEFAULT_REPO;
  /** Git branch of the starter repo — recorded on-chain, then edited in the Config tab. */
  @state() private branch = DEFAULT_BRANCH;
  @state() private authors: string[] = [];
  @state() private step: Step = 'idle';
  @state() private proposals: string[] = [];
  @state() private error = '';

  /** The persisted flow session (null when no flow is in progress). */
  private session: InitSession | null = null;
  /** Guards against auto-resuming more than once per component lifetime. */
  private resumed = false;

  static styles = [
    typograhyStyles,
    buttonStyles,
    css`
      :host {
        display: block;
      }

      .init__field {
        margin-bottom: 1rem;
      }

      .init__label {
        display: block;
        margin-bottom: 0.35rem;
        font-size: 0.85rem;
        color: var(--gray-300);
      }

      .init__name {
        display: flex;
        align-items: stretch;
      }

      .init__input {
        width: 240px;
        box-sizing: border-box;
        padding: 0.5rem 0.75rem;
        border-radius: 6px 0 0 6px;
        border: 1px solid var(--gray-500);
        background: var(--gray-900);
        color: var(--gray-50);
        font-family: var(--font-mono);
        font-size: 0.85rem;
        outline: none;
      }

      .init__input:focus {
        border-color: var(--accent);
      }

      .init__input--full {
        width: 100%;
        border-radius: 6px;
        max-width: 420px;
      }

      .init__suffix {
        display: inline-flex;
        align-items: center;
        padding: 0.5rem 0.75rem;
        border-radius: 0 6px 6px 0;
        border: 1px solid var(--gray-500);
        border-left: none;
        background: var(--gray-900);
        color: var(--gray-400);
        font-family: var(--font-mono);
        font-size: 0.85rem;
        white-space: nowrap;
      }

      .init__name-error {
        margin-top: 0.35rem;
        font-size: 0.8rem;
        color: #ffb4b4;
      }

      .alias-pills {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
      }

      .alias-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.25rem 0.75rem;
        border-radius: 999px;
        background: var(--gray-800);
        border: 1px solid var(--gray-600);
        color: var(--gray-50);
        font-family: var(--font-mono);
        font-size: 0.85rem;
      }

      .alias-pill__remove {
        display: inline-flex;
        align-items: center;
        padding: 0;
        margin: 0;
        background: transparent;
        border: none;
        color: var(--gray-400);
        cursor: pointer;
      }

      .alias-pill__remove:hover {
        color: var(--color-red);
      }

      .init__status {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin-bottom: 0.75rem;
        font-size: 0.9rem;
      }

      .init__spinner {
        width: 1rem;
        height: 1rem;
        border: 2px solid var(--gray-500);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: init-spin 0.8s linear infinite;
        flex-shrink: 0;
      }

      @keyframes init-spin {
        to {
          transform: rotate(360deg);
        }
      }

      .init__proposals {
        margin: 0.5rem 0 1rem;
        padding: 0;
        list-style: none;
      }

      .init__proposal {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.4rem;
        font-size: 0.85rem;
      }

      .init__proposal a {
        color: var(--accent);
        font-family: var(--font-mono);
        font-size: 0.8rem;
        word-break: break-all;
      }

      .init__error {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.75rem;
        margin: 0.5rem 0 1rem;
        border-radius: 6px;
        background: var(--error-bg, #3a1414);
        border: 1px solid var(--error-border, #7a2a2a);
        color: #ffb4b4;
        font-size: 0.85rem;
        white-space: pre-wrap;
      }

      .init__actions {
        display: flex;
        gap: 0.75rem;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    // Prefill authors with the Safe's owners the first time we connect.
    // (owners is defensive: some callers pass a partial safeInfo.)
    const owners = this.safeInfo?.owners;
    if (this.authors.length === 0 && owners?.length) {
      this.authors = [...new Set(owners)];
    }

    // If a flow for this Safe is mid-flight in storage, restore it — the
    // step, form values and proposal links all come back from the session.
    this.restorePersisted();
    this.maybeResume();
  }

  protected updated(changed: PropertyValues<this>): void {
    // The deps (safeIntegration / protocolInfo / safeInfo) may arrive after
    // connect (s2s-app renders this component as soon as the Safe resolves);
    // resume once everything is available.
    if (changed.has('safeIntegration') || changed.has('protocolInfo') || changed.has('safeInfo')) {
      this.maybeResume();
    }
  }

  private get safeAddress(): string {
    return this.safeInfo?.safeAddress ?? '';
  }

  private isWorkingStep(step: Step): boolean {
    return (WORKING_STEPS as readonly string[]).includes(step);
  }

  /** Restore an in-flight session for this Safe, if any, into component state. */
  private restorePersisted(): void {
    const session = loadInitSession(this.storage, INIT_SESSION_KEY);
    if (!session) return;
    // The session must belong to the currently connected Safe + chain.
    if (!this.safeInfo) return;
    if (session.safeAddress.toLowerCase() !== this.safeInfo.safeAddress.toLowerCase()) return;
    if (session.chainId !== this.safeInfo.chainId) return;
    // Config-phase sessions are host-owned: the modules are live by then (this
    // component only mounts when they are not), so <s2s-app> drives that step.
    if (isConfigPhase(session.phase)) return;

    this.session = session;
    this.name = session.name;
    this.repo = session.repo;
    this.branch = session.branch;
    this.authors = session.authors;
    this.proposals = session.proposals;
    this.step = session.phase;
    this.dispatchProgress();
  }

  /** Auto-resume a restored flow once, once the deps are present. */
  private maybeResume(): void {
    if (this.resumed) return;
    if (!this.session || !this.isWorkingStep(this.step)) return;
    if (!this.safeIntegration || !this.protocolInfo || !this.safeAddress) return;
    this.resumed = true;
    void this.start();
  }

  /** Reset to the form (also used as "try again" after an error). */
  private readonly reset = (): void => {
    clearInitSession(this.storage, INIT_SESSION_KEY);
    this.session = null;
    this.step = 'idle';
    this.error = '';
    this.proposals = [];
    this.dispatchProgress();
  };

  private fail(message: string): void {
    this.error = message;
    this.step = 'error';
    this.dispatchProgress();
  }

  /** Persist the current session with a new phase (and optional field updates). */
  private persist(phase: InitPhase, extra: Partial<InitSession> = {}): void {
    if (!this.session) return;
    this.session = { ...this.session, ...extra, phase, updatedAt: Date.now() };
    saveInitSession(this.storage, INIT_SESSION_KEY, this.session);
  }

  /** Broadcast the current step so the host can keep its progress modal in sync. */
  private dispatchProgress(): void {
    this.dispatchEvent(
      new CustomEvent('s2s-init-progress', {
        detail: {
          step: this.step,
          phase: this.session?.phase ?? 'creating',
          proposals: this.proposals,
          name: this.session?.publicationName ?? this.name,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Signal successful completion to the host (used by both fresh + resumed flows). */
  private complete(): void {
    this.step = 'done';
    const session = this.session;
    console.log(`[init] COMPLETE - flow finished. session=${session ? session.phase : 'null'}`);
    this.dispatchEvent(
      new CustomEvent('s2s-init-complete', {
        detail: {
          recordsModule: session?.recordsModule,
          publicationModule: session?.publicationModule,
          proposals: this.proposals,
          name: session?.publicationName,
          repo: session?.repo,
          branch: session?.branch,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private readonly onNameInput = (e: Event): void => {
    this.name = (e.target as HTMLInputElement).value;
    if (this.nameError) this.nameError = '';
  };

  private readonly onRepoInput = (e: Event): void => {
    this.repo = (e.target as HTMLInputElement).value;
  };

  private readonly onBranchInput = (e: Event): void => {
    this.branch = (e.target as HTMLInputElement).value;
  };

  private readonly addAuthor = (value: string): void => {
    const address = value.trim();
    if (!ADDRESS_RE.test(address)) return;
    if (this.authors.includes(address)) return;
    this.authors = [...this.authors, address];
  };

  private readonly removeAuthor = (address: string): void => {
    this.authors = this.authors.filter((a) => a !== address);
  };

  private async start(): Promise<void> {
    const si = this.safeIntegration;
    const info = this.protocolInfo;
    const safeAddress = this.safeAddress;

    if (!si || !info || !safeAddress) {
      this.fail('Not connected to a Safe yet. Reload the app inside the Safe and try again.');
      return;
    }

    // Fresh start (user clicked "Create"): validate the form and open a session.
    if (!this.session) {
      const label = this.name.trim();
      if (!label) {
        this.nameError = 'Publication name is required.';
        return;
      }
      this.error = '';
      this.proposals = [];
      this.session = {
        version: 2,
        chainId: this.safeInfo?.chainId ?? 0,
        safeAddress,
        phase: 'creating',
        name: label,
        publicationName: `${label}${SOUL2SOUL_ETH}`,
        repo: this.repo.trim() || DEFAULT_REPO,
        branch: this.branch.trim() || DEFAULT_BRANCH,
        authors: [...this.authors],
        proposals: [],
        updatedAt: Date.now(),
      };
      this.persist('creating');
    } else {
      this.error = '';
    }

    try {
      for (;;) {
        const action = await this.plan(si, info, safeAddress);
        console.log(`[init] plan -> ${action.type}`);
        const done = await this.runAction(action, si, info, safeAddress);
        if (done) return;
      }
    } catch (e) {
      if (e instanceof InitTimeoutError) return; // fail() already ran with the timeout message
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Decide the next step from the persisted phase + on-chain checks. Never
   * re-proposes a batch the session says was already sent.
   */
  private async plan(
    si: InitSafeIntegration,
    _info: ProtocolInfo,
    _safeAddress: string,
  ): Promise<ResumeAction> {
    const session = this.session;
    if (!session) return { type: 'create' };

    const recordsModule = session.recordsModule;
    const publicationModule = session.publicationModule;
    const recordsKnown = !!recordsModule;
    const publicationKnown = !!publicationModule;

    let recordsEnabled = false;
    let publicationEnabled = false;
    if (recordsModule && publicationModule) {
      [recordsEnabled, publicationEnabled] = await Promise.all([
        si.readIsModuleEnabled(recordsModule),
        si.readIsModuleEnabled(publicationModule),
      ]);
    }

    let nameRecorded = false;
    if (recordsKnown) {
      try {
        nameRecorded = (await si.getRecord('name')) !== '';
      } catch {
        nameRecorded = false;
      }
    }

    const action = planNextAction(session, {
      recordsKnown,
      publicationKnown,
      recordsEnabled,
      publicationEnabled,
      nameRecorded,
    });
    console.log(
      `[init] plan checks { known:${String(recordsKnown)}/${String(publicationKnown)}, enabled:${String(recordsEnabled)}/${String(publicationEnabled)}, nameRecorded:${String(nameRecorded)} } -> ${action.type}`,
    );
    return action;
  }

  /** Execute one planned action; returns true when the flow is finished. */
  private async runAction(
    action: ResumeAction,
    si: InitSafeIntegration,
    info: ProtocolInfo,
    safeAddress: string,
  ): Promise<boolean> {
    const session = this.session;
    if (!session) return false;

    console.log(`[init] runAction ${action.type} (phase=${this.session?.phase ?? 'none'})`);
    // Populate the shared integration's module wrappers from the session so
    // getRecord works live (freshly-created modules postdate initialize()).
    if (session.recordsModule || session.publicationModule) {
      console.log(
        `[init] adoptModules(session) ${session.recordsModule ?? 'none'}/${session.publicationModule ?? 'none'}`,
      );
      await si.adoptModules(session.recordsModule, session.publicationModule);
    }

    switch (action.type) {
      case 'create': {
        this.step = 'creating';
        this.dispatchProgress();
        const createBatch = buildCreateModuleBatch(info, safeAddress, this.authors);
        const createUrl = await si.proposeBatch(createBatch);
        this.proposals = [createUrl];
        this.persist('detecting', { proposals: [createUrl] });
        this.step = 'detecting';
        this.dispatchProgress();
        return false;
      }

      case 'detect': {
        this.step = 'detecting';
        this.dispatchProgress();
        const { recordsModule, publicationModule } = await detectModuleAddresses(
          {
            fetchModuleCreatedLogs: (factoryAddress, safe, topic0, fromBlock) =>
              si.fetchFactoryModuleCreatedLogs(factoryAddress, safe, topic0, fromBlock),
            safeAddress,
            recordsFactory: info.recordsFactory,
            publicationFactory: info.publicationFactory,
            getBlockNumber: () => si.getProvider().getBlockNumber(),
          },
          {
            timeoutMs: DEFAULT_DETECTION_TIMEOUT_MS,
            pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
            lookbackBlocks: DEFAULT_LOOKBACK_BLOCKS,
          },
        );
        this.persist('finalizing', { recordsModule, publicationModule });
        // The created contracts now exist on-chain — expose them to the shared
        // SafeIntegration so its getRecord/readIsModuleEnabled work live
        // without waiting for a reload.
        await si.adoptModules(recordsModule, publicationModule);
        return false;
      }

      case 'finalize': {
        this.step = 'finalizing';
        this.dispatchProgress();
        const { recordsModule, publicationModule } = this.requireModules(session);
        const finalizeBatch = buildFinalizeBatch(
          safeAddress,
          recordsModule,
          publicationModule,
          session.publicationName,
          { repo: session.repo, branch: session.branch },
        );
        const finalizeUrl = await si.proposeBatch(finalizeBatch);
        this.proposals = [...this.proposals, finalizeUrl];
        this.persist('awaiting-finalize', { proposals: this.proposals });
        this.step = 'awaiting-finalize';
        this.dispatchProgress();
        return false;
      }

      case 'await-finalize': {
        this.step = 'awaiting-finalize';
        this.dispatchProgress();
        const { recordsModule, publicationModule } = this.requireModules(session);
        await this.waitForEnabled(si, recordsModule, publicationModule);
        await this.waitForNameRecord(si);
        return false;
      }

      case 'done': {
        // Everything is on-chain — the flow is genuinely finished. Tell the
        // host first (reads the still-live session), then clear it.
        this.complete();
        clearInitSession(this.storage, INIT_SESSION_KEY);
        this.session = null;
        return true;
      }
    }
  }

  /**
   * The module addresses are learned by detection before any address-dependent
   * step runs, so plan() guarantees they are present — this narrows the
   * optional session fields and surfaces a bug loudly if that invariant breaks.
   */
  private requireModules(session: InitSession): {
    recordsModule: string;
    publicationModule: string;
  } {
    const recordsModule = session.recordsModule;
    const publicationModule = session.publicationModule;
    if (!recordsModule || !publicationModule) {
      throw new Error('Init flow reached an address-dependent step without module addresses.');
    }
    return { recordsModule, publicationModule };
  }

  /** Poll until the enable proposal is executed (the human executes it). */
  private async waitForEnabled(
    si: InitSafeIntegration,
    recordsModule: string,
    publicationModule: string,
  ): Promise<void> {
    try {
      await waitForModulesEnabled(
        {
          recordsModule,
          publicationModule,
          isModuleEnabled: async (module) => {
            const on = await si.readIsModuleEnabled(module);
            console.log(`[init] waitForEnabled poll ${module.slice(0, 10)}... -> ${String(on)}`);
            return on;
          },
        },
        {
          timeoutMs: this.enableTimeoutMs,
          pollIntervalMs: this.enablePollIntervalMs,
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.fail(
        `${message} Open the proposal in the Safe app, execute it, then reload — the app will resume where it left off.`,
      );
      throw new InitTimeoutError(message);
    }
  }

  /** Poll until the name record is on-chain (the human executes proposal 2).
   *  The finalize batch sets the name in the SAME transaction as the module
   *  enables, so once the enable poll passes, any non-empty value here means
   *  the batch executed — compare non-empty rather than exact equality so a
   *  formatting difference in the stored value can never block completion. */
  private async waitForNameRecord(si: InitSafeIntegration): Promise<void> {
    const start = Date.now();
    for (;;) {
      let value = '';
      try {
        value = await si.getRecord('name');
        console.log(`[init] waitForNameRecord poll getRecord('name') -> '${value}'`);
      } catch (e) {
        console.log(
          `[init] waitForNameRecord poll getRecord('name') THREW: ${e instanceof Error ? e.message : String(e)}`,
        );
        value = '';
      }
      if (value !== '') return;
      if (Date.now() - start > this.enableTimeoutMs) {
        this.fail(
          'Timed out waiting for the proposal to be executed. Open it in the Safe app, execute it, then reload — the app will resume where it left off.',
        );
        throw new InitTimeoutError('finalize timeout');
      }
      await new Promise((r) => setTimeout(r, this.enablePollIntervalMs));
    }
  }

  private renderWorking(): unknown {
    if (!this.isWorkingStep(this.step)) return '';
    // Progress is surfaced by the progress modal and the native Safe queue on
    // this page; the init component itself renders nothing while working so no
    // redundant "tx queue" block sits at the bottom of the page. Error and
    // done states render below (the modal closes on those).
    return '';
  }

  render() {
    if (this.step === 'done') {
      // No success label in the page — once the merged batch is executed the
      // host switches to the normal live UI (modules enabled), which is the
      // completion signal.
      return '';
    }

    if (this.step === 'error') {
      return html`
        <h2>Initialization failed</h2>
        <div class="init__error">${this.error}</div>
        <div class="init__actions">
          <button class="button" @click=${this.reset}>Try again</button>
        </div>
      `;
    }

    if (this.isWorkingStep(this.step)) {
      return html` ${this.renderWorking()} `;
    }

    return html`
      <h2>New publication</h2>

      <div class="init__field">
        <label class="init__label" for="init-name">Publication name</label>
        <div class="init__name">
          <input
            id="init-name"
            class="init__input"
            .value=${this.name}
            placeholder="my-publication"
            @input=${this.onNameInput}
          />
          <span class="init__suffix">${SOUL2SOUL_ETH}</span>
        </div>
        ${this.nameError ? html`<div class="init__name-error">${this.nameError}</div>` : ''}
      </div>

      <div class="init__field">
        <label class="init__label" for="init-repo">Repository</label>
        <input
          id="init-repo"
          class="init__input init__input--full"
          .value=${this.repo}
          placeholder="https://github.com/org/site"
          @input=${this.onRepoInput}
        />
      </div>

      <div class="init__field">
        <label class="init__label" for="init-branch">Branch</label>
        <input
          id="init-branch"
          class="init__input init__input--full"
          .value=${this.branch}
          placeholder="main"
          @input=${this.onBranchInput}
        />
      </div>

      <div class="init__field">
        <label class="init__label">Authors</label>
        <div class="alias-pills">
          ${this.authors.map(
            (author) => html`
              <span class="alias-pill">
                <pet-name value=${author}></pet-name>
                <button
                  class="alias-pill__remove"
                  data-address="${author}"
                  aria-label="Remove ${author}"
                  title="Remove ${author}"
                  @click=${() => {
                    this.removeAuthor(author);
                  }}
                >
                  <ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x>
                </button>
              </span>
            `,
          )}
          <s2s-sliding-add-button
            placeholder="Author address (0x...)"
            buttonLabel="Add author"
            @s2s-sliding-add=${(e: CustomEvent<{ value: string }>) => {
              this.addAuthor(e.detail.value);
            }}
          ></s2s-sliding-add-button>
        </div>
      </div>

      <div class="init__actions">
        <s2s-button type="primary" id="init-start" @click=${() => void this.start()}
          >Create</s2s-button
        >
      </div>
    `;
  }
}
