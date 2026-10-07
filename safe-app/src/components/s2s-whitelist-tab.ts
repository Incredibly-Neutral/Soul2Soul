// s2s-whitelist-tab.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { tableStyles } from '@/styles/table-styles.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

@customElement('s2s-whitelist-tab')
export class S2SWhitelistTab extends LitElement {
  @property({ attribute: false }) safeIntegration!: SafeIntegration;

  @state() private loading = true;
  @state() private authors: string[] = [];
  @state() private devs: string[] = [];
  @state() private activeSection: 'authors' | 'devs' = 'authors';

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

      .add-form {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 1rem;
        margin-bottom: 1.5rem;
      }

      @media (max-width: 768px) {
        .add-form { grid-template-columns: 1fr; }
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

      .button.thin {
        padding: 0.25rem .5rem;
        padding: 0.125rem .5rem;
        border: none;
        height: 2rem;
        margin-left: .5rem;
        font-size: .875rem;
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }

      .table {
        grid-template-columns: 1fr auto;
      }

      .check-form {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 1rem;
        margin-bottom: 1.5rem;
      }

      @media (max-width: 768px) {
        .check-form { grid-template-columns: 1fr; }
      }

      .info-box {
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 0.5rem;
        padding: 1rem;
        margin-bottom: 2rem;
        color: #1e40af;
        font-size: 0.875rem;
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

  private async checkCanPublish(address: string) {
    if (!address.trim()) {
      this.showNotification('Address cannot be empty', 'error');
      return;
    }

    if (!this.isValidAddress(address)) {
      this.showNotification('Invalid Ethereum address', 'error');
      return;
    }

    try {
      const canPublish = await this.safeIntegration.canPublish(address);
      this.showNotification(
        canPublish
          ? `✅ ${address} CAN publish`
          : `❌ ${address} CANNOT publish`,
        canPublish ? 'success' : 'error'
      );
    } catch (error) {
      console.error('Error checking publish permission:', error);
      this.showNotification('Failed to check permission', 'error');
    }
  }

  private isValidAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  private switchSection(section: 'authors' | 'devs') {
    this.activeSection = section;
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

  private addAuthorFromInput() {
    const input = this.renderRoot.querySelector('#add-author-input') as HTMLInputElement;
    const address = input?.value.trim() ?? '';
    if (address) {
      void this.addAuthor(address).then(() => {
        if (input) input.value = '';
      });
    }
  }

  private addDevFromInput() {
    const input = this.renderRoot.querySelector('#add-dev-input') as HTMLInputElement;
    const address = input?.value.trim() ?? '';
    if (address) {
      void this.addDev(address).then(() => {
        if (input) input.value = '';
      });
    }
  }

  private checkFromInput() {
    const input = this.renderRoot.querySelector('#check-address') as HTMLInputElement;
    const address = input?.value.trim() ?? '';
    if (address) {
      void this.checkCanPublish(address);
    }
  }

  render() {
    if (this.loading) {
      return html`<div class="loading"><p>Loading whitelists...</p></div>`;
    }

    return html`
      <!-- Authors -->
      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Authors (${this.authors.length})</h2>
        </div>

        ${this.authors.length > 0
          ? html`
              <div class="table">
                <div class="table-header">Address</div>
                <div class="table-header"></div>
                ${this.authors.map(
                  (author) => html`
                    <div class="table-row">
                      <div class="table-cell" style="font-family: monospace; font-size: 0.875rem; color: var(--gray-50);">
                        ${author}
                      </div>
                      <div class="table-cell">
                        <button class="button button-danger thin" data-address="${author}"
                          @click=${() => void this.removeAuthor(author)}>
                          <ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x> Remove
                        </button>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`
              <div class="empty-state">
                <div>✍️</div>
                <p>No authors whitelisted yet</p>
              </div>
            `}
        <div class="add-form">
          <input type="text" class="input" placeholder="Author Address (0x...)" id="add-author-input" />
          <button class="button" id="add-author-btn" @click=${this.addAuthorFromInput}>Add Author</button>
        </div>
      </div>

      <!-- Devs -->
      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Developers (${this.devs.length})</h2>
        </div>
        ${this.devs.length > 0
          ? html`
              <div class="table">
                <div class="table-header">Address</div>
                <div class="table-header"></div>
                ${this.devs.map(
                  (dev) => html`
                    <div class="table-row">
                      <div class="table-cell" style="font-family: monospace; font-size: 0.875rem; color: var(--gray-50);">
                        ${dev}
                      </div>
                      <div class="table-cell">
                        <button class="button button-danger thin" data-address="${dev}"
                          @click=${() => void this.removeDev(dev)}>
                          <ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x> Remove
                        </button>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`
              <div class="empty-state">
                <div>👨‍💻</div>
                <p>No developers whitelisted yet</p>
              </div>
            `}

        <div class="add-form">
          <input type="text" class="input" placeholder="Developer Address (0x...)" id="add-dev-input" />
          <button class="button" id="add-dev-btn" @click=${this.addDevFromInput}>Add Developer</button>
        </div>
        <p class="section-description">Check if an address has permission to publish</p>
        <div class="check-form">
          <input type="text" class="input" placeholder="Address (0x...)" id="check-address" />
          <button class="button" id="check-btn" @click=${this.checkFromInput}>Check</button>
        </div>
      </div>
    `;
  }
}
