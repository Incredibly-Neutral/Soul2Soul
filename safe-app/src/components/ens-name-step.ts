// safe-app/src/components/ens-name-step.ts
//
// <s2s-ens-step> — the standalone ENS registration card for a LIVE publication.
//
// The creation flow's step 1 only runs while a publication is being created.
// A publication that already lives on Base (modules + name record) never runs
// it, so its `polyphony.soul2soul.eth` subnode can remain unregistered forever.
// This is the small, dismissible card that finishes that job:
//
//   - on chain 1 it proposes `registerSubdomain` through the Safe integration;
//   - on any other chain it opens the same Safe + this app on mainnet (the
//     Safe Apps SDK cannot switch the host Safe's network);
//   - it always shows the exact `to`/`data` with copy buttons as a fallback;
//   - it polls L1 and removes itself once the subnode reads back as this Safe.
//
// It is NOT a modal and it does not own the page: <s2s-app> renders it next to
// the normal UI, skips it while an init/config flow owns the modal, and feeds
// it the one registration read it performs per Safe per page load. Read errors
// (including 429s) leave the card hidden — an unrequested prompt must never
// hijack the page.
//
// Controlled-ish: `state`/`safeInfo` are inputs, but the card owns the proposal
// round-trip (busy + persisted one-proposal flag + poll). It emits:
//   s2s-ens-done    — the subnode now reads back as this Safe (card hides)
//   s2s-ens-dismiss — the user closed the card for this page load

import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './s2s-button.js';
import { buttonStyles } from '@/styles/button-styles.js';
import {
  readEnsRegistration,
  suffixOfPublicationName,
  type EnsRegistrationState,
} from '../lib/ens-registration.js';
import { ENS_L1_CHAIN_ID, type EvmReadFn } from '../lib/domain-validation.js';
import {
  clearEnsProposal,
  ensStepView,
  hasEnsProposal,
  markEnsProposal,
  pollBackoffMs,
  safeAppUrl,
  type EnsStepStorage,
  type EnsStepView,
} from '../lib/ens-step.js';

/** The Safe-side surface this card needs. Structural so tests can inject a fake
 *  and the host can pass its SafeIntegration unchanged. */
export interface EnsStepSafeIntegration {
  proposeBatch(txs: Array<{ to: string; value: string; data: string }>): Promise<string>;
  evmRead: EvmReadFn;
  /** Byte size of the code at `address`; `chainId` defaults to the Safe's chain. */
  contractCodeSize(address: string, chainId?: number): Promise<number>;
}

@customElement('s2s-ens-step')
export class S2SEnsStep extends LitElement {
  /** The L1 registration read the host performed once for this Safe. */
  @property({ attribute: false }) state: EnsRegistrationState | null = null;
  /** The CURRENT page's Safe (host chain, not the publication's chain). */
  @property({ attribute: false }) safeInfo: { chainId: number; safeAddress: string } | null = null;
  /** Safe integration used to propose on chain 1 and to poll L1. */
  @property({ attribute: false }) safeIntegration: EnsStepSafeIntegration | null = null;
  /** This app's own URL, for the Safe-on-mainnet deep link. */
  @property() appUrl = '';
  /** Storage for the one-proposal-per-Safe flag; defaults to localStorage. */
  @property({ attribute: false }) storage: EnsStepStorage | null = null;
  /** How often to re-read the L1 subnode owner while waiting. */
  @property({ type: Number }) pollIntervalMs = 5_000;
  /** How long to keep polling before reporting "still pending". */
  @property({ type: Number }) pollTimeoutMs = 10 * 60_000;

  @state() private proposed = false;
  @state() private dismissed = false;
  @state() private busy = false;
  @state() private error = '';
  /** The poll deadline elapsed; offer an explicit re-proposal. */
  @state() private timedOut = false;
  /** Queue URL returned by the SDK, when a proposal just went out. */
  @state() private queueUrl = '';
  /** The first click on "Propose again" only warns about a possible duplicate. */
  @state() private retryArmed = false;
  /** null = unknown (do not hide on a failed check); false = no L1 Safe. */
  @state() private l1SafeHasCode: boolean | null = null;

