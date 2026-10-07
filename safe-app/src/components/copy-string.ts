import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('copy-string')
export class CopyString extends LitElement {
  @property() value = '';

  @state() private copied = false;
  private timeout: number | null = null;

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }

    .text {
      margin: 0;
      user-select: all;
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
      color: #1a1a1a;
    }

    button.copied {
      color: #2e7d32;
    }

    svg {
      width: 14px;
      height: 14px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (!this.value) {
      this.value = this.textContent?.trim() || '';
    }
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
      <span class="text">${this.value}</span>
      <button class="${this.copied ? 'copied' : ''}" aria-label="Copy to clipboard" @click=${this.copy}>
        ${this.copied
          ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>`
          : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>`}
      </button>
    `;
  }
}
