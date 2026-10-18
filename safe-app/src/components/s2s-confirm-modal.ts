import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import './s2s-button.js';
import { buttonStyles } from '@/styles/button-styles.js';

/**
 * s2s-confirm-modal — full-screen confirmation dialog.
 *
 * When `open` is true it renders a fixed, full-size overlay that dims and
 * blurs the page behind it (interaction with the page is blocked while it is
 * shown), with a centered card containing a headline, warning message and
 * Confirm/Cancel actions.
 *
 * The component is CONTROLLED: it never flips `open` itself. Consumers bind
 * `.open`, and react to the (bubbling, composed) events it emits:
 *   s2s-confirm — confirm action pressed
 *   s2s-cancel  — cancel pressed, backdrop clicked, or Escape pressed
 *
 * `busy` disables the confirm action (e.g. while a proposal is in flight) so
 * the dialog can stay open through the work with the confirm showing progress.
 */
@customElement('s2s-confirm-modal')
export class S2SConfirmModal extends LitElement {
  /** Whether the dialog is visible. */
  @property({ type: Boolean }) open = false;
  /** Short headline rendered at the top of the card. */
  @property() headline = 'Are you sure?';
  /** Warning/explanation body text. */
  @property() message = '';
  /** Label for the confirm action (e.g. "Confirm reset"). */
  @property() confirmLabel = 'Confirm';
  /** Label for the cancel action. */
  @property() cancelLabel = 'Cancel';
  /** Disables the confirm action while true (e.g. while proposing). */
  @property({ type: Boolean }) busy = false;
  /** Accent of the confirm action — 'warning' (default) or 'primary'. */
  @property() variant: 'warning' | 'primary' = 'warning';

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
        max-width: 420px;
        width: 90%;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
        outline: none;
      }

      .headline {
        margin: 0 0 0.75rem;
      }

      .message {
        margin: 0 0 1.5rem;
        color: var(--gray-300, #bdb3a0);
        font-size: 0.9rem;
        line-height: 1.55;
      }

      .actions {
        display: flex;
        gap: 0.6rem;
        justify-content: flex-end;
        flex-wrap: wrap;
      }
    `,
  ];

  /** Escape closes the dialog. */
  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.emitCancel();
  };

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('open')) {
      if (this.open) window.addEventListener('keydown', this.onKeydown);
      else window.removeEventListener('keydown', this.onKeydown);
    }
  }

  protected updated(changed: PropertyValues<this>): void {
    // Focus the card when it opens so keyboard events land inside it.
    if (changed.has('open') && this.open) {
      this.shadowRoot?.querySelector<HTMLElement>('.dialog')?.focus();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKeydown);
  }

  private readonly emitConfirm = (): void => {
    this.dispatchEvent(new CustomEvent('s2s-confirm', { bubbles: true, composed: true }));
  };

  private readonly emitCancel = (): void => {
    this.dispatchEvent(new CustomEvent('s2s-cancel', { bubbles: true, composed: true }));
  };

  private readonly onBackdropClick = (e: Event): void => {
    // Clicks inside the card stop propagation; anything else is a backdrop click.
    if (e.target === e.currentTarget) this.emitCancel();
  };

  render() {
    if (!this.open) return '';

    return html`
      <div class="overlay" @click=${this.onBackdropClick}>
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-headline"
          tabindex="-1"
          @click=${(e: Event) => {
            e.stopPropagation();
          }}
        >
          <h2  id="confirm-headline">${this.headline}</h2>
          <p class="message">${this.message}</p>
          <div class="actions">
            <button class="button" id="confirm-cancel" @click=${this.emitCancel}>
              ${this.cancelLabel}
            </button>
            <s2s-button
              type=${this.variant}
              id="confirm-ok"
              ?disabled=${this.busy}
              @click=${this.emitConfirm}
            >
              ${this.confirmLabel}
            </s2s-button>
          </div>
        </div>
      </div>
    `;
  }
}
