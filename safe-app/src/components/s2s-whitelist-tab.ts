// s2s-whitelist-tab.ts
import { tableStyles } from '@/styles/table-styles.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';

export class S2SWhitelistTab extends HTMLElement {
  public safeIntegration!: SafeIntegration;
  private loading = true;
  private authors: string[] = [];
  private devs: string[] = [];
  private activeSection: 'authors' | 'devs' = 'authors';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [typograhyStyles, sectionStyles, tableStyles, buttonStyles, sectionStyles];
  }

  async connectedCallback() {
    console.log('Whitelist tab connected');
    await this.loadWhitelists();
    this.render();
  }

  private async loadWhitelists() {
    this.loading = true;
    this.render();

    try {
      [this.authors, this.devs] = await Promise.all([
        this.safeIntegration.getWhitelistedAuthors(),
        this.safeIntegration.getWhitelistedDevs()
      ]);
      
      console.log('Authors:', this.authors);
      console.log('Devs:', this.devs);
    } catch (error) {
      console.error('Error loading whitelists:', error);
    }

    this.loading = false;
    this.render();
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
      this.authors.push(address);
      this.render();
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
      this.authors = this.authors.filter(a => a !== address);
      this.render();
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
      this.devs.push(address);
      this.render();
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
      this.devs = this.devs.filter(d => d !== address);
      this.render();
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
    this.render();
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

  private render() {
  if (!this.shadowRoot) return;

  this.shadowRoot.innerHTML = `
    <style>
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

    </style>

    ${this.loading ? `
      <div class="loading"><p>Loading whitelists...</p></div>
    ` : `

      <!-- Check Permission -->
      <div class="section">
      
     

      <!-- Authors -->
      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Authors (${this.authors.length})</h2>
        </div>

        ${this.authors.length > 0 ? `
          <div class="table">
            <div class="table-header">Address</div>
            <div class="table-header"></div>
            ${this.authors.map(author => `
              <div class="table-row">
                <div class="table-cell" style="font-family: monospace; font-size: 0.875rem; color: var(--gray-50);">
                  ${author}
                </div>
                <div class="table-cell">
                  <button class="button button-danger thin" data-action="remove-author" data-address="${author}">
                    ✗ Remove
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="empty-state">
            <div>✍️</div>
            <p>No authors whitelisted yet</p>
          </div>
        `}
        <div class="add-form">
          <input type="text" class="input" placeholder="Author Address (0x...)" id="add-author-input" />
          <button class="button" id="add-author-btn">Add Author</button>
        </div>
      </div>

      <!-- Devs -->
      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Developers (${this.devs.length})</h2>
        </div>
        ${this.devs.length > 0 ? `
          <div class="table">
            <div class="table-header">Address</div>
            <div class="table-header"></div>
            ${this.devs.map(dev => `
              <div class="table-row">
                <div class="table-cell" style="font-family: monospace; font-size: 0.875rem; color: var(--gray-50);">
                  ${dev}
                </div>
                <div class="table-cell">
                  <button class="button button-danger thin" data-action="remove-dev" data-address="${dev}">
                    ✗ Remove
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="empty-state">
            <div>👨‍💻</div>
            <p>No developers whitelisted yet</p>
          </div>
        `}

         <div class="add-form">
          <input type="text" class="input" placeholder="Developer Address (0x...)" id="add-dev-input" />
          <button class="button" id="add-dev-btn">Add Developer</button>
        </div>
        <p class="section-description">Check if an address has permission to publish</p>
        <div class="check-form">
          <input type="text" class="input" placeholder="Address (0x...)" id="check-address" />
          <button class="button" id="check-btn">Check</button>
        </div>
      </div>
    `}
  `;

  if (!this.loading) {
    this.attachEventListeners();
  }
}

  private attachEventListeners() {
    // Tab switching
    const authorsTab = this.shadowRoot?.querySelector('#authors-tab');
    const devsTab = this.shadowRoot?.querySelector('#devs-tab');
    
    authorsTab?.addEventListener('click', () => this.switchSection('authors'));
    devsTab?.addEventListener('click', () => this.switchSection('devs'));

    // Check permission
    const checkBtn = this.shadowRoot?.querySelector('#check-btn');
    const checkInput = this.shadowRoot?.querySelector('#check-address') as HTMLInputElement;
    
    checkBtn?.addEventListener('click', () => {
      const address = checkInput?.value.trim();
      if (address) {
        this.checkCanPublish(address);
      }
    });

    // Add author
    const addAuthorBtn = this.shadowRoot?.querySelector('#add-author-btn');
    const addAuthorInput = this.shadowRoot?.querySelector('#add-author-input') as HTMLInputElement;
    
    addAuthorBtn?.addEventListener('click', () => {
      const address = addAuthorInput?.value.trim();
      if (address) {
        this.addAuthor(address).then(() => {
          addAuthorInput.value = '';
        });
      }
    });

    // Add dev
    const addDevBtn = this.shadowRoot?.querySelector('#add-dev-btn');
    const addDevInput = this.shadowRoot?.querySelector('#add-dev-input') as HTMLInputElement;
    
    addDevBtn?.addEventListener('click', () => {
      const address = addDevInput?.value.trim();
      if (address) {
        this.addDev(address).then(() => {
          addDevInput.value = '';
        });
      }
    });

    // Remove actions
    this.shadowRoot?.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const action = target.dataset.action;
        const address = target.dataset.address;
        
        if (!address) return;
        
        if (action === 'remove-author') {
          this.removeAuthor(address);
        } else if (action === 'remove-dev') {
          this.removeDev(address);
        }
      });
    });
  }
}

customElements.define('s2s-whitelist-tab', S2SWhitelistTab);