import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

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
