// s2s-deals-tab.ts
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LitService, previewLink, renderwithLitActions, toBytes32Id } from '@s2s/soul2soul-shared';
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

/**
 * The two public shapes carry their dates under different names: v2 has
 * `creationDate` and `modifiedDate` in unix seconds, v1 has only `createdAt`
 * (see src/shared/src/rendering/action-io.ts). A v1 item therefore has one
 * date, and its "modified" date is its creation time.
 *
 * Read the v2 field first and fall back to the v1 one. A missing or
 * unparseable value is no date at all, never an Invalid Date: the cell shows
 * an em dash instead.
 */
function readPublicDate(content: unknown, fields: readonly string[]): Date | undefined {
  const pub = (content as { public?: Record<string, unknown> } | null | undefined)?.public;
  for (const field of fields) {
    const raw = pub?.[field];
    const seconds =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : NaN;
    if (!Number.isFinite(seconds)) continue;
    const date = new Date(seconds * 1_000);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

const CREATION_DATE_FIELDS = ['creationDate', 'createdAt'] as const;
const MODIFIED_DATE_FIELDS = ['modifiedDate', 'createdAt'] as const;

/** Zero-padded to `width` digits: a month, a day, an hour, or a year. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * The created cell: `YYYY-MM-DD`. Padded arithmetic in UTC, not
 * `toLocaleString`, so neither the browser's locale (which would append AM/PM)
 * nor its time zone can change what the same stored seconds say.
 */
function formatDate(date: Date | undefined): string {
  if (date === undefined) return '—';
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The modified cell: `YYYY-MM-DD HH:MM`, 24-hour, UTC. Never AM/PM. */
function formatDateTime(date: Date | undefined): string {
  if (date === undefined) return '—';
  return `${formatDate(date)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// Per-column sort configuration for the Offers and Deals tables.
const OFFER_COLUMNS: Array<TableColumn<Deal>> = [
  {
    key: 'title',
    label: 'id',
    get: (o) => displayName(o),
  },
  { key: 'author', label: 'author', get: (o) => o.author },
  { key: 'postType', label: 'type', cls: 'hide-sm', get: (o) => o.postType },
  { key: 'created', label: 'created', cls: 'hide-sm', get: (o) => o.creationDate },
  { key: 'tags', label: 'tags', cls: 'hide-sm', get: (o) => o.tags?.join(', ') },
  { key: 'status', label: 'status', cls: 'hide-sm', get: (o) => o.status },
];

const DEAL_COLUMNS: Array<TableColumn<Deal>> = [
  {
    key: 'title',
    label: 'id',
    get: (d) => displayName(d),
  },
  { key: 'author', label: 'author', get: (d) => d.author },
  { key: 'postType', label: 'type', cls: 'hide-sm', get: (d) => d.postType },
  { key: 'created', label: 'created', cls: 'hide-sm', get: (d) => d.creationDate },
  { key: 'modified', label: 'modified', cls: 'hide-sm', get: (d) => d.modifiedDate },
  { key: 'tags', label: 'tags', cls: 'hide-sm', get: (d) => d.tags?.join(', ') },
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
 *   done      the action reported a write, or a removal it performed
 */
type RowPhase = 'idle' | 'waiting' | 'render' | 'rendering' | 'done';

/**
 * What a render's trace says it did about removals. Line prefixes only: the
 * path is derived inside the update action, so the tab has no path to match a
 * row's page against. The honest fix is for the render sequence to return the
 * removals it performed as structured data instead of the tab reading strings;
 * that reaches src/shared and src/press and is out of scope for this branch.
 */
type RemovalOutcome =
  | { kind: 'removed' }
  | { kind: 'failed'; line: string }
  | { kind: 'skipped'; line: string }
  | { kind: 'silent' };

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
  /**
   * Previews in flight and popup-blocked preview URLs, both keyed by genesis.
   * Separate from rowPhase: a preview renders the cache, it decides nothing
   * about the agreement, so it must not move the row's publish/remove step.
   */
  @state() private previewing: Record<string, boolean> = {};
  @state() private previewReady: Record<string, string> = {};
  /** Bumped on every phase change, handed to <s2s-table> as its revision. */
  @state() private rowRevision = 0;
  /**
   * Rows kept in the Pending Offers table after the chain stopped listing them.
   * A refused offer leaves no chain state behind, but its page may still be
   * live (an author's non-whitelisted `makeOffer` suspends an agreement and
   * moves the document into the offer set without touching the tree), so the
   * row has to stay visible until its removal is rendered.
   */
  @state() private retainedOffers: Deal[] = [];

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

      /* An actions cell holds more than one button, and <s2s-table>'s
         .table-cell is a flex COLUMN, so the cell has to opt back into a row
         or the buttons stack. Wrapping keeps a long label ("Waiting for
         signers") from squeezing the fr columns into the table's hidden
         overflow; the gap is the one it always had. */
      .row-actions {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
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

      /* A preview the popup blocker refused. The link is the user's second
         gesture, so it sits beside the button rather than replacing it. */
      .preview-ready {
        font-family: var(--font-mono);
        font-size: 0.78rem;
        color: var(--color-purple, #d8b4fe);
        text-decoration: underline;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this.unsubscriber = store.subscribeToDeals(() => this.requestUpdate());
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    // A row can be mid-wait when the element is reattached: its phase survived
    // on the instance, so the timer has to come back with it, plus one pass
    // now in case the chain moved while nothing was watching.
    if (this.hasWaitingRow()) {
      this.startPoll();
      void this.pollAgreements();
    }
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
      // genesis replaces contentId; cid is the storage pointer. No date is
      // taken from the chain: the row's dates come from the stored item's
      // public part, so a fetch that fails shows an em dash rather than a chain
      // timestamp that is not the item's.
      this.deals = deals.map((d) => ({
        genesis: d.genesis,
        author: d.author,
        cid: d.cid,
        status: 'deal' as const,
      }));
      this.offers = offers.map((o) => ({
        genesis: o.genesis,
        author: o.author,
        cid: o.cid,
        status: 'offer' as const,
      }));

      // Augment with public info fetched by CID.
      for (let l of this.deals) {
        try {
          const content = await fetchFromIPFS('https://ipfs.transport-union.dev', l.cid);

          l.creationDate = readPublicDate(content, CREATION_DATE_FIELDS);
          l.modifiedDate = readPublicDate(content, MODIFIED_DATE_FIELDS);
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
          l.creationDate = readPublicDate(content, CREATION_DATE_FIELDS);
          l.modifiedDate = readPublicDate(content, MODIFIED_DATE_FIELDS);
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

      // A retained row the chain now lists as a deal is somebody else's result:
      // drop the removal it was carrying, or the deal row would offer to remove
      // the page its own agreement just wrote.
      const listedAsDeal = new Set(this.deals.map((d) => d.genesis));
      const cameBack = this.retainedOffers.filter((r) => listedAsDeal.has(r.genesis));
      if (cameBack.length > 0) {
        for (const row of cameBack) {
          this.releaseRetained(row.genesis);
          this.setRowPhase(row.genesis, 'idle');
          this.forgetExpectation(row.genesis);
        }
      }
    } catch (error) {
      console.error('Error loading deals:', error);
    }
    this.fetching = false;
    // Nothing is waiting any more (a released row included): let the timer go.
    if (!this.hasWaitingRow()) this.stopPoll();
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
        // A declined offer leaves no offer behind on chain, but that does not
        // mean it has no page: an author's non-whitelisted `makeOffer` suspends
        // an agreement and moves the document into the offer set while its page
        // stays live. Keep the row and let the render decide (hasAgreement is
        // already false, so its page is out of force and removable).
        this.showNotification('Offer rejected! Transaction pending approval.', 'success');
        // Remove from offers — no demotion
        const idx = this.offers.findIndex((o) => o.genesis === genesis);
        if (idx !== -1) {
          const offer = this.offers.splice(idx, 1)[0];
          store.setOffers(this.offers);
          this.retainOffer(offer);
        }
        this.beginWait(genesis, false);
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
    this.rowRevision += 1;
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

  private forgetExpectation(genesis: string) {
    if (!(genesis in this.rowExpects)) return;
    const next = { ...this.rowExpects };
    delete next[genesis];
    this.rowExpects = next;
  }

  private retainOffer(offer: Deal) {
    if (this.retainedOffers.some((r) => r.genesis === offer.genesis)) return;
    this.retainedOffers = [...this.retainedOffers, offer];
  }

  private releaseRetained(genesis: string) {
    if (!this.retainedOffers.some((r) => r.genesis === genesis)) return;
    this.retainedOffers = this.retainedOffers.filter((r) => r.genesis !== genesis);
  }

  private isRetained(genesis: string): boolean {
    return this.retainedOffers.some((r) => r.genesis === genesis);
  }

  /**
   * Pending Offer rows: what the chain lists, plus any row kept alive for a
   * removal the chain no longer knows about. A genesis the chain lists again
   * wins over the retained copy.
   */
  private offerRows(): Deal[] {
    const listed = new Set([...store.deals, ...store.offers].map((d) => d.genesis));
    return [...store.offers, ...this.retainedOffers.filter((r) => !listed.has(r.genesis))];
  }

  /**
   * What the update's trace says about the removals it was asked to make, by
   * line prefix. `removed:` wins over a `warn: rm failed` line, because the
   * action records the removal it performed and a warning beside it is about
   * another path. A `skip remove` line is a decision, not a failure: the action
   * considered the removal and refused it. No line about removals at all is not
   * evidence either way.
   */
  private removalOutcome(trace: unknown): RemovalOutcome {
    const lines = Array.isArray(trace)
      ? trace.filter((line): line is string => typeof line === 'string')
      : [];
    if (lines.some((line) => line.startsWith('removed: '))) return { kind: 'removed' };
    const failed = lines.find((line) => line.startsWith('warn: rm failed'));
    if (failed) return { kind: 'failed', line: failed };
    const skipped = lines.find((line) => line.startsWith('skip remove'));
    if (skipped) return { kind: 'skipped', line: skipped };
    return { kind: 'silent' };
  }

  /** The name a waiting row is announced by, for the timeout notice. */
  private rowLabel(genesis: string): string {
    const row = [...store.deals, ...store.offers, ...this.retainedOffers].find(
      (d) => d.genesis === genesis,
    );
    return row ? displayName(row) : genesis;
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

      const expects = this.rowExpects[genesis];
      if (expects === undefined) continue;

      const started = this.waitingSince[genesis];
      const expired = started !== undefined && Date.now() - started >= POLL_TIMEOUT_MS;

      try {
        const hasAgreement = await this.safeIntegration.hasAgreement(genesis);
        // The row may have moved on while the read was in flight.
        if (this.rowPhase[genesis] !== 'waiting') continue;
        if (hasAgreement === expects) {
          this.clearWait(genesis);
          this.setRowPhase(genesis, 'render');
          continue;
        }
        if (expired) {
          // Not a dead end: the proposal may still be executed later, and Sync
          // site sweeps the offers, so the removal or the page is reconciled
          // there. Say so once and stop watching. The name is read before the
          // row is released, or there is nothing left to name it by.
          const label = this.rowLabel(genesis);
          this.clearWait(genesis);
          this.setRowPhase(genesis, 'idle');
          this.releaseRetained(genesis);
          this.showNotification(
            `${label}: the proposal has not executed. Sync site will reconcile it.`,
            'error',
          );
        }
      } catch (error) {
        // A read that fails is not an answer: keep waiting until the cap, but
        // the cap is still a cap — a permanently failing read must not leave a
        // spinner turning forever.
        console.warn('Could not read agreement state', genesis, error);
        if (expired) {
          const label = this.rowLabel(genesis);
          this.clearWait(genesis);
          this.setRowPhase(genesis, 'idle');
          this.releaseRetained(genesis);
          this.showNotification(
            `${label}: the proposal could not be confirmed. Sync site will reconcile it.`,
            'error',
          );
        }
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
      // A `success:false` envelope is a render that wrote nothing, including
      // the contenthash write that moves the root. Marking it rendered would
      // claim a page that the site does not have.
      if (!res.success) {
        this.setRowPhase(genesis, 'render');
        this.showNotification(
          `Render failed: ${res.error ?? 'the update action did not report success'}`,
          'error',
        );
        return;
      }
      // A removal is done when the action's trace records the removal it
      // performed; see removalOutcome for why the trace is read as lines.
      if (this.rowExpects[genesis] === false) {
        const outcome = this.removalOutcome(res.trace);
        if (outcome.kind === 'failed') {
          this.setRowPhase(genesis, 'render');
          this.showNotification(`Removal failed: ${outcome.line}`, 'error');
          return;
        }
        if (outcome.kind === 'silent') {
          this.setRowPhase(genesis, 'render');
          this.showNotification(
            'Removal not confirmed: the action reported nothing about it.',
            'error',
          );
          return;
        }
        if (outcome.kind === 'skipped') {
          // A skip is a decision not to remove: no page there, a reserved path,
          // or another genesis still in force at that path. So the page is not
          // necessarily gone, and the row keeps the removal on offer with the
          // reason beside it. It also stays retained: the chain does not list
          // it, so releasing it would drop the row that owes the removal.
          this.setRowPhase(genesis, 'render');
          this.showNotification(
            `Removal skipped: ${outcome.line.replace(/^skip remove\s+/, '')}`,
            'success',
          );
          return;
        }
      }
      this.setRowPhase(genesis, 'done');
      this.releaseRetained(genesis);
      await this.loadDeals();
    } catch (error: any) {
      this.setRowPhase(genesis, 'render');
      this.showNotification(`Render failed: ${error.message}`, 'error');
    }
  }

  // ---- per-row preview ----------------------------------------------------

  /**
   * Preview one row's page and open it in a new tab. The window is opened
   * here, inside the click gesture, before any await: a popup raised after the
   * render returns is blocked, and Safe's iframe makes that worse.
   *
   * The encrypted check is repeated here rather than left to the disabled
   * button: a click on the <s2s-button> host (its padding) still dispatches,
   * and the render has no key for that item.
   */
  private async previewRow(genesis: string) {
    if (this.previewing[genesis] || this.isSealed(genesis)) return;

    // A new attempt supersedes the link the last blocked one left behind.
    this.setPreviewReady(genesis, null);
    this.setPreviewing(genesis, true);

    const tab = window.open('', '_blank');
    try {
      const res = await this.performRender(true, [genesis]);
      // A preview without a CID wrote nothing to look at; say why rather than
      // sending the tab to an empty page.
      if (!res.success || !res.cid) {
        throw new Error(res.error ?? 'the update action returned no preview CID');
      }
      const url = previewLink(res.cid, res.path || '/');
      if (tab) {
        // Sever the opener so the preview cannot reach back into the Safe app.
        tab.opener = null;
        tab.location.href = url;
      } else {
        this.setPreviewReady(genesis, url);
      }
    } catch (error: any) {
      tab?.close();
      this.showNotification(`Preview failed: ${error.message}`, 'error');
    } finally {
      this.setPreviewing(genesis, false);
    }
  }

  /**
   * Whether a row's manuscript is encrypted, read as truthiness like
   * renderIds does: the flag is copied off the stored item unvalidated, so a
   * non-boolean truthy value has to be refused here exactly as a sweep refuses
   * it, or the row would offer a preview the bulk preview already drops.
   */
  private isSealed(genesis: string): boolean {
    const row = [...store.deals, ...store.offers, ...this.retainedOffers].find(
      (d) => d.genesis === genesis,
    );
    return Boolean(row?.encryption);
  }

  /** Immutable copy-on-write, so Lit sees a new map and re-renders the row. */
  private setPreviewing(genesis: string, busy: boolean) {
    this.previewing = { ...this.previewing, [genesis]: busy };
  }

  private setPreviewReady(genesis: string, url: string | null) {
    const next = { ...this.previewReady };
    if (url === null) delete next[genesis];
    else next[genesis] = url;
    this.previewReady = next;
  }

  /**
   * The Preview control every row carries, off in no mode toggle: `previewMode`
   * only changes what the bulk Sync site call does. An encrypted manuscript has
   * no key here, so its button is rendered but cannot fire.
   */
  private renderPreview(deal: Deal): TemplateResult {
    const busy = this.previewing[deal.genesis] ?? false;
    const sealed = this.isSealed(deal.genesis);
    const ready = this.previewReady[deal.genesis];
    return html`
      <s2s-button action="preview" genesis="${deal.genesis}" type="secondary"
        ?disabled=${busy || sealed}
        title=${sealed ? 'Encrypted manuscripts cannot be previewed' : nothing}
        @click=${() => void this.previewRow(deal.genesis)}>
        ${busy
          ? html`<span class="row-spinner" aria-hidden="true"></span> Previewing`
          : 'Preview'}
      </s2s-button>
      ${ready
        ? html`<a class="preview-ready" href=${ready} target="_blank"
            rel="noopener noreferrer">Open preview</a>`
        : nothing}
    `;
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
      if (!res.success) {
        this.showNotification(
          `Sync failed: ${res.error ?? 'the update action did not report success'}`,
          'error',
        );
      }
    } catch (error: any) {
      console.error('Bulk render failed:', error);
      this.showNotification(`Sync failed: ${error.message}`, 'error');
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
    const expects = this.rowExpects[genesis] ?? true;
    const label = expects ? 'Publish' : 'Remove page';

    switch (phase) {
      // A done row shows no action at all, like an idle one: the phase still
      // holds (and still releases what it was carrying), it just has nothing
      // left to offer. The notice for a finished removal is already sent by
      // renderRow, so a green button said nothing new.
      case 'idle':
      case 'done':
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
    }
  }

  private renderOfferRow(offer: Deal): TemplateResult {
    return html`
      <div class="offer-card table-row" data-genesis="${offer.genesis}">
        <div class="table-cell"><copy-content-id value='${offer.genesis}' display='${displayName(offer)}'></copy-content-id></div>
        <div class="table-cell"><pet-name value=${offer.author}></pet-name></div>
        <div class="table-cell">${offer.postType ?? ''}</div>
        <div class="table-cell">${formatDate(offer.creationDate)}</div>
        <div class="table-cell">${offer.tags?.join(', ') ?? ''}</div>
        <div class="table-cell"><span class="offer-status status-pending">Pending</span></div>
        <div class="table-cell row-actions">
          ${this.renderPreview(offer)}
          ${this.isRetained(offer.genesis)
            ? nothing
            : html`<s2s-button action="accept" genesis="${offer.genesis}" status="offer" variant="spin"
                @click=${() => this.admitOffer(offer.genesis)}>Accept</s2s-button>
              <s2s-button action="reject" genesis="${offer.genesis}" status="offer"
                @click=${() => this.reject(offer.genesis, 'offer')}>Refuse</s2s-button>`}
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
        <div class="table-cell">${formatDate(deal.creationDate)}</div>
        <div class="table-cell">${formatDateTime(deal.modifiedDate)}</div>
        <div class="table-cell">${deal.tags?.join(', ') ?? ''}</div>
        <div class="table-cell row-actions">
          ${this.renderPreview(deal)}
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

    const offers = this.offerRows();

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

      ${offers.length > 0
        ? html`
            <div class="section">
              <s2s-table
                title="Pending Offers"
                .titleAction=${html`<s2s-button type="primary" ?disabled=${this.fetching}
                  @click=${() => void this.handleRefresh()} style="margin-right: 1rem">
                  <ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise> Sync
                </s2s-button>`}
                .columns=${OFFER_COLUMNS}
                .rows=${offers}
                .sort=${this.offersSort}
                .chipsGroups=${DEAL_CHIPS_GROUPS}
                .chips=${this.offersChips}
                .rowRenderer=${this.offerRowRenderer}
                .revision=${this.rowRevision}
                .actionsHeader=${true}
                .actionsContent=${html`actions`}
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
            @click=${() => void this.handleRefresh()} style="margin-right: 1rem">
            <ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise> Sync
          </s2s-button>`}
          .columns=${DEAL_COLUMNS}
          .rows=${store.deals}
          .sort=${this.dealsSort}
          .chipsGroups=${store.deals.length > 0 ? DEAL_CHIPS_GROUPS : []}
          .chips=${this.dealsChips}
          .rowRenderer=${this.dealRowRenderer}
          .revision=${this.rowRevision}
          .actionsHeader=${true}
          .actionsHeaderClass=${'hide-sm'}
          .actionsContent=${html`actions`}
          emptyText=${store.deals.length > 0 ? 'No agreements match the current filters' : 'No active agreements yet'}
          gridTemplate="2fr 1fr 1fr 1fr 1fr 1fr auto"
          @sort=${(e: CustomEvent) => { this.dealsSort = toggleSort(this.dealsSort, e.detail.key); }}
          @chip-filter=${(e: CustomEvent) => { this.dealsChips = setChips(this.dealsChips, e.detail.key, e.detail.values); }}
        ></s2s-table>
      </div>
    `;
  }
}
