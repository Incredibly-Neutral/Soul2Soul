import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { breakpoints } from '@/styles/breakpoints.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

@customElement('copy-hash')
export class CopyHash extends LitElement {
  @property() value = '';
  /** Optional gateway URL — when set, renders an open-in-new-tab icon button. */
  @property() href = '';
  /** Optional display text — when set, shown instead of the auto-truncated value. */
  @property() display = '';

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
        color: var(--color-yellow);
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

  private openGateway() {
    if (!this.href) return;
    window.open(this.href, '_blank', 'noopener,noreferrer');
  }

  render() {
    return html`
      <span class="text" title=${this.value}>${this.display || this.truncate(this.value)}</span>
      <button
        class="${this.copied ? 'copied' : ''}"
        aria-label="Copy to clipboard"
        @click=${(e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          this.copy();
        }}
      >
        ${this.copied
          ? html`<ph-check size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-check>`
          : html`<ph-copy size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-copy>`}
      </button>
      ${this.href
        ? html`<button
            class="btn-open"
            aria-label="Open on IPFS gateway"
            title="Open on IPFS gateway"
            @click=${(e: Event) => {
              e.preventDefault();
              e.stopPropagation();
              this.openGateway();
            }}
          >
            <ph-arrow-square-out size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-square-out>
          </button>`
        : nothing}
    `;
  }
}
