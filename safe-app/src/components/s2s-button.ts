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
 * The gradient runs top→bottom from the original button border color
 * (--gray-600) down to the accent color — the accent sits on the bottom.
 * On hover/focus the two stops switch, so the border slowly cross-fades
 * (500ms) as the accent moves to the top.
 *
 * Button types: the accent color is the differentiator. `type` selects a
 * CID-palette accent; consumers can also override --gb-accent from outside.
 *   primary   → yellow  (default; semi-transparent #fcd34d)
 *   secondary → purple  (--color-purple)
 *   warning   → red     (--color-red)
 *   deal      → blue    (--color-blue)
 *   success   → green   (--color-green)
 *
 * Variants:
 *   fade (default) — the vertical accent→gray border switches on hover
 *   spin           — the border is an asymmetric 2-stop linear gradient
 *                    whose angle animates 0deg → 360deg, so the accent
 *                    wedge visibly sweeps the full circle while hovered
 *                    (asymmetric pattern → every angle looks different,
 *                    unlike a symmetric gray→accent→gray which repeats
 *                    at 180° and reads as a half-swing)
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
  @property() type: 'primary' | 'secondary' | 'warning' | 'deal' | 'success' = 'primary';

  static styles = css`
    @property --gb-c1 {
      syntax: '<color>';
      inherits: false;
      initial-value: #5f564b;
    }
    @property --gb-c2 {
      syntax: '<color>';
      inherits: false;
      initial-value: #fcd34d;
    }
    @property --gb-angle {
      syntax: '<angle>';
      inherits: false;
      initial-value: 0deg;
    }

    :host {
      display: inline-flex;
      /* Accent (gradient color) — the per-type differentiator.
         All accents sit at 50% opacity so the bright stops read as soft
         glows instead of full-strength colors. */
      --gb-accent: rgba(252, 211, 77, 0.5);
    }
    :host([type='secondary']) {
      --gb-accent: rgba(216, 180, 254, 0.5);
    }
    :host([type='warning']) {
      --gb-accent: rgba(219, 66, 51, 0.5);
    }
    :host([type='deal']) {
      --gb-accent: rgba(147, 197, 253, 0.5);
    }
    :host([type='success']) {
      --gb-accent: rgba(110, 231, 183, 0.5);
    }

    button {
      /* Top stop — the original button border color. */
      --gb-c1: var(--gray-600, #5f564b);
      /* Bottom stop — the accent (per-type differentiator). */
      --gb-c2: var(--gb-accent);
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

    button:not(.spin):hover:not(:disabled),
    button:not(.spin):focus-visible {
      --gb-c1: var(--gb-accent);
      --gb-c2: var(--gray-600, #5f564b);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.spin {
      /* Set explicitly: a registered inherits:false angle that is never set on
         the element resolves to guaranteed-invalid inside a gradient in some
         Chromium versions (background computes to none). With an explicit
         value the gradient renders and the keyframes interpolate 0deg → 360deg.

         The gradient is a 2-stop LINEAR (not conic, not symmetric). The accent
         fills roughly half the border, and because the pattern is asymmetric
         (accent→gray, not gray→accent→gray) every angle looks different — the
         accent wedge visibly sweeps the full 360° instead of repeating at 180°. */
      --gb-angle: 0deg;
      background:
        linear-gradient(var(--gb-fill), var(--gb-fill)) padding-box,
        linear-gradient(var(--gb-angle), var(--gb-accent), var(--gb-c1)) border-box;
    }

    button.spin:hover:not(:disabled),
    button.spin:focus-visible {
      animation: gb-spin 2800ms linear infinite;
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
