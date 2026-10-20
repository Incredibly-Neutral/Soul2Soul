// s2s-init-progress-modal.ts — the "initialization in progress" dialog.
//
// Shown by <s2s-app> while a new-publication init flow is active, whether it
// is running live (the init component drives it) or was recovered from local
// storage after a reload. Mirrors s2s-confirm-modal's overlay (fixed, full-size,
// blurs the page behind it — interaction is blocked while the flow is active,
// so the user cannot lose track of it).
//
// It is CONTROLLED: the host binds `.open` / `.phase` / `.message` / `.error`
// and the modal never flips `open` itself. The only action it offers is Retry,
// shown when the host reports an error: the config build/propose failed or its
// proposal timed out, and re-running it is the only way forward. The proposals
// it tracks are executed in the Safe queue on this page — the modal never
// renders a URL.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { INIT_STEPS, stepState, type InitPhase } from '../lib/init-session.js';

@customElement('s2s-init-progress-modal')
export class S2SInitProgressModal extends LitElement {
  /** Whether the dialog is visible. */
  @property({ type: Boolean }) open = false;
  /** The persisted/current phase of the init flow. */
  @property() phase: InitPhase = 'creating';
  /** Status line the host drives (e.g. "Building configuration…"). */
  @property() message = '';
  /** Failure text; when set, the modal offers Retry. */
  @property() error = '';
  /**
   * Offer the escape hatch for a failed step 3. The host sets it only for a
   * build/propose failure (nothing queued): Retry re-runs the same failing
   * build, so without this the user would be stuck behind a full-screen scrim
   * that covers the Config tab where the repo/branch are fixed.
   */
  @property({ type: Boolean }) canDismiss = false;

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

      .message {
        margin: 0 0 1rem;
        font-size: 0.85rem;
        line-height: 1.4;
        color: var(--gray-300, #bdb3a0);
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

  private renderStep(index: 1 | 2 | 3, title: string): unknown {
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

  render() {
    if (!this.open) return '';

    return html`
      <div class="overlay">
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

          ${this.message
            ? html`<p class="message" id="init-progress-message">${this.message}</p>`
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
