// s2s-whitelist-tab.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { tableStyles } from '@/styles/table-styles.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import './s2s-check.js';
import './s2s-sliding-add-button.js';
import './copy-hash.js';
import './pet-name.js';

@customElement('s2s-whitelist-tab')
export class S2SWhitelistTab extends LitElement {
  @property({ attribute: false }) safeIntegration!: SafeIntegration;

  @state() private loading = true;
  @state() private authors: string[] = [];
  @state() private devs: string[] = [];
  @state() private pubCheck: {
    result: 'idle' | 'pending' | 'pass' | 'fail' | 'error';
    message: string;
  } = { result: 'idle', message: '' };

  static styles = [
    typograhyStyles,
    sectionStyles,
    tableStyles,
    buttonStyles,
    css`
      :host {
        display: block;
        padding: 2rem 0;
        background: var(--gray-900);
      }

      .section {
        margin-bottom: 3rem;
      }

      .alias-pills {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.75rem;
      }

      .alias-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.25rem 0.75rem;
        border-radius: 999px;
        background: var(--gray-800);
        border: 1px solid var(--gray-600);
        color: var(--gray-50);
        font-family: var(--font-mono);
        font-size: 0.85rem;
      }

      .alias-pill__remove {
        display: inline-flex;
        align-items: center;
        padding: 0;
        margin: 0;
        background: transparent;
        border: none;
        color: var(--gray-400);
        cursor: pointer;
      }

      .alias-pill__remove:hover {
        color: var(--color-red);
      }

      .input {
        padding: 0.75rem 1rem;
        border: 1px solid var(--gray-200);
        background: var(--gray-50);
        border-radius: 0.5rem;
        font-size: 1rem;
        font-family: 'Monaco', 'Menlo', monospace;
      }

      .input:focus {
        outline: none;
        border-color: var(--color-yellow);
      }

      .empty-state {
        text-align: center;
        padding: 3rem;
        color: #6b7280;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    console.log('Whitelist tab connected');
    void this.loadWhitelists();
  }

  private async loadWhitelists() {
    this.loading = true;

    try {
      [this.authors, this.devs] = await Promise.all([
        this.safeIntegration.getWhitelistedAuthors(),
        this.safeIntegration.getWhitelistedDevs(),
      ]);

      console.log('Authors:', this.authors);
      console.log('Devs:', this.devs);
    } catch (error) {
      console.error('Error loading whitelists:', error);
    }

    this.loading = false;
  }

  private async addAuthor(address: string) {
    if (!address.trim()) {
      this.showNotification('Address cannot be empty', 'error');
      return;
    }

    if (!this.isValidAddress(address)) {
      this.showNotification('Invalid Ethereum address', 'error');
      return;
    }

    if (this.authors.includes(address)) {
      this.showNotification('Author already whitelisted', 'error');
      return;
    }

    try {
      await this.safeIntegration.whitelistAuthor(address);
      this.showNotification('Author whitelisted! Transaction pending approval.', 'success');

      // Optimistically update
      this.authors = [...this.authors, address];
    } catch (error) {
      console.error('Error whitelisting author:', error);
      this.showNotification('Failed to whitelist author. Please try again.', 'error');
    }
  }

  private async removeAuthor(address: string) {
    if (!confirm(`Remove ${address} from author whitelist?`)) {
      return;
    }

    try {
      await this.safeIntegration.removeWhitelistedAuthor(address);
      this.showNotification('Author removed! Transaction pending approval.', 'success');

      // Optimistically update
      this.authors = this.authors.filter((a) => a !== address);
    } catch (error) {
      console.error('Error removing author:', error);
      this.showNotification('Failed to remove author. Please try again.', 'error');
    }
  }

  private async addDev(address: string) {
    if (!address.trim()) {
      this.showNotification('Address cannot be empty', 'error');
      return;
    }

    if (!this.isValidAddress(address)) {
      this.showNotification('Invalid Ethereum address', 'error');
      return;
    }

    if (this.devs.includes(address)) {
      this.showNotification('Dev already whitelisted', 'error');
      return;
    }

    try {
      await this.safeIntegration.whitelistDev(address);
      this.showNotification('Dev whitelisted! Transaction pending approval.', 'success');

      // Optimistically update
      this.devs = [...this.devs, address];
    } catch (error) {
      console.error('Error whitelisting dev:', error);
      this.showNotification('Failed to whitelist dev. Please try again.', 'error');
    }
  }

  private async removeDev(address: string) {
    if (!confirm(`Remove ${address} from dev whitelist?`)) {
      return;
    }

    try {
      await this.safeIntegration.removeWhitelistedDev(address);
      this.showNotification('Dev removed! Transaction pending approval.', 'success');

      // Optimistically update
      this.devs = this.devs.filter((d) => d !== address);
    } catch (error) {
      console.error('Error removing dev:', error);
      this.showNotification('Failed to remove dev. Please try again.', 'error');
    }
  }

  /**
   * Parent-driven 'check if address can publish' verification (s2s-check).
   * Validates the address, then asks SafeIntegration.canPublish and reflects
   * the outcome back onto <s2s-check> via .result / .message.
   */
  private async runPubCheck(address: string) {
    if (!this.isValidAddress(address)) {
      this.pubCheck = { result: 'error', message: 'invalid address' };
      return;
    }

    this.pubCheck = { result: 'pending', message: '' };
    try {
      const canPublish = await this.safeIntegration.canPublish(address);
      this.pubCheck = {
        result: canPublish ? 'pass' : 'fail',
        message: canPublish ? 'can publish' : 'cannot publish',
      };
    } catch (error) {
      console.error('Error checking publish permission:', error);
      this.pubCheck = { result: 'error', message: 'check failed' };
    }
  }

  private isValidAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  private showNotification(message: string, type: 'success' | 'error') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 16px 24px;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      z-index: 1000;
      max-width: 400px;
      background: ${type === 'success' ? '#10b981' : '#ef4444'};
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 5000);
  }

  render() {
    if (this.loading) {
      return html`<div class="loading"><p>Loading whitelists...</p></div>`;
    }

    return html`
    
      <div class="section">
        <s2s-check
            label="check if address can publish"
            placeholder="0x… address"
            .result=${this.pubCheck.result}
            .message=${this.pubCheck.message}
            @s2s-check=${(e: CustomEvent) => void this.runPubCheck(e.detail.value)}
          ></s2s-check>
      </div>
      <!-- Authors -->
      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Authors (${this.authors.length})</h2>
        </div>

        <div class="alias-pills">
          ${this.authors.map(
            (author) => html`
              <span class="alias-pill">
                <pet-name value=${author}></pet-name>
                <button
                  class="alias-pill__remove"
                  data-address="${author}"
                  aria-label="Remove ${author}"
                  title="Remove ${author}"
                  @click=${() => void this.removeAuthor(author)}
                >
                  <ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x>
                </button>
              </span>
            `,
          )}
          <s2s-sliding-add-button
            placeholder="Author address (0x...)"
            buttonLabel="Add author"
            @s2s-sliding-add=${(e: CustomEvent) => void this.addAuthor(e.detail.value)}
          ></s2s-sliding-add-button>
        </div>

        ${this.authors.length === 0
          ? html`
              <div class="empty-state">
                <div>✍️</div>
                <p>No authors whitelisted yet</p>
              </div>
            `
          : ''}
      </div>

      <!-- Devs -->
      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Developers (${this.devs.length})</h2>
        </div>

        <div class="alias-pills">
          ${this.devs.map(
            (dev) => html`
              <span class="alias-pill">
                <pet-name value=${dev}></pet-name>
                <button
                  class="alias-pill__remove"
                  data-address="${dev}"
                  aria-label="Remove ${dev}"
                  title="Remove ${dev}"
                  @click=${() => void this.removeDev(dev)}
                >
                  <ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x>
                </button>
              </span>
            `,
          )}
          <s2s-sliding-add-button
            placeholder="Developer address (0x...)"
            buttonLabel="Add developer"
            @s2s-sliding-add=${(e: CustomEvent) => void this.addDev(e.detail.value)}
          ></s2s-sliding-add-button>
        </div>
      </div>
    `;
  }
}
