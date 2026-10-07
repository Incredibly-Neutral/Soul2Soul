import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

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

    svg {
      width: 18px;
      height: 18px;
      stroke: var(--color-too-dark);
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
          ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>`
          : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>`}
      </button>

      <button class="btn-open" aria-label="Open link"
        @click=${() => window.open('https://basescan.org/address/' + this.value, '_blank', 'noopener,noreferrer')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      </button>
    `;
  }
}
