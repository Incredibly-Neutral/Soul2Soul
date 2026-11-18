// s2s-deals-tab.ts
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
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

/**
 * The name a row shows, and the value the ID / Title column sorts on, so the
 * two cannot disagree:
 *   unencrypted          -> the title, else the genesis id
 *   encrypted, labelled  -> the label
 *   encrypted, bare      -> the genesis id, in full (never a shortened address)
 * `public.label` is unsigned and read straight off the stored item, absent
 * meaning "no label"; it is never verified, so an encrypted row with none
 * falls back to the id rather than inventing a name.
 *
 * `||`, not `??`: a blank label or title must fall back to the id too, so a
 * blank can never render a blank cell. readPublicLabel drops blanks and
 * whitespace today, and this keeps that guard from being the only one.
 */
function displayName(d: Deal): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- blank falls back, not just nullish
  return d.encryption ? d.label || d.genesis : d.title || d.genesis;
}

/**
 * `public.label` off a fetched stored item: a non-blank string, trimmed, or
 * undefined. A blank is no label at all, never a fabricated one.
 */
function readPublicLabel(content: unknown): string | undefined {
  const label = (content as { public?: { label?: unknown } } | null | undefined)?.public?.label;
  return typeof label === 'string' && label.trim() !== '' ? label.trim() : undefined;
}

