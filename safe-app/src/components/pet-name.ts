// pet-name.ts
//
// Display an address with an optional user-assigned "pet name". The pet name
// lives only in the browser (localStorage + in-memory state) — it is never
// sent over the network, so on-chain identities stay pseudonymous: everyone
// sees the raw address, each viewer sees only the names they chose.
//
// Render modes:
//   1. display = the pet name, if this address has one (full address in title)
//   2. otherwise the shortened address (0x1234…abcd)
// Copy button copies the full address; the pencil swaps the label for an
// inline input to set / edit / clear the pet name.
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { petNameStore } from '@/state/pet-name.store.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

@customElement('pet-name')
export class PetName extends LitElement {
  /** Full address this pet name is attached to (e.g. an author's 0x…). */
  @property() value = '';
  /** Optional caller-provided label; falls back to pet name, then truncation. */
  @property() display = '';
  /** Placeholder shown in the inline input while naming. */
  @property() placeholder = 'Name this address';

  @state() private copied = false;
  @state() private editing = false;
  @state() private draft = '';
  private timeout: number | null = null;
  private unsub: (() => void) | null = null;

  static styles = [
    typograhyStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        min-width: 0;
      }

      .text {
        margin: 0;
        user-select: all;
        font-family: var(--font-mono, 'Monaco', 'Menlo', 'Ubuntu Mono', monospace);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .text.has-name {
        color: var(--color-yellow);
        font-weight: 600;
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

      button.btn-cancel:hover {
        color: var(--color-red);
      }

      .pet-input {
        font-family: var(--font-mono, 'Monaco', 'Menlo', 'Ubuntu Mono', monospace);
        font-size: 0.8rem;
        background: var(--gray-800);
        color: var(--gray-50);
        border: 1px solid var(--color-yellow);
        border-radius: 3px;
        padding: 0.1rem 0.4rem;
        width: 11rem;
        max-width: 100%;
        outline: none;
      }

      .pet-input::placeholder {
        color: var(--gray-500);
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    if (!this.value) this.value = this.textContent?.trim() || '';
    // Reflect pet-name edits made anywhere (the same address can appear in
    // several rows) live. The store only emits on an actual change.
    this.unsub = petNameStore.subscribe(() => this.requestUpdate());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    if (this.timeout) clearTimeout(this.timeout);
  }

  private truncate(str: string): string {
    if (!str) return '';
    if (str.length <= 8) return str;
    return `${str.slice(0, 4)}...${str.slice(-4)}`;
  }

  private startEditing(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.draft = petNameStore.get(this.value) ?? '';
    this.editing = true;
  }

  private cancelEditing(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.editing = false;
    this.draft = '';
  }

  private save(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    // An empty draft clears the pet name (back to shortened address).
    petNameStore.set(this.value, this.draft);
    this.editing = false;
    this.draft = '';
  }

  private onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.save(e);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelEditing(e);
    }
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
    if (this.editing) {
      return html`
        <span class="text" @click=${(e: Event) => e.stopPropagation()}>
          <input
            class="pet-input"
            .value=${this.draft}
            placeholder=${this.placeholder}
            maxlength="40"
            aria-label="Pet name"
            @input=${(e: Event) => {
              this.draft = (e.target as HTMLInputElement).value;
            }}
            @keydown=${this.onKeydown}
          />
          <button
            class="btn-save"
            aria-label="Save pet name"
            title="Save pet name"
            @click=${this.save}
          >
            <ph-check size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-check>
          </button>
          <button
            class="btn-cancel"
            aria-label="Cancel"
            title="Cancel"
            @click=${this.cancelEditing}
          >
            <ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x>
          </button>
        </span>
      `;
    }

    const pet = petNameStore.get(this.value);
    const shown = pet ?? (this.display || this.truncate(this.value) || '—');

    return html`
      <span class="text ${pet ? 'has-name' : ''}" title=${this.value}>${shown}</span>
      <button
        class="${this.copied ? 'copied' : ''}"
        aria-label="Copy full address"
        title="Copy full address"
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
      <button
        class="btn-edit"
        aria-label="Set pet name"
        title="Set pet name"
        @click=${this.startEditing}
      >
        <ph-pencil-simple size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-pencil-simple>
      </button>
    `;
  }
}
