// s2s-deals-tab.ts
import { LitService, pinCidFromRemote, renderwithLitActions } from '@s2s/soul2soul-shared';
import { CID } from 'multiformats';
import { SafeIntegration } from '../lib/safe-integration.js';
import { tableStyles } from '../styles/table-styles.js';
import { filterStyles } from '@/styles/filter-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { store } from '../state/index.js';
import { Deal } from '../types/index.js';
import { ProtocolIntegration } from '@/lib/protocol-integration.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import {
  sortByColumn,
  toggleSort,
  renderSortableHeader,
  type SortState,
  type TableColumn,
} from '@/utils/sort.js';
import {
  filterByColumn,
  uniqueValuesForColumn,
  type FilterState,
} from '@/utils/filter.js';
import { TableFilter } from './table-filter.js';
import './toggle-button.js';
import './copy-content-id.js';
import { fetchFromIPFS } from '@/lib/ipfs.factory.js';

// Per-column sort configuration for the Offers and Deals tables.
const OFFER_COLUMNS: Array<TableColumn<Deal>> = [
  {
    key: 'title',
    label: 'ID / Title',
    get: (o) => (o.encryption ? o.genesis : o.title ?? o.genesis),
  },
  { key: 'author', label: 'Author (safe)', get: (o) => o.author },
  { key: 'postType', label: 'Post type', cls: 'hide-sm', get: (o) => o.postType },
  { key: 'created', label: 'Created', cls: 'hide-sm', get: (o) => o.creationDate },
  { key: 'tags', label: 'Tags', cls: 'hide-sm', get: (o) => o.tags?.join(', ') },
  { key: 'status', label: 'Status', cls: 'hide-sm', get: (o) => o.status },
];

