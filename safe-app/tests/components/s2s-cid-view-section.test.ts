// tests/components/s2s-cid-view-section.test.ts — component (browser) tests
// for the read-only CID inventory section.
//
// The section renders whatever `buildPublicationCidView` (the shared
// coordinator) produces over a host-supplied `CidViewReadContext`. We keep the
// REAL coordinator + collectors (imported via the light cid-view barrel) and
// wrap `buildPublicationCidView` in a spy that delegates to the real
// coordinator by default, so we can also drive deterministic loading/error
// states.
//
// Mocks:
//   @s2s/soul2soul-shared/safe-app -> { buildPublicationCidView: spy } that
//                                     delegates to the real coordinator
//   @/state/index.js              -> in-memory store mock (getRecord only)
//
// The fixture ctx returns deterministic chain/IPFS data: one deal (2 versions,
// last tombstoned), one offer, a config (template DAG + assets tree), a site
// root (contenthash_wrapped) + tree, and an archive (content_cache) — so the
// coordinator exercises every collector and every render path.

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { CID } from 'multiformats';
import { sha256 } from 'multiformats/hashes/sha2';
import type { CidViewReadContext, PublicationCidView } from '@s2s/soul2soul-shared/safe-app';
import { mountLit } from '../helpers/mount';
// Side-effect import registers the element; type-only import gives the
// mountLit generic its class type without a runtime value import (a value
// named import of the component breaks the browser test's mock transform).
import '../../src/components/s2s-cid-view-section';
import type { S2SCidViewSection } from '../../src/components/s2s-cid-view-section';

// ---------------------------------------------------------------------------
// Hoisted mocks — available to vi.mock factories (hoisted above all imports).
// ---------------------------------------------------------------------------

const buildSpy = vi.hoisted(() => vi.fn());
const realBuild = vi.hoisted<{
  fn: ((ctx: CidViewReadContext, publication: string) => Promise<unknown>) | null;
}>(() => ({ fn: null }));

vi.mock('@s2s/soul2soul-shared/safe-app', async () => {
  // Load the REAL coordinator/collectors straight from the shared source tree
  // (relative path — bypasses the heavy safe-app barrel / Lit graph, so the
  // browser test stays light). parsePublicationCidView (the zod validator) is
  // also real so the component's cache-load path validates exactly as in src.
  const real = await import('../../../shared/src/cid-view/coordinator.ts');
  const validation = await import('../../../shared/src/cid-view/validation.ts');
  realBuild.fn = real.buildPublicationCidView;
  return {
    buildPublicationCidView: buildSpy,
    parsePublicationCidView: validation.parsePublicationCidView,
  };
});

const stateMocks = vi.hoisted(() => ({
  store: { getRecord: vi.fn<(key: string) => string | null>(() => null) },
}));

vi.mock('@/state/index.js', () => ({ store: stateMocks.store }));

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

// Two distinct valid CIDv1 (dag-pb / sha2-256) for the site root + archive
// pointer; contenthash_wrapped hex is `0xe301` + the CID bytes.
let ROOT_CID = '';
let CACHE_CID = '';
let ROOT_HASH = '';
let CACHE_HASH = '';

