// s2s-init.ts — "New publication" component (SPEC-hosts.md AD-3).
//
// Shown by <s2s-app> when the loaded Safe has neither the records nor the
// publication module. It drives the DIRECT-SEQUENCE init flow end-to-end
// (PR #158) using the exported building blocks of publication-init.ts (the
// pure lib, PR #147):
//
//   1. propose create-batch  (buildCreateModuleBatch)      → Safe queue
//      — SKIPPED when a scan of both factories' ModuleCreated logs finds both
//      modules for this Safe already (scanExistingModules): the factory is
//      plain CREATE, so re-proposing would deploy a duplicate pair. The scan
//      escalates once — default 10k-block window, then 250k, because the pair
//      is often days old; a failed wide scan just means "no answer". On a hit
//      it adopts the existing addresses and jumps straight to the enable+name
//      batch below (or to done when they are already enabled and the name is
//      recorded). A half-present pair is never adopted on its own — the flow
//      needs both modules, so a partial narrow hit also triggers the wide pass.
//   2. await execution, detect module addresses           (detectModuleAddresses)
//   3. propose the MERGED enable+name batch (buildFinalizeBatch) → Safe queue
//   4. await execution (modules enabled AND name recorded) → hand over
//
// Those are two proposals / two Safe executions, issued by this component.
// STEP 1 of the flow — the ENS name — precedes them (see ens-registration.ts):
// `registerSubdomain(label, safe)` on the L1 registry, proposed from the L1
// twin Safe (the registry has code on chain 1 only, and a Safe transaction is
// single-chain), then polled until the subnode's owner is this Safe. Without
// it `resolvePublicationSafe` returns 0x0 and the publication is unreachable by
// name — the modules are installed but nobody can find them.
// The flow's THIRD proposal — the config record — is host-owned: once the
// finalize batch executes the modules are live, so <s2s-app> takes over, drives
// the build + proposal through <s2s-records-tab>.updateConfig() and waits for
// it (see the step-3 section of init-session.ts). The module addresses are
// unknowable until the create batch executes (plain CREATE, non-idempotent
// factories), so a single-proposal init is impossible without a protocol
// change; the merged finalize batch is the floor for the safe-app-only flow.
//
// The component deliberately drives its own steps itself (rather than calling
// the single-shot initializePublication) so each Safe-proposal queue URL can be
// surfaced the moment it is created — a human has to open the Safe app and
// execute each proposal before the next step can run.
//
// It depends on the SafeIntegration only through a small duck-typed surface
// (proposeBatch / getProvider / fetchFactoryModuleCreatedLogs /
// readIsModuleEnabled / getRecord) so component tests can hand-roll a mock —
// the same pattern as the other tabs.
//
// # Chain guard
//
// `protocolInfo.recordsFactory` / `publicationFactory` are read from on-chain
// protocol state through the L2 provider (shared/src/protocol), i.e. they are
// Base (8453) deployments. On any other chain createModule targets an address
// with no code: the Safe tx SUCCEEDS as a no-op, nothing is deployed, no
// ModuleCreated log is emitted, and detection polls a filter that can never
// match — a live mainnet-Safe bug that looked like "modules never appear".
// Both the create and the detect step therefore check that both factories have
// code on the Safe's chain FIRST and throw a real error instead (before any
// proposal is sent, and before a pointless timeout wait).
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
// if a proposal is still pending it waits instead. When this component's part
// of the flow finishes, `complete()` clears ITS OWN session entry and only
// then dispatches s2s-init-complete; the host persists the step-3
// ('configuring') phase from that event's detail. Config-phase sessions are
// host-owned: restorePersisted() ignores them, so this element never resumes
// step 3.
//
// # Retry vs. reset
//
// An error (rejected signature, RPC failure, human-in-the-loop timeout) does
// NOT mean the flow is lost: the persisted session still records every batch
// already proposed. "Try again" therefore *retries* — it re-enters the plan
// loop with the existing session, so `planNextAction` resumes from the
// persisted phase and (for phases 'detecting' and 'awaiting-finalize') does
// not re-propose a batch that is already in the Safe queue: a second create
// batch would deploy a duplicate module pair.
//
// One failure mode is NOT covered: phase 'creating' means "a create proposal
// is being sent", and `proposalProgress('creating')` reports no proposal yet.
// If proposeBatch() throws only after the queue entry was created (timeout /
// RPC failure on the response), retrying from 'creating' proposes a second
// create batch. Resolving that needs a queue lookup (or an explicit user
// confirmation) before re-proposing, which this component does not do — the
// phase is knowingly replayed. Only "Start over" clears the session and
// returns to the blank form.
//
// `start()` additionally holds a re-entrancy flag so a double click (or a
// resume firing while a loop is already running) can never start two plan
// loops — two loops would propose the same batch twice.

