// s2s-cid-view-section.ts — read-only CID inventory for the Storage tab.
//
// Runs the shared cid-view coordinator (buildPublicationCidView) over a
// `CidViewReadContext` supplied by the host (s2s-storage-tab), then renders a
// grouped inventory table of every CID a publication uses: deals/offers +
// version history, the config/templates/assets tree, the site root + tree, and
// the publication archive. Read-only by design — no mutation/delete controls;
// unpin/cleanup ships in a later iteration.
//
// Fail-open: no ctx (no modules) renders an "unavailable" empty state, a build
// failure renders the error state, and a successful empty build renders
// "No CIDs found". It never throws and never mutates the store.
//
// Stale-while-revalidate: the last-good view per publication is kept in
// localStorage (s2s.cidview.<publication>) so a reload / publication switch
// paints the known table instantly and revalidates in the background. Reads/
// writes are fail-open (privacy mode or corrupt JSON → no cache).
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';
import { buildPublicationCidView, parsePublicationCidView } from '@s2s/soul2soul-shared/safe-app';
import type {
  CidCategory,
  CidEntry,
  CidViewReadContext,
  PublicationCidView,
} from '@s2s/soul2soul-shared/safe-app';
import { store } from '../state/index.js';
import './copy-hash.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

/** Human label + badge class per CID category. */
const CATEGORY_META: Record<CidCategory, { label: string; cls: string }> = {
  deal: { label: 'deal', cls: 'deal' },
  'deal-version': { label: 'deal version', cls: 'deal-version' },
  offer: { label: 'offer', cls: 'offer' },
  'offer-version': { label: 'offer version', cls: 'offer-version' },
  config: { label: 'config', cls: 'config' },
  'template-dag': { label: 'template DAG', cls: 'config' },
  template: { label: 'template', cls: 'config' },
  'assets-root': { label: 'assets root', cls: 'asset' },
  asset: { label: 'asset', cls: 'asset' },
  'site-root': { label: 'site root', cls: 'tree' },
  'site-file': { label: 'site file', cls: 'tree' },
  archive: { label: 'archive', cls: 'archive' },
  'archive-item': { label: 'archive item', cls: 'archive' },
};

function categoryLabel(cat: CidCategory): string {
  return CATEGORY_META[cat]?.label ?? cat.replace(/-/g, ' ');
}
function categoryClass(cat: CidCategory): string {
  return CATEGORY_META[cat]?.cls ?? 'deal';
}

// --- localStorage stale-while-revalidate cache ---

const CACHE_PREFIX = 's2s.cidview.';

/** What we persist per publication: the last-good view + when it was saved. */
interface CachedCidView {
  savedAt: number; // epoch ms — when the fresh view was persisted
  view: PublicationCidView;
}

function cacheKey(publication: string): string {
  return CACHE_PREFIX + publication;
}

/**
 * Read the last-good view for a publication from localStorage.
 * Fail-open: privacy mode, missing key, corrupt JSON or a JSON-valid but
 * schema-invalid blob all degrade to null (no cache), mirroring the
 * component's fail-open posture.
 *
 * Shape validation delegates to the shared house schema
 * (parsePublicationCidView / publicationCidViewSchema) — the same invariant
 * the coordinator enforces on its own output — so a blob with a bad category
 * enum, wrong sources/summary shape etc. can never be rendered as garbage.
 */
function loadCachedView(publication: string): CachedCidView | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(publication));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { savedAt, view } = parsed as { savedAt?: unknown; view?: unknown };
    if (typeof savedAt !== 'number') return null;
    if (typeof view !== 'object' || view === null) return null;
    const v = view as Record<string, unknown>;
    if (v.publication !== publication) return null; // key/record mismatch
    // Full zod validation — throws ZodError on any structural violation, which
    // the try/catch above converts into the fail-open no-cache result.
    const validated = parsePublicationCidView(view);
    return { savedAt, view: validated };
  } catch {
    return null;
  }
}

