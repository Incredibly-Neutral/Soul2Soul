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
        border-top-left-radius: 0;
        border-bottom-left-radius: 0;
      }

      :host(:not([open])) #add-btn {
        border-radius: 6px;
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
        >${this.buttonLabel}</button>
      </div>
    `;
  }
}