const DEAL_COLUMNS: Array<TableColumn<Deal>> = [
  {
    key: 'title',
    label: 'ID / Title',
    get: (d) => (d.encryption ? d.genesis : d.title ?? d.genesis),
  },
  { key: 'author', label: 'Author (safe)', get: (d) => d.author },
  { key: 'postType', label: 'Post type', cls: 'hide-sm', get: (d) => d.postType },
  { key: 'created', label: 'Creation Date', cls: 'hide-sm', get: (d) => d.creationDate },
  { key: 'modified', label: 'Modified Date', cls: 'hide-sm', get: (d) => d.modifiedDate },
  { key: 'tags', label: 'Tags', cls: 'hide-sm', get: (d) => d.tags?.join(', ') },
];

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
  private offersSort: SortState | null = null;
  private dealsSort: SortState | null = null;
  private offersFilters: FilterState = {};
  private dealsFilters: FilterState = {};

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [
      typograhyStyles,
      sectionStyles,
      tableStyles,
      buttonStyles,
      filterStyles,
    ];
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
      this.deals = deals.map((d) => ({
        genesis: d.genesis,
        author: d.author,
        cid: d.cid,
        status: 'deal' as const,
        modifiedDate: new Date(Number(d.timestamp) * 1_000),
      }));
      this.offers = offers.map((o) => ({
        genesis: o.genesis,
        author: o.author,
        cid: o.cid,
        status: 'offer' as const,
        modifiedDate: new Date(Number(o.timestamp) * 1_000),
      }));

      // Augment with public info fetched by CID.
      for (let l of this.deals) {
        try {
          const content = await fetchFromIPFS('https://ipfs.transport-union.dev', l.cid);

          const creationDate = parseInt(content.public.createdAt, 10);
          l.creationDate = new Date(creationDate * 1_000);
          l.author = content.public.author;
          l.postType = content.public.postType;
          l.encryption = content.encryption;
          l.title = l.encryption ? '-' : JSON.parse(content.body).title;
          l.position = parseInt(content.public.position);
          l.tags = content.public.tags;
        } catch (e) {
          console.warn('Could not augment deal', l.genesis, e);
        }
      }

      // Augment offers too — needed for table rendering
      for (let l of this.offers) {
        try {
          const content = await fetchFromIPFS('https://ipfs.transport-union.dev', l.cid);
          const creationDate = parseInt(content.public.createdAt, 10);
          l.creationDate = new Date(creationDate * 1_000);
          l.author = content.public.author;
          l.postType = content.public.postType;
          l.encryption = content.encryption;
          l.title = l.encryption ? '-' : JSON.parse(content.body).title;
          l.tags = content.public.tags;
        } catch (e) {
          console.warn('Could not augment offer', l.genesis, e);
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
        isDeal ? `✅ Active deal for ${genesis}` : `❌ No active deal for ${genesis}`,
        isDeal ? 'success' : 'error',
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
      const idx = this.offers.findIndex((o) => o.genesis === genesis);
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

  private async retract(genesis: string, status: 'deal' | 'offer') {
    try {
      await this.safeIntegration.retract(genesis);

      if (status === 'offer') {
        this.showNotification('Offer rejected! Transaction pending approval.', 'success');
        // Remove from offers — no demotion
        const idx = this.offers.findIndex((o) => o.genesis === genesis);
        if (idx !== -1) {
          this.offers.splice(idx, 1);
          store.setOffers(this.offers);
        }
      } else {
        this.showNotification('Deal retracted! Transaction pending approval.', 'success');
        // Deal → offer demotion (existing logic)
        const idx = this.deals.findIndex((d) => d.genesis === genesis);
        if (idx !== -1) {
          const deal = this.deals.splice(idx, 1)[0];
          deal.status = 'offer';
          this.offers.push(deal);
          store.setDeals(this.deals);
          store.setOffers(this.offers);
        }
      }

      await this.loadDeals();
      this.render();
    } catch (error: any) {
      console.error('Error retracting:', error);
      this.showNotification(`Failed: ${error.message}`, 'error');
    }
  }

  private showNotification(message: string, type: 'success' | 'error') {
    const event = new CustomEvent('show-notification', {
      detail: { message, type },
      bubbles: true,
      composed: true,
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
    const configCid = store.getRecord('config');
    if (configCid == null) return;

    const publication = store.getRecord('name');
    if (publication == null) return;
    // possibly add a visual list with filters & checkboxes // make that a separate component

    const protocolInfo = store.protocolInfo;
    if (protocolInfo == undefined) return;
    const safeInfo = store.safeInfo;
    if (safeInfo == undefined) return;

    const signature = await this.safeIntegration.signWithSigner('lit actions auth');
    // console.log(signature);

    const genesisIds = preview
      ? store.deals.filter((d) => d.encryption == false).map((d) => d.genesis)
      : store.deals.map((d) => d.genesis);

    // DRPC endpoints, one URL per chain (L1 = Ethereum, L2 = Base).
    // Key mirrors getRpcUrl in lib/evm.ts — no hardcoded keys in the bundle.
    const apiKey = String(import.meta.env.VITE_DRPC_API_KEY ?? 'default');
    const rpcs = {
      L1: [`https://lb.drpc.live/ethereum/${apiKey}`],
      L2: [`https://lb.drpc.live/base/${apiKey}`],
    };

    const res = await renderwithLitActions(
      preview,
      this.lit,
      signature,
      import.meta.env.VITE_LIT_USAGE_KEY,
      protocolInfo,
      undefined,
      store.safeInfo?.safeAddress || '',
      publication,
      genesisIds,
      configCid,
      rpcs,
      undefined, // ipfsGateway — fall back to protocolInfo.gateway
    );

    console.log(res);

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
    return `${s.slice(0, 4)}...${s.slice(-4)}`;
  }

  private render() {
    if (!this.shadowRoot) return;

    // Filter first, then sort (filters narrow the rows, sort orders the result).
    const offers = sortByColumn(
      filterByColumn(store.offers, OFFER_COLUMNS, this.offersFilters),
      OFFER_COLUMNS,
      this.offersSort,
    );
    const deals = sortByColumn(
      filterByColumn(store.deals, DEAL_COLUMNS, this.dealsFilters),
      DEAL_COLUMNS,
      this.dealsSort,
    );

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
          width: 2rem;
          height: 2rem;
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

        .offer-actions {
          display: flex;
          gap: 0.5rem;
        }
        
      </style>

      ${
        this.fetching && store.deals.length === 0
          ? `
      <div class="loading">
        <p>Loading deals...</p>
      </div>
    `
          : `

      <div class="toolbar">
        <button data-action="bulkrender">Bulk Render</button>
         <toggle-button bool="${this.previewMode}" label="preview"></toggle-button>
      </div>

     

      ${
        store.offers.length > 0
          ? `
        <div class="section">
          <div class="list_header">
            <h2 class="section-title">Pending Offers (${offers.length})</h2>
            <button class="button has-icon refresh-button" id="refresh-btn" ${this.fetching ? 'disabled' : ''}>
              <span>${this.fetching ? '..' : '<img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" />'}</span>
            </button>
          </div>
          <div class="table-filters">
            <table-filter data-key="author" label="Author" value="${this.offersFilters.author ?? ''}"></table-filter>
            <table-filter data-key="postType" label="Post type" value="${this.offersFilters.postType ?? ''}"></table-filter>
          </div>
          ${
            offers.length > 0
              ? `
          <div class="table table-offers">
            ${OFFER_COLUMNS.map((c) => renderSortableHeader(c, this.offersSort)).join('')}
            <div class="table-header"></div>

            ${offers
              .map(
                (offer) => `
              <div class="offer-card table-row" data-genesis="${offer.genesis}">
                <div class="table-cell"><copy-content-id value='${offer.genesis}' display='${offer.encryption ? this.shortenAddress(offer.genesis) : (offer.title ?? '—')}'></copy-content-id></div>
                <div class="table-cell">${this.shortenAddress(offer.author)}</div>
                <div class="table-cell">${offer.postType ?? ''}</div>
                <div class="table-cell">${offer.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
                <div class="table-cell">${offer.tags?.join(', ') ?? ''}</div>
                <div class="table-cell"><span class="offer-status status-pending">Pending</span></div>
                <div class="table-cell offer-actions">
                  <button
                    class="button button-secondary thin"
                    data-action="accept"
                    data-genesis="${offer.genesis}"
                  >Accept</button>
                  <button
                    class="button button-danger thin"
                    data-action="reject"
                    data-genesis="${offer.genesis}"
                    data-status="offer"
                  >Refuse</button>
                </div>
              </div>
            `,
            )
            .join('')}
          </div>
        `
              : `
          <div class="empty-state">
            <div class="empty-icon">📄</div>
            <p>No offers match the current filters</p>
          </div>
        `
          }
        </div>
      `
          : ''
      }

      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Active Deals (${deals.length})</h2>
        </div>

        ${
          store.deals.length > 0
            ? `
        <div class="table-filters">
          <table-filter data-key="author" label="Author" value="${this.dealsFilters.author ?? ''}"></table-filter>
          <table-filter data-key="postType" label="Post type" value="${this.dealsFilters.postType ?? ''}"></table-filter>
        </div>
      `
            : ''
        }

        ${
          deals.length > 0
            ? `
          <div class="table table-deals">
            ${DEAL_COLUMNS.map((c) => renderSortableHeader(c, this.dealsSort)).join('')}
            <div class="table-header hide-sm">
              <button class="button has-icon" id="refresh-btn" ${this.fetching ? 'disabled' : ''}>
                <span>${this.fetching ? '..' : '<img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" />'}</span>
              </button>
            </div>

            ${deals
              .map(
                (deal) => `
              <div class="deal-card table-row" data-genesis="${deal.genesis}">
                <div class="table-cell"><copy-content-id value='${deal.genesis}' display='${deal.encryption ? this.shortenAddress(deal.genesis) : deal.title}'></copy-content-id></div>
                <div class="table-cell">${this.shortenAddress(deal.author)}</div>
                <div class="table-cell">${deal.postType ?? ''}</div>
                <div class="table-cell">${deal.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
                <div class="table-cell">${deal.modifiedDate?.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) ?? '—'}</div>
                <div class="table-cell">${deal.tags?.join(', ') ?? ''}</div>
                <div class="table-cell deal-actions">
          
                  <button
                    class="button button-danger thin"
                    data-action="retract"
                    data-genesis="${deal.genesis}"
                    data-status="deal"
                  >Revoke
                    <!-- <img src="/icons/noun-revoke-3391394.svg" class="revoke-icon" alt="Revoke" /> -->
                    </button>
                </div>
              </div>
            `,
              )
              .join('')}
          </div>
        `
            : `
          <div class="empty-state">
            <div class="empty-icon">📄</div>
            <p>${store.deals.length > 0 ? 'No deals match the current filters' : 'No active deals yet'}</p>
          </div>
        `
        }
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
      `
      }
    `;

    if (!this.fetching || store.deals.length > 0) {
      this.attachEventListeners();
    }
  }

  private attachEventListeners() {
    // Column header sorting — Offers table
    this.shadowRoot?.querySelectorAll('.table-offers .table-header.sortable').forEach((el) => {
      el.addEventListener('click', () => {
        const key = (el as HTMLElement).dataset.sort;
        if (key) {
          this.offersSort = toggleSort(this.offersSort, key);
          this.render();
        }
      });
    });

    // Column header sorting — Deals table
    this.shadowRoot?.querySelectorAll('.table-deals .table-header.sortable').forEach((el) => {
      el.addEventListener('click', () => {
        const key = (el as HTMLElement).dataset.sort;
        if (key) {
          this.dealsSort = toggleSort(this.dealsSort, key);
          this.render();
        }
      });
    });

    // Filter dropdowns — Offers table
    this.shadowRoot?.querySelectorAll('.table-offers .table-filters table-filter').forEach((el) => {
      const filterEl = el as TableFilter;
      const key = (el as HTMLElement).dataset.key;
      if (!key) return;
      filterEl.options = uniqueValuesForColumn(store.offers, OFFER_COLUMNS, key);
      filterEl.addEventListener('change', (e) => {
        const value = (e as CustomEvent).detail.value as string;
        const next = { ...this.offersFilters };
        if (value) next[key] = value;
        else delete next[key];
        this.offersFilters = next;
        this.render();
      });
    });

    // Filter dropdowns — Deals table
    this.shadowRoot?.querySelectorAll('.table-deals .table-filters table-filter').forEach((el) => {
      const filterEl = el as TableFilter;
      const key = (el as HTMLElement).dataset.key;
      if (!key) return;
      filterEl.options = uniqueValuesForColumn(store.deals, DEAL_COLUMNS, key);
      filterEl.addEventListener('change', (e) => {
        const value = (e as CustomEvent).detail.value as string;
        const next = { ...this.dealsFilters };
        if (value) next[key] = value;
        else delete next[key];
        this.dealsFilters = next;
        this.render();
      });
    });

    // Preview toggle
    this.shadowRoot?.querySelector('toggle-button')?.addEventListener('toggle', ((
      e: CustomEvent,
    ) => {
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
    this.shadowRoot?.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const action = target.dataset.action;
        const genesis = target.dataset.genesis;

        if (action === 'accept') {
          this.acceptOffer(genesis!);
        } else if (action === 'retract') {
          this.retract(genesis!, 'deal');
        } else if (action === 'reject') {
          this.retract(genesis!, 'offer');
        } else if (action === 'bulkrender') {
          this.bulkRender(this.previewMode);
        }
      });
    });
  }
}

customElements.define('s2s-deals-tab', S2SDealsTab);
