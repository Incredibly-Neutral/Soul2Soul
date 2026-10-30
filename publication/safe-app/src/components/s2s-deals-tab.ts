// s2s-deals-tab.ts
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LitService, renderwithLitActions, toBytes32Id } from '@s2s/soul2soul-shared';
import { SafeIntegration } from '../lib/safe-integration.js';
import { tableStyles } from '../styles/table-styles.js';
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
  type ChipsGroup,
} from '@/utils/filter.js';
import './s2s-table.js';
import './toggle-button.js';
import './s2s-button.js';
import './copy-content-id.js';
import { fetchFromIPFS } from '@/lib/ipfs.factory.js';
import { getRpcUrl } from '@/lib/evm.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import './s2s-check.js';
import './pet-name.js';

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

// Chips filter groups for the Offers and Deals tables (both DEAL-typed). Same
// two groups, in the same order the dropdowns filtered before: author, then
// postType.
const DEAL_CHIPS_GROUPS: Array<ChipsGroup<Deal>> = [
  { key: 'author', get: (d) => d.author ?? '', petName: true },
  { key: 'postType', get: (d) => d.postType ?? '' },
];

/**
 * Immutable chips-state update: copy, set `key` to `values`, delete the key
 * when `values` is empty (matches <s2s-table>'s clear-filters chip, which
 * emits values: []). The host owns the chips state, mirroring the chip-filter
 * event back, so filtering stays immutable like setFilter before it.
 */
