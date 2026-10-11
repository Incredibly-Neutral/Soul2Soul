// s2s-cid-view-section.ts — read-only CID inventory for the Storage tab.
//
// Runs the shared cid-view coordinator (buildPublicationCidView) over a
// `CidViewReadContext` supplied by the host (s2s-storage-tab), then renders a
// grouped inventory table of every CID a publication uses: deals/offers +
// version history, the config/templates/assets tree, the site root + tree, and
// the publication archive. Read-only by design — no mutation/delete controls;
// unpin/cleanup ships in a later iteration.
//
// SCOPE: offers + version history (deal/offer versions) are intentionally
// HIDDEN from this view and from the retrievability check — storage operators
// care about the live deal rows, config/tree/archive CIDs, not the offer
// ledger or historical versions. The full view still powers the incremental
// cache baseline; only the displayed/checked view is filtered.
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
import {
  cidsFromView,
  orderByCopiesAscending,
  orderByStaleness,
  RETRIEVABILITY_SOURCES,
} from '@s2s/soul2soul-shared/safe-app';
import type {
  CidCategory,
  CidEntry,
  CidRetrievabilityMap,
  CidRetrievabilityStatus,
  CidViewReadContext,
  CheckState,
  PublicationCidView,
  RetrievabilitySource,
} from '@s2s/soul2soul-shared/safe-app';
import { store } from '../state/index.js';
import './copy-hash.js';
import { checkRetrievability, loadRetrievabilityMap } from '@/lib/cid-view/index.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { tableStyles } from '@/styles/table-styles.js';
import { toggleSort, type SortState, type TableColumn } from '@/utils/sort.js';
import type { ChipsGroup } from '@/utils/filter.js';
import './s2s-table.js';
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

/**
 * Human name shown in the Role/Path cell for entries WITHOUT a path (roots and
 * ledger rows: config, templates DAG, assets root, site root, archive, deals).
 * When an entry has a path, the path is the identifier — no name is shown.
 */
const ROOT_NAME: Partial<Record<CidCategory, string>> = {
  deal: 'deal',
  'deal-version': 'version',
  offer: 'offer',
  'offer-version': 'offer version',
  config: 'publication config',
  'template-dag': 'templates DAG',
  'assets-root': 'assets root',
  'site-root': 'site root',
  archive: 'publication archive',
  'archive-item': 'archive item',
};

/**
 * Display name for the Role/Path cell: the path when one exists, else the
 * role, else a per-category description. Never renders a bare '-'
 * (the templates DAG row, e.g., reads 'templates DAG' instead of '-').
 */
function entryName(entry: CidEntry): string {
  if (entry.path) return entry.path;
  if (entry.role) return entry.role;
  return ROOT_NAME[entry.category] ?? categoryLabel(entry.category);
}

/**
 * Collapsed source+category type column. The type is a coarser, human label
 * that groups categories (deal/version/config/html/asset/cache); the badge
 * still carries the fine-grained category class + title for color/detail.
 */
const TYPE_META: Record<CidCategory, { label: string; cls: string }> = {
  deal: { label: 'source', cls: 'deal' },
  'deal-version': { label: 'version', cls: 'deal-version' },
  offer: { label: 'offer', cls: 'offer' },
  'offer-version': { label: 'offer version', cls: 'offer-version' },
  config: { label: 'config', cls: 'config' },
  'template-dag': { label: 'config', cls: 'config' },
  template: { label: 'config', cls: 'config' },
  'assets-root': { label: 'asset', cls: 'asset' },
  asset: { label: 'asset', cls: 'asset' },
  'site-root': { label: 'html', cls: 'tree' },
  'site-file': { label: 'html', cls: 'tree' },
  archive: { label: 'cache', cls: 'archive' },
  'archive-item': { label: 'cache item', cls: 'archive' },
};

function typeLabel(cat: CidCategory): string {
  return TYPE_META[cat].label;
}
function typeClass(cat: CidCategory): string {
  return TYPE_META[cat].cls;
}