/** Persist a fresh view for a publication. Fail-open (storage full / privacy mode). */
function saveCachedView(publication: string, view: PublicationCidView): void {
  try {
    window.localStorage.setItem(
      cacheKey(publication),
      JSON.stringify({ savedAt: Date.now(), view }),
    );
  } catch {
    // ignore — the component still works without a cache
  }
}

@customElement('s2s-cid-view-section')
export class S2SCidViewSection extends LitElement {
  /** Read context over chain + IPFS (undefined → unavailable state). */
  @property({ attribute: false }) ctx?: CidViewReadContext;
  /** Publication ENS name; falls back to the store `name` record when empty. */
  @property() publication = '';

  @state() private view: PublicationCidView | null = null;
  @state() private loading = false;
  @state() private error = '';
  /** Epoch ms when the currently displayed (cached) view was persisted — null when fresh. */
  @state() private staleSince: number | null = null;

  /** Monotonic build id — stale async builds never overwrite a newer one. */
  private buildId = 0;
  /** One-minute ticker that keeps the staleness label honest while stale. */
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  /** Mark the shown view as stale (served from cache) and start the age ticker. */
  private setStale(savedAt: number): void {
    this.staleSince = savedAt;
    this.staleTimer ??= setInterval(() => {
      this.requestUpdate();
    }, 60_000);
  }

