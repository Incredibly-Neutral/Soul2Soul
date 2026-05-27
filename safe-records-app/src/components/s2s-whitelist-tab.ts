// s2s-whitelist-tab.ts
import { SafeIntegration } from '../lib/safe-integration.js';

export class S2SWhitelistTab extends HTMLElement {
  public safeIntegration!: SafeIntegration;
  private loading = true;
  private authors: string[] = [];
  private devs: string[] = [];
  private activeSection: 'authors' | 'devs' = 'authors';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
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
        }

        .section {
          margin-bottom: 3rem;
        }

        .section-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: #000;
          margin: 0 0 1rem 0;
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .section-description {
          color: #000;
          margin-bottom: 1.5rem;
        }

        .subsection-tabs {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 2rem;
          border-bottom: 1px solid #000;
        }

        .subsection-tab {
          padding: 0.75rem 1.5rem;
          border: none;
          background: transparent;
          color: #000;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          margin-bottom: -2px;
          transition: all 0.2s;
        }

        .subsection-tab:hover {
          color: #111827;
        }

        .subsection-tab.active {
          color: #5bba9d;
          border-bottom-color: #5bba9d;
        }

        .add-form,
        .check-form {
          display: grid;
          gap: 1rem;
          background: #f9fafb;
          padding: 1.5rem;
          border-radius: 0.5rem;
          border: 1px solid #e5e7eb;
          margin-bottom: 2rem;
        }

        .add-form {
          grid-template-columns: 1fr auto;
        }

        .check-form {
          grid-template-columns: 1fr auto;
        }

        @media (max-width: 768px) {
          .add-form,
          .check-form {
            grid-template-columns: 1fr;
          }
        }

        .input {
          padding: 0.75rem 1rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 1rem;
          font-family: 'Monaco', 'Menlo', monospace;
          transition: border-color 0.2s, box-shadow 0.2s;
        }

        .input:focus {
          outline: none;
          border-color: #5bba9d;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .button {
          background: #5bba9d;
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 0.5rem;
          cursor: pointer;
          font-size: 1rem;
          font-weight: 500;
          transition: background-color 0.2s, transform 0.1s;
          white-space: nowrap;
        }

        .button:hover {
          background: #5bba9d;
          transform: translateY(-1px);
        }

        .button:active {
          transform: translateY(0);
        }

        .button-danger {
          background: #ef4444;
        }

        .button-danger:hover {
          background: #dc2626;
        }

        .whitelist {
          display: grid;
          gap: 1rem;
        }

        .whitelist-item {
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 0.5rem;
          padding: 1rem 1.5rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .address {
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 0.875rem;
          color: #111827;
          word-break: break-all;
        }

        .stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .stat-card {
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 0.5rem;
          padding: 1.5rem;
        }

        .stat-label {
          font-size: 0.875rem;
          color: #6b7280;
          margin-bottom: 0.5rem;
        }

        .stat-value {
          font-size: 2rem;
          font-weight: 700;
          color: #111827;
        }

        .empty-state {
          text-align: center;
          padding: 3rem;
          color: #6b7280;
        }

        .empty-icon {
          font-size: 3rem;
          margin-bottom: 1rem;
        }

        .loading {
          text-align: center;
          padding: 3rem;
          color: #6b7280;
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
      </style>

      ${this.loading ? `
        <div class="loading">
          <p>Loading whitelists...</p>
        </div>
      ` : `
        <!-- Check Permission -->
        <div class="section">
          <h2 class="section-title">🔍 Check Publishing Permission</h2>
          <p class="section-description">Check if an address has permission to publish</p>
          
          <div class="check-form">
            <input 
              type="text" 
              class="input" 
              placeholder="Address (0x...)"
              id="check-address"
            />
            <button class="button" id="check-btn">
              Check Permission
            </button>
          </div>
        </div>

        <!-- Stats -->
        <div class="stats">
          <div class="stat-card">
            <div class="stat-label">Whitelisted Authors</div>
            <div class="stat-value">${this.authors.length}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Whitelisted Devs</div>
            <div class="stat-value">${this.devs.length}</div>
          </div>
        </div>

        <!-- Info -->
        <div class="info-box">
          ℹ️ <strong>Authors</strong> can offer deals and publish content. <strong>Devs</strong> can update the entire publication (including staging environments).
        </div>

        <!-- Tabs -->
        <div class="subsection-tabs">
          <button 
            class="subsection-tab ${this.activeSection === 'authors' ? 'active' : ''}"
            id="authors-tab"
          >
            ✍️ Authors (${this.authors.length})
          </button>
          <button 
            class="subsection-tab ${this.activeSection === 'devs' ? 'active' : ''}"
            id="devs-tab"
          >
            👨‍💻 Developers (${this.devs.length})
          </button>
        </div>

        <!-- Authors Section -->
        ${this.activeSection === 'authors' ? `
          <div class="section">
            <h3 class="section-title">➕ Add Author</h3>
            <div class="add-form">
              <input 
                type="text" 
                class="input" 
                placeholder="Author Address (0x...)"
                id="add-author-input"
              />
              <button class="button" id="add-author-btn">
                Add Author
              </button>
            </div>

            <h3 class="section-title">Whitelisted Authors</h3>
            ${this.authors.length > 0 ? `
              <div class="whitelist">
                ${this.authors.map(author => `
                  <div class="whitelist-item">
                    <div class="address">${author}</div>
                    <button 
                      class="button button-danger" 
                      data-action="remove-author"
                      data-address="${author}"
                    >
                      ✗ Remove
                    </button>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div class="empty-state">
                <div class="empty-icon">✍️</div>
                <p>No authors whitelisted yet</p>
              </div>
            `}
          </div>
        ` : ''}

        <!-- Devs Section -->
        ${this.activeSection === 'devs' ? `
          <div class="section">
            <h3 class="section-title">➕ Add Developer</h3>
            <div class="add-form">
              <input 
                type="text" 
                class="input" 
                placeholder="Developer Address (0x...)"
                id="add-dev-input"
              />
              <button class="button" id="add-dev-btn">
                Add Developer
              </button>
            </div>

            <h3 class="section-title">Whitelisted Developers</h3>
            ${this.devs.length > 0 ? `
              <div class="whitelist">
                ${this.devs.map(dev => `
                  <div class="whitelist-item">
                    <div class="address">${dev}</div>
                    <button 
                      class="button button-danger" 
                      data-action="remove-dev"
                      data-address="${dev}"
                    >
                      ✗ Remove
                    </button>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div class="empty-state">
                <div class="empty-icon">👨‍💻</div>
                <p>No developers whitelisted yet</p>
              </div>
            `}
          </div>
        ` : ''}
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