/**
 * Categories hidden from the Storage CID inventory: offers + version history
 * (deal versions and offer versions). They're chain-ledger noise for storage
 * operators — the live deal row is what matters. Hidden both from the rendered
 * table AND from the retrievability (ipfs-check) pass.
 */
const HIDDEN_CATEGORIES: ReadonlySet<CidCategory> = new Set([
  'offer',
  'offer-version',
  'deal-version',
]);

/**
 * Display copy of a view with offer + version entries removed (deals kept).
 * Recomputes sources + summary so the chips/counters stay honest. `meta` is
 * preserved untouched — the FULL view is what gets cached and passed as the
 * incremental baseline (see rebuild), so the incremental fast path keeps its
 * version history even though the table/check never see it.
 */
function withoutOffersAndVersions(view: PublicationCidView): PublicationCidView {
  const entries = view.entries.filter((e) => !HIDDEN_CATEGORIES.has(e.category));
  const sources = {
    deals: entries.some((e) => e.source === 'deals'),
    config: entries.some((e) => e.source === 'config'),
    tree: entries.some((e) => e.source === 'tree'),
    archive: entries.some((e) => e.source === 'archive'),
  };
  const byCategory: Partial<Record<CidCategory, number>> = {};
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
  }
  return {
    ...view,
    entries,
    sources,
    summary: {
      total: entries.length,
      uniqueCids: new Set(entries.map((e) => e.cid)).size,
      byCategory,
    },
  };
}

/** Health bucket for a checked status — drives the health filter chips. */
type CidHealth = 'healthy' | 'needs-healing' | 'danger' | 'lost';

const HEALTH_LABELS: Record<CidHealth, string> = {
  healthy: 'healthy',
  'needs-healing': 'needs healing',
  danger: 'danger',
  lost: 'lost',
};

/** 0 copies lost, 1 danger, 2–4 needs healing, ≥5 healthy. */
function healthBucket(status: CidRetrievabilityStatus): CidHealth {
  // 'inconclusive' (no provider reachable) and 'failed' (the check errored) are
  // NOT confirmed zero-copy — an overloaded check node must never read as
  // "lost". They surface as 'needs-healing' instead.
  if (status.state === 'inconclusive' || status.state === 'failed') return 'needs-healing';
  if (status.copies === 0) return 'lost';
  if (status.copies < 2) return 'danger';
  if (status.copies < 5) return 'needs-healing';
  return 'healthy';
}

/** Badge shown in the copies cell for every state except 'ok'. */
const STATE_BADGE: Partial<Record<CheckState, { label: string; cls: string }>> = {
  'no-providers': { label: 'no providers', cls: 'state-none' },
  inconclusive: { label: 'unreachable', cls: 'state-warn' },
  'not-served': { label: 'not served', cls: 'state-bad' },
  failed: { label: 'check failed', cls: 'state-error' },
};

/**
 * How to render the copies cell for a status. 'inconclusive' / 'failed' are
 * “could not verify this pass” — show last-known copies when we have them
 * (flagged by the state badge) or '?' when we don't, instead of a confident 0.
 */
function copiesRender(status: CidRetrievabilityStatus): { label: string; cls: string } {
  const unknown = status.state === 'inconclusive' || (status.state === 'failed' && status.checkedAt === '');
  if (unknown) {
    return status.copies > 0
      ? { label: `${String(status.copies)}/4`, cls: 'copies-unknown' }
      : { label: '?', cls: 'copies-unknown' };
  }
  const cls = status.copies >= 2 ? 'copies-ok' : status.copies === 1 ? 'copies-low' : 'copies-none';
  return { label: `${String(status.copies)}/4`, cls };
}

/** CIDs per retrievability batch POST (streaming keeps the UI incremental regardless). */
const RETRIEVABILITY_BATCH = 50;

/**
 * Auto-pass freshness window: a CID whose last check is younger than this is
 * left alone by the automatic pass (only stale/never-checked CIDs are
 * re-queried on mount / tab re-open). The manual Recheck button always forces
 * a full pass over every CID regardless of age.
 */