  /** Clear staleness (a fresh build now owns the view) and stop the ticker. */
  private clearStale(): void {
    this.staleSince = null;
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  /** Human 'cached N min ago' label for the staleness hint. */
  private staleLabel(): string {
    if (this.staleSince == null) return '';
    const mins = Math.max(1, Math.round((Date.now() - this.staleSince) / 60_000));
    return `cached ${String(mins)} min ago`;
  }

  static styles = [
    typograhyStyles,
    sectionStyles,
    buttonStyles,
    css`
      :host {
        display: block;
        margin-bottom: 2rem;
      }
h

      .cid-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        margin-bottom: 1rem;
        flex-wrap: wrap;
      }

      .cid-title {

        color: var(--gray-100, #f3f4f6);
        margin: 0;
        display: flex;
        align-items: center;
      }

      .refresh {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        background: transparent;
        border: 1px solid var(--gray-600, #4b5563);
        color: var(--gray-200, #e5e7eb);
        padding: 0.35rem 0.7rem;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.78rem;
        font-weight: 500;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .refresh:hover:not(:disabled) {
        border-color: var(--blue-400, #60a5fa);
        color: var(--blue-300, #93c5fd);
      }
      .refresh:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-bottom: 1rem;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.25rem 0.65rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid var(--gray-700, #374151);
        color: var(--gray-200, #e5e7eb);
        font-size: 0.75rem;
        white-space: nowrap;
      }
      .chip .chip-value {
        font-weight: 700;
        color: var(--gray-50, #f9fafb);
      }
      .chip.flag-on {
        border-color: rgba(16, 185, 129, 0.4);
        color: #6ee7b7;
      }
      .chip.flag-off {
        opacity: 0.55;
      }

      /* Grouped inventory table (simple grid, read-only). */
      .cid-table {
        display: grid;
        grid-template-columns: 0.95fr 0.7fr 1.9fr 1.6fr 1.2fr 0.85fr 0.55fr;
        width: 100%;
        overflow-x: auto;
      }
      .cid-header-row,
      .cid-group-row,
      .cid-row {
        display: contents;
      }
      .cid-cell {
        padding: 0.55rem 0.6rem;
        border-bottom: 1px solid var(--gray-800, #1f2937);
        font-size: 0.82rem;
        color: var(--gray-300, #d1d5db);
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .cid-head {
        padding: 0.55rem 0.6rem;
        border-bottom: 1px solid var(--gray-600, #4b5563);
        text-transform: uppercase;
        font-size: 0.68rem;
        letter-spacing: 0.06em;
        color: var(--gray-400, #9ca3af);
      }
      .cid-group {
        padding: 0.5rem 0.6rem;
        grid-column: 1 / -1;
        background: rgba(59, 130, 246, 0.06);
        border-bottom: 1px solid var(--gray-700, #374151);
        color: var(--gray-200, #e5e7eb);
        font-size: 0.78rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .cid-group .group-count {
        color: var(--gray-400, #9ca3af);
        font-weight: 500;
        margin-left: 0.4rem;
      }

      .badge {
        display: inline-block;
        padding: 0.12rem 0.5rem;
        border-radius: 4px;
        font-size: 0.7rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .badge.deal {
        background: rgba(59, 130, 246, 0.15);
        color: #93c5fd;
      }
      .badge.offer {
        background: rgba(168, 85, 247, 0.15);
        color: #d8b4fe;
      }
      .badge.deal-version,
      .badge.offer-version {
        background: rgba(14, 165, 233, 0.15);
        color: #7dd3fc;
      }
      .badge.config {
        background: rgba(245, 158, 11, 0.15);
        color: #fcd34d;
      }
      .badge.asset {
        background: rgba(139, 92, 246, 0.15);
        color: #c4b5fd;
      }
      .badge.tree {
        background: rgba(16, 185, 129, 0.15);
        color: #6ee7b7;
      }
      .badge.archive {
        background: rgba(244, 63, 94, 0.15);
        color: #fda4af;
      }
      .badge.source {
        background: rgba(148, 163, 184, 0.15);
        color: #cbd5e1;
      }
      .badge.tombstone {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
      }

      .gateway-link {
        text-decoration: none;
        color: inherit;
        display: inline-flex;
        align-items: center;
      }
      .gateway-link:hover {
        text-decoration: underline;
        color: var(--blue-400, #60a5fa);
      }
      .gateway-link::after {
        content: '↗';
        margin-left: 0.25rem;
        font-size: 0.75rem;
        opacity: 0.6;
      }

      .muted {
        color: var(--gray-500, #6b7280);
      }
      .stale-hint {
        font-size: 0.72rem;
        font-style: italic;
        color: var(--gray-500, #6b7280);
        white-space: nowrap;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 1rem;
        padding: 2.5rem 1rem;
        color: var(--gray-400, #9ca3af);
      }
      .spinner {
        width: 2rem;
        height: 2rem;
        border: 3px solid #e5e7eb;
        border-top: 3px solid #3b82f6;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        0% {
          transform: rotate(0deg);
        }
        100% {
          transform: rotate(360deg);
        }
      }

      .empty {
        padding: 2rem 1rem;
        text-align: center;
        color: var(--gray-400, #9ca3af);
        font-size: 0.9rem;
      }
      .empty .empty-title {
        font-weight: 600;
        color: var(--gray-200, #e5e7eb);
        margin-bottom: 0.25rem;
      }

      .error {
        padding: 1rem;
        border-radius: 6px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.35);
        color: #fca5a5;
        font-size: 0.85rem;
      }
    `,
  ];

  protected updated(changed: PropertyValues) {
    if (changed.has('ctx') || changed.has('publication')) {
      // Defer past the current update flush: kicking off the async load from
      // `updated()` synchronously writes @state and re-requests an update
      // while Lit is still inside the finished render (noisy warning + wasted
      // render). Awaiting updateComplete schedules the next update cleanly.
      void this.updateComplete.then(() => this.rebuild());
    }
  }

  private async rebuild() {
    const buildId = ++this.buildId;
    const ctx = this.ctx;
    if (!ctx) {
      // No read context (modules not detected) → unavailable state.
      this.view = null;
      this.loading = false;
      this.error = '';
      this.clearStale();
      return;
    }
    const publication = this.publication || store.getRecord?.('name') || '';

    // Stale-while-revalidate: hydrate the last-known view from localStorage
    // BEFORE the async fresh build so the table renders instantly instead of
    // the infinite spinner. Only hydrate when nothing is displayed yet or the
    // shown view belongs to a different publication. loading stays true so the
    // Refresh button reads 'Loading…' while revalidating in the background.
    const cached = loadCachedView(publication);
    if (cached && this.view?.publication !== publication) {
      console.log('[cid-view] serving cached view for ' + publication);
      this.view = cached.view;
      this.setStale(cached.savedAt);
    } else if (!cached && this.view !== null && this.view.publication !== publication) {
      // Publication changed and the new one has no cache → never show another
      // publication's stale data; reset so the spinner takes over.
      this.view = null;
      this.clearStale();
    }

    this.loading = true;
    this.error = ''; // setting @state already requests an update; no explicit requestUpdate needed
    const started = performance.now();
    try {
      const view = await buildPublicationCidView(ctx, publication);
      if (buildId !== this.buildId) return;
      this.view = view;
      saveCachedView(publication, view);
      this.clearStale();
      const elapsed = Math.round(performance.now() - started);
      console.log(
        `[cid-view] rebuild ${publication} done in ${String(elapsed)}ms — ${String(view.summary.total)} entries, ${String(view.summary.uniqueCids)} unique CIDs`,
      );
      console.log('[cid-view] fresh view saved for ' + publication);
    } catch (e) {
      if (buildId !== this.buildId) return;
      if (this.view === null) {
        // No cached/prior view to fall back on → error state (fail-open).
        this.error = e instanceof Error ? e.message : String(e);
      }
      // else: keep the last-known (cached) view — never clobber good data
      // with an error state.
    } finally {
      if (buildId === this.buildId) this.loading = false;
    }
  }

  private shortenCid(cid: string, len: number = 10): string {
    if (!cid || cid.length <= len * 2) return cid || '-';
    return `${cid.slice(0, len)}...${cid.slice(-len)}`;
  }

  private gatewayUrl(cid: string): string {
    return `https://ipfs.io/ipfs/${cid}`;
  }

  private ageDisplay(timestamp?: number): string {
    if (!timestamp) return '-';
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  /** Group entries by category, preserving first-appearance (coordinator) order. */
  private groupByCategory(
    entries: CidEntry[],
  ): Array<{ category: CidCategory; items: CidEntry[] }> {
    const order: CidCategory[] = [];
    const map = new Map<CidCategory, CidEntry[]>();
    for (const entry of entries) {
      let group = map.get(entry.category);
      if (!group) {
        group = [];
        map.set(entry.category, group);
        order.push(entry.category);
      }
      group.push(entry);
    }
    return order.map((category) => ({ category, items: map.get(category) ?? [] }));
  }

  private renderSummary(view: PublicationCidView): TemplateResult {
    const catCounts = Object.entries(view.summary.byCategory ?? {}) as Array<[CidCategory, number]>;
    return html`
      <div class="chips">
        <span class="chip"
          ><span class="chip-value">${view.summary.uniqueCids}</span> unique CIDs</span
        >
        <span class="chip"><span class="chip-value">${view.summary.total}</span> entries</span>
        ${catCounts.map(
          ([cat, count]) =>
            html`<span class="chip"
              ><span class="chip-value">${count}</span> ${categoryLabel(cat)}${count !== 1
                ? 's'
                : ''}</span
            >`,
        )}
        <span class="chip ${view.sources.deals ? 'flag-on' : 'flag-off'}"
          >deals ${view.sources.deals ? '✓' : '✗'}</span
        >
        <span class="chip ${view.sources.config ? 'flag-on' : 'flag-off'}"
          >config ${view.sources.config ? '✓' : '✗'}</span
        >
        <span class="chip ${view.sources.tree ? 'flag-on' : 'flag-off'}"
          >tree ${view.sources.tree ? '✓' : '✗'}</span
        >
        <span class="chip ${view.sources.archive ? 'flag-on' : 'flag-off'}"
          >archive ${view.sources.archive ? '✓' : '✗'}</span
        >
      </div>
    `;
  }

  private renderEntryRow(entry: CidEntry): TemplateResult {
    const cid = entry.cid;
    return html`
      <div class="cid-row">
        <div class="cid-cell">
          <span class="badge ${categoryClass(entry.category)}"
            >${categoryLabel(entry.category)}</span
          >
        </div>
        <div class="cid-cell"><span class="badge source">${entry.source}</span></div>
        <div class="cid-cell">
          <a
            href="${this.gatewayUrl(cid)}"
            target="_blank"
            rel="noopener noreferrer"
            class="gateway-link"
            title="Open on IPFS gateway"
          >
            <copy-hash .value=${this.shortenCid(cid)}></copy-hash>
          </a>
        </div>
        <div class="cid-cell">
          ${entry.role || entry.path || html`<span class="muted">-</span>`}
        </div>
        <div class="cid-cell">
          ${entry.genesis ? this.shortenCid(entry.genesis, 6) : html`<span class="muted">-</span>`}
        </div>
        <div class="cid-cell">${this.ageDisplay(entry.timestamp)}</div>
        <div class="cid-cell">
          ${entry.tombstoned
            ? html`<span class="badge tombstone">tombstone</span>`
            : html`<span class="muted">-</span>`}
        </div>
      </div>
    `;
  }

  private renderTable(view: PublicationCidView): TemplateResult {
    const groups = this.groupByCategory(view.entries);
    return html`
      <div class="cid-table">
        <div class="cid-header-row">
          <div class="cid-head">Category</div>
          <div class="cid-head">Source</div>
          <div class="cid-head">CID</div>
          <div class="cid-head">Role / Path</div>
          <div class="cid-head">Genesis</div>
          <div class="cid-head">Age</div>
          <div class="cid-head">Tombstone</div>
        </div>
        ${groups.map(
          (group) => html`
            <div class="cid-group-row">
              <div class="cid-group">
                ${categoryLabel(group.category)}<span class="group-count"
                  >${group.items.length}</span
                >
              </div>
            </div>
            ${group.items.map((entry) => this.renderEntryRow(entry))}
          `,
        )}
      </div>
    `;
  }

  render() {
    if (!this.ctx) {
      return html`
        <div class="cid-section">
          <div class="empty">
            <div class="empty-title">CID inventory unavailable</div>
            <div>Connect a publication module to enumerate every CID this publication uses.</div>
          </div>
        </div>
      `;
    }

    if (this.loading && !this.view) {
      return html`
        <div class="cid-section">
          <div class="loading">
            <div class="spinner"></div>
            <p>Loading CID inventory…</p>
          </div>
        </div>
      `;
    }

    if (this.error && !this.view) {
      return html`
        <div class="cid-section">
          <div class="error">
            <ph-warning size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-warning> ${this.error}
          </div>
        </div>
      `;
    }

    const view = this.view;
    if (!view) {
      // ctx set but build hasn't produced anything yet (first paint).
      return html`
        <div class="cid-section">
          <div class="loading">
            <div class="spinner"></div>
            <p>Loading CID inventory…</p>
          </div>
        </div>
      `;
    }

    return html`
      <div class="cid-section">
        <div class="cid-header">
          <h2 class="cid-title">
            <ph-tree-structure size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-tree-structure>
            CID Inventory
          </h2>
          <button class="refresh" ?disabled=${this.loading} @click=${() => void this.rebuild()}>
            <ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise>
            ${this.loading ? 'Loading…' : 'Refresh'}
          </button>
          ${this.staleSince != null
            ? html`<span class="stale-hint">${this.staleLabel()}</span>`
            : nothing}
        </div>
        ${this.renderSummary(view)}
        ${view.entries.length === 0
          ? html`
              <div class="empty">
                <div class="empty-title">No CIDs found</div>
                <div>
                  No deals, config, site tree or archive entries are available for this publication.
                </div>
              </div>
            `
          : this.renderTable(view)}
      </div>
    `;
  }
}
