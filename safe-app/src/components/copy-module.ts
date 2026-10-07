import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('copy-module')
export class CopyModule extends LitElement {
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
      text-transform: uppercase;
    }

    button {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.15rem;
      border-radius: 3px;
      color: var(--gray-50);
      transition: color 0.2s ease;
    }

    button:hover {
      color: #fff;
    }

    svg {
      width: 18px;
      height: 18px;
      stroke: var(--gray-50);
    }

    .btn-copy {
      margin-left: 0;
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
      await this.writeToClipboard(this.value);
      this.copied = true;
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = window.setTimeout(() => {
        this.copied = false;
      }, 1500);
    } catch (e) {
      console.error('Copy failed', e);
    }
  }

  private async writeToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to legacy fallback
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      if (!document.execCommand('copy')) throw new Error('execCommand copy failed');
    } finally {
      document.body.removeChild(textarea);
    }
  }

  render() {
    return html`
      ${this.label}

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