import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import {
  buildCreateModuleBatch,
  buildFinalizeBatch,
  detectModuleAddresses,
  scanExistingModules,
  waitForModulesEnabled,
  type MetaTransactionData,
  type ProtocolInfo,
} from '../lib/publication-init.js';
import { ENS_L1_CHAIN_ID, ENS_REGISTRY_ADDRESS, ZERO_ADDRESS } from '../lib/domain-validation.js';
import {
  buildRegisterSubdomainCall,
  readEnsRegistration,
  subdomainLabelError,
  SOUL2SOUL_SUFFIX,
  suffixOfPublicationName,
  type EnsRegistrationState,
} from '../lib/ens-registration.js';
import {
  INIT_SESSION_KEY,
  clearInitSession,
  isConfigPhase,
  loadInitSession,
  maxPhase,
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
  /** Byte size of the code at an address on the Safe's chain (0 = no contract). */
  contractCodeSize(address: string): Promise<number>;
  /** Make getRecord / module reads work for freshly-created modules. */
  adoptModules(recordsModule?: string, publicationModule?: string): void | Promise<void>;
  /** Raw chain read (src/lib/evm). The ENS step reads the L1 registry through it. */
  evmRead(
    chainId: number,
    contractAddress: string,
    abi: any,
    method: string,
    args: any[],
    rpcs?: string[],
  ): Promise<unknown>;
}

/** publication-init's ProtocolInfo plus the L1 ENS registry the flow's step 1
 *  targets. The property keeps accepting a plain ProtocolInfo (the registry then
 *  falls back to the shared ENS_REGISTRY_ADDRESS). */
type InitProtocolInfo = ProtocolInfo & { ensRegistry?: string };

/** How long to keep polling for the create-batch execution (human-in-the-loop). */
const DEFAULT_DETECTION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LOOKBACK_BLOCKS = 10_000;
/**
 * Second, wider window for the pre-create module scan. Iterating users hit
 * "the modules already exist" days after they were deployed — far outside the
 * default ~14h (5s blocks) window — so the scan escalates once instead of
 * re-proposing a duplicate create batch. Not used for post-create detection
 * (those logs are seconds old).
 */
const WIDE_SCAN_LOOKBACK_BLOCKS = 250_000;

/** How long to wait for the enable batch to be executed in the Safe app. */
const DEFAULT_ENABLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ENABLE_POLL_INTERVAL_MS = 2_000;

/** How long to wait for the L1 ENS registration to be executed (step 1). */
const DEFAULT_ENS_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ENS_POLL_INTERVAL_MS = 5_000;

/** Suffix appended to the publication name (displayed and recorded). */
const SOUL2SOUL_ETH = `.${SOUL2SOUL_SUFFIX}`;

/** Starter template the config build pulls from (prefilled, overridable). */
const DEFAULT_REPO = 'https://github.com/Joera/website-starter';
const DEFAULT_BRANCH = 'main';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const WORKING_STEPS = [
  'ens',
  'awaiting-ens',
  'creating',
  'detecting',
  'finalizing',
  'awaiting-finalize',
] as const;

type Step = 'idle' | (typeof WORKING_STEPS)[number] | 'done' | 'error';

/** Payload of the `s2s-init-complete` event.
 *
 * Carries the whole identity of the finished flow so the host can persist the
 * next phase ('configuring') from the event alone: the component clears its
 * own session before dispatching, so by handler time the storage entry is
 * already gone. `name` is the FULL publication name (with the
 * .soul2soul.eth suffix), as it has always been for this event.
 */
interface InitCompleteDetail {
  recordsModule?: string;
  publicationModule?: string;
  name?: string;
  repo?: string;
  branch?: string;
  authors?: string[];
  proposals?: string[];
}

/** Sentinel thrown when a human-in-the-loop wait timed out (fail() already ran). */
class InitTimeoutError extends Error {}

@customElement('s2s-publication-init')
export class S2SPublicationInit extends LitElement {
  /** Duck-typed SafeIntegration (see InitSafeIntegration). */
  @property({ attribute: false }) safeIntegration?: InitSafeIntegration;

  /** Deployed factory addresses (recordsFactory + publicationFactory) + the L1
   *  ENS registry step 1 reads and proposes against. */
  @property({ attribute: false }) protocolInfo?: InitProtocolInfo;

  /** How long to poll for the create batch's ModuleCreated logs. */
  @property({ type: Number }) detectionTimeoutMs = DEFAULT_DETECTION_TIMEOUT_MS;
  /** Poll interval while waiting for the create batch's ModuleCreated logs. */
  @property({ type: Number }) detectionPollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

  /** How long to wait for the enable batch to be executed in the Safe app. */
  @property({ type: Number }) enableTimeoutMs = DEFAULT_ENABLE_TIMEOUT_MS;
  /** Poll interval while waiting for the enable batch to be executed. */
  @property({ type: Number }) enablePollIntervalMs = DEFAULT_ENABLE_POLL_INTERVAL_MS;

  /** How long to wait for the L1 ENS registration to be executed. */
  @property({ type: Number }) ensTimeoutMs = DEFAULT_ENS_TIMEOUT_MS;
  /** Poll interval while waiting for the L1 ENS registration. */
  @property({ type: Number }) ensPollIntervalMs = DEFAULT_ENS_POLL_INTERVAL_MS;

  /** The current Safe (safeAddress / chainId / owners). */
  @property({ attribute: false }) safeInfo?: SafeInfo;

