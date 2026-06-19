// s2s-licenses-tab.ts
import { fetchById, LitService, pinCidFromRemote, renderwithLitActions } from '@s2s/soul2soul-shared';
import { SafeIntegration } from '../lib/safe-integration.js';
import { tableStyles } from '../styles/table-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { store } from '../state/index.js'
import { License } from '../types/index.js'
import { ProtocolIntegration } from '@/lib/protocol-integration.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import './toggle-button.js'

export class S2SLicensesTab extends HTMLElement {
  public safeIntegration!: SafeIntegration;
  public protocolIntegration!: ProtocolIntegration;
  private lit!: LitService;
  private loading = true;
  private licenses: Array<License> = [];
  private pendingLicenses: Array<License> = [];
  private unsubscriber!: () => void;
  private fetching: boolean = false;
  private devMode: boolean = false;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [typograhyStyles, sectionStyles, tableStyles, buttonStyles]

  }

  async connectedCallback() {

    this.unsubscriber = store.subscribeToLicenses(() => this.render());
    this.render();

    await this.loadLicenses();
  }

  disconnectedCallback() {
    this.unsubscriber?.();
  }

  private async loadLicenses() {
    this.fetching = true;
    this.render();
    try {
      const { activeLicenses, pendingLicenses } = await this.safeIntegration.getAllLicenses();
      
      this.licenses = activeLicenses;
      this.pendingLicenses = pendingLicenses;

      // console.log('Active licenses:', this.licenses);
      // console.log('Pending licenses:', this.pendingLicenses);

      this.licenses = this.licenses.filter(l => l.contentId && l.contentId.length == 77)

      // augment with public info from lens 
      for (let l of this.licenses) {
          const content = await fetchById(l.contentId);
          // console.log(content)
          const creationDate = parseInt(content.creationDate, 10); // always parse explicitly
          l.creationDate = new Date(creationDate * 1_000);
          const modifiedDate = parseInt(content.modifiedDate, 10); // always parse explicitly
          l.modifiedDate = new Date(modifiedDate * 1_000);
          l.postType = content.postType;
          l.encryption = content.encryption;
          l.title = l.encryption ? "-" : content.title;
          l.position = parseInt(content.position);
          l.tags = content.tags;
      }

      store.setLicenses(this.licenses);
      //store.setPendingLicenses(pendingLicenses); // needs adding to store
    } catch (error) {
      console.error('Error loading licenses:', error);
    }
    this.fetching = false;
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
    // if (!confirm(`Are you sure you want to revoke the license for ${contentId}?`)) {
    //   return;
    // }

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

  private async bulkRender(dev: boolean) {

    console.log("bulkrender")

    const configCid  = store.getRecord("config");
    if (configCid == null) return; 

    const publication  = store.getRecord("name");
    if (publication == null) return; 
    // possibly add a visual list with filters & checkboxes // make that a separate component 

    const protocolInfo = store.protocolInfo;
    if (protocolInfo == undefined) return;
     const safeInfo = store.safeInfo;
    if (safeInfo == undefined) return;

    const signature = await this.safeIntegration.signWithSigner("lit actions auth");
    // console.log(signature);

    const res = await renderwithLitActions( 
        dev,
        this.lit, 
        signature, 
        import.meta.env.VITE_LIT_USAGE_KEY, 
        protocolInfo, 
        undefined,
        store.safeInfo?.safeAddress || "",
        publication,
        store.licenses.filter( l => l.encryption == false).map( l => l.contentId),
        configCid 
    )

    console.log("success:", res.success);

    if(res.cid) {
      await pinCidFromRemote(res.cid, "https://ipfs.tranport-union.dev", import.meta.env.VITE_PINATA_JWT)
      console.log("pinned on pinata")
    }

  }

  private shortenAddress(s: string) {

    return `${s.slice(0,4)}...${s.slice(-4)}`;
  }

  private render() {
    if (!this.shadowRoot) return;

    const licenses = store.licenses;
    const pending = store.pending; 

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 2rem 0;
          background: var(--gray-900);
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
          border: 1px solid var(--gray-200);
          background: var(--gray-50);
          border-radius: 0.5rem;
          font-size: 1rem;
        }

        .input:focus {
          outline: none;
          border-color: var(--color-yellow);
        }
        .toolbar {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 1.5rem;
          margin-bottom: 1.5rem;
        }

        .refresh-icon {
          width: 2.4rem;
          height: 2.4rem;
          vertical-align: middle;
          filter: brightness(0) invert(1);
        }

        .revoke-icon {
          width: 2rem;
          height: 2rem;
          vertical-align: middle;
          filter: brightness(0) invert(1);
        }

        .table {
          grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr auto;
        }
        
      </style>

      ${this.fetching && licenses.length === 0 ? `
      <div class="loading">
        <p>Loading licenses...</p>
      </div>
    ` : `

      <div class="toolbar">
        <button data-action="bulkrender">Bulk Render</button>
         <toggle-button bool="${this.devMode}" label="preview"></toggle-button>
      </div>

     

      ${pending.length > 0 ? `
        <div class="section">
          <div class="list_header">
            <h2 class="section-title">Pending Licenses (${pending.length})</h2>
            <button class="button has-icon refresh-button" id="refresh-btn" ${this.fetching ? 'disabled' : ''}>
              <span>${this.fetching ? '..' : '<img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" />'}</span>
            </button>
          </div>
          <div class="licenses-list">
            ${pending.map(license => `
              <div class="license-card">
                <div class="license-info">
                  <div class="license-content-id">${license.contentId}</div>
                  <div class="license-author">Author: ${license.author}</div>
                  <span class="license-status status-pending">Pending</span>
                </div>
                <div class="license-actions">
                  <button
                    class="button button-secondary thin"
                    data-action="accept"
                    data-content-id="${license.contentId}"
                  >Accept</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Active Licenses (${licenses.length})</h2>
        </div>

        ${licenses.length > 0 ? `
          <div class="table">
            <div class="table-header">ID / Title</div>
            <div class="table-header">Author (safe)</div>
            <div class="table-header hide-sm">Post type</div>
            <div class="table-header hide-sm">Creation Date</div>
            <div class="table-header hide-sm">Modified Date</div>
            <div class="table-header hide-sm">Tags</div>
            <div class="table-header hide-sm">
              <button class="button has-icon" id="refresh-btn" ${this.fetching ? 'disabled' : ''}>
                <span>${this.fetching ? '..' : '<img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" />'}</span>
              </button>
            </div>

            ${licenses.map(license => `
              <div class="license-card table-row" data-lic-id="${license.contentId}">
                <div class="table-cell">${license.encryption ? this.shortenAddress(license.contentId) : license.title}</div>
                <div class="table-cell">${this.shortenAddress(license.author)}</div>
                <div class="table-cell">${license.postType ?? ''}</div>
                <div class="table-cell">${license.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
                <div class="table-cell">${license.modifiedDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
                <div class="table-cell">${license.tags?.join(', ') ?? ''}</div>
                <div class="table-cell license-actions">
                  <button
                    class="button button-danger thin has-icon"
                    data-action="revoke"
                    data-content-id="${license.contentId}"
                  >
                    <img src="/icons/noun-revoke-3391394.svg" class="revoke-icon" alt="Revoke" />
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

      <div class="section">
        <div class="section-header">
          <h2 class="section-title">Check License Status</h2>
        </div>
        <p class="section-description">Check if a license exists for a specific content ID</p>
        <div class="check-license-form">
          <input type="text" class="input" placeholder="Content ID" id="check-content-id" />
          <button class="button" id="check-license-btn">Check License</button>
        </div>
      </div>
      `}
    `;

    if (!this.fetching || licenses.length > 0) {
      this.attachEventListeners();
    }
  }

  private attachEventListeners() {
    // Dev toggle
    this.shadowRoot?.querySelector('toggle-button')?.addEventListener('toggle', ((e: CustomEvent) => {
      this.devMode = e.detail.checked;
    }) as EventListener);

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
        
        // if (!contentId) return;
                if (action === 'accept') {
          this.acceptLicense(contentId!);
        } else if (action === 'revoke') {
          this.revokeLicense(contentId!);
        } else if (action === 'bulkrender') {
          this.bulkRender(this.devMode);
        }
      });
    });
  }
}

customElements.define('s2s-licenses-tab', S2SLicensesTab);