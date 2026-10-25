// s2s-init-progress-modal.ts — the "initialization in progress" dialog.
//
// Shown by <s2s-app> while a new-publication init flow is active, whether it
// is running live (the init component drives it) or was recovered from local
// storage after a reload. Mirrors s2s-confirm-modal's overlay (fixed, full-size,
// blurs the page behind it — interaction is blocked while the flow is active,
// so the user cannot lose track of it).
//
// It is CONTROLLED: the host binds `.open` / `.phase` / `.error` /
// `.canDismiss` / `.ensCall` and the modal never flips `open` itself. It shows
// only the step markers (spinner for the current step, check for done, dot for
// pending) and — when there is a failure — the red error block. When the host reports an
// error it offers up to two actions: Retry, and — only for a failure that
// queued nothing (a build/propose error, where retrying the same input cannot
// work) — "Close and fix the configuration", which dismisses the flow and
// hands the page back so the input can be fixed. A timed-out proposal is never
// dismissible: its Safe transaction may still be pending. The proposals it
// tracks are executed in the Safe queue on this page — the modal never renders
// a URL.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { INIT_STEPS, stepState, type InitPhase } from '../lib/init-session.js';

@customElement('s2s-init-progress-modal')
export class S2SInitProgressModal extends LitElement {
  /** Whether the dialog is visible. */
  @property({ type: Boolean }) open = false;
  /** The persisted/current phase of the init flow (drives the step markers). */
  @property() phase: InitPhase = 'creating';
  /** Failure text; when set, the modal offers Retry. */
  @property() error = '';
  /**
   * Offer the escape hatch for a failed step 3. The host sets it only for a
   * build/propose failure (nothing queued): Retry re-runs the same failing
   * build, so without this the user would be stuck behind a full-screen scrim
   * that covers the Config tab where the repo/branch are fixed.
   */
  @property({ type: Boolean }) canDismiss = false;

  /**
   * Step 1's write, when it has to be executed OUTSIDE this Safe: the ENS
   * registry lives on Ethereum L1, so `registerSubdomain` is a transaction on
   * chain 1 that this Base-embedded app cannot propose. The host passes the
   * ready-to-send call and the modal shows `to` + `data` for the human to
   * execute from the L1 Safe. Undefined for every other step.
   */
  @property({ attribute: false }) ensCall?: { to: string; data: string };

  static styles = [
    buttonStyles,
    css`
      :host {
        display: contents;
      }

      .overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(10, 8, 6, 0.6);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      .dialog {
        background: var(--gray-800, #2e2925);
        border: 1px solid var(--gray-600, #5f564b);
        border-radius: 12px;
        padding: 1.75rem;
        max-width: 440px;
        width: 90%;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
        outline: none;
      }

      .headline {
        margin: 0 0 1rem;
      }

      .steps {
        margin: 0 0 1rem;
        padding: 0;
        list-style: none;
      }

      .step {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.35rem 0;
        font-size: 0.9rem;
        color: var(--gray-300, #bdb3a0);
      }

      .step--current {
        color: var(--gray-50, #f5f1e8);
      }

      .step__marker {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.25rem;
        height: 1.25rem;
        flex-shrink: 0;
        color: var(--accent, #f5c542);
      }

      .step__marker--dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 50%;
        background: var(--gray-600, #5f564b);
      }

      .step__marker--spinner {
        width: 1rem;
        height: 1rem;
        border: 2px solid var(--gray-500);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: init-progress-spin 0.8s linear infinite;
      }

      @keyframes init-progress-spin {
        to {
          transform: rotate(360deg);
        }
      }

      /* Same red init-error treatment as the inline flow's error block. */
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
        flex-wrap: wrap;
        gap: 0.5rem;
      }

      .ens {
        margin: 0 0 1rem;
        padding: 0.75rem;
        border-radius: 6px;
        background: var(--gray-900, #1b1815);
        border: 1px solid var(--gray-600, #5f564b);
      }

      .ens__headline {
        margin: 0 0 0.5rem;
        font-size: 0.8rem;
        letter-spacing: 0.04em;
        color: var(--gray-300, #bdb3a0);
      }

      .ens__row {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        margin-top: 0.35rem;
      }

      .ens__label {
        flex-shrink: 0;
        width: 2.5rem;
        font-family: var(--font-mono);
        font-size: 0.75rem;
        color: var(--gray-400, #8f8474);
        padding-top: 0.15rem;
      }

      .ens__value {
        flex: 1;
        min-width: 0;
        font-family: var(--font-mono);
        font-size: 0.75rem;
        line-height: 1.4;
        color: var(--gray-50, #f5f1e8);
        word-break: break-all;
        white-space: pre-wrap;
        user-select: all;
      }

      .ens__copy {
        flex-shrink: 0;
        padding: 0.15rem 0.45rem;
        font-size: 0.7rem;
        background: transparent;
        border: 1px solid var(--gray-600, #5f564b);
        border-radius: 4px;
        color: var(--gray-300, #bdb3a0);
        cursor: pointer;
      }

      .ens__copy:hover {
        color: var(--gray-50, #f5f1e8);
      }
    `,
  ];

