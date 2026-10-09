// s2s-sliding-add-button.ts — generic slide-open add control.
//
// Ports the import-survey slide-open pattern into a LitElement (lit.dev format):
// an 'Add' button with a text input that slides open (width 0 -> 14rem) once the
// button is clicked, animated via a reflected `open` attribute and a
// :host([open]) selector. First click opens + focuses, Enter submits, Escape
// clears + closes, second click on the button submits.
//
// 100% presentational + input handling: on submit it clears the input and
// dispatches a composed bubbling CustomEvent `s2s-sliding-add` with
// detail { value }. No alias/config/store/safeIntegration logic lives here —
// consumers own the value's meaning.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

@customElement('s2s-sliding-add-button')
export class S2SSlidingAddButton extends LitElement {
  /** Input placeholder, settable by consumers. */
  @property({ type: String }) placeholder = '';

  /** Visible button label, settable by consumers. */
  @property({ type: String }) buttonLabel = 'Add';

  /** Slide-open state — reflected so :host([open]) drives the animation. */
  @property({ type: Boolean, reflect: true }) open = false;

  static styles = [
    typograhyStyles,
    buttonStyles,
    css`
      :host {
        display: flex;
      }

      .add {
        display: flex;
        align-items: stretch;
        overflow: hidden;
      }

      .add__input {
        width: 0;
        opacity: 0;
        padding: 0;
        border: none;
        outline: none;
        transition: width 0.3s ease, opacity 0.25s ease, padding 0.3s ease;
        margin: 0;
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
      }

      :host([open]) .add__input {
        width: 14rem;
        opacity: 1;
        padding: 0 0.75rem;
      }

      #add-btn {
        /* Match the .alias-pill box model (s2s-records-tab) so the Add
           control sits flush next to the alias pills: same height (padding +
           border + mono font), 999px radius and grey-800 pill treatment. */
        border-top-left-radius: 0;
        border-bottom-left-radius: 0;
        border-top-right-radius: 999px;
        border-bottom-right-radius: 999px;
        padding: 0.25rem 0.75rem;
        border: 1px solid var(--gray-600);
        background: var(--gray-800);
        color: var(--gray-50);
        font-family: var(--font-mono);
        font-size: 0.85rem;
        letter-spacing: 0;
        text-transform: none;
        gap: 0.35rem;
      }

      :host(:not([open])) #add-btn {
        border-radius: 999px;
      }

      :host([open]) #add-btn {
        /* Slide-open: merge with the input — square left edge, pill right
           edge, and drop the border so it reads as one unit with the input. */
        border: none;
        border-top-left-radius: 0;
        border-bottom-left-radius: 0;
        border-top-right-radius: 999px;
        border-bottom-right-radius: 999px;
      }
    `,
  ];

  private get input(): HTMLInputElement | null {
    return this.renderRoot.querySelector<HTMLInputElement>('.add__input');
  }

  /** Trim + dispatch the value, then clear and keep focus (mirror import-survey). */
  private submit(): void {
    const value = this.input?.value.trim() ?? '';
    if (!value) return;

    this.dispatchEvent(
      new CustomEvent('s2s-sliding-add', {
        detail: { value },
        bubbles: true,
        composed: true,
      }),
    );

    if (this.input) this.input.value = '';
    this.input?.focus();
  }

  private onButtonClick(): void {
    if (!this.open) {
      // First click: open the input and focus it (after render applies width).
      this.open = true;
      void this.updateComplete.then(() => this.input?.focus());
      return;
    }
    // Second click: submit.
    this.submit();
  }

  private onInputKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      this.submit();
    } else if (e.key === 'Escape') {
      this.open = false;
      if (this.input) this.input.value = '';
    }
  }

  render() {
    return html`
      <div class="add">
        <input
          class="add__input"
          type="text"
          placeholder=${this.placeholder}
          autocomplete="off"
          tabindex=${this.open ? 0 : -1}
          aria-label=${this.placeholder || this.buttonLabel}
          @keydown=${this.onInputKeydown}
        />
        <button
          class="button"
          id="add-btn"
          aria-expanded=${this.open}
          @click=${this.onButtonClick}
        ><ph-plus size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-plus>${this.buttonLabel}</button>
      </div>
    `;
  }
}
