import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('toggle-button')
export class ToggleButton extends LitElement {
  @property({ type: Boolean }) bool = false;
  @property() label = '';

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }

    .toggle-wrap {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .toggle-lid {
      --lid-bg: var(--gray-600, #4b5563);
      --track-bg: var(--gray-700, #374151);
      --accent: var(--color-yellow, #facc15);

      display: flex;
      align-items: center;
      width: 3.4rem;
      /* Height-only match to the buttons and the .check pill (s2s-check): the
         pill's computed height is 2×0.25rem vertical padding + 2×1px border +
         the 0.85rem mono line box (0.85rem × 1.55). Box-sizing + reduced
         padding keep the knob inside and the switch same-height as the row. */
      height: calc(0.25rem * 2 + 1px * 2 + 0.85rem * 1.55);
      box-sizing: border-box;
      padding: 0.2rem;
      background: var(--track-bg);
      border-radius: 2.4rem;
      cursor: pointer;
      transition: all 0.3s ease-in-out;
    }

    .toggle-knob {
      --icon-color: var(--gray-400, #9ca3af);
      display: flex;
      justify-content: center;
      align-items: center;
      width: 1.4rem;
      height: 1.4rem;
      position: relative;
      background: var(--lid-bg);
      border-radius: 50%;
      transition: all 0.3s ease-in-out;
      box-shadow: 0 0 8px rgba(0, 0, 0, 0.3);
    }

    .toggle-knob::before,
    .toggle-knob::after {
      content: "";
      position: absolute;
      width: 0.25rem;
      height: 1.1rem;
      background: var(--icon-color);
      transition: all 0.3s ease-in-out;
    }

    .toggle-knob::before {
      transform: rotate(45deg);
    }

    .toggle-knob::after {
      transform: rotate(-45deg);
    }

    .toggle-lid.active {
      background: var(--accent);
    }

    .toggle-lid.active .toggle-knob {
      --icon-color: var(--accent);
      margin-left: 50%;
      background: var(--color-yellow-light, #fef3c7);
    }

    .toggle-lid.active .toggle-knob::before {
      transform: rotate(45deg) translate(0.125rem, -0.125rem);
    }

    .toggle-lid.active .toggle-knob::after {
      height: 0.85rem;
      transform: rotate(-45deg) translate(-0.25rem, -0.125rem);
    }

    .toggle-label {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      letter-spacing: 0.75px;
      text-transform: uppercase;
      color: var(--gray-300);
    }
  `;

  private handleToggle() {
    this.bool = !this.bool;
    this.dispatchEvent(
      new CustomEvent('toggle', {
        detail: { checked: this.bool },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    return html`
      <span class="toggle-wrap">
        <label class="toggle-lid${this.bool ? ' active' : ''}" @click=${this.handleToggle}>
          <span class="toggle-knob"></span>
        </label>
        <span class="toggle-label">${this.label}</span>
      </span>
    `;
  }
}