  /**
   * Where the flow's state is persisted between page loads (injected so unit
   * tests can pass a fake; defaults to the real localStorage).
   *
   * NOTE: INIT_SESSION_KEY is a single global key, shared by every Safe — two
   * tabs (two Safes) are last-writer-wins, so clearing here clears for all.
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
  /**
   * The L1 `registerSubdomain(label, owner)` call the human has to execute from
   * the twin Safe on chain 1 (the registry has no code on Base, so this is never
   * batched with the module txs). Surfaced to the host's progress modal via the
   * `s2s-init-progress` detail; cleared once the subnode resolves to this Safe.
   */
  @state() private ensCall?: { to: string; data: string };

  /** The persisted flow session (null when no flow is in progress). */
  private session: InitSession | null = null;
  /** The ENS state the current plan() iteration read (avoids a duplicate L1 read). */
  private ensState: EnsRegistrationState | null = null;
  /** Guards against auto-resuming more than once per component lifetime. */
  private resumed = false;
  /**
   * Re-entrancy guard: true while a plan loop is running. A second start()
   * (double click, double mount, resume racing a click) is a no-op — two
   * loops would propose the same batch twice.
   */
  private running = false;

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
    if (!changed.has('safeIntegration') && !changed.has('protocolInfo') && !changed.has('safeInfo'))
      return;

    // The Safe may only resolve after connect (the host mounts this element
    // as soon as it has a Safe, and keeps it mounted when the modules are
    // already installed), so a session that could not be matched at connect
    // time gets another chance once safeInfo arrives. Restoring writes
    // reactive state, so defer it out of this update cycle (writing state in
    // updated() schedules an extra update).
    if (changed.has('safeInfo') && !this.session && !this.resumed) {
      queueMicrotask(() => {
        if (this.session || this.resumed) return;
        // Only restore onto an untouched form: a late-safeInfo restore must
        // never overwrite values the user has already typed (name is empty
        // when untouched; repo/branch are prefilled with the defaults).
        if (
          this.step !== 'idle' ||
          this.name !== '' ||
          this.repo !== DEFAULT_REPO ||
          this.branch !== DEFAULT_BRANCH
        ) {
          return;
        }
        this.restorePersisted();
        this.maybeResume();
      });
    }

