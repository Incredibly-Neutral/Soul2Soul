// s2s-init-progress-modal.ts — the "initialization in progress" dialog.
//
// Shown by <s2s-app> while a new-publication init flow is active, whether it
// is running live (the init component drives it) or was recovered from local
// storage after a reload. Mirrors s2s-confirm-modal's overlay (fixed, full-size,
// blurs the page behind it — interaction is blocked while the flow is active,
// so the user cannot lose track of it).
//
// It is CONTROLLED: the host binds `.open` / `.phase` / `.proposals` and the
// modal never flips `open` itself. Unlike the confirm modal there is no
// confirm/cancel — a progress dialog, the only way forward is executing the
// proposals it links to.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import { INIT_PHASE_LABELS, INIT_STEPS, stepState, type InitPhase } from '../lib/init-session.js';

@customElement('s2s-init-progress-modal')
export class S2SInitProgressModal extends LitElement {
  /** Whether the dialog is visible. */
  @property({ type: Boolean }) open = false;
  /** The persisted/current phase of the init flow. */
  @property() phase: InitPhase = 'creating';
  /** Safe transaction-queue URLs, in proposal order. */
  @property({ attribute: false }) proposals: string[] = [];
  /** The publication name being created (for the headline). */
  @property() name = '';

  static styles = css`
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

    .phase {
      margin: 0 0 0.75rem;
      padding: 0.6rem 0.75rem;
      border-radius: 6px;
      background: var(--gray-900, #1c1a17);
      border: 1px solid var(--gray-700, #4a443c);
      font-size: 0.85rem;
      color: var(--gray-100, #efe9dd);
    }

    .proposals {
      margin: 0 0 1rem;
      padding: 0;
      list-style: none;
    }

    .proposal {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.4rem;
      font-size: 0.85rem;
      color: var(--gray-300, #bdb3a0);
    }

    .proposal a {
      color: var(--accent);
      font-family: var(--font-mono);
      font-size: 0.8rem;
      word-break: break-all;
    }

    .hint {
      margin: 0;
      font-size: 0.78rem;
      color: var(--gray-400, #a89d8a);
      line-height: 1.5;
    }
  `;

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
          <h2 class="headline" id="init-progress-headline">
            Initializing publication${this.name ? ` — ${this.name}` : ''}
          </h2>

          <ul class="steps">
            ${INIT_STEPS.map((row) => this.renderStep(row.index, row.title))}
          </ul>

          <p class="phase" id="init-progress-phase">${INIT_PHASE_LABELS[this.phase]}</p>

          ${this.proposals.length > 0
            ? html`
                <ul class="proposals">
                  ${this.proposals.map(
                    (url, i) => html`
                      <li class="proposal">
                        <span>Proposal ${i + 1}:</span>
                        <a href=${url} target="_blank" rel="noopener noreferrer"
                          >open in Safe app</a
                        >
                      </li>
                    `,
                  )}
                </ul>
              `
            : ''}

          <p class="hint">
            Execute each proposal in the Safe app — this window stays open and resumes the flow
            automatically.
          </p>
        </div>
      </div>
    `;
  }
}