function contenthashFor(cid: CID): string {
  return (
    '0x' +
    'e301' +
    Array.from(cid.bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

const ARCHIVE_JSON = JSON.stringify({
  items: { '0xgen9': { cid: 'bafyarchiveitem', item: { public: { title: 'Post 1' } } } },
});

function makeFullCtx(): CidViewReadContext {
  return {
    getDeals: async () => [
      {
        genesis: '0xgen1',
        author: '0xAuthor1',
        cid: 'bafydeal1',
        timestamp: 1700000000,
        status: 'deal',
      },
    ],
    getOffers: async () => [
      {
        genesis: '0xgen2',
        author: '0xAuthor2',
        cid: 'bafyoffer1',
        timestamp: 1700002000,
        status: 'offer',
      },
    ],
    getVersions: async (genesis: string) =>
      genesis === '0xgen1'
        ? [
            { cid: 'bafyver0', timestamp: 1699999000, tombstone: false },
            { cid: 'bafyver1', timestamp: 1700000000, tombstone: true },
          ]
        : [],
    getConfig: async () => ({
      cid: 'bafyconfig',
      config: { templateCid: 'bafytemplatedag', assetsCid: 'bafyassets' },
    }),
    dagGet: async (cid: string) =>
      cid === 'bafytemplatedag' ? [{ path: 'about/index.html', cid: 'bafytemplate' }] : null,
    ls: async (cid: string) => {
      if (cid === 'bafyassets') return [{ name: 'logo.png', hash: 'bafyasset', size: 100 }];
      if (cid === ROOT_CID) return [{ name: 'index.html', hash: 'bafysitefile', size: 50 }];
      return [];
    },
    cat: async (cid: string) => (cid === CACHE_CID ? ARCHIVE_JSON : ''),
    getEnsText: async (_node: string, key: string) => {
      if (key === 'contenthash_wrapped') return ROOT_HASH;
      if (key === 'content_cache_test.eth') return CACHE_HASH;
      return '';
    },
  };
}

function makeEmptyCtx(): CidViewReadContext {
  return {
    getDeals: async () => [],
    getOffers: async () => [],
    getVersions: async () => [],
    // The config collector ALWAYS emits a 'config' entry for a resolved
    // { cid, config }, so to get a genuinely empty view it must fail (the
    // collector is fail-open and returns [] on throw).
    getConfig: async () => {
      throw new Error('no config');
    },
    dagGet: async () => null,
    ls: async () => [],
    cat: async () => '',
    getEnsText: async () => '',
  };
}

/** Small deterministic PublicationCidView used to seed localStorage caches. */
function makeCachedView(
  opts: { publication?: string; cid?: string; generatedAt?: string } = {},
): PublicationCidView {
  const publication = opts.publication ?? 'test.eth';
  const entries = [
    { cid: opts.cid ?? 'bafycached1', category: 'deal' as const, source: 'deals' as const },
  ];
  return {
    publication,
    generatedAt: opts.generatedAt ?? '2026-01-01T00:00:00.000Z',
    entries,
    sources: { deals: true, config: false, tree: false, archive: false },
    summary: { total: entries.length, uniqueCids: 1, byCategory: { deal: 1 } },
  };
}

function seedCache(publication: string, view: PublicationCidView, savedAt = Date.now()): void {
  localStorage.setItem('s2s.cidview.' + publication, JSON.stringify({ savedAt, view }));
}

/**
 * makeFullCtx + a version for the offer genesis, so the coordinator's cold
 * completeness check (every live deal/offer genesis has ≥1 version) passes and
 * the built view carries meta.complete:true — a valid incremental baseline.
 */
function makeCompleteCtx(): CidViewReadContext {
  return {
    ...makeFullCtx(),
    getVersions: async (genesis: string) => {
      if (genesis === '0xgen1') {
        return [
          { cid: 'bafyver0', timestamp: 1699999000, tombstone: false },
          { cid: 'bafyver1', timestamp: 1700000000, tombstone: true },
        ];
      }
      if (genesis === '0xgen2') {
        return [{ cid: 'bafyver2', timestamp: 1700002000, tombstone: false }];
      }
      return [];
    },
  };
}

/**
 * Build a genuine (schema-valid) view through the REAL coordinator for seeding
 * the localStorage cache, so the seeded `meta` block is exactly what the
 * coordinator would persist — not a hand-rolled approximation.
 */
async function buildSeededView(
  ctx: CidViewReadContext,
  publication = 'test.eth',
): Promise<PublicationCidView> {
  const view = realBuild.fn ? await realBuild.fn(ctx, publication) : null;
  if (!view) throw new Error('real coordinator unavailable for seeding');
  return view as PublicationCidView;
}

/** The build options arg of the latest recorded buildPublicationCidView call. */
function latestBuildOpts(): { prev?: PublicationCidView } | undefined {
  const call = buildSpy.mock.calls.at(-1);
  if (!call) return undefined;
  return call[2] as { prev?: PublicationCidView } | undefined;
}

/** The CIDs currently rendered, read from each copy-hash's value property (shadow DOM). */
function renderedCids(root: ShadowRoot): string[] {
  return Array.from(root.querySelectorAll('copy-hash')).map(
    (c) => (c as HTMLElement & { value: string }).value,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('s2s-cid-view-section', () => {
  beforeAll(async () => {
    const rootDigest = await sha256.digest(new TextEncoder().encode('site root'));
    const cacheDigest = await sha256.digest(new TextEncoder().encode('cache blob'));
    const root = CID.create(1, 0x70, rootDigest);
    const cache = CID.create(1, 0x70, cacheDigest);
    ROOT_CID = root.toString();
    CACHE_CID = cache.toString();
    ROOT_HASH = contenthashFor(root);
    CACHE_HASH = contenthashFor(cache);
  });

  beforeEach(() => {
    // Reset the spy back to the real coordinator for every test.
    buildSpy.mockReset();
    buildSpy.mockImplementation((ctx, publication) =>
      realBuild.fn ? realBuild.fn(ctx, publication) : Promise.resolve({}),
    );
    stateMocks.store.getRecord.mockReset();
    stateMocks.store.getRecord.mockReturnValue(null);
    // The component persists to localStorage (s2s.cidview.*) — clear between
    // tests so each spec starts without a cache.
    localStorage.clear();
  });

  afterEach(() => {
    buildSpy.mockReset();
    localStorage.clear();
  });

  it('renders the unavailable state when no ctx is provided', async () => {
    const el = await mountLit('s2s-cid-view-section', { publication: 'test.eth' });
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).toContain('CID inventory unavailable');
    expect(text).not.toContain('CID Inventory');
    // No context → buildPublicationCidView must never run.
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('renders summary chips, grouped entries and badges for a full fixture', async () => {
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });

    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.cid-table')).toBeTruthy();
    });

    const root = el.shadowRoot!;
    const text = root.textContent ?? '';

    // Title + publication.
    expect(text).toContain('CID Inventory');
    expect(text).toContain('test.eth');

    // Summary chips — totals + unique CIDs.
    expect(text).toContain('13 unique CIDs');
    expect(text).toContain('13 entries');
    // Per-category chips.
    expect(text).toContain('1 deal');
    expect(text).toContain('2 deal versions');
    expect(text).toContain('1 offer');
    expect(text).toContain('1 config');
    expect(text).toContain('1 template DAG');
    expect(text).toContain('1 template');
    expect(text).toContain('1 assets root');
    expect(text).toContain('1 asset');
    expect(text).toContain('1 site root');
    expect(text).toContain('1 site file');
    expect(text).toContain('1 archive');
    expect(text).toContain('1 archive item');

    // Entry rows: one per entry.
    expect(root.querySelectorAll('.cid-row').length).toBe(13);
    // Group headers: 12 distinct categories.
    expect(root.querySelectorAll('.cid-group').length).toBe(12);

    // Category badges.
    expect(root.querySelectorAll('.badge.deal').length).toBe(1);
    expect(root.querySelectorAll('.badge.deal-version').length).toBe(2);
    expect(root.querySelectorAll('.badge.offer').length).toBe(1);
    expect(root.querySelectorAll('.badge.config').length).toBe(3); // config + template DAG + template
    expect(root.querySelectorAll('.badge.asset').length).toBe(2); // assets root + asset
    expect(root.querySelectorAll('.badge.tree').length).toBe(2); // site root + site file
    expect(root.querySelectorAll('.badge.archive').length).toBe(2); // archive + archive item

    // Source badges: deals/config/tree/archive present, one per row.
    expect(root.querySelectorAll('.badge.source').length).toBe(13);
    expect(text).toContain('deals ✓');
    expect(text).toContain('config ✓');
    expect(text).toContain('tree ✓');
    expect(text).toContain('archive ✓');

    // Tombstone badge on the last version only.
    expect(root.querySelectorAll('.badge.tombstone').length).toBe(1);

    // Gateway links — one per row, pointing at the ipfs.io gateway.
    const links = Array.from(root.querySelectorAll('a.gateway-link')).map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toHaveLength(13);
    expect(links).toContain('https://ipfs.io/ipfs/bafydeal1');
    expect(links).toContain(`https://ipfs.io/ipfs/${ROOT_CID}`);

    // copy-hash carries the CID (short CIDs stay full, long roots are shortened).
    const hashValues = Array.from(root.querySelectorAll('copy-hash')).map(
      (c) => (c as HTMLElement & { value: string }).value,
    );
    expect(hashValues).toHaveLength(13);
    expect(hashValues).toContain('bafydeal1');
    expect(hashValues).toContain(ROOT_CID.slice(0, 10) + '...' + ROOT_CID.slice(-10));
  });

  it('renders the empty state for a context with no data', async () => {
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeEmptyCtx(),
      publication: 'test.eth',
    });

    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('No CIDs found');
    });

    const root = el.shadowRoot!;
    const text = root.textContent ?? '';
    expect(text).toContain('0 unique CIDs');
    expect(text).toContain('0 entries');
    // All sources flagged off.
    expect(text).toContain('deals ✗');
    expect(text).toContain('config ✗');
    expect(text).toContain('tree ✗');
    expect(text).toContain('archive ✗');
    expect(root.querySelectorAll('.cid-row').length).toBe(0);
  });

  it('falls back to the store name record for the publication', async () => {
    stateMocks.store.getRecord.mockReturnValue('store-name.eth');
    const el = await mountLit('s2s-cid-view-section', { ctx: makeEmptyCtx() });

    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('No CIDs found');
    });
    expect(el.shadowRoot?.textContent).toContain('store-name.eth');
  });

  it('renders the loading state while the build is in flight', async () => {
    buildSpy.mockImplementation(() => new Promise(() => {})); // never resolves
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeEmptyCtx(),
      publication: 'test.eth',
    });

    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('Loading CID inventory…');
    });
    expect(el.shadowRoot?.querySelector('.spinner')).toBeTruthy();
  });

  it('renders the error state when the build fails', async () => {
    buildSpy.mockRejectedValue(new Error('boom boom'));
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeEmptyCtx(),
      publication: 'test.eth',
    });

    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.error')).toBeTruthy();
    });
    expect(el.shadowRoot?.textContent).toContain('boom boom');
  });

  it('serves a cached view instantly (SWR), then replaces + persists after the fresh build', async () => {
    const cached = makeCachedView();
    seedCache('test.eth', cached);

    // Deferred fresh build — resolves only after we've asserted the stale paint.
    let resolveFresh!: (v: PublicationCidView) => void;
    const freshView = makeCachedView({
      cid: 'bafyfresh1',
      generatedAt: '2026-01-02T00:00:00.000Z',
    });
    buildSpy.mockImplementation(
      () =>
        new Promise<PublicationCidView>((resolve) => {
          resolveFresh = resolve;
        }),
    );

    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });

    // Cached view is on screen while the fresh build is still in flight — no spinner.
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.cid-table')).toBeTruthy();
    });
    const root = el.shadowRoot!;
    expect(renderedCids(root)).toContain('bafycached1');
    expect(root.textContent).toContain('1 unique CIDs');
    expect(root.textContent).toContain('cached 1 min ago'); // staleness hint
    expect(root.querySelector('.spinner')).toBeNull();
    expect(root.textContent).not.toContain('Loading CID inventory…');
    // Revalidating: refresh button still reads Loading… and is disabled.
    expect(root.querySelector('.refresh')?.textContent).toContain('Loading');
    expect((root.querySelector('.refresh') as HTMLButtonElement).disabled).toBe(true);

    // Fresh build resolves → table replaced with the fresh view + persisted.
    resolveFresh(freshView);
    await vi.waitFor(() => {
      expect(renderedCids(el.shadowRoot!)).toContain('bafyfresh1');
    });
    expect(renderedCids(el.shadowRoot!)).not.toContain('bafycached1');
    expect(el.shadowRoot?.querySelector('.refresh')?.textContent).toContain('Refresh');
    // The stale hint disappears once the fresh view is displayed.
    expect(el.shadowRoot?.textContent).not.toContain('cached');
    const persisted = JSON.parse(localStorage.getItem('s2s.cidview.test.eth') ?? 'null');
    expect(persisted?.view?.entries?.[0]?.cid).toBe('bafyfresh1');
    expect(persisted?.view?.generatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(typeof persisted?.savedAt).toBe('number');
  });

  it('keeps the cached view (and shows no error) when the fresh build fails', async () => {
    const cached = makeCachedView();
    seedCache('test.eth', cached);
    buildSpy.mockRejectedValue(new Error('kubo down'));

    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });

    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.cid-table')).toBeTruthy();
    });
    const root = el.shadowRoot!;
    expect(renderedCids(root)).toContain('bafycached1');
    // Cached data wins over the error state — fail-open.
    expect(root.querySelector('.error')).toBeNull();
    expect(root.textContent).not.toContain('kubo down');
    // The stored cache is left untouched.
    const persisted = JSON.parse(localStorage.getItem('s2s.cidview.test.eth') ?? 'null');
    expect(persisted?.view?.entries?.[0]?.cid).toBe('bafycached1');
  });

  it('resets to the spinner (never another publication’s data) when a new publication has no cache', async () => {
    // old.eth has a cache; test.eth does not. Defer every build so the cached
    // view is observable until we resolve it ourselves.
    seedCache('old.eth', makeCachedView({ publication: 'old.eth', cid: 'bafyold' }));
    const resolvers: Array<(v: PublicationCidView) => void> = [];
    buildSpy.mockImplementation(
      () => new Promise<PublicationCidView>((resolve) => resolvers.push(resolve)),
    );

    const el = await mountLit<S2SCidViewSection>('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'old.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.cid-table')).toBeTruthy();
    });
    expect(renderedCids(el.shadowRoot!)).toContain('bafyold');

    // Switch publications → old.eth data must vanish while test.eth loads.
    el.publication = 'test.eth';
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('Loading CID inventory…');
    });
    expect(renderedCids(el.shadowRoot!)).not.toContain('bafyold');

    // Resolve the second build (test.eth) → only the new publication's view.
    resolvers[1]?.(makeCachedView({ publication: 'test.eth', cid: 'bafytest' }));
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('test.eth');
    });
    expect(renderedCids(el.shadowRoot!)).toContain('bafytest');
    expect(renderedCids(el.shadowRoot!)).not.toContain('bafyold');
  });

  it('degrades gracefully to no-cache when the stored blob is corrupt', async () => {
    localStorage.setItem('s2s.cidview.test.eth', 'not json {{{');
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });

    // Falls back to a normal fresh build (real coordinator) — no crash, no cache.
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('13 unique CIDs');
    });
    expect(el.shadowRoot?.querySelector('.error')).toBeNull();
  });

  it('degrades to no-cache when the cached blob is JSON-valid but schema-invalid', async () => {
    // Valid JSON that JSON.parse accepts, but an invalid category enum value —
    // rejected by the shared zod schema (parsePublicationCidView). A hand-rolled
    // validator that only checks cid/category are strings would let this through.
    localStorage.setItem(
      's2s.cidview.test.eth',
      JSON.stringify({
        savedAt: Date.now(),
        view: {
          publication: 'test.eth',
          generatedAt: '2026-01-01T00:00:00.000Z',
          entries: [{ cid: 'bafycached1', category: 'not-a-real-category', source: 'deals' }],
          sources: { deals: true, config: false, tree: false, archive: false },
          summary: { total: 1, uniqueCids: 1, byCategory: { deal: 1 } },
        },
      }),
    );
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });

    // Falls back to a normal fresh build (real coordinator) — no crash, no
    // garbage render from the schema-invalid blob.
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('13 unique CIDs');
    });
    expect(el.shadowRoot?.querySelector('.error')).toBeNull();
    expect(renderedCids(el.shadowRoot!)).not.toContain('bafycached1');
  });

  it('persists meta in the SWR cache and round-trips it through loadCachedView', async () => {
    // First mount: fresh cold build via the real coordinator → the view carries
    // a meta block (complete) and saveCachedView persists it verbatim.
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeCompleteCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.cid-table')).toBeTruthy();
    });
    // Wait for the fresh build to finish persisting (button re-enabled).
    await vi.waitFor(() => {
      expect((el.shadowRoot?.querySelector('.refresh') as HTMLButtonElement).disabled).toBe(false);
    });

    // The persisted blob's view includes the optional meta block, intact.
    const persisted = JSON.parse(localStorage.getItem('s2s.cidview.test.eth') ?? 'null') as {
      savedAt?: number;
      view?: PublicationCidView;
    };
    expect(persisted.savedAt).toBeTypeOf('number');
    expect(persisted.view?.meta?.complete).toBe(true);
    expect(persisted.view?.meta?.fingerprint).toBeTypeOf('string');

    // A second mount re-hydrates that cached view (meta intact) and passes it
    // as prev on the auto-revalidate build — proving loadCachedView round-trips
    // meta so the incremental path has its baseline.
    buildSpy.mockClear();
    await mountLit('s2s-cid-view-section', {
      ctx: makeCompleteCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(buildSpy.mock.calls.length).toBeGreaterThan(0);
    });
    expect(latestBuildOpts()?.prev?.meta?.complete).toBe(true);
    expect(latestBuildOpts()?.prev?.publication).toBe('test.eth');
  });

  it('passes the cached view as prev on auto-revalidate (incremental)', async () => {
    // Seed a genuine complete view (meta.complete:true) via the real coordinator.
    const seeded = await buildSeededView(makeCompleteCtx());
    expect(seeded.meta?.complete).toBe(true);
    seedCache('test.eth', seeded);

    await mountLit('s2s-cid-view-section', {
      ctx: makeCompleteCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(buildSpy.mock.calls.length).toBeGreaterThan(0);
    });
    // The auto-revalidate (mount) diffed against the cached view.
    expect(latestBuildOpts()).toEqual({ prev: seeded });
  });

  it('passes no prev on auto-revalidate when there is no cache (cold)', async () => {
    // beforeEach clears localStorage, so no cache exists for this publication.
    await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(buildSpy.mock.calls.length).toBeGreaterThan(0);
    });
    expect(latestBuildOpts()).toEqual({});
  });

  it('manual Refresh forces a cold rebuild even when a cache exists', async () => {
    const seeded = await buildSeededView(makeCompleteCtx());
    seedCache('test.eth', seeded);

    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeCompleteCtx(),
      publication: 'test.eth',
    });
    // The mount's auto-revalidate is incremental (prev passed).
    await vi.waitFor(() => {
      expect(buildSpy.mock.calls.length).toBeGreaterThan(0);
    });
    expect(buildSpy.mock.calls[0]?.[2]).toHaveProperty('prev');

    // Wait for the auto-revalidate build to finish so the button is enabled,
    // then click Refresh → the rebuild must be cold (no prev), ignoring the
    // cache entirely. The button's disabled/loading state stays unchanged.
    await vi.waitFor(() => {
      expect((el.shadowRoot?.querySelector('.refresh') as HTMLButtonElement).disabled).toBe(false);
    });
    (el.shadowRoot?.querySelector('.refresh') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(buildSpy.mock.calls.length).toBeGreaterThan(1);
    });
    expect(latestBuildOpts()).toEqual({});
    // The cold rebuild still paints the table (ground truth) and re-enables.
    await vi.waitFor(() => {
      expect((el.shadowRoot?.querySelector('.refresh') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(el.shadowRoot?.querySelector('.cid-table')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('.error')).toBeNull();
  });

  it('renders and rebuilds cold when the cached view has meta.complete:false', async () => {
    // makeFullCtx's offer genesis has no version → the coordinator's cold
    // completeness check fails → meta.complete:false (an incomplete baseline).
    const incomplete = await buildSeededView(makeFullCtx());
    expect(incomplete.meta?.complete).toBe(false);
    seedCache('test.eth', incomplete);

    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });

    // The cached (incomplete) view paints instantly, and the revalidate build
    // — which passes prev but is self-degraded to cold by the coordinator —
    // still succeeds and renders. No error state either way.
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.cid-table')).toBeTruthy();
    });
    expect(el.shadowRoot?.querySelector('.error')).toBeNull();
    await vi.waitFor(() => {
      expect((el.shadowRoot?.querySelector('.refresh') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(el.shadowRoot?.querySelector('.cid-table')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('.error')).toBeNull();
    // prev was still passed (incremental request) — the coordinator degraded it.
    expect(latestBuildOpts()?.prev?.meta?.complete).toBe(false);
  });

  it('clears the staleness ticker on disconnect (no interval leak)', async () => {
    seedCache('test.eth', makeCachedView());
    // Never-resolving fresh build: keeps the SWR staleness timer alive so we
    // can observe it, exactly like the deferred-build SWR test.
    buildSpy.mockImplementation(() => new Promise(() => {}));

    const el = await mountLit<S2SCidViewSection>('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });

    // Cached view is served → staleness hint shown + ticker armed.
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('cached 1 min ago');
    });
    const timer = (el as unknown as { staleTimer: ReturnType<typeof setInterval> | null })
      .staleTimer;
    expect(timer).not.toBeNull();

    // Detaching fires disconnectedCallback → ticker cleared, no leak.
    el.remove();
    expect(
      (el as unknown as { staleTimer: ReturnType<typeof setInterval> | null }).staleTimer,
    ).toBeNull();
  });
});
