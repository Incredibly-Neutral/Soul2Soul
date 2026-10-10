import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';

/**
 * s2s-button — gradient border button.
 *
 * Single <button>, no wrapper. The border is a gradient background layer
 * clipped to border-box with a solid fill layer clipped to padding-box on
 * top, so the visible outline is a gradient while the face stays opaque.
 *
 * The gradient runs top→bottom from the accent color down to the original
 * button border color (--gray-600). On hover/focus the two stops switch, so
 * the border slowly cross-fades (500ms) as the accent moves to the bottom.
 *
 * Button types: the accent color is the differentiator. `type` selects a
 * CID-palette accent; consumers can also override --gb-accent from outside.
 *   default  → yellow  (--color-yellow)
 *   offer    → purple  (--color-purple)
 *   deal     → blue    (--color-blue)
 *   success  → green   (--color-green)
 *   danger   → red     (--color-red)
 *
 * Variants:
 *   fade (default) — the vertical accent→gray border switches on hover
 *   spin           — the border is a conic gradient that rotates while hovered
 *
 * `@property` registers the animated custom props so the border actually
 * interpolates; browsers without it still render the gradient (hover just
 * snaps). Reduced motion is respected (transition/animation disabled).
 *
 * data-* forwarding: `action`, `genesis` and `status` render as
 * data-action / data-genesis / data-status on the real <button>, so existing
 * row wiring and tests that target the button keep working. Clicks on the
 * inner button bubble (composed) to this host, so consumers attach @click on
 * the <s2s-button> itself.
 */
@customElement('s2s-button')
export class S2SButton extends LitElement {
  /** Rendered as data-action on the inner <button>. */
  @property() action = '';
  /** Rendered as data-genesis on the inner <button>. */
  @property() genesis = '';
  /** Rendered as data-status on the inner <button>. */
  @property() status = '';
  /** Forwards to the inner <button> disabled attribute. */
  @property({ type: Boolean }) disabled = false;
  /** 'fade' (default) or 'spin' border animation. */
  @property() variant: 'fade' | 'spin' = 'fade';
  /** Accent color selector — the gradient color is the differentiator. */
  @property() type: 'default' | 'offer' | 'deal' | 'success' | 'danger' = 'default';

  static styles = css`
    @property --gb-c1 {
      syntax: '<color>';
      inherits: false;
      initial-value: #fcd34d;
    }
    @property --gb-c2 {
      syntax: '<color>';
      inherits: false;
      initial-value: #5f564b;
    }
    @property --gb-angle {
      syntax: '<angle>';
      inherits: false;
      initial-value: 0deg;
    }

    :host {
      display: inline-flex;
      /* Accent (top stop) — the per-type differentiator. */
      --gb-accent: var(--color-yellow, #fcd34d);
    }
    :host([type='offer']) {
      --gb-accent: var(--color-purple, #d8b4fe);
    }
    :host([type='deal']) {
      --gb-accent: var(--color-blue, #93c5fd);
    }
    :host([type='success']) {
      --gb-accent: var(--color-green, #6ee7b7);
    }
    :host([type='danger']) {
      --gb-accent: var(--color-red, #db4233);
    }

    button {
      --gb-c1: var(--gb-accent);
      /* Bottom stop — the original button border color. */
      --gb-c2: var(--gray-600, #5f564b);
      --gb-fill: var(--gray-900, #1a1714);

      font-family: var(--font-mono);
      font-size: 0.78rem;
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      line-height: 1rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      padding: 0.35rem 0.7rem;
      border: 1px solid transparent;
      border-radius: 6px;
      color: #fff;
      cursor: pointer;

      background:
        linear-gradient(var(--gb-fill), var(--gb-fill)) padding-box,
        linear-gradient(180deg, var(--gb-c1), var(--gb-c2)) border-box;

      transition: --gb-c1 0.5s ease, --gb-c2 0.5s ease;
    }

    button:hover:not(:disabled),
    button:focus-visible {
      --gb-c1: var(--gray-600, #5f564b);
      --gb-c2: var(--gb-accent);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.spin {
      background:
        linear-gradient(var(--gb-fill), var(--gb-fill)) padding-box,
        conic-gradient(
          from var(--gb-angle),
          var(--gb-c1),
          var(--gb-c2),
          var(--gb-accent),
          var(--gb-c1)
        ) border-box;
    }

    button.spin:hover:not(:disabled),
    button.spin:focus-visible {
      animation: gb-spin 3s linear infinite;
    }

    @keyframes gb-spin {
      to {
        --gb-angle: 360deg;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      button {
        transition-duration: 0s;
      }
      button.spin:hover:not(:disabled),
      button.spin:focus-visible {
        animation: none;
      }
    }
  `;

  render() {
    return html`
      <button
        type="button"
        class="${this.variant === 'spin' ? 'spin' : ''}"
        ?disabled=${this.disabled}
        data-action=${ifDefined(this.action || undefined)}
        data-genesis=${ifDefined(this.genesis || undefined)}
        data-status=${ifDefined(this.status || undefined)}
      ><slot></slot></button>
    `;
  }
}