const RETRIEVABILITY_AUTO_FRESH_MS = 15 * 60_000; // 15 minutes

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
  /** Per-cid retrievability snapshot (Kubo/Pinata/Filebase/Filecoin copies). */
  @state() private retrievability: CidRetrievabilityMap | null = null;
  /** True while a retrievability recheck pass is running. */
  @state() private checking = false;
  /** Statuses applied this pass — for the checking X/Y indicator. */
  @state() private checkedCount = 0;
  /** CIDs this pass intends to check (unfresh on auto, all on manual) — Y in the indicator. */
  @state() private checkTarget = 0;
  /** True when the browser refuses localStorage (sandboxed iframe / privacy) — surfaced to the user. */
  @state() private storageBlocked = false;

  /** Active chip filter per group key (type/health; empty array or missing key = none). */
  @state() private chips: Record<string, string[]> = {};
  /** Current sort (user-initiated; null = the default risk-sorted row order). */
  @state() private sort: SortState | null = null;

  /** Monotonic build id — stale async builds never overwrite a newer one. */
  private buildId = 0;
  /**
   * The publication actually in use (this.publication falls back to the store
   * `name` record). Resolved once per rebuild and used for the retrievability
   * localStorage key + pass, so the cache is keyed by the same name as the view.
   */
  private resolvedPublication = '';
  /** Aborts the in-flight retrievability pass (disconnect / recheck / publication change). */
  private retrievabilityAbort: AbortController | null = null;
  /** Monotonic guard — a stale retrievability pass must not clobber a newer map. */
  private retrievabilityEpoch = 0;
  /** One-minute ticker that keeps the staleness label honest while stale. */
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  connectedCallback() {
    super.connectedCallback();
    // Storage probe: if the browser refuses localStorage (sandboxed Safe iframe
    // / privacy mode) the retrievability cache can never persist — surface that
    // loudly instead of silently degrading (save/load are fail-open).
    try {
      const probe = 's2s.cidview.probe';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
    } catch {
      this.storageBlocked = true;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    this.retrievabilityAbort?.abort();
    this.retrievabilityAbort = null;
    this.retrievabilityEpoch++;
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

  /**
   * Cached-retrievability hint: shows how many cids are stored + when the
   * newest result was written, so persistence is observable ("did my check
   * survive the reload?"). Hidden while a pass is actively re-checking.
   * Wording deliberately avoids the literal "cached" (an existing test asserts
   * that substring disappears once a fresh view is displayed).
   */
  private cachedRetrievabilityHint(): TemplateResult | typeof nothing {
    if (this.checking) return nothing;
    const map = this.retrievability;
    if (!map) return nothing;
    const count = Object.keys(map).length;
    if (count === 0) return nothing;
    let newest = 0;
    for (const status of Object.values(map)) {
      const t = Date.parse(status.checkedAt);
      if (!Number.isNaN(t) && t > newest) newest = t;
    }
    if (newest === 0) return nothing;
    const mins = Math.max(0, Math.round((Date.now() - newest) / 60_000));
    return html`<span class="stale-hint"
      >${String(count)} CIDs stored · last checked ${mins === 0 ? 'just now' : `${String(mins)} min ago`}</span
    >`;
  }

  static styles = [
    typograhyStyles,
    sectionStyles,
    buttonStyles,
    tableStyles,
    css`
      :host {
        display: block;
        margin-bottom: 2rem;
      }


      .cid-header {
        display: flex;
        justify-content: flex-start;
        align-items: center;
        gap: 1rem;
        margin-bottom: 2rem;
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

      /* Flat risk-sorted inventory grid (via <s2s-table> + tableStyles): the
         section only styles its own row cells; the grid, sortable headers and
         chips come from tableStyles / chipStyles (chipStyles is injected into
         light DOM by <s2s-table>). */
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
      /* First cell (Type badge) sits flush against the table's left edge. */
      .cid-cell:first-child {
        padding-left: 0;
      }
      /* Per-source availability dots. */
      .dot {
        display: inline-block;
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 9999px;
        vertical-align: middle;
      }
      .dot.on {
        background: #10b981;
        box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.4);
      }
      .dot.off {
        background: #ef4444;
        box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.4);
      }
      .dot.unknown {
        background: #4b5563;
      }
      /* Copies n/4 risk colouring. */
      .copies {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .copies.copies-ok {
        color: #6ee7b7;
      }
      .copies.copies-low {
        color: #fcd34d;
      }
      .copies.copies-none {
        color: #f87171;
      }
      .copies.copies-unknown {
        color: var(--gray-400, #9ca3af);
      }
      .state-badge {
        display: inline-block;
        margin-left: 0.4rem;
        padding: 0.08rem 0.42rem;
        border-radius: 4px;
        font-size: 0.62rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .state-badge.state-warn {
        background: rgba(245, 158, 11, 0.16);
        color: #fcd34d;
      }
      .state-badge.state-bad,
      .state-badge.state-error {
        background: rgba(239, 68, 68, 0.16);
        color: #fca5a5;
      }
      .state-badge.state-none {
        background: rgba(148, 163, 184, 0.16);
        color: #cbd5e1;
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

      .muted {
        color: var(--gray-500, #6b7280);
      }
      .stale-hint {
        font-size: 0.72rem;
        font-style: italic;
        color: var(--gray-500, #6b7280);
        white-space: nowrap;
      }

      .stale-hint.storage-warn {
        color: #f59e0b;
        font-style: normal;
        font-weight: 600;
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

      /* s2s-table's filtered-empty state (matches the section's .empty look). */
      .empty-state {
        padding: 2rem 1rem;
        text-align: center;
        color: var(--gray-400, #9ca3af);
        font-size: 0.9rem;
      }
      .empty-state .empty-icon {
        display: none;
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
    if (changed.has('view')) {
      // A new inventory replaced the table — drop stale filters so they never
      // hide rows of the fresh view (publication switch / refresh / revalidate).
      this.clearFilters();
    }
    if (changed.has('ctx') || changed.has('publication')) {
      // Defer past the current update flush: kicking off the async load from
      // `updated()` synchronously writes @state and re-requests an update
      // while Lit is still inside the finished render (noisy warning + wasted
      // render). Awaiting updateComplete schedules the next update cleanly.
      void this.updateComplete.then(() => this.rebuild());
    }
  }

  /**
   * Rebuild the CID view for the current publication.
   *
   * Default (auto-revalidate from mount / publication change) is INCREMENTAL:
   * when a last-good cached view exists for this publication it is passed as
   * `prev` so the shared coordinator diffs against it (the coordinator only
   * enters the incremental path when prev.meta?.complete === true and
   * otherwise self-degrades to a cold build — so a stale/partial cache is
   * safe). forceCold (manual Refresh) passes no prev → a full cold rebuild,
   * i.e. ground truth regardless of what is cached.
   */
  private async rebuild(forceCold = false) {
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
    this.resolvedPublication = publication;

    // Publication switch: abort any in-flight retrievability pass and drop the
    // old publication's statuses so a stale pass can't write back into a map
    // that now belongs to a different publication.
    if (this.view !== null && this.view.publication !== publication) {
      this.retrievabilityAbort?.abort();
      this.retrievabilityAbort = null;
      this.retrievabilityEpoch++;
      this.retrievability = null;
      this.checking = false;
      this.checkedCount = 0;
    }

    // Stale-while-revalidate: hydrate the last-known view from localStorage
    // BEFORE the async fresh build so the table renders instantly instead of
    // the infinite spinner. Only hydrate when nothing is displayed yet or the
    // shown view belongs to a different publication. loading stays true so the
    // Refresh button reads 'Loading…' while revalidating in the background.
    const cached = loadCachedView(publication);
    if (cached && this.view?.publication !== publication) {
      console.log('[cid-view] serving cached view for ' + publication);
      // Offers/versions are hidden on display too (the full view is what gets
      // reused as the incremental `prev` below).
      this.view = withoutOffersAndVersions(cached.view);
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
    // Incremental by default: the last-good cached view (zod-validated by
    // loadCachedView) is the `prev` baseline for the coordinator's incremental
    // diff path. forceCold omits it so the build is a full cold ground-truth
    // rebuild even when a cache exists.
    const prev = cached && !forceCold ? cached.view : undefined;
    try {
      const view = await buildPublicationCidView(ctx, publication, prev ? { prev } : {});
      if (buildId !== this.buildId) return;
      // The table + retrievability pass run over the filtered view (offers +
      // versions hidden); the FULL view is persisted as the cache so the
      // incremental baseline keeps its version history.
      this.view = withoutOffersAndVersions(view);
      saveCachedView(publication, view);
      this.clearStale();
      this.startRetrievabilityCheck();
      const elapsed = Math.round(performance.now() - started);
      console.log(
        `[cid-view] rebuild ${publication} done in ${String(elapsed)}ms${prev ? ' (incremental)' : ' (cold)'} — ${String(view.summary.total)} entries, ${String(view.summary.uniqueCids)} unique CIDs`,
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

  /** Status for a cid, or undefined when never checked (gray dots). */
  private retrievabilityStatus(cid: string): CidRetrievabilityStatus | undefined {
    const map = this.retrievability;
    if (!map) return undefined;
    return cid in map ? map[cid] : undefined;
  }

  /** Human relative label for a checkedAt ISO string. */
  private relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '-';
    const diffMs = Date.now() - then;
    if (diffMs < 60_000) return 'just now';
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 60) return `${String(mins)}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${String(hours)}h ago`;
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  /**
   * First-occurrence entry per unique cid, preserving coordinator order — the
   * flat risk-sorted table renders one row per cid.
   */
  private firstOccurrenceEntries(view: PublicationCidView): CidEntry[] {
    const seen = new Set<string>();
    const entries: CidEntry[] = [];
    for (const entry of view.entries) {
      if (seen.has(entry.cid)) continue;
      seen.add(entry.cid);
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Is a CID "fresh" (skip it in the auto pass)? Fresh = checked within
   * `freshnessMs`. Never-checked or unknown-age CIDs are never fresh.
   * `freshnessMs <= 0` forces a full pass (manual Recheck).
   */
  private isFresh(cid: string, freshnessMs: number, map: Partial<CidRetrievabilityMap>): boolean {
    if (freshnessMs <= 0) return false;
    const status = map[cid];
    if (!status) return false;
    // A malformed checkedAt parses to NaN → `NaN <= freshnessMs` is false →
    // treated as not-fresh, i.e. re-checked. Correct fail-open behaviour.
    return Date.now() - Date.parse(status.checkedAt) <= freshnessMs;
  }

  /**
   * Self-pacing retrievability pass: stalest-first batches over the batch
   * endpoint until the list is exhausted. The auto pass (freshnessMs > 0) only
   * covers UNFRESH cids — never-checked first, then checked longer ago than the
   * freshness window — so a reload / tab re-open resumes from the localStorage
   * cache instead of re-running a full check. The manual Recheck passes 0 to
   * force every cid through the endpoint. Incremental per-line updates arrive
   * as results stream; the pass restarts until aborted or exhausted.
   */
  private async runRetrievabilityPass(freshnessMs = RETRIEVABILITY_AUTO_FRESH_MS): Promise<void> {
    if (!this.view || this.checking) return;
    const epoch = this.retrievabilityEpoch;
    this.checking = true;
    this.checkedCount = 0;
    try {
      const all = cidsFromView(this.view);
      const map = this.retrievability ?? {};
      // Unfresh set is fixed for the whole pass: never-checked first, then
      // stalest-first (orderByStaleness is a pure SORT over all cids, so we
      // filter to the unfresh ones AFTER sorting — never fewer of them).
      const unfresh = orderByStaleness(all, map).filter((cid) => !this.isFresh(cid, freshnessMs, map));
      this.checkTarget = unfresh.length;
      const doneThisPass = new Set<string>();
      for (;;) {
        const next = unfresh
          .filter((cid) => !doneThisPass.has(cid))
          .slice(0, RETRIEVABILITY_BATCH);
        if (next.length === 0) break;
        for (const cid of next) doneThisPass.add(cid);
        try {
          const result = await checkRetrievability(this.resolvedPublication, this.view, next, {
            prev: this.retrievability ?? undefined,
            onResult: (cid, status) => {
              if (epoch === this.retrievabilityEpoch) {
                this.retrievability = { ...this.retrievability, [cid]: status };
                this.checkedCount++;
              }
            },
            signal: this.retrievabilityAbort?.signal,
          });
          if (epoch === this.retrievabilityEpoch) this.retrievability = result;
        } catch {
          // Aborted (disconnect / recheck / publication switch) → stop now.
          break;
        }
        if (this.retrievabilityAbort?.signal.aborted) break;
      }
    } finally {
      // Only the current owner of the pass resets checking — a stale pass
      // (epoch changed via recheck / publication switch) must not clobber a
      // newer pass that is already running.
      if (epoch === this.retrievabilityEpoch) this.checking = false;
    }
  }

  /** Manually restart the retrievability pass (abort any in-flight one) — forces a full check. */
  private recheck(): void {
    this.retrievabilityAbort?.abort();
    this.retrievabilityAbort = new AbortController();
    this.retrievabilityEpoch++;
    this.checking = false;
    void this.runRetrievabilityPass(0);
  }

  /**
   * Kick off the retrievability pass after a fresh build: paint the cached
   * dots instantly, arm a fresh abort controller, then start the stalest-first
   * background loop over the batch endpoint. Auto mode is FRESHNESS-GATED —
   * only unfresh (never-checked / older than the window) cids are re-queried,
   * so a reload resumes from the cache instead of re-checking everything.
   */
  private startRetrievabilityCheck(): void {
    // A same-publication refresh can land while the previous pass is still
    // running over the OLD view's cids. Invalidate it exactly like recheck()
    // (abort + bump the epoch + unset checking) so the fresh view gets a
    // stalest-first pass over ITS cids, and a stale pass can never write back
    // into the new state or leave `checking` stuck.
    this.retrievabilityAbort?.abort();
    this.retrievabilityEpoch++;
    this.checking = false;
    this.checkedCount = 0;
    this.checkTarget = 0;
    this.retrievability = loadRetrievabilityMap(this.resolvedPublication);
    this.retrievabilityAbort = new AbortController();
    void this.runRetrievabilityPass();
  }

  /**
   * Top chips row: a full-width unique-CIDs counter chip, rendered as
   * <s2s-table>'s `chipsTop`. The clear-filters affordance is now the table's
   * built-in `.chip.clear-filters` in the chips row below (appears when any
   * group is active).
   */
  private renderChipsTop(view: PublicationCidView): TemplateResult {
    return html`
      <span class="chip"
        ><span class="chip-value">${view.summary.uniqueCids}</span> unique CIDs</span
      >
    `;
  }

  /**
   * Health buckets that have ≥1 row in the current view (computed from the
   * retrievability map over the same unique rows the table renders). A bucket
   * with zero rows never renders a chip — same rule the hand-rolled summary
   * used. Labels use HEALTH_LABELS.
   */
  private healthBucketValues(view: PublicationCidView): Array<{ value: string; label: string }> {
    const counts = new Map<CidHealth, number>();
    for (const entry of this.firstOccurrenceEntries(view)) {
      const status = this.retrievabilityStatus(entry.cid);
      if (status !== undefined) {
        const bucket = healthBucket(status);
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      }
    }
    return (['healthy', 'needs-healing', 'danger', 'lost'] as const)
      .filter((bucket) => (counts.get(bucket) ?? 0) > 0)
      .map((bucket) => ({ value: bucket, label: HEALTH_LABELS[bucket] }));
  }

  /**
   * The two chips filter groups handed to <s2s-table>: Type (column-backed,
   * counts derive from distinct type labels over the full rows) and Health
   * (custom bucket predicate over the retrievability status, explicit values
   * = only the buckets present in the current view).
   */
  private chipsGroups(view: PublicationCidView): readonly ChipsGroup<CidEntry>[] {
    return [
      { key: 'type', get: (e) => typeLabel(e.category) },
      {
        key: 'health',
        matches: (e, v) => {
          const s = this.retrievabilityStatus(e.cid);
          return s !== undefined && healthBucket(s) === v;
        },
        values: this.healthBucketValues(view),
      },
    ];
  }

  /**
   * The 10 sortable columns of the inventory grid, matching the historical
   * header labels (Type / CID / Role / Path / Age / Kubo / Pinata / Filebase /
   * Filecoin / Copies / Last check). Source + copies columns read the live
   * retrievability status.
   */
  private tableColumns(): readonly TableColumn<CidEntry>[] {
    return [
      { key: 'type', label: 'Type', get: (e) => typeLabel(e.category) },
      { key: 'cid', label: 'CID', get: (e) => e.cid },
      { key: 'role-path', label: 'Role / Path', get: entryName },
      { key: 'age', label: 'Age', get: (e) => e.timestamp ?? 0 },
      ...RETRIEVABILITY_SOURCES.map((source) => ({
        key: source,
        label: source[0].toUpperCase() + source.slice(1),
        get: (e: CidEntry) => Boolean(this.retrievabilityStatus(e.cid)?.sources[source]),
      })),
      {
        key: 'copies',
        label: 'Copies',
        get: (e) => (this.retrievabilityStatus(e.cid)?.copies ?? 0),
      },
      {
        key: 'last-check',
        label: 'Last check',
        get: (e) => this.retrievabilityStatus(e.cid)?.checkedAt ?? '',
      },
    ];
  }

  /**
   * The rows <s2s-table> receives: one entry per unique cid, in the default
   * RISK order (fewest copies first, never-checked on top) via
   * orderByCopiesAscending over cidsFromView, mapped back to the
   * first-occurrence entries. `sort` starts null so this risk order is the
   * default; a user sort (this.sort) overrides it inside s2s-table's pipeline.
   */
  private riskSortedRows(view: PublicationCidView): CidEntry[] {
    const byCid = new Map<string, CidEntry>();
    for (const entry of this.firstOccurrenceEntries(view)) {
      byCid.set(entry.cid, entry);
    }
    const rows: CidEntry[] = [];
    for (const cid of orderByCopiesAscending(cidsFromView(view), this.retrievability ?? {})) {
      const entry = byCid.get(cid);
      if (entry) rows.push(entry);
    }
    return rows;
  }

  /** Clear every chip filter (used on view change so a fresh view isn't hidden). */
  private clearFilters(): void {
    this.chips = {};
  }

  /** Availability dot cell for one source. Gray while unchecked, green/red when checked. */
  private renderSourceDot(
    source: RetrievabilitySource,
    status: CidRetrievabilityStatus | undefined,
  ): TemplateResult {
    let cls = 'dot unknown';
    let label = `${source}: not checked yet`;
    if (status !== undefined) {
      if (status.state === 'inconclusive' && status.copies === 0) {
        // All providers unreachable and no last-known data — unknown, not absent.
        cls = 'dot unknown';
        label = `${source}: providers unreachable — could not verify`;
      } else {
        const present = status.sources[source];
        cls = present ? 'dot on' : 'dot off';
        label = `${source}: ${present ? 'copy found' : 'no copy'}`;
        if (status.state === 'inconclusive') label += ' — providers unreachable this pass (last-known)';
        if (status.lastError) label += ` — ${status.lastError}`;
      }
    }
    return html`<div class="cid-cell"><span class="${cls}" title="${label}"></span></div>`;
  }

  /** Stable row renderer (bound once) so <s2s-table> only re-renders on real
   *  data/state changes, not on every host render — like the deals tab. */
  private entryRowRenderer = (entry: CidEntry) => this.renderEntryRow(entry);

  private renderEntryRow(entry: CidEntry): TemplateResult {
    const cid = entry.cid;
    const status = this.retrievabilityStatus(cid);
    const cr = status === undefined ? { label: '—', cls: '' } : copiesRender(status);
    const stateBadge =
      status === undefined || status.state === 'ok' ? null : STATE_BADGE[status.state] ?? null;
    const stateTitle =
      status === undefined || status.state === 'ok'
        ? null
        : `${STATE_BADGE[status.state]?.label ?? status.state}${status.lastError ? ` — ${status.lastError}` : ''}`;
    const lastCheck = status === undefined ? '—' : this.relativeTime(status.checkedAt);
    return html`
      <div class="cid-row">
        <div class="cid-cell">
          <span
            class="badge ${typeClass(entry.category)}"
            title="${categoryLabel(entry.category)}"
            >${typeLabel(entry.category)}</span
          >
        </div>
        <div class="cid-cell">
          <copy-hash .value=${cid} display=${this.shortenCid(cid)} href=${this.gatewayUrl(cid)}></copy-hash>
        </div>
        <div class="cid-cell">
          ${entry.genesis && !entry.role && !entry.path
            ? html`<copy-hash .value=${entry.genesis} display=${this.shortenCid(entry.genesis, 6)}></copy-hash>`
            : entryName(entry)}
        </div>
        <div class="cid-cell">${this.ageDisplay(entry.timestamp)}</div>
        ${RETRIEVABILITY_SOURCES.map((source) => this.renderSourceDot(source, status))}
        <div class="cid-cell">
          <span class="copies ${cr.cls}">${cr.label}</span>
          ${stateBadge
            ? html`<span
                class="state-badge ${stateBadge.cls}"
                title="${stateTitle}"
                >${stateBadge.label}</span
              >`
            : nothing}
        </div>
        <div class="cid-cell">${lastCheck}</div>
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
          <button class="refresh" ?disabled=${this.loading} @click=${() => void this.rebuild(true)}>
            <ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise>
            ${this.loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            class="refresh"
            ?disabled=${this.checking}
            title="Re-check every CID against the ipfs-check service (full pass, ignores cache)"
            @click=${() => {
              this.recheck();
            }}
          >
            <ph-arrow-counter-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-counter-clockwise>
            ${this.checking ? 'Checking…' : 'Recheck'}
          </button>
          ${this.storageBlocked
            ? html`<span class="stale-hint storage-warn"
                >⚠ browser storage unavailable — check results won't persist across reloads</span
              >`
            : nothing}
          ${this.checking
            ? html`<span class="stale-hint"
                >checking copies… (${this.checkedCount}/${this.checkTarget})</span
              >`
            : nothing}
          ${this.cachedRetrievabilityHint()}${this.staleSince != null
            ? html`<span class="stale-hint">${this.staleLabel()}</span>`
            : nothing}
        </div>
        ${view.entries.length === 0
          ? html`
              <div class="empty">
                <div class="empty-title">No CIDs found</div>
                <div>
                  No deals, config, site tree or archive entries are available for this publication.
                </div>
              </div>
            `
          : html`
              <s2s-table
                .columns=${this.tableColumns()}
                .rows=${this.riskSortedRows(view)}
                .sort=${this.sort}
                .chips=${this.chips}
                .chipsGroups=${this.chipsGroups(view)}
                .chipsTop=${this.renderChipsTop(view)}
                .rowRenderer=${this.entryRowRenderer}
                emptyText="No rows match the active filters"
                gridTemplate="0.9fr 2.2fr 1.6fr 1.1fr 0.55fr 0.55fr 0.55fr 0.55fr 0.6fr 0.95fr"
                @sort=${(e: CustomEvent) => {
                  this.sort = toggleSort(this.sort, e.detail.key as string);
                }}
                @chip-filter=${(e: CustomEvent) => {
                  const key = e.detail.key as string;
                  const values = e.detail.values as string[];
                  if (values.length === 0) {
                    const next = { ...this.chips };
                    delete next[key];
                    this.chips = next;
                  } else {
                    this.chips = { ...this.chips, [key]: values };
                  }
                }}
              ></s2s-table>
            `}
      </div>
    `;
  }
}
