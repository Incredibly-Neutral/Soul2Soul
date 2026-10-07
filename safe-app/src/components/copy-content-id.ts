import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

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
          ? html`<ph-check size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-check>`
          : html`<ph-copy size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-copy>`}
      </button>
    `;
  }
}
