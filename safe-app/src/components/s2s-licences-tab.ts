// s2s-licenses-tab.ts
import { SafeIntegration } from '../lib/safe-integration.js';

export class S2SLicensesTab extends HTMLElement {
  public safeIntegration!: SafeIntegration;
  private loading = true;
  private licenses: Array<{contentId: string, author: string, status: 'active' | 'pending'}> = [];
  private pendingLicenses: Array<{contentId: string, author: string, status: 'active' | 'pending'}> = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    console.log('Licenses tab connected');
    await this.loadLicenses();
    this.render();
  }

  private async loadLicenses() {
    this.loading = true;
    this.render();

    try {
      const safeIntegration = new SafeIntegration();
      await safeIntegration.initialize();

      const { activeLicenses, pendingLicenses } = await safeIntegration.getAllLicenses();
      
      this.licenses = activeLicenses;
      this.pendingLicenses = pendingLicenses;

      console.log('Active licenses:', this.licenses);
      console.log('Pending licenses:', this.pendingLicenses);
      
    } catch (error) {
      console.error('Error loading licenses:', error);
    }

    this.loading = false;
    this.render();
  }

  // Add refresh handler
  private async handleRefresh() {
    await this.loadLicenses();
  }

  private async checkLicense(contentId: string) {
    try {
      const isLicensed = await this.safeIntegration.isLicensed(contentId);
      const author = isLicensed ? await this.safeIntegration.getLicenseAuthor(contentId) : '';
      
      this.showNotification(
        isLicensed 
          ? `✅ License exists for ${contentId} (Author: ${author})`
          : `❌ No license found for ${contentId}`,
        isLicensed ? 'success' : 'error'
      );
    } catch (error) {
      console.error('Error checking license:', error);
      this.showNotification('Failed to check license', 'error');
    }
  }

  private async acceptLicense(contentId: string) {
    try {
      await this.safeIntegration.acceptLicense(contentId);
      this.showNotification('License accepted! Transaction pending approval.', 'success');
      
      // Move from pending to active
      const licenseIndex = this.pendingLicenses.findIndex(l => l.contentId === contentId);
      if (licenseIndex !== -1) {
        const license = this.pendingLicenses[licenseIndex];
        this.licenses.push({ contentId: license.contentId, author: license.author, status: 'active' });
        this.pendingLicenses.splice(licenseIndex, 1);
        this.render();
      }
    } catch (error) {
      console.error('Error accepting license:', error);
      this.showNotification('Failed to accept license. Please try again.', 'error');
    }
  }

  private async revokeLicense(contentId: string) {
    if (!confirm(`Are you sure you want to revoke the license for ${contentId}?`)) {
      return;
    }

    try {
      await this.safeIntegration.revokeLicense(contentId);
      this.showNotification('License revoked! Transaction pending approval.', 'success');
      
      // Remove from licenses list
      this.licenses = this.licenses.filter(l => l.contentId !== contentId);
      this.render();
    } catch (error) {
      console.error('Error revoking license:', error);
      this.showNotification('Failed to revoke license. Please try again.', 'error');
    }
  }

  private showNotification(message: string, type: 'success' | 'error') {
    const event = new CustomEvent('show-notification', {
      detail: { message, type },
      bubbles: true,
      composed: true
    });
    this.dispatchEvent(event);

    // Also show inline notification
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

        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }

        .section-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: #000;
          margin: 0;
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .section-description {
          color: #000;
          margin-bottom: 1.5rem;
        }

        .refresh-button {
          background: #000;
          color: white;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 0.5rem;
          cursor: pointer;
          font-size: 1rem;
          font-weight: 500;
          transition: background-color 0.2s, transform 0.1s;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .refresh-button:hover:not(:disabled) {
          background: #4a9a85;
          transform: translateY(-1px);
        }

        .refresh-button:disabled {
          background: #9ca3af;
          cursor: not-allowed;
          transform: none;
        }

        .check-license-form {
          display: grid;
          gap: 1rem;
          padding: 1.5rem 0;
          grid-template-columns: 1fr auto;
        }

        @media (max-width: 768px) {
          .check-license-form {
            grid-template-columns: 1fr;
          }
          
          .section-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 1rem;
          }
        }

        .input {
          padding: 0.75rem 1rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 1rem;
        }

        .input:focus {
          outline: none;
          border-color: #3b82f6;
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
          background: #2563eb;
          transform: translateY(-1px);
        }

        .button:active {
          transform: translateY(0);
        }

        .button-secondary {
          background: #6b7280;
        }

        .button-secondary:hover {
          background: #4b5563;
        }

        .button-danger {
          background: #ef4444;
        }

        .button-danger:hover {
          background: #dc2626;
        }

        .licenses-list {
          display: grid;
          gap: 1rem;
        }

        .license-card {
          border-bottom: 1px solid #000;
          padding: 1.5rem 0;
          margin-bottom: .75rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .license-info {
          flex: 1;
        }

        .license-content-id {
          font-size: 1rem;
          color: #000;
          font-weight: 600;
          margin-bottom: 0.5rem;
        }

        .license-author {
          font-size: 1rem;
          color: #000;
        }

        .license-status {
          display: inline-block;
          padding: 0.25rem 0.75rem;
          border-radius: 9999px;
          font-size: 0.75rem;
          font-weight: 500;
          margin-top: 0.5rem;
        }

        .status-active {
          background: #dcfce7;
          color: #166534;
        }

        .status-pending {
          background: #fef3c7;
          color: #92400e;
        }

        .license-actions {
          display: flex;
          gap: 0.5rem;
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

        .list_header {
          display: flex;
          flex-direction: row;
          justify-content: space-between;
          align-items: center;
          border-bottom: 3px solid #000;
          padding-bottom: .75rem;
        }
      </style>

      ${this.loading ? `
        <div class="loading">
          <p>Loading licenses...</p>
        </div>
      ` : `
        <!-- Check License -->
        <div class="section">
          <div class="section-header">
            <h2 class="section-title">Check License Status</h2>
          </div>
          <p class="section-description">Check if a license exists for a specific content ID</p>
          
          <div class="check-license-form">
            <input 
              type="text" 
              class="input" 
              placeholder="Content ID"
              id="check-content-id"
            />
            <button class="button" id="check-license-btn">
              Check License
            </button>
          </div>
        </div>

        <!-- Pending Licenses -->
        ${this.pendingLicenses.length > 0 ? `
          <div class="section">
            <h2 class="section-title">Pending Licenses (${this.pendingLicenses.length})</h2>
            <button class="refresh-button" id="refresh-btn" ${this.loading ? 'disabled' : ''}>
              <span>${this.loading ? 'Loading...' : 'Refresh'}</span>
            </button>
            <div class="licenses-list">
              ${this.pendingLicenses.map(license => `
                <div class="license-card">
                  <div class="license-info">
                    <div class="license-content-id">${license.contentId}</div>
                    <div class="license-author">Author: ${license.author}</div>
                    <span class="license-status status-pending">Pending</span>
                  </div>
                  <div class="license-actions">
                    <button 
                      class="button button-secondary" 
                      data-action="accept"
                      data-content-id="${license.contentId}"
                    >
                      ✓ Accept
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Active Licenses -->
        <div class="section">
          <div class="list_header">
            <h2 class="section-title">Active Licenses (${this.licenses.length})</h2>
            <button class="refresh-button" id="refresh-btn" ${this.loading ? 'disabled' : ''}>
              <span>${this.loading ? 'Loading...' : 'Refresh'}</span>
            </button>
          </div>
          ${this.licenses.length > 0 ? `
            <div class="licenses-list">
              ${this.licenses.map(license => `
                <div class="license-card">
                  <div class="license-info">
                    <div class="license-content-id">${license.contentId}</div>
                    <div class="license-author">Author: ${license.author}</div>
                  </div>
                  <div class="license-actions">
                    <button 
                      class="button button-danger" 
                      data-action="revoke"
                      data-content-id="${license.contentId}"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : `
            <div class="empty-state">
              <div class="empty-icon">📄</div>
              <p>No active licenses yet</p>
            </div>
          `}
        </div>
      `}
    `;

    if (!this.loading) {
      this.attachEventListeners();
    }
  }

  private attachEventListeners() {
    // Refresh button
    const refreshBtn = this.shadowRoot?.querySelector('#refresh-btn');
    refreshBtn?.addEventListener('click', () => {
      this.handleRefresh();
    });

    // Check license
    const checkBtn = this.shadowRoot?.querySelector('#check-license-btn');
    const checkInput = this.shadowRoot?.querySelector('#check-content-id') as HTMLInputElement;
    
    checkBtn?.addEventListener('click', () => {
      const contentId = checkInput?.value.trim();
      if (contentId) {
        this.checkLicense(contentId);
      }
    });

    // License actions (accept/revoke)
    this.shadowRoot?.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const action = target.dataset.action;
        const contentId = target.dataset.contentId;
        
        if (!contentId) return;
        
        if (action === 'accept') {
          this.acceptLicense(contentId);
        } else if (action === 'revoke') {
          this.revokeLicense(contentId);
        }
      });
    });
  }
}

customElements.define('s2s-licenses-tab', S2SLicensesTab);