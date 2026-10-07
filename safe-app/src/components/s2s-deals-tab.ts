// s2s-deals-tab.ts
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LitService, renderwithLitActions } from '@s2s/soul2soul-shared';
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
  toggleSort,
  type SortState,
  type TableColumn,
} from '@/utils/sort.js';
import {
  setFilter,
  type FilterState,
} from '@/utils/filter.js';
import './s2s-table.js';
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

// Column keys that get a filter dropdown in each table.
const OFFER_FILTER_KEYS = ['author', 'postType'];
const DEAL_FILTER_KEYS = ['author', 'postType'];

// The historical filter-toolbar label for the author column is "Author", while
// the column's sortable-header label is "Author (safe)". Preserve the exact
// pre-refactor dropdown text via <s2s-table>'s filterLabels override.
const DEAL_FILTER_LABELS: Record<string, string> = { author: 'Author' };

@customElement('s2s-deals-tab')
export class S2SDealsTab extends LitElement {
  @property({ attribute: false }) safeIntegration!: SafeIntegration;
  @property({ attribute: false }) protocolIntegration!: ProtocolIntegration;
  @property({ attribute: false }) lit!: LitService;

  @state() private loading = true;
  @state() private deals: Array<Deal> = [];
  @state() private offers: Array<Deal> = [];
  @state() private fetching = false;
  @state() private previewMode = false;
  @state() private offersSort: SortState | null = null;
  @state() private dealsSort: SortState | null = null;
  @state() private offersFilters: FilterState = {};
  @state() private dealsFilters: FilterState = {};
  @state() private offersCount = 0;
  @state() private dealsCount = 0;

  private unsubscriber: (() => void) | null = null;

  // Stable row renderers (bound once) so <s2s-table> only re-renders on real
  // data/state changes, not on every host render.
  private offerRowRenderer = (offer: Deal) => this.renderOfferRow(offer);
  private dealRowRenderer = (deal: Deal) => this.renderDealRow(deal);

