// s2s-deals-tab.ts
import { LitService, pinCidFromRemote, renderwithLitActions } from '@s2s/soul2soul-shared';
import { CID } from 'multiformats';
import { SafeIntegration } from '../lib/safe-integration.js';
import { tableStyles } from '../styles/table-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { store } from '../state/index.js'
import { Deal } from '../types/index.js'
import { ProtocolIntegration } from '@/lib/protocol-integration.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import './toggle-button.js'
import './copy-content-id.js'
import { fetchFromIPFS } from '@/lib/ipfs.factory.js';

export class S2SDealsTab extends HTMLElement {
  public safeIntegration!: SafeIntegration;
  public protocolIntegration!: ProtocolIntegration;
  private lit!: LitService;
  private loading = true;
  private deals: Array<Deal> = [];
  private offers: Array<Deal> = [];
  private unsubscriber!: () => void;
  private fetching: boolean = false;
  private previewMode: boolean = false;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [typograhyStyles, sectionStyles, tableStyles, buttonStyles]

  }

  async connectedCallback() {

    this.unsubscriber = store.subscribeToDeals(() => this.render());
    this.render();

    await this.loadDeals();
  }

  disconnectedCallback() {
    this.unsubscriber?.();
  }

  private async loadDeals() {
    this.fetching = true;
    this.render();
    try {
      const { deals, offers } = await this.safeIntegration.getAllDealsAndOffers();

      // Map deals → this.deals; offers → this.offers.
      // genesis replaces contentId; cid is the storage pointer.
      this.deals = deals.map(d => ({
        genesis: d.genesis,
        author: d.author,
        cid: d.cid,
        status: 'deal' as const,
      }));
      this.offers = offers.map(o => ({
        genesis: o.genesis,
        author: o.author,
        cid: o.cid,
        status: 'offer' as const,
      }));

      // Augment with public info fetched by CID.
      for (let l of this.deals) {
        try {

          const content = await fetchFromIPFS("https://ipfs.transport-union.dev", l.cid);

          const creationDate = parseInt(content.public.createdAt, 10);
          l.creationDate = new Date(creationDate * 1_000);
          l.author = content.public.author;
          l.postType = content.public.postType;
          l.encryption = content.encryption;
          l.title = l.encryption ? "-" : JSON.parse(content.body).title;
          l.position = parseInt(content.public.position);
          l.tags = content.public.tags;
        } catch (e) {
          console.warn('Could not augment deal', l.genesis, e);
        }
      }

      store.setDeals(this.deals);
      store.setOffers(this.offers);
    } catch (error) {
      console.error('Error loading deals:', error);
    }
    this.fetching = false;
    this.render();
  }

  // Add refresh handler
  private async handleRefresh() {
    await this.loadDeals();
  }

  private async checkDeal(genesis: string) {
    try {
      const isDeal = await this.safeIntegration.hasDeal(genesis);
      this.showNotification(
        isDeal
          ? `✅ Active deal for ${genesis}`
          : `❌ No active deal for ${genesis}`,
        isDeal ? 'success' : 'error'
      );
    } catch (error) {
      console.error('Error checking deal:', error);
      this.showNotification('Failed to check deal', 'error');
    }
  }

  private async acceptOffer(genesis: string) {
    try {
      await this.safeIntegration.acceptOffer(genesis);
      this.showNotification('Offer accepted! Transaction pending approval.', 'success');
      await this.loadDeals();
      // Update internal state
      const idx = this.offers.findIndex(o => o.genesis === genesis);
      if (idx !== -1) {
        const offer = this.offers.splice(idx, 1)[0];
        offer.status = 'deal';
        this.deals.push(offer);
        this.render();
      }
    } catch (error: any) {
      this.showNotification(`Error accepting offer: ${error.message}`, 'error');
    }
  }

  private async retract(genesis: string) {
    try {
      await this.safeIntegration.retract(genesis);
      this.showNotification('Deal retracted! Transaction pending approval.', 'success');
      await this.loadDeals();
      // Update internal state
      const idx = this.deals.findIndex(d => d.genesis === genesis);
      if (idx !== -1) {
        this.deals.splice(idx, 1);
        this.render();
      }
    } catch (error) {
      console.error('Error retracting deal:', error);
      this.showNotification('Failed to retract deal. Please try again.', 'error');
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

  private async bulkRender(preview: boolean) {

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

    const genesisIds = preview ? store.deals.filter( d => d.encryption == false).map( d => d.genesis) : store.deals.map( d => d.genesis)

    const res = await renderwithLitActions( 
        preview,
        this.lit, 
        signature, 
        import.meta.env.VITE_LIT_USAGE_KEY, 
        protocolInfo, 
        undefined,
        store.safeInfo?.safeAddress || "",
        publication,
        genesisIds,
        configCid 
    )

    console.log(res)

    // console.log("success:", res.success);

    // if(res.cid) {
    //   await pinCidFromRemote(res.cid, "https://ipfs.tranport-union.dev", import.meta.env.VITE_PINATA_JWT)
    //   console.log("pinned on pinata")

    //   // Push the new root CID to the store — same transformation as fetchFreshData
    //   const rootCid = CID.parse(res.cid).toV1().toString();
    //   store.setRoot(rootCid);
    // }

  }

  private shortenAddress(s: string) {

    return `${s.slice(0,4)}...${s.slice(-4)}`;
  }

  private render() {
    if (!this.shadowRoot) return;

    const deals = store.deals;
    const offers = store.offers;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 2rem 0;
          background: var(--gray-900);
        }
      
        .check-deal-form {
          display: grid;
          gap: 1rem;
          padding: 1.5rem 0;
          grid-template-columns: 1fr auto;
        }

        @media (max-width: 768px) {
          .check-deal-form {
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

      ${this.fetching && deals.length === 0 ? `
      <div class="loading">
        <p>Loading deals...</p>
      </div>
    ` : `

      <div class="toolbar">
        <button data-action="bulkrender">Bulk Render</button>
         <toggle-button bool="${this.previewMode}" label="preview"></toggle-button>
      </div>

     

      ${offers.length > 0 ? `
        <div class="section">
          <div class="list_header">
            <h2 class="section-title">Pending Offers (${offers.length})</h2>
            <button class="button has-icon refresh-button" id="refresh-btn" ${this.fetching ? 'disabled' : ''}>
              <span>${this.fetching ? '..' : '<img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" />'}</span>
            </button>
          </div>
          <div class="offers-list">
            ${offers.map(offer => `
              <div class="offer-card">
                <div class="offer-info">
                  <copy-content-id value='${offer.genesis}' display='${this.shortenAddress(offer.genesis)}'></copy-content-id>
                  <div class="offer-author">Author: ${offer.author}</div>
                  <span class="offer-status status-pending">Pending</span>
                </div>
                <div class="offer-actions">
                  <button
                    class="button button-secondary thin"
                    data-action="accept"
                    data-genesis="${offer.genesis}"
                  >Accept</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Active Deals (${deals.length})</h2>
        </div>

        ${deals.length > 0 ? `
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

            ${deals.map(deal => `
              <div class="deal-card table-row" data-genesis="${deal.genesis}">
                <div class="table-cell"><copy-content-id value='${deal.genesis}' display='${deal.encryption ? this.shortenAddress(deal.genesis) : deal.title}'></copy-content-id></div>
                <div class="table-cell">${this.shortenAddress(deal.author)}</div>
                <div class="table-cell">${deal.postType ?? ''}</div>
                <div class="table-cell">${deal.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
                <div class="table-cell">${deal.modifiedDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
                <div class="table-cell">${deal.tags?.join(', ') ?? ''}</div>
                <div class="table-cell deal-actions">
                  <button
                    class="button button-danger thin has-icon"
                    data-action="retract"
                    data-genesis="${deal.genesis}"
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
            <p>No active deals yet</p>
          </div>
        `}
      </div>

      <div class="section">
        <div class="section-header">
          <h2 class="section-title">Check Deal Status</h2>
        </div>
        <p class="section-description">Check if a deal exists for a genesis</p>
        <div class="check-deal-form">
          <input type="text" class="input" placeholder="Genesis (0x...)" id="check-genesis" />
          <button class="button" id="check-deal-btn">Check Deal</button>
        </div>
      </div>
      `}
    `;

    if (!this.fetching || deals.length > 0) {
      this.attachEventListeners();
    }
  }

  private attachEventListeners() {
    // Preview toggle
    this.shadowRoot?.querySelector('toggle-button')?.addEventListener('toggle', ((e: CustomEvent) => {
      this.previewMode = e.detail.checked;
    }) as EventListener);

    // Refresh button
    const refreshBtn = this.shadowRoot?.querySelector('#refresh-btn');
    refreshBtn?.addEventListener('click', () => {
      this.handleRefresh();
    });

    // Check deal
    const checkBtn = this.shadowRoot?.querySelector('#check-deal-btn');
    const checkInput = this.shadowRoot?.querySelector('#check-genesis') as HTMLInputElement;

    checkBtn?.addEventListener('click', () => {
      const genesis = checkInput?.value.trim();
      if (genesis) {
        this.checkDeal(genesis);
      }
    });

    // Deal actions (accept/retract)
    this.shadowRoot?.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const action = target.dataset.action;
        const genesis = target.dataset.genesis;
        
        if (action === 'accept') {
          this.acceptOffer(genesis!);
        } else if (action === 'retract') {
          this.retract(genesis!);
        } else if (action === 'bulkrender') {
          this.bulkRender(this.previewMode);
        }
      });
    });
  }
}

customElements.define('s2s-deals-tab', S2SDealsTab);
