import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

@customElement('copy-link')
export class CopyLink extends LitElement {
  @property() value = '';
  @property() label = '';
  @property({ type: Boolean, reflect: true }) used = false;

  @state() private copied = false;
  private timeout: number | null = null;

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }

    :host([used]) a {
      color: #9ca3af;
    }

    a {
      margin: 0;
      color: var(--color-too-dark);
      text-decoration: none;
      user-select: all;
      word-break: break-all;
    }

    a:hover {
      text-decoration: underline;
    }

    button {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.15rem;
      border-radius: 3px;
      color: #666;
      transition: color 0.2s ease;
    }

    button:hover {
      color: #fff;
    }

    button.copied {
      color: #2e7d32;
    }

    .btn-copy {
      margin-left: 1.5rem;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (!this.value) this.value = this.textContent?.trim() || '';
    if (!this.label) this.label = this.getAttribute('label') || '';
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timeout) clearTimeout(this.timeout);
  }

  private async copy() {
    try {
      await navigator.clipboard.writeText(this.value);
      this.copied = true;
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = window.setTimeout(() => {
        this.copied = false;
      }, 1500);
    } catch (e) {
      console.error('Copy failed', e);
    }
  }

  render() {
    return html`
      <a href=${this.value} target="_blank" rel="noopener noreferrer">${this.label}</a>

      <button class="btn-copy ${this.copied ? 'copied' : ''}" aria-label="Copy to clipboard" @click=${this.copy}>
        ${this.copied
          ? html`<ph-check size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-check>`
          : html`<ph-copy size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-copy>`}
      </button>

      <button class="btn-open" aria-label="Open link"
        @click=${() => window.open('https://basescan.org/address/' + this.value, '_blank', 'noopener,noreferrer')}>
        <ph-arrow-square-out size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-square-out>
      </button>
    `;
  }
}
