// s2s-check.ts — generic single-action check control.
//
// Ports the crude inline check forms (whitelist "can publish", deals "genesis
// has a deal") into a reusable LitElement: a border-only pill that blends in,
// holding a mono value input and a check icon button. Clicking the button (or
// pressing Enter in the input) trims the value
// and dispatches a composed bubbling CustomEvent `s2s-check` with
// detail { value }. 100% presentational + input handling — no store/contract/
// Safe knowledge lives here. The consumer runs the async verification and
// pushes `.result` (+ optional `.message`) back; the pill reflects the state
// subtly (border + icon color) and nothing more.

import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

/** Parent-driven result state of a check. */
export type S2SCheckResult = 'idle' | 'pending' | 'pass' | 'fail' | 'error';

@customElement('s2s-check')
export class S2SCheck extends LitElement {
  /** Descriptive label used as the input's aria-label fallback (no longer rendered). */
  @property({ type: String }) label = '';

  /** Placeholder hint for the value input, e.g. '0x… address'. */
  @property({ type: String }) placeholder = '';

  /**
   * Parent-driven result state, reflected so the pill can style itself:
   *   pass → green border + ph-check · fail → red border + ph-x ·
   *   error → yellow border · pending → dimmed/disabled input.
   */
  @property({ type: String, reflect: true }) result: S2SCheckResult = 'idle';

  /** Optional short result text rendered muted beside the pill. */
  @property({ type: String }) message = '';

  /** Current input value. */
  @state() private value = '';

  /** True from submit until the parent pushes a non-idle result back. */
  @state() private submitting = false;

  static styles = [
    typograhyStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 0.6rem;
        font-family: var(--font-mono);
        font-size: 0.85rem;
      }

      /* Border-only pill that blends in. Fixed height matches the .alias-pill
         (s2s-records-tab): 2×0.25rem vertical padding + 2×1px border + the
         0.85rem mono line box (0.85rem × 1.55 inherited line-height). */
      .check {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        box-sizing: border-box;
        height: calc(0.25rem * 2 + 1px * 2 + 0.85rem * 1.55);
        padding: 0 0.75rem;
        border-radius: 999px;
        border: 1px solid var(--gray-600);
        background: transparent;
      }

      .check__input {
        background: transparent;
        border: none;
        outline: none;
        padding: 0;
        min-width: 0;
        width: 11rem;
        font-family: var(--font-mono);
        font-size: 0.85rem;
        color: var(--gray-50);
      }

      .check__input::placeholder {
        color: var(--gray-500);
      }

      /* The only action affordance — a transparent check-icon button. */
      .check__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        margin: 0;
        background: transparent;
        border: none;
        color: var(--gray-300);
        cursor: pointer;
      }

      .check__btn:hover {
        color: var(--gray-50);
      }

      .check__btn:disabled,
      .check__input:disabled {
        cursor: default;
        opacity: 0.55;
      }

      /* Subtle result state — driven by the parent via the reflected attr. */
      :host([result='pending']) .check__input,
      :host([result='pending']) .check__btn {
        opacity: 0.55;
      }

      :host([result='pass']) .check {
        border-color: var(--color-green);
      }
      :host([result='pass']) .check__btn {
        color: var(--color-green);
      }

      :host([result='fail']) .check {
        border-color: var(--color-red);
      }
      :host([result='fail']) .check__btn {
        color: var(--color-red);
      }

      :host([result='error']) .check {
        border-color: var(--color-yellow);
      }
      :host([result='error']) .check__btn {
        color: var(--color-yellow);
      }

      .check__message {
        color: var(--gray-400);
        font-family: var(--font-mono);
        font-size: 0.75rem;
        white-space: nowrap;
      }
    `,
  ];

  private get input(): HTMLInputElement | null {
    return this.renderRoot.querySelector<HTMLInputElement>('.check__input');
  }

  willUpdate(changed: PropertyValues<this>) {
    // The parent owns the result: the moment it pushes any non-idle state back,
    // the submission is over and we re-enable the control.
    if (changed.has('result') && this.result !== 'idle') {
      this.submitting = false;
    }
  }

  /**
   * Trim the input value and dispatch the check. Empty input just refocuses
   * (no event). Called from the check button and Enter in the input.
   */
  private submit(): void {
    const trimmed = this.value.trim();
    if (!trimmed) {
      this.input?.focus();
      return;
    }
    this.submitting = true;
    // A fresh submission clears any previous (stale) result display; the parent
    // will push 'pending' then the terminal state back.
    this.result = 'idle';
    this.dispatchEvent(
      new CustomEvent('s2s-check', {
        detail: { value: trimmed },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onInput(e: Event): void {
    this.value = (e.target as HTMLInputElement).value;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      this.submit();
    }
  }

  /** Clear the value and reset result + message to idle. */
  reset(): void {
    this.value = '';
    this.result = 'idle';
    this.message = '';
    this.submitting = false;
  }

  render() {
    const busy = this.result === 'pending' || this.submitting;
    return html`
      <div class="check">
        <input
          class="check__input"
          type="text"
          .value=${this.value}
          placeholder=${this.placeholder}
          autocomplete="off"
          spellcheck="false"
          ?disabled=${busy}
          aria-label=${this.placeholder || this.label}
          @input=${this.onInput}
          @keydown=${this.onKeydown}
        />
        <button
          class="check__btn"
          type="button"
          ?disabled=${busy}
          aria-label="Run check"
          title="Run check"
          @click=${this.submit}
        >${
            this.result === 'fail'
              ? html`<ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x>`
              : html`<ph-check size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-check>`
          }</button>
      </div>
      ${
        this.message
          ? html`<span class="check__message">${this.message}</span>`
          : ''
      }
    `;
  }
}