// Per-column sort configuration for the Offers and Deals tables.
const OFFER_COLUMNS: Array<TableColumn<Deal>> = [
  {
    key: 'title',
    label: 'ID / Title',
    get: (o) => displayName(o),
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
    get: (d) => displayName(d),
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
 * The next step a row owes after its proposal has executed:
 *   idle      nothing to do
 *   waiting   the proposal is queued; poll `hasAgreement` until it lands
 *   render    the chain agrees with what the proposal asked for — render it
 *   rendering the per-row render call is in flight
 *   done      rendered, and the page now matches the agreement state
 */
type RowPhase = 'idle' | 'waiting' | 'render' | 'rendering' | 'done';

/** How often a waiting row asks `hasAgreement`, and how long it keeps asking. */
const POLL_INTERVAL_MS = 6_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

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
  @state() private rowPhase: Record<string, RowPhase> = {};

  private unsubscriber: (() => void) | null = null;

  // Per-row poll bookkeeping, keyed like rowPhase. `rowExpects` is the
  // agreement state the proposal asks for: true from an Accept (the page is
  // written), false from a Refuse (the page is removed). It also decides the
  // only thing the tab says differently about the two: the button label.
  private rowExpects: Record<string, boolean> = {};
  private waitingSince: Record<string, number> = {};
  private pollTimer: ReturnType<typeof setInterval> | null = null;

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

      .row-spinner {
        display: inline-block;
        width: 0.7rem;
        height: 0.7rem;
        border: 2px solid rgba(255, 255, 255, 0.25);
        border-top-color: #fff;
        border-radius: 50%;
        animation: row-spin 1s linear infinite;
      }

      @keyframes row-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this.unsubscriber = store.subscribeToDeals(() => this.requestUpdate());
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.loadDeals();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscriber?.();
    this.unsubscriber = null;
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.stopPoll();
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
          l.label = readPublicLabel(content);
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
          l.label = readPublicLabel(content);
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
   * Normalises the genesis ref to bytes32, then asks SafeIntegration.hasAgreement
   * and reflects the outcome back onto <s2s-check> via .result / .message.
   * An offer does NOT count — hasAgreement is the deal-only (_isDeal) view.
   */
  private async runDealCheck(genesis: string) {
    this.dealCheck = { result: 'pending', message: '' };
    try {
      const g = toBytes32Id(genesis);
      const ok = await this.safeIntegration.hasAgreement(g);
      this.dealCheck = {
        result: ok ? 'pass' : 'fail',
        message: ok ? 'has an agreement' : 'no agreement',
      };
    } catch (error) {
      console.error('Error checking deal:', error);
      this.dealCheck = { result: 'error', message: 'check failed' };
    }
  }

  private async admitOffer(genesis: string) {
    try {
      await this.safeIntegration.admit(genesis);
      // The proposal is only queued: the agreement exists once the signers
      // execute it, so the row waits for the chain rather than rendering now.
      this.beginWait(genesis, true);
      this.showNotification('Offer admitted! Transaction pending approval.', 'success');
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
      this.showNotification(`Error admitting offer: ${error.message}`, 'error');
    }
  }

  /**
   * Reject a deal or an offer. The publication's reversible takedown: a deal
   * returns to the pending offer set and can be admitted again, an offer is
   * declined. Not `retract` — that is the author's verb and it reverts
   * `NotAuthorized()` for the publication Safe.
   */
  private async reject(genesis: string, status: 'deal' | 'offer') {
    try {
      await this.safeIntegration.reject(genesis);

      if (status === 'offer') {
        // A declined offer never had a page, so there is nothing to render:
        // no wait, no row action, the row simply goes away.
        this.showNotification('Offer rejected! Transaction pending approval.', 'success');
        // Remove from offers — no demotion
        const idx = this.offers.findIndex((o) => o.genesis === genesis);
        if (idx !== -1) {
          this.offers.splice(idx, 1);
          store.setOffers(this.offers);
        }
      } else {
        // A demoted deal leaves a live page behind; once the chain reports no
        // agreement the row can render that page away.
        this.beginWait(genesis, false);
        this.showNotification('Agreement rejected — back in pending offers.', 'success');
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
      console.error('Error rejecting:', error);
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

  // ---- row action state machine -------------------------------------------

  private setRowPhase(genesis: string, phase: RowPhase) {
    this.rowPhase = { ...this.rowPhase, [genesis]: phase };
  }

  /** Record what the proposal asks for and start watching the chain for it. */
  private beginWait(genesis: string, expectsAgreement: boolean) {
    this.rowExpects = { ...this.rowExpects, [genesis]: expectsAgreement };
    this.waitingSince = { ...this.waitingSince, [genesis]: Date.now() };
    this.setRowPhase(genesis, 'waiting');
    this.startPoll();
  }

  private clearWait(genesis: string) {
    if (!(genesis in this.waitingSince)) return;
    const next = { ...this.waitingSince };
    delete next[genesis];
    this.waitingSince = next;
  }

  private hasWaitingRow(): boolean {
    return Object.values(this.rowPhase).includes('waiting');
  }

  /**
   * One timer for every waiting row. Polling is bound to the tab being visible:
   * a hidden tab costs nothing, and turning visible again picks the rows back
   * up where they were, the 10-minute cap still counted from the click.
   */
  private startPoll() {
    if (this.pollTimer !== null) return;
    if (!this.hasWaitingRow()) return;
    if (document.visibilityState !== 'visible') return;
    this.pollTimer = setInterval(() => void this.pollAgreements(), POLL_INTERVAL_MS);
  }

  private stopPoll() {
    if (this.pollTimer === null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') this.startPoll();
    else this.stopPoll();
  };

  private async pollAgreements() {
    for (const [genesis, phase] of Object.entries(this.rowPhase)) {
      if (phase !== 'waiting') continue;

      const started = this.waitingSince[genesis];
      if (started !== undefined && Date.now() - started >= POLL_TIMEOUT_MS) {
        // Nobody executed the proposal: drop the row back to no action rather
        // than nag about it forever. A later click starts the dance again.
        this.clearWait(genesis);
        this.setRowPhase(genesis, 'idle');
        continue;
      }

      const expects = this.rowExpects[genesis];
      if (expects === undefined) continue;

      try {
        const hasAgreement = await this.safeIntegration.hasAgreement(genesis);
        // The row may have moved on while the read was in flight.
        if (this.rowPhase[genesis] !== 'waiting') continue;
        if (hasAgreement === expects) {
          this.clearWait(genesis);
          this.setRowPhase(genesis, 'render');
        }
      } catch (error) {
        // A read that fails is not an answer: keep waiting until the cap.
        console.warn('Could not read agreement state', genesis, error);
      }
    }

    if (!this.hasWaitingRow()) this.stopPoll();
  }

  /**
   * Render one row's genesis. The render action decides for itself what to do —
   * an agreement writes the page, no agreement removes the page its path holds
   * — so the tab passes only the id and never a remove entry.
   */
  private async renderRow(genesis: string) {
    this.setRowPhase(genesis, 'rendering');
    try {
      const res = await this.performRender(false, [genesis]);
      console.log(res);
      this.setRowPhase(genesis, 'done');
      await this.loadDeals();
    } catch (error: any) {
      this.setRowPhase(genesis, 'render');
      this.showNotification(`Render failed: ${error.message}`, 'error');
    }
  }

  // ---- render calls -------------------------------------------------------

  /**
   * Every genesis a sweep must visit: the deals and the offers, deduped. An
   * offer has no agreement, so rendering it makes the action remove the page
   * its path still holds — which is the only way a revoked manuscript's own
   * page is ever revisited, since it is no longer a deal. Preview drops
   * encrypted items: their bodies cannot be rendered without the key.
   */
  private renderIds(preview: boolean): string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of [...store.deals, ...store.offers]) {
      if (preview && item.encryption) continue;
      if (seen.has(item.genesis)) continue;
      seen.add(item.genesis);
      ids.push(item.genesis);
    }
    return ids;
  }

  private async bulkRender(preview: boolean) {
    try {
      const res = await this.performRender(preview, this.renderIds(preview));
      console.log(res);
    } catch (error) {
      console.error('Bulk render failed:', error);
    }
  }

  /**
   * The one render call the tab makes, in both shapes: a sweep or a single row.
   * Throws when the records it needs are missing, so a caller can report it
   * instead of rendering nothing under a spinner.
   */
  private async performRender(preview: boolean, genesisIds: string[]) {
    const configCid = store.getRecord('config');
    if (configCid == null) throw new Error('no config record');

    const publication = store.getRecord('name');
    if (publication == null) throw new Error('no publication name record');

    const protocolInfo = store.protocolInfo;
    if (protocolInfo == undefined) throw new Error('no protocol info');
    const safeInfo = store.safeInfo;
    if (safeInfo == undefined) throw new Error('no safe info');

    const signature = await this.safeIntegration.signWithSigner('lit actions auth');

    // DRPC endpoints, one URL per chain (L1 = Ethereum, L2 = Base).
    // Single source of truth is getRpcUrl in lib/evm.ts — no hardcoded keys
    // in the bundle, and a keyless build falls back to public RPCs (never the
    // retired lb.drpc.live/.../default endpoint).
    const rpcs = {
      L1: [getRpcUrl(1)],
      L2: [getRpcUrl(8453)],
    };

    return await renderwithLitActions(
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
  }

  /**
   * The next step for one row, or nothing. Preview hides it: a preview renders
   * the cache, it does not decide what the live site says about an agreement.
   */
  private renderRowAction(genesis: string): TemplateResult | typeof nothing {
    if (this.previewMode) return nothing;

    const phase = this.rowPhase[genesis] ?? 'idle';
    const label = this.rowExpects[genesis] ? 'Publish' : 'Remove page';

    switch (phase) {
      case 'idle':
        return nothing;
      case 'waiting':
        return html`
          <s2s-button action="render" genesis="${genesis}" ?disabled=${true}>
            <span class="row-spinner" aria-hidden="true"></span> Waiting for signers
          </s2s-button>
        `;
      case 'render':
        return html`
          <s2s-button action="render" genesis="${genesis}" variant="spin"
            @click=${() => void this.renderRow(genesis)}>${label}</s2s-button>
        `;
      case 'rendering':
        return html`
          <s2s-button action="render" genesis="${genesis}" ?disabled=${true}>
            <span class="row-spinner" aria-hidden="true"></span> Rendering
          </s2s-button>
        `;
      case 'done':
        return html`
          <s2s-button action="render" genesis="${genesis}" ?disabled=${true} type="success">Published</s2s-button>
        `;
    }
  }

  private renderOfferRow(offer: Deal): TemplateResult {
    return html`
      <div class="offer-card table-row" data-genesis="${offer.genesis}">
        <div class="table-cell"><copy-content-id value='${offer.genesis}' display='${displayName(offer)}'></copy-content-id></div>
        <div class="table-cell"><pet-name value=${offer.author}></pet-name></div>
        <div class="table-cell">${offer.postType ?? ''}</div>
        <div class="table-cell">${offer.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${offer.tags?.join(', ') ?? ''}</div>
        <div class="table-cell"><span class="offer-status status-pending">Pending</span></div>
        <div class="table-cell offer-actions">
          <s2s-button action="accept" genesis="${offer.genesis}" status="offer" variant="spin"
            @click=${() => this.admitOffer(offer.genesis)}>Accept</s2s-button>
          <s2s-button action="reject" genesis="${offer.genesis}" status="offer"
            @click=${() => this.reject(offer.genesis, 'offer')}>Refuse</s2s-button>
          ${this.renderRowAction(offer.genesis)}
        </div>
      </div>
    `;
  }

  private renderDealRow(deal: Deal): TemplateResult {
    return html`
      <div class="deal-card table-row" data-genesis="${deal.genesis}">
        <div class="table-cell"><copy-content-id value='${deal.genesis}' display='${displayName(deal)}'></copy-content-id></div>
        <div class="table-cell"><pet-name value=${deal.author}></pet-name></div>
        <div class="table-cell">${deal.postType ?? ''}</div>
        <div class="table-cell">${deal.creationDate?.toLocaleString('en-US', { dateStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${deal.modifiedDate?.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) ?? '—'}</div>
        <div class="table-cell">${deal.tags?.join(', ') ?? ''}</div>
        <div class="table-cell deal-actions">
          <s2s-button action="reject" genesis="${deal.genesis}" status="deal" type="secondary"
            @click=${() => this.reject(deal.genesis, 'deal')}><ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x> Revoke
          </s2s-button>
          ${this.renderRowAction(deal.genesis)}
        </div>
      </div>
    `;
  }

  render() {
    if (this.fetching && store.deals.length === 0) {
      return html`
        <div class="loading">
          <p>Loading agreements...</p>
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
          @click=${() => this.bulkRender(this.previewMode)}>Sync site</s2s-button>
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
          title="Active Agreements"
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
          emptyText=${store.deals.length > 0 ? 'No agreements match the current filters' : 'No active agreements yet'}
          gridTemplate="2fr 1fr 1fr 1fr 1fr 1fr auto"
          @sort=${(e: CustomEvent) => { this.dealsSort = toggleSort(this.dealsSort, e.detail.key); }}
          @chip-filter=${(e: CustomEvent) => { this.dealsChips = setChips(this.dealsChips, e.detail.key, e.detail.values); }}
        ></s2s-table>
      </div>
    `;
  }
}