  /** Retry: the host re-runs (or re-waits on) the failed config step. */
  private readonly retry = (): void => {
    this.dispatchEvent(new CustomEvent('s2s-init-retry', { bubbles: true, composed: true }));
  };

  /** Dismiss a failed (nothing-queued) step 3 and hand the app back to the user. */
  private readonly dismiss = (): void => {
    this.dispatchEvent(new CustomEvent('s2s-init-dismiss', { bubbles: true, composed: true }));
  };

  /** Copy a value to the clipboard. Never throws: a denied clipboard (no
   *  permission, insecure context) must not break the dialog — the value is
   *  selectable in the <code> regardless. Dispatches nothing. */
  private async copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Nothing to surface: the text is on screen and selectable.
    }
  }

  private renderStep(index: 1 | 2 | 3 | 4, title: string): unknown {
    const state = stepState(this.phase, index);
    const marker =
      state === 'done'
        ? html`<ph-check size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-check>`
        : state === 'current'
          ? html`<span class="step__marker step__marker--spinner" aria-hidden="true"></span>`
          : html`<span class="step__marker step__marker--dot" aria-hidden="true"></span>`;

    return html`
      <li class="step step--${state}" data-step="${index}">
        <span class="step__marker">${marker}</span>
        <span>${title}</span>
      </li>
    `;
  }

  /** One `label + <code> + copy` row of the ENS block. */
  private renderEnsRow(label: string, value: string): unknown {
    return html`
      <div class="ens__row">
        <span class="ens__label">${label}</span>
        <code class="ens__value" data-ens="${label}">${value}</code>
        <button
          class="ens__copy"
          data-copy="${label}"
          aria-label="Copy ${label}"
          @click=${() => void this.copy(value)}
        >
          Copy
        </button>
      </div>
    `;
  }

  render() {
    if (!this.open) return '';

    return html`
      <div class="overlay" id="init-progress">
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="init-progress-headline"
        >
          <h2 class="headline" id="init-progress-headline">Initializing publication</h2>

          <ul class="steps">
            ${INIT_STEPS.map((row) => this.renderStep(row.index, row.title))}
          </ul>

          ${this.ensCall
            ? html`
                <div class="ens" id="init-ens-call">
                  <div class="ens__headline">Register on the L1 Safe (chain 1)</div>
                  ${this.renderEnsRow('to', this.ensCall.to)}
                  ${this.renderEnsRow('data', this.ensCall.data)}
                </div>
              `
            : ''}
          ${this.error
            ? html`
                <div class="init__error" id="init-progress-error" role="alert">${this.error}</div>
                <div class="init__actions">
                  <button class="button" id="init-retry" @click=${this.retry}>Retry</button>
                  ${this.canDismiss
                    ? html`<button class="button" id="init-dismiss" @click=${this.dismiss}>
                        Close and fix the configuration
                      </button>`
                    : ''}
                </div>
              `
            : ''}
        </div>
      </div>
    `;
  }
}