function setChips(
  chips: Record<string, string[]>,
  key: string,
  values: string[],
): Record<string, string[]> {
  const next = { ...chips };
  if (values.length > 0) next[key] = [...values];
  else delete next[key];
  return next;
}

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
  @state() private offersChips: Record<string, string[]> = {};
  @state() private dealsChips: Record<string, string[]> = {};
  @state() private dealCheck: {
    result: 'idle' | 'pending' | 'pass' | 'fail' | 'error';
    message: string;
  } = { result: 'idle', message: '' };

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
    css`
      :host {
        display: block;
        padding: 2rem 0;
        background: var(--gray-900);
      }

      .toolbar {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 1.5rem;
        margin-bottom: 1.5rem;
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

  /**
   * Parent-driven 'check if genesis id has a deal' verification (s2s-check).
   * Normalises the genesis ref to bytes32, then asks SafeIntegration.hasDeal
   * and reflects the outcome back onto <s2s-check> via .result / .message.
   * An offer does NOT count — hasDeal is the deal-only (_isDeal) view.
   */
  private async runDealCheck(genesis: string) {
    this.dealCheck = { result: 'pending', message: '' };
    try {
      const g = toBytes32Id(genesis);
      const ok = await this.safeIntegration.hasDeal(g);
      this.dealCheck = {
        result: ok ? 'pass' : 'fail',
        message: ok ? 'has a deal' : 'no deal',
      };
    } catch (error) {
      console.error('Error checking deal:', error);
      this.dealCheck = { result: 'error', message: 'check failed' };
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
    // Single source of truth is getRpcUrl in lib/evm.ts — no hardcoded keys
    // in the bundle, and a keyless build falls back to public RPCs (never the
    // retired lb.drpc.live/.../default endpoint).
    const rpcs = {
      L1: [getRpcUrl(1)],
      L2: [getRpcUrl(8453)],
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
      undefined, // remove
      undefined, // reset
      // ipfsGatewayAuth — 15th positional arg: FULL header (`Bearer <token>`),
      // so the render action's writes (add/dag/put to compute CIDs) pass the gate.
      import.meta.env.VITE_KUBO_TOKEN ? `Bearer ${import.meta.env.VITE_KUBO_TOKEN}` : undefined,
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
        <div class="table-cell"><pet-name value=${offer.author}></pet-name></div>
        <div class="table-cell">${offer.postType ?? ''}</div>
        <div class="table-cell">${offer.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${offer.tags?.join(', ') ?? ''}</div>
        <div class="table-cell"><span class="offer-status status-pending">Pending</span></div>
        <div class="table-cell offer-actions">
          <s2s-button action="accept" genesis="${offer.genesis}" variant="spin"
            @click=${() => this.acceptOffer(offer.genesis)}>Accept</s2s-button>
          <s2s-button action="reject" genesis="${offer.genesis}" status="offer"
            @click=${() => this.retract(offer.genesis, 'offer')}>Refuse</s2s-button>
        </div>
      </div>
    `;
  }

  private renderDealRow(deal: Deal): TemplateResult {
    return html`
      <div class="deal-card table-row" data-genesis="${deal.genesis}">
        <div class="table-cell"><copy-content-id value='${deal.genesis}' display='${deal.encryption ? this.shortenAddress(deal.genesis) : deal.title}'></copy-content-id></div>
        <div class="table-cell"><pet-name value=${deal.author}></pet-name></div>
        <div class="table-cell">${deal.postType ?? ''}</div>
        <div class="table-cell">${deal.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${deal.modifiedDate?.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${deal.tags?.join(', ') ?? ''}</div>
        <div class="table-cell deal-actions">
          <s2s-button action="retract" genesis="${deal.genesis}" status="deal" type="secondary"
            @click=${() => this.retract(deal.genesis, 'deal')}><ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x> Revoke
          </s2s-button>
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
        <s2s-check
          placeholder="0x… genesis"
          .result=${this.dealCheck.result}
          .message=${this.dealCheck.message}
          @s2s-check=${(e: CustomEvent) => void this.runDealCheck(e.detail.value)}
        ></s2s-check>
        <s2s-button action="bulkrender" type="secondary"
          @click=${() => this.bulkRender(this.previewMode)}>Bulk Render</s2s-button>
        <toggle-button .bool=${this.previewMode} label="preview"
          @toggle=${(e: CustomEvent) => { this.previewMode = e.detail.checked; }}></toggle-button>
      </div>

      ${store.offers.length > 0
        ? html`
            <div class="section">
              <s2s-table
                title="Pending Offers"
                .titleAction=${html`<s2s-button type="primary" ?disabled=${this.fetching}
                  @click=${this.handleRefresh} style="margin-right: 1rem">
                  <ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise> Sync
                </s2s-button>`}
                .columns=${OFFER_COLUMNS}
                .rows=${store.offers}
                .sort=${this.offersSort}
                .chipsGroups=${DEAL_CHIPS_GROUPS}
                .chips=${this.offersChips}
                .rowRenderer=${this.offerRowRenderer}
                .actionsHeader=${true}
                emptyText="No offers match the current filters"
                gridTemplate="2fr 1fr 1fr 1fr 1fr 1fr auto"
                @sort=${(e: CustomEvent) => { this.offersSort = toggleSort(this.offersSort, e.detail.key); }}
                @chip-filter=${(e: CustomEvent) => { this.offersChips = setChips(this.offersChips, e.detail.key, e.detail.values); }}
              ></s2s-table>
            </div>
          `
        : ''}

      <div class="section">
        <s2s-table
          title="Active Deals"
          .titleAction=${html`<s2s-button type="primary" ?disabled=${this.fetching}
            @click=${this.handleRefresh} style="margin-right: 1rem">
            <ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise> Sync
          </s2s-button>`}
          .columns=${DEAL_COLUMNS}
          .rows=${store.deals}
          .sort=${this.dealsSort}
          .chipsGroups=${store.deals.length > 0 ? DEAL_CHIPS_GROUPS : []}
          .chips=${this.dealsChips}
          .rowRenderer=${this.dealRowRenderer}
          .actionsHeader=${true}
          .actionsHeaderClass=${'hide-sm'}
          .actionsContent=${html`Actions`}
          emptyText=${store.deals.length > 0 ? 'No deals match the current filters' : 'No active deals yet'}
          gridTemplate="2fr 1fr 1fr 1fr 1fr 1fr auto"
          @sort=${(e: CustomEvent) => { this.dealsSort = toggleSort(this.dealsSort, e.detail.key); }}
          @chip-filter=${(e: CustomEvent) => { this.dealsChips = setChips(this.dealsChips, e.detail.key, e.detail.values); }}
        ></s2s-table>
      </div>
    `;
  }
}
