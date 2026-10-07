import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('copy-content-id')
export class CopyContentId extends LitElement {
  @property() value = '';
  @property() display = '';

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
      color: #fff;
    }

    button.copied {
      color: #2e7d32;
    }

    svg {
      width: 16px;
      height: 16px;
      stroke: var(--color-too-dark);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (!this.value) this.value = this.textContent?.trim() || '';
    if (!this.display) this.display = this.getAttribute('display') || this.value;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timeout) clearTimeout(this.timeout);
  }

  private async copy() {
    try {
      // execCommand('copy') directly — in the Safe iframe the async
      // Clipboard API is blocked by permissions policy, so skip it.
      const textarea = document.createElement('textarea');
      textarea.value = this.value;
      textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      if (!document.execCommand('copy')) throw new Error('execCommand copy failed');
      document.body.removeChild(textarea);

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
      <span class="text" style="font-family: ${this.display.length < 20 ? 'inherit' : 'monospace'};" title=${this.value}>
        ${this.display}
      </span>
      <button
        class="${this.copied ? 'copied' : ''}"
        aria-label="Copy content ID to clipboard"
        @click=${(e: Event) => {
          e.stopPropagation();
          this.copy();
        }}
      >
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