    this.maybeResume();
  }

  private get safeAddress(): string {
    return this.safeInfo?.safeAddress ?? '';
  }

  private isWorkingStep(step: string): step is (typeof WORKING_STEPS)[number] {
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

  /**
   * "Start over": drop the persisted session and return to the blank form.
   * This is the only action that clears the session, so it is also the only
   * way to end up with a second create batch for the same Safe.
   */
  private readonly cancel = (): void => {
    if (this.running) return; // a loop is still unwinding; it owns the state
    clearInitSession(this.storage, INIT_SESSION_KEY);
    this.session = null;
    this.resumed = false;
    this.step = 'idle';
    this.error = '';
    this.name = '';
    this.nameError = '';
    this.proposals = [];
    this.ensCall = undefined;
    this.ensState = null;
    this.dispatchProgress();
  };

  /**
   * "Try again": keep the persisted session and re-enter the plan loop.
   * `planNextAction` reads the session phase + on-chain state, so a rejected
   * signature or a timeout resumes exactly where the flow stopped instead of
   * starting a fresh flow (which would propose a duplicate create batch).
   */
  private readonly retry = (): void => {
    if (this.running) return; // a loop is still unwinding; it owns the state
    this.error = '';
    if (!this.session) {
      // The session may exist in storage but never have been restored (e.g.
      // the failure was "no Safe yet" and safeInfo arrived afterwards): give
      // the restore one chance first. Otherwise drop any stale session so a
      // fresh "Create" cannot silently overwrite an unread half-finished one.
      this.restorePersisted();
      if (!this.session) {
        clearInitSession(this.storage, INIT_SESSION_KEY);
        this.step = 'idle';
        this.dispatchProgress();
        return;
      }
    }
    // Leave the error view immediately; runAction() re-derives the step from
    // the planned action. A waiting phase keeps its own step (it is what the
    // modal's step markers should show until the plan re-runs) — 'creating' is
    // only the fallback for a phase that has no working step of its own.
    const phase = this.session.phase;
    this.step = phase === 'done' ? 'idle' : this.isWorkingStep(phase) ? phase : 'creating';
    this.dispatchProgress();
    void this.start();
  };

  private fail(message: string): void {
    this.error = message;
    this.step = 'error';
    this.dispatchProgress();
  }

  /** Persist the current session with a new phase (and optional field updates).
   *
   * The phase is MONOTONIC (`maxPhase`): step 1 can re-enter from a later phase
   * (the name was released/transferred on L1 mid-flow), and writing
   * 'awaiting-ens' over 'detecting' would erase "the create batch is queued" —
   * the next plan would then propose a second, non-idempotent create batch. */
  private persist(phase: InitPhase, extra: Partial<InitSession> = {}): void {
    if (!this.session) return;
    const next = maxPhase(this.session.phase, phase);
    this.session = { ...this.session, ...extra, phase: next, updatedAt: Date.now() };
    saveInitSession(this.storage, INIT_SESSION_KEY, this.session);
  }

  /** Broadcast the current step so the host can keep its progress modal in sync. */
  private dispatchProgress(): void {
    this.dispatchEvent(
      new CustomEvent('s2s-init-progress', {
        detail: {
          step: this.step,
          phase: this.displayPhase,
          proposals: this.proposals,
          name: this.session?.publicationName ?? this.name,
          ensCall: this.ensCall,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * The phase the progress modal should render its step markers from.
   *
   * Normally the persisted phase — but step 1 renders as step 1 while its L1
   * transaction is pending, even when the session has already reached a later
   * phase. The two differ on purpose: the session's phase is monotonic (a
   * re-entered step 1 must not forget a queued create batch — see persist),
   * while the modal has to say what the human is actually waiting for.
   */
  private get displayPhase(): InitPhase {
    if (this.step === 'ens' || this.step === 'awaiting-ens') return this.step;
    return this.session?.phase ?? 'creating';
  }

  /** Signal successful completion to the host (used by both fresh + resumed flows).
   *
   * Ownership: this component only owns ITS OWN session. Capture the identity,
   * clear the session (and null our copy) BEFORE dispatching, then let the host
   * persist the 'configuring' phase from the event detail. The host's handler
   * runs `persistInitPhase('configuring', …)` synchronously at its top, so a
   * clear after the dispatch would delete the session the host just wrote —
   * and clearing first is safe only because the detail carries every field the
   * host needs (it must not merge `prev` from storage).
   */
  private complete(): void {
    this.step = 'done';
    const session = this.session;
    console.log(`[init] COMPLETE - flow finished. session=${session ? session.phase : 'null'}`);
    const detail: InitCompleteDetail = {
      recordsModule: session?.recordsModule,
      publicationModule: session?.publicationModule,
      proposals: session?.proposals ?? this.proposals,
      // Full publication name (with the .soul2soul.eth suffix) — unchanged
      // key/meaning, the host's existing destructuring keeps working.
      name: session?.publicationName,
      repo: session?.repo,
      branch: session?.branch,
      authors: session?.authors,
    };

    this.session = null;
    clearInitSession(this.storage, INIT_SESSION_KEY);

    this.dispatchEvent(
      new CustomEvent<InitCompleteDetail>('s2s-init-complete', {
        detail,
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

  /**
   * Entry point for every path into the flow (form button, retry, resume).
   * Guarded so only one plan loop can run at a time; the loop itself lives in
   * runFlow().
   */
  private async start(): Promise<void> {
    if (this.running) {
      console.log('[init] start() ignored — a plan loop is already running');
      return;
    }
    this.running = true;
    try {
      await this.runFlow();
    } finally {
      this.running = false;
    }
  }

  private async runFlow(): Promise<void> {
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
      // Validated here as well as in `buildRegisterSubdomainCall`: the registry
      // reverts outside this alphabet, and a reverting L1 Safe tx costs real
      // gas. Failing on the form is the only place the user can still fix it.
      const labelError = subdomainLabelError(label);
      if (labelError) {
        this.nameError = labelError;
        return;
      }
      this.error = '';
      this.proposals = [];
      this.ensCall = undefined;
      this.ensState = null;
      this.session = {
        version: 3,
        chainId: this.safeInfo?.chainId ?? 0,
        safeAddress,
        phase: 'ens',
        name: label,
        publicationName: `${label}${SOUL2SOUL_ETH}`,
        repo: this.repo.trim() || DEFAULT_REPO,
        branch: this.branch.trim() || DEFAULT_BRANCH,
        authors: [...this.authors],
        proposals: [],
        updatedAt: Date.now(),
      };
      this.persist('ens');
    } else {
      this.error = '';
    }

    try {
      for (;;) {
        // The session can disappear mid-loop (defensive: cancel()/retry() are
        // guarded by `running`, so today only a host-driven clear can do it).
        // End in a VISIBLE state — a working step renders nothing, so a silent
        // return would leave the user on a blank page with no actions.
        if (!this.session) {
          this.fail('The initialization session was cleared elsewhere — reload to continue.');
          return;
        }
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
    info: InitProtocolInfo,
    _safeAddress: string,
  ): Promise<ResumeAction> {
    const session = this.session;
    if (!session) return { type: 'ens' };

    // Step 1: the ENS subnode. Read ONCE per flow: as soon as the subnode is
    // seen owned by this Safe, `ensResolved` is persisted, and from then on no
    // plan iteration touches L1 — steps 2–4 have nothing to do with ENS, so an
    // L1 RPC outage must not stop a create/detect/finalize run (or a resumed
    // one: the phase passed step 1 only because it resolved).
    let ens = this.ensState;
    let ensResolved = session.ensResolved === true;
    if (!ensResolved) {
      const step1Proposed = session.ensProposed === true || session.phase === 'awaiting-ens';
      try {
        ens = await this.readEns(si, info, session);
        this.ensState = ens;
        ensResolved = ens.ownedBySafe;
        if (ensResolved) this.persistEnsResolved();
      } catch (e) {
        // A step-1 read that fails AFTER the L1 tx was proposed is "not
        // answered yet", not a dead flow: the `await-ens` action re-reads it
        // and the poll already treats a failed read as "keep waiting". Failing
        // here would kill the wait on a single rate-limited RPC response.
        if (!step1Proposed) throw e;
        console.log(
          `[init] plan: ENS read failed (${e instanceof Error ? e.message : String(e)}), waiting anyway`,
        );
      }
    }
    const ensDetail = ens
      ? `${ens.name} owner=${ens.owner}`
      : `${session.publicationName} (verified earlier)`;

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
      ensResolved,
      recordsKnown,
      publicationKnown,
      recordsEnabled,
      publicationEnabled,
      nameRecorded,
    });
    console.log(
      `[init] plan checks { ens:${String(ensResolved)} (${ensDetail}), known:${String(recordsKnown)}/${String(publicationKnown)}, enabled:${String(recordsEnabled)}/${String(publicationEnabled)}, nameRecorded:${String(nameRecorded)} } -> ${action.type}`,
    );
    return action;
  }

  /** Record that step 1 is verified done (the subnode resolves to this Safe). */
  private persistEnsResolved(): void {
    const phase = this.session?.phase;
    if (!phase) return;
    this.persist(phase, { ensResolved: true });
  }

  /** Execute one planned action; returns true when the flow is finished. */
  private async runAction(
    action: ResumeAction,
    si: InitSafeIntegration,
    info: InitProtocolInfo,
    safeAddress: string,
  ): Promise<boolean> {
    const session = this.session;
    // No session: there is nothing left to drive, so tell the loop to stop
    // (returning false would make it re-plan forever against a null session).
    if (!session) return true;

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
      case 'ens': {
        this.step = 'ens';
        this.dispatchProgress();

        const state = this.ensState ?? (await this.readEns(si, info, session));
        this.ensState = state;
        console.log(
          `[init] ens: ${state.name} registered=${String(state.registered)} owner=${state.owner} registry=${state.registry} wrapped=${String(state.parentWrapped)}`,
        );

        // Already registered to this Safe (an earlier run, or a registration
        // that executed since the last poll): step 1 is done, go to the modules.
        if (state.ownedBySafe) {
          console.log(`[init] ens: ${state.name} already owned by this Safe`);
          this.ensCall = undefined;
          // `persist` is monotonic: when the session already sits at a later
          // phase (a name released on L1 after the create batch went out) the
          // phase is kept — downgrading it would forget that batch.
          this.persist('creating', { ensResolved: true });
          this.step = 'creating';
          this.dispatchProgress();
          return false;
        }

        // Desynced (registry says taken, no owner) or owned by somebody else:
        // neither is auto-retried — a human has to look at chain 1.
        this.assertEnsClaimable(state);

        // The registration is permissionless while the parent is wrapped, but
        // the registry has code on ETH L1 ONLY: it must be its own Safe tx from
        // the L1 twin Safe, never batched with the Base module txs.
        const call = buildRegisterSubdomainCall(state.registry, session.name, safeAddress);
        this.ensCall = { to: call.to, data: call.data };
        const chainId = this.safeInfo?.chainId ?? session.chainId;
        if (chainId === ENS_L1_CHAIN_ID) {
          // "Start over" / a host-side clear can land while the L1 read above is
          // in flight (four RPC round trips): without a session nothing records
          // this tx, so the human's only trace of it would be the Safe queue.
          // Never propose into a flow that no longer exists.
          if (!this.session) {
            console.log('[init] ens: session cleared before proposeBatch -> not proposing');
            this.step = 'idle';
            this.ensCall = undefined;
            this.dispatchProgress();
            return true;
          }
          const url = await si.proposeBatch([call]);
          // Append: the array may already hold a create/finalize URL from an
          // earlier step of this session (a re-entered step 1 must not erase
          // the queue links the user is following).
          this.proposals = [...this.proposals, url];
          this.persist('awaiting-ens', { proposals: this.proposals, ensProposed: true });
          // The tx is IN the Safe queue now, so the manual to/data is redundant
          // — and the modal's "execute this from the L1 Safe" block would sit
          // next to the very proposal it duplicates.
          this.ensCall = undefined;
          console.log(
            `[init] ens: proposed registerSubdomain(${session.name}, ${safeAddress}) on chain ${chainId} -> ${url}`,
          );
        } else {
          // Not on L1: never propose (the registry is not deployed here). The
          // call is surfaced so the human can register the name from the L1
          // twin Safe; the poll below picks the subnode up once they do.
          this.persist('awaiting-ens', { ensProposed: true });
          console.log(
            `[init] ens: ${state.name} needs registration on chain 1 — not proposing from chain ${chainId}`,
          );
        }
        this.step = 'awaiting-ens';
        this.dispatchProgress();
        return false;
      }

      case 'await-ens': {
        this.step = 'awaiting-ens';
        // A resumed session has no in-memory state: read once so the fatal
        // states are caught immediately and the call can be rebuilt. A failed
        // read is NOT fatal here — the poll below retries it and treats a
        // failed read as "not answered yet".
        let state = this.ensState;
        if (!state) {
          try {
            state = await this.readEns(si, info, session);
            this.ensState = state;
          } catch (e) {
            console.log(
              `[init] await-ens: initial read failed (${e instanceof Error ? e.message : String(e)}), polling anyway`,
            );
          }
        }
        if (state) {
          // Same fatal states as 'ens' — a resumed poll must not sit out the whole
          // timeout on a name this Safe can never own.
          if (!state.ownedBySafe) this.assertEnsClaimable(state);
          // A resumed session has no in-memory call, so it may have to be
          // rebuilt for the human to execute on chain 1. Only when THIS Safe
          // cannot propose it: a chain-1 Safe with `ensProposed` already has the
          // tx in its queue (URL and all), and re-showing the to/data would
          // invite a second, identical registration.
          const chainId = this.safeInfo?.chainId ?? session.chainId;
          const cannotPropose = chainId !== ENS_L1_CHAIN_ID || session.ensProposed !== true;
          if (cannotPropose && !this.ensCall && (state.needsRegistration || state.desynced)) {
            const call = buildRegisterSubdomainCall(state.registry, session.name, safeAddress);
            this.ensCall = { to: call.to, data: call.data };
          }
        }
        this.dispatchProgress();
        await this.waitForEnsRegistration(si, info, session);
        this.ensCall = undefined;
        // Verified: the subnode resolves to this Safe. Persist it so no later
        // step (this run or after a reload) needs L1 again.
        this.persistEnsResolved();
        this.dispatchProgress();
        return false;
      }

      case 'create': {
        this.step = 'creating';
        // Enter the transient phase in the SESSION too, not just in the view: a
        // resumed flow still carries the previous phase ('ens' when the name was
        // already owned), and a proposeBatch that throws mid-create must leave
        // the record saying "no create batch was sent" rather than pointing at
        // the step it already passed.
        this.persist('creating');
        this.dispatchProgress();

        // The module factories are plain CREATE (non-idempotent), so proposing
        // the create batch for a Safe that ALREADY has the pair deploys a
        // duplicate — the modules the user has been building on get replaced by
        // two new empty ones. That state is normal while iterating (an earlier
        // run created them, the session was lost), so look before proposing.
        const scanDeps = {
          fetchModuleCreatedLogs: (
            factoryAddress: string,
            safe: string,
            topic0: string,
            fromBlock: number,
          ) => si.fetchFactoryModuleCreatedLogs(factoryAddress, safe, topic0, fromBlock),
          safeAddress,
          recordsFactory: info.recordsFactory,
          publicationFactory: info.publicationFactory,
          getBlockNumber: () => si.getProvider().getBlockNumber(),
        };
        const scanAt = (lookbackBlocks: number) =>
          scanExistingModules(scanDeps, { lookbackBlocks });
        const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

        let existing: { recordsModule?: string; publicationModule?: string } = {};
        let narrowScanFailed = false;
        try {
          existing = await scanAt(DEFAULT_LOOKBACK_BLOCKS);
        } catch (err) {
          // A failed scan must never block the flow: without an answer we are
          // back to the pre-scan behaviour (propose the create batch). No
          // widening either — an RPC that just failed will fail again.
          narrowScanFailed = true;
          console.log(
            `[init] create: module scan failed (${reason(err)}), proposing the create batch`,
          );
        }

        if (!narrowScanFailed && !(existing.recordsModule && existing.publicationModule)) {
          // A pair deployed a while ago is invisible to the default window
          // (10k blocks ≈ 14h on a 5s chain) — "I created them earlier" is the
          // normal iterating state, so escalate once before re-creating. This
          // also covers a partial narrow hit: the missing module may predate
          // the window. Prefer the narrow value per module, fill gaps from the
          // wide pass.
          console.log(
            `[init] create: no complete pair in the last ${DEFAULT_LOOKBACK_BLOCKS} blocks, widening the scan to 250k`,
          );
          try {
            const wide = await scanAt(WIDE_SCAN_LOOKBACK_BLOCKS);
            existing = {
              recordsModule: existing.recordsModule ?? wide.recordsModule,
              publicationModule: existing.publicationModule ?? wide.publicationModule,
            };
          } catch (err) {
            // Public RPCs commonly cap getLogs ranges; a failed wide scan is
            // just "no answer", never a reason to stop the flow.
            console.log(`[init] create: wide scan failed (${reason(err)})`);
          }
        }

        // The factories are read from on-chain protocol state through the Base
        // provider (shared/src/protocol), i.e. they are Base (8453)
        // deployments. On any other chain the create batch is a call to an
        // address with no code: the Safe tx SUCCEEDS as a no-op, nothing is
        // deployed, no ModuleCreated log is ever emitted and detection polls a
        // filter that can never match. Refuse to propose that no-op tx — and
        // do it before the fields are used by the finalize batch below too.
        await this.assertFactoriesHaveCode(
          si,
          info,
          this.safeInfo?.chainId ?? session.chainId,
          'create',
        );

        if (existing.recordsModule && existing.publicationModule) {
          console.log(
            `[init] create: modules already exist for this Safe, skipping the create batch (records=${existing.recordsModule} publication=${existing.publicationModule})`,
          );
          await si.adoptModules(existing.recordsModule, existing.publicationModule);
          this.persist('finalizing', {
            recordsModule: existing.recordsModule,
            publicationModule: existing.publicationModule,
          });
          // The loop re-plans from 'finalizing': straight to the enable+name
          // batch, or straight to done when the pair is already live.
          return false;
        }

        console.log(
          `[init] create: no complete module pair found (records=${existing.recordsModule ?? 'none'} publication=${existing.publicationModule ?? 'none'}), proposing the create batch`,
        );
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
        const chainId = this.safeInfo?.chainId ?? session.chainId;

        // Same chain check as create, run ONCE before the polling loop (never
        // per poll): when a factory has no code here the create batch was a
        // no-op and no ModuleCreated log can ever appear, so polling would
        // just hang for the whole timeout. Fail now, with the actionable
        // message instead.
        await this.assertFactoriesHaveCode(si, info, chainId, 'detect');

        // Last observed poll, carried into the timeout message: "polls until
        // it gives up" is far easier to diagnose when the error names the
        // chain, the factories, the block window and the log counts.
        const lastPoll = { block: 0, fromBlock: 0, counts: new Map<string, number>() };
        const detectDeps = {
          fetchModuleCreatedLogs: async (
            factoryAddress: string,
            safe: string,
            topic0: string,
            fromBlock: number,
          ) => {
            const logs = await si.fetchFactoryModuleCreatedLogs(
              factoryAddress,
              safe,
              topic0,
              fromBlock,
            );
            lastPoll.fromBlock = fromBlock;
            lastPoll.counts.set(factoryAddress.toLowerCase(), logs.length);
            return logs;
          },
          safeAddress,
          recordsFactory: info.recordsFactory,
          publicationFactory: info.publicationFactory,
          getBlockNumber: async () => {
            const block = await si.getProvider().getBlockNumber();
            lastPoll.block = block;
            return block;
          },
        };

        let detected: { recordsModule: string; publicationModule: string };
        try {
          detected = await detectModuleAddresses(detectDeps, {
            timeoutMs: this.detectionTimeoutMs,
            pollIntervalMs: this.detectionPollIntervalMs,
            lookbackBlocks: DEFAULT_LOOKBACK_BLOCKS,
          });
        } catch (e) {
          throw this.describeDetectFailure(e, {
            chainId,
            recordsFactory: info.recordsFactory,
            publicationFactory: info.publicationFactory,
            block: lastPoll.block,
            fromBlock: lastPoll.fromBlock,
            counts: lastPoll.counts,
          });
        }

        const { recordsModule, publicationModule } = detected;
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
        // Everything is on-chain — the flow is finished. complete() captures the
        // session identity, clears THIS component's own session entry and only
        // then dispatches s2s-init-complete.
        //
        // Contract with the host (s2s-app.onInitComplete): it persists the
        // 'configuring' phase from the event detail — it must NOT read the
        // session from storage, which is already gone at handler time, and it
        // must not merge a stored `prev`. Do not reverse this order: a clear
        // after the dispatch would delete the phase the host just persisted,
        // and clearing before the dispatch is only safe because the detail is
        // complete.
        this.complete();
        return true;
      }
    }
  }

  /** The L1 registry the ENS step reads and proposes against. */
  private ensRegistry(info: InitProtocolInfo): string {
    return info.ensRegistry || ENS_REGISTRY_ADDRESS;
  }

  /**
   * Read the publication's ENS registration state from L1 (step 1).
   *
   * Every read goes through the injected `si.evmRead` on chain 1, so nothing
   * here touches a real RPC in tests — the same injection seam as
   * ens-registration.ts itself. The display suffix comes from the session's own
   * publication name, so a registry with a different parent is not labelled
   * `.soul2soul.eth`.
   */
  private readEns(
    si: InitSafeIntegration,
    info: InitProtocolInfo,
    session: InitSession,
  ): Promise<EnsRegistrationState> {
    return readEnsRegistration(
      {
        evmRead: (chainId, contractAddress, abi, method, args) =>
          si.evmRead(chainId, contractAddress, abi, method, args),
      },
      {
        registry: this.ensRegistry(info),
        label: session.name,
        safeAddress: this.safeAddress || session.safeAddress,
        suffix: suffixOfPublicationName(session.publicationName, session.name) || undefined,
      },
    );
  }

  /**
   * Throw the actionable error for a name this Safe cannot claim.
   *
   * Desynced (the registry flags the label as registered but the subnode has no
   * owner) is a half-written on-chain state: only a human on chain 1 can fix it,
   * and re-proposing `registerSubdomain` would not. A third-party owner is a
   * hard stop — the name is simply taken. Neither is auto-retried.
   */
  private assertEnsClaimable(state: EnsRegistrationState): void {
    if (state.desynced) {
      throw new Error(
        `The ENS registry reports ${state.name} as taken but the name has no owner — this half-written state needs fixing on chain 1 before the flow can continue.`,
      );
    }
    if (state.owner !== ZERO_ADDRESS) {
      throw new Error(
        `${state.name} is already owned by ${state.owner}, not this Safe — the publication cannot use this name.`,
      );
    }
  }

  /**
   * Poll L1 until the subnode's owner is this Safe (the human executes the
   * registration from the twin Safe). Timeout fails with the exact command to
   * run: the registry is permissionless while the parent is wrapped, so a
   * manual registration is always a viable escape hatch.
   *
   * A FAILED read is not a flow failure: public L1 RPCs rate-limit (429), time
   * out, or briefly disagree, and none of that means the registration the human
   * is executing did not land. Treat it as "not answered yet" and keep polling
   * until the timeout.
   */
  private async waitForEnsRegistration(
    si: InitSafeIntegration,
    info: InitProtocolInfo,
    session: InitSession,
  ): Promise<void> {
    const start = Date.now();
    const registry = this.ensRegistry(info);
    const label = session.name;
    const safeAddress = this.safeAddress || session.safeAddress;
    for (;;) {
      let state: EnsRegistrationState | null = null;
      try {
        state = await this.readEns(si, info, session);
      } catch (e) {
        console.log(
          `[init] ens poll failed (${e instanceof Error ? e.message : String(e)}), retrying until the timeout`,
        );
      }
      if (state) {
        this.ensState = state;
        console.log(`[init] ens poll owner=${state.owner} registered=${String(state.registered)}`);
        if (state.ownedBySafe) return;
        // A state that turned fatal DURING the wait (desynced, or somebody else
        // registered the label) fails now with the actionable message instead
        // of burning the whole timeout on a registration this Safe can never
        // land.
        if (!state.needsRegistration) this.assertEnsClaimable(state);
      }
      if (Date.now() - start > this.ensTimeoutMs) {
        const name = session.publicationName || `${label}${SOUL2SOUL_ETH}`;
        const message =
          `Timed out waiting for ${name} to resolve to this Safe. Register it from the ` +
          `L1 Safe (${safeAddress}) on chain 1: ` +
          `${registry}.registerSubdomain("${label}", "${safeAddress}").`;
        this.fail(message);
        throw new InitTimeoutError(message);
      }
      await new Promise((r) => setTimeout(r, this.ensPollIntervalMs));
    }
  }

  /**
   * Refuse to use the module factories on a chain where they do not exist.
   *
   * `protocolInfo.recordsFactory` / `publicationFactory` come from on-chain
   * protocol state read through the L2 provider (shared/src/protocol
   * getProtocolInfo), i.e. they are Base (8453) deployments. On any other chain
   * a createModule call to them hits an address with no code: the Safe tx
   * SUCCEEDS as a no-op, no module is deployed, no ModuleCreated log is emitted
   * — and the flow used to poll a filter that could never match for ten
   * minutes. Throwing here (before any proposeBatch) is the guard.
   *
   * `phase` is only used for the log line, so a create run and a detect run are
   * distinguishable in the console.
   */
  private async assertFactoriesHaveCode(
    si: InitSafeIntegration,
    info: ProtocolInfo,
    chainId: number,
    phase: 'create' | 'detect',
  ): Promise<void> {
    const [recordsBytes, publicationBytes] = await Promise.all([
      si.contractCodeSize(info.recordsFactory),
      si.contractCodeSize(info.publicationFactory),
    ]);
    console.log(
      `[init] ${phase}: factory code records=${recordsBytes} publication=${publicationBytes} chain=${chainId}`,
    );

    const missing =
      recordsBytes === 0
        ? info.recordsFactory
        : publicationBytes === 0
          ? info.publicationFactory
          : '';
    if (!missing) return;

    throw new Error(
      `The S2S module factories have no code on this Safe's chain (${chainId}): ${missing}. They are deployed on Base (8453) — this Safe must be on chain 8453 for the publication init to work.`,
    );
  }

  /**
   * Append the polling context to a detection timeout.
   *
   * The message itself is built by detectModuleAddresses (publication-init, a
   * pure lib this component must not own), so the diagnostics are appended at
   * the call site: the original prefix is preserved verbatim, and only real
   * detection timeouts are rewritten — any other failure propagates untouched.
   */
  private describeDetectFailure(
    error: unknown,
    ctx: {
      chainId: number;
      recordsFactory: string;
      publicationFactory: string;
      block: number;
      fromBlock: number;
      counts: Map<string, number>;
    },
  ): unknown {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('Timed out after ') || !message.includes('module deployment logs')) {
      return error;
    }
    const count = (factory: string) => ctx.counts.get(factory.toLowerCase()) ?? 0;
    const detail =
      `(chain ${ctx.chainId}, factories ${ctx.recordsFactory}/${ctx.publicationFactory}, ` +
      `blocks ${ctx.fromBlock}-${ctx.block}, ` +
      `last poll: ${count(ctx.recordsFactory)}/${count(ctx.publicationFactory)} logs)`;
    return new Error(`${message} ${detail}`);
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
          <s2s-button type="primary" id="init-retry" @click=${this.retry}>Try again</s2s-button>
          <s2s-button type="secondary" id="init-start-over" @click=${this.cancel}
            >Start over</s2s-button
          >
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