  static styles = [
    typograhyStyles,
    sectionStyles,
    tableStyles,
    buttonStyles,
    filterStyles,
    css`
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

      .offer-actions {
        display: flex;
        gap: 0.5rem;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this.unsubscriber = store.subscribeToDeals(() => this.requestUpdate());
    this.loadDeals();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscriber?.();
    this.unsubscriber = null;
  }

  private async loadDeals() {
    this.fetching = true;
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
        this.requestUpdate();
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
      this.requestUpdate();
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
  }

  private shortenAddress(s: string) {
    return `${s.slice(0, 4)}...${s.slice(-4)}`;
  }

  private renderOfferRow(offer: Deal): TemplateResult {
    return html`
      <div class="offer-card table-row" data-genesis="${offer.genesis}">
        <div class="table-cell"><copy-content-id value='${offer.genesis}' display='${offer.encryption ? this.shortenAddress(offer.genesis) : (offer.title ?? '—')}'></copy-content-id></div>
        <div class="table-cell">${this.shortenAddress(offer.author)}</div>
        <div class="table-cell">${offer.postType ?? ''}</div>
        <div class="table-cell">${offer.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${offer.tags?.join(', ') ?? ''}</div>
        <div class="table-cell"><span class="offer-status status-pending">Pending</span></div>
        <div class="table-cell offer-actions">
          <button class="button button-secondary thin" data-action="accept" data-genesis="${offer.genesis}"
            @click=${() => this.acceptOffer(offer.genesis)}>Accept</button>
          <button class="button button-danger thin" data-action="reject" data-genesis="${offer.genesis}" data-status="offer"
            @click=${() => this.retract(offer.genesis, 'offer')}>Refuse</button>
        </div>
      </div>
    `;
  }

  private renderDealRow(deal: Deal): TemplateResult {
    return html`
      <div class="deal-card table-row" data-genesis="${deal.genesis}">
        <div class="table-cell"><copy-content-id value='${deal.genesis}' display='${deal.encryption ? this.shortenAddress(deal.genesis) : deal.title}'></copy-content-id></div>
        <div class="table-cell">${this.shortenAddress(deal.author)}</div>
        <div class="table-cell">${deal.postType ?? ''}</div>
        <div class="table-cell">${deal.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${deal.modifiedDate?.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${deal.tags?.join(', ') ?? ''}</div>
        <div class="table-cell deal-actions">
          <button class="button button-danger thin" data-action="retract" data-genesis="${deal.genesis}" data-status="deal"
            @click=${() => this.retract(deal.genesis, 'deal')}>Revoke
          </button>
        </div>
      </div>
    `;
  }

  render() {
    if (this.fetching && store.deals.length === 0) {
      return html`
        <div class="loading">
          <p>Loading deals...</p>
        </div>
      `;
    }

    return html`
      <div class="toolbar">
        <button data-action="bulkrender" @click=${() => this.bulkRender(this.previewMode)}>Bulk Render</button>
        <toggle-button .bool=${this.previewMode} label="preview"
          @toggle=${(e: CustomEvent) => { this.previewMode = e.detail.checked; }}></toggle-button>
      </div>

      ${store.offers.length > 0
        ? html`
            <div class="section">
              <div class="list_header">
                <h2 class="section-title">Pending Offers (${this.offersCount})</h2>
                <button class="button has-icon refresh-button" id="refresh-btn" ?disabled=${this.fetching}
                  @click=${this.handleRefresh}>
                  <span>${this.fetching ? '..' : html`<img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" />`}</span>
                </button>
              </div>
              <s2s-table
                .columns=${OFFER_COLUMNS}
                .rows=${store.offers}
                .sort=${this.offersSort}
                .filters=${this.offersFilters}
                .filterKeys=${OFFER_FILTER_KEYS}
                .filterLabels=${DEAL_FILTER_LABELS}
                .rowRenderer=${this.offerRowRenderer}
                .actionsHeader=${true}
                emptyText="No offers match the current filters"
                gridTemplate="2fr 1fr 1fr 1fr 1fr 1fr auto"
                @sort=${(e: CustomEvent) => { this.offersSort = toggleSort(this.offersSort, e.detail.key); }}
                @filter=${(e: CustomEvent) => { this.offersFilters = setFilter(this.offersFilters, e.detail.key, e.detail.value); }}
                @count=${(e: CustomEvent) => { this.offersCount = e.detail.count; }}
              ></s2s-table>
            </div>
          `
        : ''}

      <div class="section">
        <div class="list_header">
          <h2 class="section-title">Active Deals (${this.dealsCount})</h2>
        </div>

        <s2s-table
          .columns=${DEAL_COLUMNS}
          .rows=${store.deals}
          .sort=${this.dealsSort}
          .filters=${this.dealsFilters}
          .filterKeys=${store.deals.length > 0 ? DEAL_FILTER_KEYS : []}
          .filterLabels=${DEAL_FILTER_LABELS}
          .rowRenderer=${this.dealRowRenderer}
          .actionsHeader=${true}
          .actionsHeaderClass=${'hide-sm'}
          .actionsContent=${html`
            <button class="button has-icon" id="refresh-btn" ?disabled=${this.fetching} @click=${this.handleRefresh}>
              <span>${this.fetching ? '..' : html`<img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" />`}</span>
            </button>`}
          emptyText=${store.deals.length > 0 ? 'No deals match the current filters' : 'No active deals yet'}
          gridTemplate="2fr 1fr 1fr 1fr 1fr 1fr auto"
          @sort=${(e: CustomEvent) => { this.dealsSort = toggleSort(this.dealsSort, e.detail.key); }}
          @filter=${(e: CustomEvent) => { this.dealsFilters = setFilter(this.dealsFilters, e.detail.key, e.detail.value); }}
          @count=${(e: CustomEvent) => { this.dealsCount = e.detail.count; }}
        ></s2s-table>
      </div>

      <div class="section">
        <div class="section-header">
          <h2 class="section-title">Check Deal Status</h2>
        </div>
        <p class="section-description">Check if a deal exists for a genesis</p>
        <div class="check-deal-form">
          <input type="text" class="input" placeholder="Genesis (0x...)" id="check-genesis" />
          <button class="button" id="check-deal-btn" @click=${() => {
            const input = this.renderRoot.querySelector('#check-genesis') as HTMLInputElement;
            const genesis = input?.value.trim();
            if (genesis) this.checkDeal(genesis);
          }}>Check Deal</button>
        </div>
      </div>
    `;
  }
}
