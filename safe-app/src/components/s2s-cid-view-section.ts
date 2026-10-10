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
  PublicationCidView,
  RetrievabilitySource,
} from '@s2s/soul2soul-shared/safe-app';
import { store } from '../state/index.js';
import './copy-hash.js';
import { checkRetrievability, loadRetrievabilityMap } from '@/lib/cid-view.js';
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
  if (status.copies === 0) return 'lost';
  if (status.copies < 2) return 'danger';
  if (status.copies < 5) return 'needs-healing';
  return 'healthy';
}

/** CIDs per retrievability batch POST (streaming keeps the UI incremental regardless). */
const RETRIEVABILITY_BATCH = 50;

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

  /** Active Type filter (type labels, empty = all types shown). */
  @state() private typeFilter = new Set<string>();
  /** Active health-bucket filter (empty = all health states shown). */
  @state() private healthFilter = new Set<CidHealth>();

  /** Monotonic build id — stale async builds never overwrite a newer one. */
  private buildId = 0;
  /** Aborts the in-flight retrievability pass (disconnect / recheck / publication change). */
  private retrievabilityAbort: AbortController | null = null;
  /** Monotonic guard — a stale retrievability pass must not clobber a newer map. */
  private retrievabilityEpoch = 0;
  /** One-minute ticker that keeps the staleness label honest while stale. */
  private staleTimer: ReturnType<typeof setInterval> | null = null;

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

  static styles = [
    typograhyStyles,
    sectionStyles,
    buttonStyles,
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

      .chips-top {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 0.5rem;
        margin-bottom: 0.75rem;
      }
      .chips-row {
        display: flex;
        align-items: flex-start;
        gap: 1.5rem;
        margin-bottom: 1rem;
      }
      .chips-group {
        flex: 1;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
      }
      .chips-group + .chips-group {
        border-left: 1px solid var(--gray-700, #374151);
        padding-left: 1.5rem;
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
      button.chip {
        font: inherit;
        cursor: pointer;
        transition: border-color 120ms, background 120ms;
        font-size: 0.75rem;
        text-transform: none;
      }
      button.chip:hover:not(.active) {
        border-color: var(--gray-500, #6b7280);
      }
      .chip.active {
        border-color: rgba(59, 130, 246, 0.65);
        background: rgba(59, 130, 246, 0.12);
        color: var(--blue-300, #93c5fd);
      }
      .chip .chip-value {
        font-weight: 700;
        color: var(--gray-50, #f9fafb);
      }
      .chip.active .chip-value {
        color: #bfdbfe;
      }

      /* Flat risk-sorted inventory table (simple grid, read-only). */
      .cid-table {
        display: grid;
        grid-template-columns: 0.9fr 1.7fr 2fr 1.1fr 0.7fr 0.55fr 0.55fr 0.55fr 0.55fr 0.6fr 0.95fr;
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
      .cell-sub {
        margin-top: 0.18rem;
        font-size: 0.72rem;
        color: var(--gray-500, #6b7280);
        overflow-wrap: anywhere;
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
    // Incremental by default: the last-good cached view (zod-validated by
    // loadCachedView) is the `prev` baseline for the coordinator's incremental
    // diff path. forceCold omits it so the build is a full cold ground-truth
    // rebuild even when a cache exists.
    const prev = cached && !forceCold ? cached.view : undefined;
    try {
      const view = await buildPublicationCidView(ctx, publication, prev ? { prev } : {});
      if (buildId !== this.buildId) return;
      this.view = view;
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
   * Self-pacing retrievability pass: stalest-first batches over the batch
   * endpoint until the whole list is checked. Incremental per-line updates
   * arrive as results stream; the pass restarts until aborted or exhausted.
   */
  private async runRetrievabilityPass(): Promise<void> {
    if (!this.view || this.checking) return;
    const epoch = this.retrievabilityEpoch;
    this.checking = true;
    this.checkedCount = 0;
    try {
      const all = cidsFromView(this.view);
      // Cids already (re)checked by THIS pass. orderByStaleness is a pure SORT
      // (returns every cid, never fewer) — so the next batch is the stalest
      // order minus what this pass already covered; the loop terminates when
      // every cid has been touched this pass.
      const doneThisPass = new Set<string>();
      for (;;) {
        const next = orderByStaleness(all, this.retrievability ?? {})
          .filter((cid) => !doneThisPass.has(cid))
          .slice(0, RETRIEVABILITY_BATCH);
        if (next.length === 0) break;
        for (const cid of next) doneThisPass.add(cid);
        try {
          const map = await checkRetrievability(this.publication, this.view, next, {
            prev: this.retrievability ?? undefined,
            onResult: (cid, status) => {
              if (epoch === this.retrievabilityEpoch) {
                this.retrievability = { ...this.retrievability, [cid]: status };
                this.checkedCount++;
              }
            },
            signal: this.retrievabilityAbort?.signal,
          });
          if (epoch === this.retrievabilityEpoch) this.retrievability = map;
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

  /** Manually restart the retrievability pass (abort any in-flight one). */
  private recheck(): void {
    this.retrievabilityAbort?.abort();
    this.retrievabilityAbort = new AbortController();
    this.retrievabilityEpoch++;
    this.checking = false;
    void this.runRetrievabilityPass();
  }

  /**
   * Kick off the retrievability pass after a fresh build: paint the cached
   * dots instantly, arm a fresh abort controller, then start the stalest-first
   * background loop over the batch endpoint.
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
    this.retrievability = loadRetrievabilityMap(this.publication);
    this.retrievabilityAbort = new AbortController();
    void this.runRetrievabilityPass();
  }

  /**
   * Chip section: a full-width top row (unique-CIDs counter + clear-filters)
   * above one row with two equal containers. Left = Type chips (a filter
   * button per type — clicking toggles which types the table shows). Right =
   * health chips (lost / danger / needs healing / healthy — same toggle
   * behaviour). Type/health chips use the same classification as the table's
   * Type badges / copy thresholds.
   */
  private renderSummary(view: PublicationCidView): TemplateResult {
    const { typeCounts, healthCounts } = this.chipCounts(view);
    const hasFilter = this.typeFilter.size > 0 || this.healthFilter.size > 0;
    const typeChips = Array.from(typeCounts.entries()).map(([label, count]) =>
      this.renderFilterChip(label, count, this.typeFilter.has(label), () => {
        this.toggleType(label);
      }),
    );
    const healthChips = (['healthy', 'needs-healing', 'danger', 'lost'] as const).map((bucket) => {
      const count = healthCounts.get(bucket) ?? 0;
      if (count === 0) return nothing;
      return this.renderFilterChip(
        HEALTH_LABELS[bucket],
        count,
        this.healthFilter.has(bucket),
        () => {
          this.toggleHealth(bucket);
        },
      );
    });
    return html`
      <div class="chips-top">
        <span class="chip"
          ><span class="chip-value">${view.summary.uniqueCids}</span> unique CIDs</span
        >
        ${hasFilter
          ? html`<button type="button" class="chip" @click=${() => {
              this.clearFilters();
            }}>
              × clear filters
            </button>`
          : nothing}
      </div>
      <div class="chips-row">
        <div class="chips-group">${typeChips}</div>
        <div class="chips-group">${healthChips}</div>
      </div>
    `;
  }

  /** Per-filter-bucket counts over the same unique-cid rows the table renders. */
  private chipCounts(view: PublicationCidView): {
    typeCounts: Map<string, number>;
    healthCounts: Map<CidHealth, number>;
  } {
    const typeCounts = new Map<string, number>();
    const healthCounts = new Map<CidHealth, number>();
    for (const entry of this.firstOccurrenceEntries(view)) {
      const label = typeLabel(entry.category);
      typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
      const status = this.retrievabilityStatus(entry.cid);
      if (status !== undefined) {
        const bucket = healthBucket(status);
        healthCounts.set(bucket, (healthCounts.get(bucket) ?? 0) + 1);
      }
    }
    return { typeCounts, healthCounts };
  }

  /** One pill chip that toggles as a table filter. Count + label, same chip design. */
  private renderFilterChip(
    label: string,
    count: number,
    active: boolean,
    onClick: () => void,
  ): TemplateResult {
    return html`
      <button type="button" class="chip ${active ? 'active' : ''}" @click=${onClick}>
        <span class="chip-value">${count}</span> ${label}
      </button>
    `;
  }

  /** Toggle a type filter; empty set = show every type. */
  private toggleType(label: string): void {
    const next = new Set(this.typeFilter);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    this.typeFilter = next;
  }

  /** Toggle a health-bucket filter; empty set = show every health state. */
  private toggleHealth(bucket: CidHealth): void {
    const next = new Set(this.healthFilter);
    if (next.has(bucket)) next.delete(bucket);
    else next.add(bucket);
    this.healthFilter = next;
  }

  private clearFilters(): void {
    this.typeFilter = new Set();
    this.healthFilter = new Set();
  }

  /** Availability dot cell for one source. Gray while unchecked, green/red when checked. */
  private renderSourceDot(
    source: RetrievabilitySource,
    status: CidRetrievabilityStatus | undefined,
  ): TemplateResult {
    let cls = 'dot unknown';
    let label = `${source}: not checked yet`;
    if (status !== undefined) {
      const present = status.sources[source];
      cls = present ? 'dot on' : 'dot off';
      label = `${source}: ${present ? 'copy found' : 'no copy'}`;
      if (status.error) label += ` — ${status.error}`;
    }
    return html`<div class="cid-cell"><span class="${cls}" title="${label}"></span></div>`;
  }

  private renderEntryRow(entry: CidEntry): TemplateResult {
    const cid = entry.cid;
    const status = this.retrievabilityStatus(cid);
    const copies = status === undefined ? null : status.copies;
    const copiesCls =
      copies === null
        ? ''
        : copies >= 2
          ? 'copies-ok'
          : copies === 1
            ? 'copies-low'
            : 'copies-none';
    const copiesLabel = copies === null ? '—' : `${String(copies)}/4`;
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
          ${entry.genesis
            ? html`<div class="cell-sub">${this.shortenCid(entry.genesis, 6)}</div>`
            : nothing}
        </div>
        <div class="cid-cell">${this.ageDisplay(entry.timestamp)}</div>
        <div class="cid-cell">
          ${entry.tombstoned
            ? html`<span class="badge tombstone">tombstone</span>`
            : html`<span class="muted">-</span>`}
        </div>
        ${RETRIEVABILITY_SOURCES.map((source) => this.renderSourceDot(source, status))}
        <div class="cid-cell"><span class="copies ${copiesCls}">${copiesLabel}</span></div>
        <div class="cid-cell">${lastCheck}</div>
      </div>
    `;
  }

  private renderTable(view: PublicationCidView): TemplateResult {
    // Flat risk-sorted table: one row per unique cid, fewest copies first
    // (unchecked statuses sort to the top so the riskiest rows surface first).
    const byCid = new Map<string, CidEntry>();
    for (const entry of this.firstOccurrenceEntries(view)) {
      byCid.set(entry.cid, entry);
    }
    const rows: CidEntry[] = [];
    for (const cid of orderByCopiesAscending(cidsFromView(view), this.retrievability ?? {})) {
      const entry = byCid.get(cid);
      if (entry) rows.push(entry);
    }
    // Apply the chip filters (type / copies / health). Empty set in a group = no
    // constraint; groups combine with AND so filters narrow the table.
    const visible = rows.filter((entry) => this.matchesFilters(entry));
    if (visible.length === 0 && rows.length > 0) {
      return html`
        <div class="empty">
          <div class="empty-title">No rows match the active filters</div>
          <div>Clear or widen the type / copies / health filters to see CIDs again.</div>
        </div>
      `;
    }
    return html`
      <div class="cid-table">
        <div class="cid-header-row">
          <div class="cid-head">Type</div>
          <div class="cid-head">CID</div>
          <div class="cid-head">Role / Path</div>
          <div class="cid-head">Age</div>
          <div class="cid-head">Tombstone</div>
          <div class="cid-head">Kubo</div>
          <div class="cid-head">Pinata</div>
          <div class="cid-head">Filebase</div>
          <div class="cid-head">Filecoin</div>
          <div class="cid-head">Copies</div>
          <div class="cid-head">Last check</div>
        </div>
        ${visible.map((entry) => this.renderEntryRow(entry))}
      </div>
    `;
  }

  /** Row-level filter: type (AND) health; empty set = no constraint. */
  private matchesFilters(entry: CidEntry): boolean {
    if (this.typeFilter.size > 0 && !this.typeFilter.has(typeLabel(entry.category))) return false;
    const status = this.retrievabilityStatus(entry.cid);
    if (
      this.healthFilter.size > 0 &&
      (status === undefined || !this.healthFilter.has(healthBucket(status)))
    ) {
      return false;
    }
    return true;
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
            title="Re-check every CID against the ipfs-check service (stalest first)"
            @click=${() => {
              this.recheck();
            }}
          >
            <ph-arrow-counter-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-counter-clockwise>
            ${this.checking ? 'Checking…' : 'Recheck'}
          </button>
          ${this.checking
            ? html`<span class="stale-hint"
                >checking copies… (${this.checkedCount}/${cidsFromView(view).length})</span
              >`
            : nothing}
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