  private pollTimer: number | null = null;
  private pollActive = false;
  private pollDeadline = 0;
  private pollFailures = 0;
  /** Invalidates an in-flight L1 read when the poll is stopped. */
  private pollRunId = 0;
  private doneDispatched = false;
  private proposalChecked = false;
  /** Scope whose persisted marker `proposed` currently mirrors. */
  private proposalScopeKey = '';
  private l1SafeCheckedFor = '';
  private l1SafeCheckPending = false;

  static styles = [
    buttonStyles,
    css`
      :host {
        display: block;
      }

      .card {
        margin: 0 0 1.25rem;
        padding: 1rem 1.1rem;
        background: var(--gray-800, #2e2925);
        border: 1px solid var(--gray-600, #5f564b);
        border-radius: 10px;
        color: var(--gray-50, #f5f1e8);
      }

      .head {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.6rem;
      }

      .eyebrow {
        flex: 1;
        font-family: var(--font-mono);
        font-size: 0.72rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--gray-400, #8f8474);
      }

      .dismiss {
        all: unset;
        cursor: pointer;
        padding: 0.1rem 0.35rem;
        border-radius: 4px;
        color: var(--gray-400, #8f8474);
        font-size: 1rem;
        line-height: 1;
      }

      .dismiss:hover {
        color: var(--gray-50, #f5f1e8);
      }

      .headline {
        margin: 0 0 0.4rem;
        font-size: 1.05rem;
      }

      .reason {
        margin: 0 0 0.75rem;
        color: var(--gray-300, #bdb3a0);
        font-size: 0.88rem;
        line-height: 1.5;
      }

      .name {
        display: inline-block;
        margin-bottom: 0.8rem;
        font-family: var(--font-mono);
        font-size: 0.85rem;
        word-break: break-all;
        user-select: all;
      }

      .call {
        margin: 0 0 0.9rem;
        border: 1px solid var(--gray-700, #443d36);
        border-radius: 6px;
        padding: 0.6rem 0.7rem;
        background: var(--gray-900, #1a1714);
      }

      .call__headline {
        font-family: var(--font-mono);
        font-size: 0.7rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--gray-400, #8f8474);
        margin-bottom: 0.45rem;
      }

      .call__row {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.15rem 0;
      }

      .call__label {
        width: 2.2rem;
        flex-shrink: 0;
        font-family: var(--font-mono);
        font-size: 0.72rem;
        color: var(--gray-400, #8f8474);
      }

      .call__value {
        flex: 1;
        min-width: 0;
        font-family: var(--font-mono);
        font-size: 0.73rem;
        line-height: 1.4;
        word-break: break-all;
        user-select: all;
      }

      .copy {
        flex-shrink: 0;
        padding: 0.12rem 0.4rem;
        font-size: 0.68rem;
        background: transparent;
        border: 1px solid var(--gray-600, #5f564b);
        border-radius: 4px;
        color: var(--gray-300, #bdb3a0);
        cursor: pointer;
      }

      .copy:hover {
        color: var(--gray-50, #f5f1e8);
      }

      .actions {
        display: flex;
        align-items: center;
        gap: 0.7rem;
        flex-wrap: wrap;
      }

      .open-l1 {
        display: inline-flex;
        align-items: center;
        padding: 0.35rem 0.7rem;
        border: 1px solid var(--gray-600, #5f564b);
        border-radius: 6px;
        color: var(--gray-50, #f5f1e8);
        font-family: var(--font-mono);
        font-size: 0.78rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        text-decoration: none;
      }

      .open-l1:hover {
        border-color: var(--color-yellow, #fcd34d);
      }

      .waiting {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-family: var(--font-mono);
        font-size: 0.78rem;
        color: var(--gray-300, #bdb3a0);
      }

      .waiting__dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 9999px;
        background: var(--color-yellow, #fcd34d);
        animation: pulse 1.4s ease-in-out infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 0.35;
        }
        50% {
          opacity: 1;
        }
      }

      .retry-warning {
        flex-basis: 100%;
        margin: 0;
        font-family: var(--font-mono);
        font-size: 0.76rem;
        line-height: 1.45;
        color: var(--color-yellow, #fcd34d);
      }

      .error {
        margin: 0 0 0.75rem;
        padding: 0.5rem 0.6rem;
        border-radius: 5px;
        background: var(--error-bg, #3a1414);
        border: 1px solid var(--error-border, #7a2a2a);
        color: #ffb4b4;
        font-size: 0.82rem;
        white-space: pre-wrap;
      }

      @media (prefers-reduced-motion: reduce) {
        .waiting__dot {
          animation: none;
          opacity: 1;
        }
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.syncProposalFlag();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPolling();
  }

  protected willUpdate(): void {
    // The host may hand us `state` after the element is created; read the
    // persisted marker once that name is known. Doing it before render lets the
    // first paint already be correct (no waiting-flash for a new label).
    this.syncProposalFlag();
    this.ensureL1SafeChecked();
  }

  protected updated(_changed: PropertyValues<this>): void {
    this.syncView();
  }

  private get store(): EnsStepStorage {
    return this.storage ?? window.localStorage;
  }

  /** The persisted marker's scope: one proposal per Safe, label and registry. */
  private proposalScope(): { safeAddress: string; label: string; registry: string } | null {
    const safe = this.safeInfo;
    const state = this.state;
    if (!safe || !state) return null;
    return { safeAddress: safe.safeAddress, label: state.label, registry: state.registry };
  }

  /** Mirror the persisted marker into reactive state. Re-reads when the
   *  publication label or registry changes (rename / reconfigure), so the old
   *  scope's marker cannot leave the new one stuck on "waiting". */
  private syncProposalFlag(): void {
    const scope = this.proposalScope();
    if (!scope) return;
    const key = `${scope.safeAddress.toLowerCase()}:${scope.registry.toLowerCase()}:${scope.label.toLowerCase()}`;
    if (this.proposalChecked && key === this.proposalScopeKey) return;
    if (this.proposalChecked && key !== this.proposalScopeKey) {
      // The card is now about another publication: the old label's timeout,
      // error, queue link and armed retry do not describe it.
      this.error = '';
      this.timedOut = false;
      this.queueUrl = '';
      this.retryArmed = false;
      this.pollDeadline = 0;
      this.pollFailures = 0;
      this.stopPolling();
    }
    this.proposalChecked = true;
    this.proposalScopeKey = key;
    this.proposed = hasEnsProposal(this.store, scope.safeAddress, scope.label, scope.registry);
  }

  /** A Base-only Safe has no mainnet twin: its hop and its Propose button would
   *  both address a Safe that does not exist. Unknown stays visible: a 429 must
   *  not hide a legitimate step. */
  private ensureL1SafeChecked(): void {
    const safe = this.safeInfo;
    if (!safe || !this.state) return;
    const deps = this.safeIntegration;
    if (!deps) return;
    if (this.l1SafeCheckPending) return;
    if (this.l1SafeCheckedFor === safe.safeAddress && this.l1SafeHasCode !== null) return;
    this.l1SafeCheckedFor = safe.safeAddress;
    this.l1SafeCheckPending = true;
    void deps
      .contractCodeSize(safe.safeAddress, ENS_L1_CHAIN_ID)
      .then((size) => {
        if (this.safeInfo?.safeAddress !== safe.safeAddress) return;
        this.l1SafeHasCode = size > 0;
      })
      .catch(() => {
        if (this.safeInfo?.safeAddress !== safe.safeAddress) return;
        // Stay unknown rather than turning a transient failure into "this Safe
        // does not exist"; a later render may retry.
        this.l1SafeHasCode = null;
        this.l1SafeCheckedFor = '';
      })
      .finally(() => {
        this.l1SafeCheckPending = false;
      });
  }

  private get view(): EnsStepView {
    if (!this.safeInfo) return { kind: 'hidden', chain: 'other', canPropose: false };
    return ensStepView(this.state, this.safeInfo, { proposed: this.proposed });
  }

  /** Keep the poll in sync with the view: wait while a proposal is pending,
   *  stop on done/error/hidden/dismissed. */
  private syncView(): void {
    if (this.dismissed || this.l1SafeHasCode === false) {
      this.stopPolling();
      return;
    }
    const view = this.view;
    if (view.kind === 'done') {
      this.stopPolling();
      this.dispatchDone();
      return;
    }
    if (view.kind === 'waiting') {
      this.ensurePolling();
      return;
    }
    this.stopPolling();
  }

  /** The L1 read options for the current publication. */
  private registrationOptions(): {
    registry: string;
    label: string;
    safeAddress: string;
    suffix?: string;
  } | null {
    const state = this.state;
    const safe = this.safeInfo;
    if (!state || !safe) return null;
    return {
      registry: state.registry,
      label: state.label,
      safeAddress: safe.safeAddress,
      suffix: suffixOfPublicationName(state.name, state.label) || undefined,
    };
  }

  private ensurePolling(): void {
    if (this.pollActive || this.dismissed || this.timedOut) return;
    if (!this.safeIntegration || !this.state || !this.safeInfo) return;
    if (this.pollDeadline === 0) this.pollDeadline = Date.now() + this.pollTimeoutMs;
    if (Date.now() >= this.pollDeadline) {
      this.finishPolling();
      return;
    }
    this.pollActive = true;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    const backoff = pollBackoffMs(this.pollIntervalMs, this.pollFailures);
    // Never sleep past the deadline: the timeout UI must appear on time even
    // when the last read failed and the backoff is a minute.
    const untilDeadline =
      this.pollDeadline > 0 ? this.pollDeadline - Date.now() : Number.POSITIVE_INFINITY;
    this.pollTimer = window.setTimeout(
      () => void this.pollOnce(),
      Math.max(0, Math.min(backoff, untilDeadline)),
    );
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollActive = false;
    // A read already in flight belongs to the stopped poll and must not write
    // its result (or its timeout) into the next one.
    this.pollRunId += 1;
  }

  /** Stop for good: show the pending message and let the user retry. A later
   *  render (view still 'waiting') must NOT re-arm the timer. */
  private finishPolling(): void {
    this.stopPolling();
    if (this.timedOut) return;
    this.timedOut = true;
    this.error =
      'The registration is still pending in the Safe queue. Execute it on Ethereum mainnet, or propose it again.';
  }

  /** Re-read the L1 subnode owner. A failed read is "not answered yet", not a
   *  verdict: retry with exponential backoff until the deadline. */
  private async pollOnce(): Promise<void> {
    this.pollTimer = null;
    const deps = this.safeIntegration;
    const opts = this.registrationOptions();
    if (!this.isConnected || this.dismissed || !deps || !opts) {
      this.pollActive = false;
      return;
    }
    // The timer may have been scheduled at the deadline while backoff was in
    // effect: stop before spending another RPC call.
    if (Date.now() >= this.pollDeadline) {
      this.finishPolling();
      return;
    }

    const runId = this.pollRunId;
    const remaining = Math.max(0, this.pollDeadline - Date.now());
    let timeoutId: number | undefined;
    const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
      timeoutId = window.setTimeout(() => resolve({ kind: 'deadline' }), remaining);
    });
    // A hung provider must not park the poll past its deadline: race the read
    // against the remaining time, then stop on either branch.
    const read = readEnsRegistration(
      {
        evmRead: (chainId, contractAddress, abi, method, args) =>
          deps.evmRead(chainId, contractAddress, abi, method, args),
      },
      opts,
    )
      .then((value) => ({ kind: 'ok' as const, value }))
      .catch((value) => ({ kind: 'error' as const, value }));

    const result = await Promise.race([read, deadline]);
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    // A dismissal, scope change or removal stopped this poll while the read
    // was in flight: its answer is stale.
    if (runId !== this.pollRunId) {
      this.pollActive = false;
      return;
    }
    if (result.kind === 'deadline') {
      this.finishPolling();
      return;
    }

    if (result.kind === 'error') {
      // Transient (429, RPC blip): keep waiting, but back off the next attempt.
      this.pollFailures += 1;
    } else {
      const next = result.value;
      this.pollFailures = 0;
      this.state = next;
      if (next.ownedBySafe) {
        this.pollActive = false;
        this.dispatchDone();
        return;
      }
      if (ensStepView(next, this.safeInfo!, { proposed: true }).kind !== 'waiting') {
        this.pollActive = false;
        return;
      }
    }

    if (this.dismissed) {
      this.pollActive = false;
      return;
    }
    if (Date.now() >= this.pollDeadline) {
      this.finishPolling();
      return;
    }
    this.schedulePoll();
  }

  /**
   * Send the registration. The persisted marker is written BEFORE the await
   * so a second tab (or a re-created card) cannot queue the same transaction;
   * it is cleared on any failure. The L1 state is re-read immediately before
   * sending: a name someone else registered while the card sat open must not
   * cost a reverting transaction.
   */
  private readonly propose = async (): Promise<void> => {
    if (this.busy) return;
    const view = this.view;
    const deps = this.safeIntegration;
    const safe = this.safeInfo;
    const scope = this.proposalScope();
    if (!view.canPropose || !view.call || !deps || !safe || !scope) return;

    const { safeAddress, label, registry } = scope;
    if (hasEnsProposal(this.store, safeAddress, label, registry)) {
      this.proposed = true;
      this.pollDeadline = this.pollDeadline || Date.now() + this.pollTimeoutMs;
      this.ensurePolling();
      return;
    }

    this.busy = true;
    this.error = '';
    this.timedOut = false;
    this.queueUrl = '';
    markEnsProposal(this.store, safeAddress, label, registry);

    try {
      const fresh = await readEnsRegistration(
        {
          evmRead: (chainId, contractAddress, abi, method, args) =>
            deps.evmRead(chainId, contractAddress, abi, method, args),
        },
        {
          registry,
          label,
          safeAddress,
          suffix: suffixOfPublicationName(this.state?.name ?? '', label) || undefined,
        },
      );
      if (!ensStepView(fresh, safe).canPropose) {
        clearEnsProposal(this.store, safeAddress, label, registry);
        this.state = fresh;
        return;
      }

      const url = await deps.proposeBatch([{ to: view.call.to, value: '0', data: view.call.data }]);
      this.proposed = true;
      this.queueUrl = url || '';
      this.pollDeadline = Date.now() + this.pollTimeoutMs;
      this.pollFailures = 0;
      this.ensurePolling();
    } catch (e) {
      clearEnsProposal(this.store, safeAddress, label, registry);
      this.proposed = false;
      this.error = `Proposing the registration failed: ${
        e instanceof Error ? e.message : String(e)
      }`;
    } finally {
      this.busy = false;
    }
  };

  /** Explicit recovery after the poll deadline: drop the marker and re-propose.
   *  This is what makes a rejected Safe transaction (or a stale marker) a
   *  retryable state instead of a permanent dead end. The SDK cannot tell a
   *  still-queued proposal from no proposal, so the first click only warns;
   *  the second one actually re-sends. */
  private readonly retry = async (): Promise<void> => {
    const scope = this.proposalScope();
    if (!scope || this.busy) return;
    if (!this.retryArmed) {
      this.retryArmed = true;
      return;
    }
    this.retryArmed = false;
    clearEnsProposal(this.store, scope.safeAddress, scope.label, scope.registry);
    this.proposed = false;
    this.timedOut = false;
    this.error = '';
    this.pollDeadline = 0;
    this.pollFailures = 0;
    this.stopPolling();
    await this.propose();
  };

  private readonly dismiss = (): void => {
    this.dismissed = true;
    this.stopPolling();
    this.dispatchEvent(new CustomEvent('s2s-ens-dismiss', { bubbles: true, composed: true }));
  };

  private dispatchDone(): void {
    if (this.doneDispatched) return;
    this.doneDispatched = true;
    this.dispatchEvent(new CustomEvent('s2s-ens-done', { bubbles: true, composed: true }));
  }

  private async copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // The value is selectable on screen; a denied clipboard must not break
      // the card.
    }
  }

  private renderCallRow(label: string, value: string): unknown {
    return html`
      <div class="call__row">
        <span class="call__label">${label}</span>
        <code class="call__value" data-call="${label}">${value}</code>
        <button
          class="copy"
          data-copy="${label}"
          aria-label="Copy ${label}"
          @click=${() => void this.copy(value)}
        >
          Copy
        </button>
      </div>
    `;
  }

  /** The mainnet hop for a page whose Safe lives on another chain. Returns ''
   *  for chain 1, a partial Safe, or an unusable app URL. */
  private renderChainHop(safe: { chainId: number; safeAddress: string }): unknown {
    if (safe.chainId === ENS_L1_CHAIN_ID) return '';
    const url = safeAppUrl({
      chainId: ENS_L1_CHAIN_ID,
      safeAddress: safe.safeAddress,
      appUrl: this.appUrl,
    });
    if (!url) return '';
    return html`
      <a class="open-l1" id="ens-open-l1" href=${url} target="_blank" rel="noopener noreferrer">
        Open Safe on Ethereum
      </a>
    `;
  }

  private renderActions(
    view: EnsStepView,
    safe: { chainId: number; safeAddress: string },
  ): unknown {
    if (view.kind === 'waiting') {
      return html`
        <div class="waiting">
          <span class="waiting__dot" aria-hidden="true"></span>
          <span>Waiting for the Safe transaction…</span>
        </div>
        ${this.queueUrl
          ? html`
              <a
                class="open-l1"
                id="ens-queue"
                href=${this.queueUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Safe queue
              </a>
            `
          : ''}
        ${this.renderChainHop(safe)}
        ${this.timedOut && view.chain === 'l1' && view.call
          ? html`
              ${this.retryArmed
                ? html`<p class="retry-warning" id="ens-retry-warning">
                    The earlier proposal may still be pending in the Safe queue. Proposing again can
                    add a duplicate transaction.
                  </p>`
                : ''}
              <s2s-button
                type="secondary"
                id="ens-retry"
                ?disabled=${this.busy}
                @click=${() => void this.retry()}
              >
                ${this.busy
                  ? 'Proposing…'
                  : this.retryArmed
                    ? 'Propose again anyway'
                    : 'Propose again'}
              </s2s-button>
            `
          : ''}
      `;
    }
    if (view.kind === 'error' || !view.call) return '';

    if (view.canPropose) {
      return html`
        <s2s-button
          type="primary"
          id="ens-propose"
          ?disabled=${this.busy}
          @click=${() => void this.propose()}
        >
          ${this.busy ? 'Proposing…' : 'Propose on Ethereum'}
        </s2s-button>
      `;
    }

    return this.renderChainHop(safe);
  }

  render() {
    const safe = this.safeInfo;
    if (!safe || this.dismissed) return '';

    const view = this.view;
    if (view.kind === 'hidden' || view.kind === 'done' || this.l1SafeHasCode === false) return '';

    const name = this.state?.name ?? '';
    const headline =
      view.kind === 'error'
        ? 'ENS name needs attention'
        : view.kind === 'waiting'
          ? 'Waiting for ENS registration'
          : 'Register this publication’s ENS name';

    return html`
      <section class="card" id="ens-step" aria-live="polite">
        <div class="head">
          <span class="eyebrow"
            >ENS registration · ${view.chain === 'l1' ? 'chain 1' : 'L1 step'}</span
          >
          <button class="dismiss" id="ens-dismiss" aria-label="Dismiss" @click=${this.dismiss}>
            ×
          </button>
        </div>

        <h2 class="headline">${headline}</h2>
        ${view.reason ? html`<p class="reason">${view.reason}</p>` : ''}
        ${name ? html`<code class="name" id="ens-name">${name}</code>` : ''}
        ${view.call
          ? html`
              <div class="call">
                <div class="call__headline">registerSubdomain call (Ethereum mainnet)</div>
                ${this.renderCallRow('to', view.call.to)}
                ${this.renderCallRow('data', view.call.data)}
              </div>
            `
          : ''}
        ${this.error
          ? html`<div class="error" id="ens-error" role="alert">${this.error}</div>`
          : ''}
        <div class="actions">${this.renderActions(view, safe)}</div>
      </section>
    `;
  }
}
