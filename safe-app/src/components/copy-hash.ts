import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { breakpoints } from '@/styles/breakpoints.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

@customElement('copy-hash')
export class CopyHash extends LitElement {
  @property() value = '';

  @state() private copied = false;
  private timeout: number | null = null;

  static styles = [
    typograhyStyles,
    css`
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


    `,
  ];

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

  private truncate(str: string): string {
    if (str.length <= 4) return str;
    return window.innerWidth > breakpoints.md
      ? `${str.slice(0, 4)}...${str.slice(-4)}`
      : `..${str.slice(-3)}`;
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
      <span class="text" title=${this.value}>${this.truncate(this.value)}</span>
      <button
        class="${this.copied ? 'copied' : ''}"
        aria-label="Copy to clipboard"
        @click=${(e: Event) => {
          // A copy-hash may be rendered inside a gateway <a> link — stop the
          // anchor from navigating while still letting the click copy.
          e.preventDefault();
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
