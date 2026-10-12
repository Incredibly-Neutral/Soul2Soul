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
//
// SCOPE: the Storage CID view hides offers + version history (deal/offer
// versions) from the rendered table AND from the retrievability pass, so the
// fixture's 13 unique CIDs render as 10 (offer + 2 deal versions dropped). The
// full view still flows into the SWR cache + incremental baseline.

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { CID } from 'multiformats';
import { sha256 } from 'multiformats/hashes/sha2';
import type {
  CidRetrievabilityMap,
  CidRetrievabilityStatus,
  CidViewReadContext,
  PublicationCidView,
} from '@s2s/soul2soul-shared/safe-app';
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
  // The retrievability helpers are real too — the section's risk-sorted flat
  // table + stalest-first recheck loop depend on them.
  const real = await import('../../../shared/src/cid-view/coordinator.ts');
  const validation = await import('../../../shared/src/cid-view/validation.ts');
  const retrievability = await import('../../../shared/src/cid-view/retrievability.ts');
  realBuild.fn = real.buildPublicationCidView;
  return {
    buildPublicationCidView: buildSpy,
    parsePublicationCidView: validation.parsePublicationCidView,
    cidsFromView: retrievability.cidsFromView,
    orderByCopiesAscending: retrievability.orderByCopiesAscending,
    orderByStaleness: retrievability.orderByStaleness,
    RETRIEVABILITY_SOURCES: retrievability.RETRIEVABILITY_SOURCES,
  };
});

// The section's retrievability adapter (`@/lib/cid-view`) is mocked so the
// browser tests never hit the real ipfs-check endpoint. loadRetrievabilityMap
// seeds the dots; checkRetrievability's default impl marks every passed cid
// checked (all-false) so the self-pacing pass terminates after one batch.
const cidViewMocks = vi.hoisted(() => ({
  loadRetrievabilityMap: vi.fn<() => CidRetrievabilityMap | null>(() => null),
  saveRetrievabilityMap: vi.fn(),
  checkRetrievability: vi.fn(),
}));

vi.mock('@/lib/cid-view/index.js', () => cidViewMocks);

// The section's heal adapter (`@/lib/cid-view/heal.js`) is mocked so the
// browser tests never hit the network (kubo/pinata/filebase/filecoin) and
// never construct a real FilecoinStorage. healCid's default resolves a
// fully-successful outcome; individual specs override it to drive running /
// failed states.
const healMocks = vi.hoisted(() => ({
  healCid: vi.fn(),
  buildHealConfig: vi.fn(),
  HEAL_PROVIDERS: ['kubo', 'pinata', 'filebase', 'filecoin'],
}));

vi.mock('@/lib/cid-view/heal.js', () => healMocks);

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

/** The row CIDs currently rendered, read from each CID copy-hash's value
 *  property (shadow DOM). Genesis ids also render as copy-hash but carry no
 *  gateway href — they are excluded so row-order assertions see exactly the
 *  rendered row CIDs. */
function renderedCids(root: ShadowRoot): string[] {
  return Array.from(root.querySelectorAll('copy-hash'))
    .filter((c) => (c as HTMLElement & { href: string }).href)
    .map((c) => (c as HTMLElement & { value: string }).value);
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
    // Retrievability mocks: no cache + a terminating pass (every passed cid
    // becomes checked all-false) by default.
    cidViewMocks.loadRetrievabilityMap.mockReset().mockReturnValue(null);
    cidViewMocks.saveRetrievabilityMap.mockReset();
    cidViewMocks.checkRetrievability.mockReset().mockImplementation(
      async (_publication: string, _view: PublicationCidView, cids: readonly string[]) => {
        const map: CidRetrievabilityMap = {};
        for (const cid of cids) {
          map[cid] = {
            checkedAt: '2026-01-01T00:00:00.000Z',
            copies: 0,
            sources: { kubo: false, pinata: false, filebase: false, filecoin: false },
            state: 'no-providers',
          };
        }
        return map;
      },
    );
    // Heal mocks: default a fully-successful outcome (all providers ok).
    healMocks.healCid.mockReset().mockImplementation(async (cid: string) => ({
      cid,
      results: [],
      ok: true,
      partial: false,
      sources: { kubo: true, pinata: true, filebase: true, filecoin: true },
    }));
    healMocks.buildHealConfig.mockReset();
  });

  afterEach(() => {
    buildSpy.mockReset();
    cidViewMocks.checkRetrievability.mockReset();
    healMocks.healCid.mockReset();
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
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });

    const root = el.shadowRoot!;
    const text = root.textContent ?? '';

    // Summary chips — the unique-CIDs counter lives in a full-width top row;
    // the type/health filter chips sit in two equal containers below. The
    // entries counter chip was removed. Offers + versions are hidden, so the
    // 13-entry fixture renders as 10 unique CIDs.
    expect(text).toContain('10 unique CIDs');
    expect(text).not.toContain('10 entries');
    const topRow = root.querySelector('.chips-top');
    expect(topRow?.textContent).toContain('10 unique CIDs');
    // No filters active → no clear-filters chip.
    expect(topRow?.textContent).not.toContain('clear filters');
    // Chip section is one row with two containers: type chips | health chips.
    const groups = root.querySelectorAll('.chips-group');
    expect(groups.length).toBe(2);
    // Type chips (collapsed classification) live in container 1, counted over
    // the same unique-cid rows the table renders. (Whitespace-normalized:
    // <s2s-table> puts the chip label on its own line, so the raw textContent
    // has a newline between the count and the label.)
    const typeGroup = (groups[0]!.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(typeGroup).toContain('1 source');
    // Versions + offers are hidden — no version/offer chips at all.
    expect(typeGroup).not.toContain('version');
    expect(typeGroup).not.toContain('offer');
    expect(typeGroup).toContain('3 config');
    expect(typeGroup).toContain('2 asset');
    expect(typeGroup).toContain('2 html');
    expect(typeGroup).toContain('1 cache');
    expect(typeGroup).toContain('1 cache item');
    // Type chips are filter buttons (same pill design); none active initially.
    const filterChips = Array.from(root.querySelectorAll('button.chip'));
    expect(filterChips.length).toBeGreaterThanOrEqual(6);
    expect(filterChips.some((b) => b.textContent?.trim().endsWith('config'))).toBe(true);
    expect(root.querySelectorAll('button.chip.active').length).toBe(0);
    // Copies/health chips are empty until a retrievability pass fills the map
    // (the default all-false pass may or may not have landed here — asserted
    // deterministically in the dedicated filter tests below).

    // Entry rows: one per unique cid (flat risk-sorted table, no group rows).
    // The offer + 2 deal versions are hidden, so 13 → 10.
    expect(root.querySelectorAll('.cid-row').length).toBe(10);

    // Type badges (collapsed Category+Source): one per row, labels grouped by
    // the TYPE_META mapping, badge class keeps the fine-grained category color.
    expect(root.querySelectorAll('.badge.deal').length).toBe(1);
    expect(root.querySelectorAll('.badge.deal-version').length).toBe(0); // versions hidden
    expect(root.querySelectorAll('.badge.offer').length).toBe(0); // offers hidden
    expect(root.querySelectorAll('.badge.config').length).toBe(3); // config + template DAG + template
    expect(root.querySelectorAll('.badge.asset').length).toBe(2); // assets root + asset
    expect(root.querySelectorAll('.badge.tree').length).toBe(2); // site root + site file
    expect(root.querySelectorAll('.badge.archive').length).toBe(2); // archive + archive item
    const badgeText = (sel: string) =>
      Array.from(root.querySelectorAll(sel)).map((b) => b.textContent);
    expect(badgeText('.cid-row .badge.deal')).toEqual(['source']);
    expect(badgeText('.cid-row .badge.config')).toEqual(['config', 'config', 'config']);
    expect(badgeText('.cid-row .badge.asset')).toEqual(['asset', 'asset']);
    expect(badgeText('.cid-row .badge.tree')).toEqual(['html', 'html']);
    expect(badgeText('.cid-row .badge.archive')).toEqual(['cache', 'cache item']);
    // No separate source column anymore — single Type column per row.
    expect(root.querySelectorAll('.badge.source').length).toBe(0);
    // Fine-grained category is preserved as the badge title for hover detail.
    const dealBadge = root.querySelector('.cid-row .badge.deal') as HTMLElement | null;
    expect(dealBadge?.getAttribute('title')).toBe('deal');

    // No tombstone badge — versions (the only tombstoned entries) are hidden.
    expect(root.querySelectorAll('.badge.tombstone').length).toBe(0);

    // Gateway links — one per row pointing at the ipfs.io gateway (via copy-hash
    // href); the deal row's genesis id is an extra copyable value with no link.
    const links = Array.from(root.querySelectorAll('copy-hash')).map(
      (c) => (c as HTMLElement & { href: string }).href,
    );
    expect(links).toHaveLength(11);
    expect(links.filter((h) => h)).toHaveLength(10);
    expect(links).toContain('https://ipfs.io/ipfs/bafydeal1');
    expect(links).toContain(`https://ipfs.io/ipfs/${ROOT_CID}`);

    // copy-hash carries the CID (short CIDs stay full, long roots are shortened).
    const hashValues = Array.from(root.querySelectorAll('copy-hash')).map(
      (c) => (c as HTMLElement & { value: string }).value,
    );
    expect(hashValues).toHaveLength(11);
    expect(hashValues).toContain('bafydeal1');
    expect(hashValues).toContain(ROOT_CID); // .value is the FULL cid
    expect(hashValues).toContain('0xgen1'); // genesis id is copyable too
    // Offers + versions never reach the table.
    expect(hashValues).not.toContain('bafyoffer1');
    expect(hashValues).not.toContain('bafyver0');
    expect(hashValues).not.toContain('bafyver1');
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
    // The unique-CIDs counter chip is now part of <s2s-table> (chipsTop); a
    // zero-entry view renders the section's "No CIDs found" empty state
    // INSTEAD of the table, so the counter chip is absent here.
    expect(text).not.toContain('unique CIDs');
    expect(root.querySelectorAll('.cid-row').length).toBe(0);
  });

  it('falls back to the store name record for the publication', async () => {
    stateMocks.store.getRecord.mockReturnValue('store-name.eth');
    const el = await mountLit('s2s-cid-view-section', { ctx: makeEmptyCtx() });

    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('No CIDs found');
    });
    // The header no longer renders the publication text; the fallback's
    // observable effect is that the store-name record is the publication
    // actually passed to the build.
    expect(buildSpy.mock.calls.some((c) => c[1] === 'store-name.eth')).toBe(true);
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
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
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
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
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
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
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
      expect(renderedCids(el.shadowRoot!)).toContain('bafytest');
    });
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
      expect(el.shadowRoot?.textContent).toContain('10 unique CIDs');
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
      expect(el.shadowRoot?.textContent).toContain('10 unique CIDs');
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
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
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
    expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
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
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    expect(el.shadowRoot?.querySelector('.error')).toBeNull();
    await vi.waitFor(() => {
      expect((el.shadowRoot?.querySelector('.refresh') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
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

  // --- retrievability (ipfs-check batch) ---

  /** recent checkedAt so relativeTime yields a friendly "Nm ago" label. */
  const RECENT = () => new Date(Date.now() - 5 * 60_000).toISOString();

  /**
   * checkRetrievability mock that never resolves — the self-pacing pass hangs
   * forever, so the seeded map loaded from localStorage stays authoritative and
   * the "unchecked" rows (gray dots + dash) remain deterministic to assert on.
   */
  function hangRetrievability(): Promise<CidRetrievabilityMap> {
    return new Promise<CidRetrievabilityMap>(() => {});
  }

  function seededRetrievability(): CidRetrievabilityMap {
    // bafydeal1: fully available (3 copies); bafyver1: single (1, risky) —
    // though bafyver1 is a hidden version row (excluded from the view);
    // ROOT_CID / bafyconfig: unchecked. Deterministic for dot/risk assertions.
    return {
      bafydeal1: {
        checkedAt: RECENT(),
        copies: 3,
        sources: { kubo: true, pinata: true, filebase: true, filecoin: false },
        state: 'ok',
      },
      bafyver1: {
        checkedAt: RECENT(),
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
    };
  }

  it('renders per-source dots from the loaded retrievability map', async () => {
    const seed = seededRetrievability();
    cidViewMocks.loadRetrievabilityMap.mockReturnValue(seed);
    cidViewMocks.checkRetrievability.mockImplementation(hangRetrievability);
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    const root = el.shadowRoot!;
    const rows = Array.from(root.querySelectorAll('.cid-row'));
    const dealRow = rows.find((r) => r.querySelector('.badge.deal'));
    expect(dealRow).toBeTruthy();
    // bafydeal1 → 3 green + 1 red among the four source dots.
    const dots = dealRow!.querySelectorAll('.dot');
    expect(dots.length).toBe(4);
    expect(dealRow!.querySelectorAll('.dot.on').length).toBe(3);
    expect(dealRow!.querySelectorAll('.dot.off').length).toBe(1);
    // Copies cell reads 3/4.
    expect(dealRow!.textContent).toContain('3/4');
    // Unchecked rows show gray dots + a dash for copies.
    const unknownRow = rows.find((r) => r.querySelector('.badge.config'));
    expect(unknownRow!.querySelectorAll('.dot.unknown').length).toBe(4);
    expect(unknownRow!.textContent).toContain('—');
  });

  it('sorts the flat table fewest-copies-first (unchecked on top)', async () => {
    const seed = seededRetrievability();
    cidViewMocks.loadRetrievabilityMap.mockReturnValue(seed);
    cidViewMocks.checkRetrievability.mockImplementation(hangRetrievability);
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    const rows = Array.from(el.shadowRoot!.querySelectorAll('.cid-row'));
    // Unchecked (config, site root...) come first (never-checked on top), then
    // copies 3 (bafydeal1) last. bafyver1 (the 1/4 version) is excluded from
    // the view entirely. CIDs live in copy-hash values, not text — match on
    // the copies labels instead.
    const order = rows.map((r) => r.textContent ?? '');
    const configIdx = order.findIndex((t) => t.includes('config'));
    const dealIdx = order.findIndex((t) => t.includes('3/4'));
    expect(configIdx).toBeGreaterThanOrEqual(0);
    expect(dealIdx).toBeGreaterThan(configIdx);
    // The excluded version row (1/4) never renders.
    expect(order.some((t) => t.includes('1/4'))).toBe(false);
  });

  it('kicks off a retrievability pass after a fresh build with the view cids', async () => {
    // Never-resolving pass keeps the checking indicator visible long enough to
    // assert on it; the component's disconnectedCallback aborts it on unmount.
    cidViewMocks.checkRetrievability.mockImplementation(() => new Promise(() => {}));
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(cidViewMocks.checkRetrievability).toHaveBeenCalled();
    });
    const [publication, view, cids] = cidViewMocks.checkRetrievability.mock.calls[0];
    expect(publication).toBe('test.eth');
    expect(view.publication).toBe('test.eth');
    expect(cids).toContain('bafydeal1');
    expect(cids).toContain(ROOT_CID);
    // The whole visible unique-cid set is the pass input (10 unique < batch 50).
    expect(cids.length).toBe(10);
    // Offers + versions are excluded from the check too.
    expect(cids).not.toContain('bafyoffer1');
    expect(cids).not.toContain('bafyver0');
    expect(cids).not.toContain('bafyver1');
    // The pass paints a 'checking copies…' indicator while in flight.
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('checking');
    });
  });

  it('Recheck button aborts any in-flight pass and starts a fresh one', async () => {
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    // Wait for the first (default terminating) pass to finish so the Recheck
    // button is enabled.
    await vi.waitFor(() => {
      const recheck = Array.from(el.shadowRoot!.querySelectorAll('.refresh')).find((b) =>
        b.textContent?.includes('Recheck'),
      ) as HTMLButtonElement | undefined;
      expect(recheck && !recheck.disabled).toBe(true);
    });
    const buttons = Array.from(el.shadowRoot!.querySelectorAll('.refresh'));
    const recheck = buttons.find((b) => b.textContent?.includes('Recheck'));
    expect(recheck).toBeTruthy();
    recheck!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await vi.waitFor(() => {
      expect(cidViewMocks.checkRetrievability.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('resumes from the cache — all-fresh cids are NOT re-checked on (re)mount', async () => {
    // First mount with no cache → the terminating pass runs once; the cids it
    // was handed are the view's real unique set (13, incl. site-root/archive
    // CIDs that render as wrapped hashes in the table).
    const el0 = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => expect(cidViewMocks.checkRetrievability).toHaveBeenCalled());
    const all = [...(cidViewMocks.checkRetrievability.mock.calls[0][2] as readonly string[])];
    expect(all.length).toBe(10);
    el0.remove();
    cidViewMocks.checkRetrievability.mockClear();

    // Reload: a cache exists with every cid checked within the freshness
    // window → the auto pass must NOT re-query anything.
    const seed: CidRetrievabilityMap = {};
    for (const cid of all) {
      seed[cid] = {
        checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min ago < 15 min window
        copies: 2,
        sources: { kubo: true, pinata: true, filebase: false, filecoin: false },
        state: 'ok',
      };
    }
    cidViewMocks.loadRetrievabilityMap.mockReturnValue(seed);
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('.table')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50)); // let any (wrong) async pass surface
    expect(cidViewMocks.checkRetrievability).not.toHaveBeenCalled();
    // Dots render from the persisted map + the stored-hint makes persistence observable.
    expect(el.shadowRoot!.textContent).toContain('10 CIDs stored');
    const dealRow = Array.from(el.shadowRoot!.querySelectorAll('.cid-row')).find((r) =>
      r.querySelector('.badge.deal'),
    );
    expect(dealRow!.querySelectorAll('.dot.on').length).toBe(2);
  });

  it('auto pass only re-checks UNFRESH cids (never-checked/stale), not the fresh ones', async () => {
    const el0 = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => expect(cidViewMocks.checkRetrievability).toHaveBeenCalled());
    const all = [...(cidViewMocks.checkRetrievability.mock.calls[0][2] as readonly string[])];
    el0.remove();
    cidViewMocks.checkRetrievability.mockClear();

    // 7 cids checked recently (fresh), 3 checked long ago (stale) → only the
    // 3 stale ones may be re-queried by the auto pass.
    const stale = all.slice(0, 3);
    const seed: CidRetrievabilityMap = {};
    for (const cid of all) {
      seed[cid] = {
        checkedAt: stale.includes(cid)
          ? new Date(Date.now() - 2 * 60 * 60_000).toISOString() // 2h old → stale
          : new Date(Date.now() - 5 * 60_000).toISOString(),
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      };
    }
    cidViewMocks.loadRetrievabilityMap.mockReturnValue(seed);
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => expect(cidViewMocks.checkRetrievability).toHaveBeenCalled());
    const [, , rechecked] = cidViewMocks.checkRetrievability.mock.calls[0] as [
      string,
      PublicationCidView,
      readonly string[],
    ];
    expect([...rechecked].sort()).toEqual([...stale].sort());
    // The other 10 (fresh) are untouched by the pass.
    expect(cidViewMocks.checkRetrievability.mock.calls.length).toBe(1);
  });

  it('manual Recheck ignores the freshness window and forces a full pass', async () => {
    const el0 = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => expect(cidViewMocks.checkRetrievability).toHaveBeenCalled());
    const all = [...(cidViewMocks.checkRetrievability.mock.calls[0][2] as readonly string[])];
    el0.remove();
    cidViewMocks.checkRetrievability.mockClear();

    const seed: CidRetrievabilityMap = {};
    for (const cid of all) {
      seed[cid] = {
        checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(), // all fresh
        copies: 2,
        sources: { kubo: true, pinata: true, filebase: false, filecoin: false },
        state: 'ok',
      };
    }
    cidViewMocks.loadRetrievabilityMap.mockReturnValue(seed);
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('.table')).toBeTruthy());
    // Auto pass is a no-op (all fresh) → Recheck must still force every cid.
    await new Promise((r) => setTimeout(r, 50));
    expect(cidViewMocks.checkRetrievability).not.toHaveBeenCalled();
    const recheck = Array.from(el.shadowRoot!.querySelectorAll('.refresh')).find((b) =>
      b.textContent?.includes('Recheck'),
    ) as HTMLButtonElement;
    recheck.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(cidViewMocks.checkRetrievability).toHaveBeenCalled());
    const [, , forced] = cidViewMocks.checkRetrievability.mock.calls[0] as [
      string,
      PublicationCidView,
      readonly string[],
    ];
    expect([...forced].sort()).toEqual([...all].sort());
  });

  it('shows genesis as the single copyable Role/Path value on deal rows', async () => {
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    const root = el.shadowRoot!;
    // Header no longer has a standalone Genesis column.
    expect(root.textContent).not.toContain('Genesis');
    const rows = Array.from(root.querySelectorAll('.cid-row'));
    const dealRow = rows.find((r) => r.querySelector('.badge.deal'))!;
    // Role/Path is the 3rd .cid-cell of each row (badge, cid, role/path, ...).
    const rolePath = Array.from(dealRow.querySelectorAll('.cid-cell'))[2]!;
    // No name + genesis sub-line anymore — just one copyable genesis id.
    expect(rolePath.querySelector('.cell-sub')).toBeNull();
    expect(rolePath.textContent).not.toContain('deal');
    const genesisHash = rolePath.querySelector('copy-hash');
    expect(genesisHash).toBeTruthy();
    expect((genesisHash as HTMLElement & { value: string }).value).toBe('0xgen1');
    // Shorter display, full value on copy (no gateway link for genesis).
    expect((genesisHash as HTMLElement & { href: string }).href).toBe('');
  });

  it('shows the path when an entry has one, else a per-category name — never a bare "-"', async () => {
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    const root = el.shadowRoot!;
    const rows = Array.from(root.querySelectorAll('.cid-row'));
    // Role/Path is the 3rd .cid-cell of each row (badge, cid, role/path, ...).
    const rolePathOf = (row: Element) =>
      (Array.from(row.querySelectorAll('.cid-cell'))[2]?.textContent ?? '').trim();

    // templates DAG root has no path → its descriptive name, not '-'.
    const templateDagRow = rows.find(
      (r) => r.querySelector('.badge.config')?.getAttribute('title') === 'template DAG',
    );
    expect(templateDagRow).toBeTruthy();
    expect(rolePathOf(templateDagRow!)).toContain('templates DAG');

    // config root has no path → its descriptive name.
    const configRow = rows.find(
      (r) => r.querySelector('.badge.config')?.getAttribute('title') === 'config',
    );
    expect(rolePathOf(configRow!)).toContain('publication config');

    // A template entry WITH a path shows the path, not a name / dash.
    const templateRow = rows.find(
      (r) => r.querySelector('.badge.config')?.getAttribute('title') === 'template',
    );
    expect(rolePathOf(templateRow!)).toContain('about/index.html');

    // No Role/Path cell is left as a bare '-' placeholder.
    const rolePathTexts = rows.map(rolePathOf);
    expect(rolePathTexts.some((t) => t === '-')).toBe(false);
  });



  it('shows a relative last-check label for checked cids and a dash for unchecked', async () => {
    const seed = seededRetrievability();
    cidViewMocks.loadRetrievabilityMap.mockReturnValue(seed);
    cidViewMocks.checkRetrievability.mockImplementation(hangRetrievability);
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    const rows = Array.from(el.shadowRoot!.querySelectorAll('.cid-row'));
    const dealRow = rows.find((r) => r.querySelector('.badge.deal'));
    // recent checkedAt → relative label (e.g. '5m ago').
    expect(dealRow!.textContent).toMatch(/ago/);
    const configRow = rows.find((r) => r.querySelector('.badge.config'));
    expect(configRow!.textContent).toContain('—');
  });

  // --- chip filters (type / copies / health) ---

  it('type chips filter the table and toggle back off', async () => {
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    const root = el.shadowRoot!;
    expect(root.querySelectorAll('.cid-row').length).toBe(10);

    const configChip = Array.from(root.querySelectorAll('button.chip')).find((b) =>
      b.textContent?.trim().endsWith('config'),
    );
    expect(configChip).toBeTruthy();
    (configChip as HTMLButtonElement).click();

    // Only the 3 config-type rows remain (config + template DAG + template).
    await vi.waitFor(() => {
      expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(3);
    });
    const badges = Array.from(el.shadowRoot!.querySelectorAll('.cid-row .badge'));
    expect(badges.length).toBe(3);
    expect(badges.every((b) => b.textContent === 'config')).toBe(true);
    // Chip shows the active state and a clear-filters affordance appears.
    const activeChip = Array.from(el.shadowRoot!.querySelectorAll('button.chip.active')).find(
      (b) => b.textContent?.includes('config'),
    );
    expect(activeChip).toBeTruthy();
    expect(el.shadowRoot!.textContent).toContain('clear filters');

    // Toggle the active chip off → all 10 rows return.
    (activeChip as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(10);
    });
    expect(el.shadowRoot!.querySelectorAll('button.chip.active').length).toBe(0);
  });

  it('health chips filter the table by copy buckets and combine with type chips (AND)', async () => {
    // Deterministic mixed retrievability covering every VISIBLE bucket: deal 5
    // Deterministic mixed retrievability covering every VISIBLE bucket: deal 4
    // copies (healthy — the realistic max, all four platforms), config 1 copy
    // (danger), assets 0 copies (lost); bafyver1 3 copies (needs healing) is
    // seeded but the version row is hidden from the view, so its bucket never
    // appears. Everything else unchecked.
    const seed: CidRetrievabilityMap = {
      bafydeal1: {
        checkedAt: RECENT(),
        copies: 4,
        sources: { kubo: true, pinata: true, filebase: true, filecoin: true },
        state: 'ok',
      },
      bafyver1: {
        checkedAt: RECENT(),
        copies: 3,
        sources: { kubo: true, pinata: true, filebase: true, filecoin: false },
        state: 'ok',
      },
      bafyconfig: {
        checkedAt: RECENT(),
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
      bafyassets: {
        checkedAt: RECENT(),
        copies: 0,
        sources: { kubo: false, pinata: false, filebase: false, filecoin: false },
        state: 'no-providers',
      },
    };
    cidViewMocks.loadRetrievabilityMap.mockReturnValue(seed);
    cidViewMocks.checkRetrievability.mockImplementation(hangRetrievability);
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    const root = el.shadowRoot!;
    expect(root.querySelectorAll('.cid-row').length).toBe(10);

    // Container 2 chips: healthy / needs healing / danger / lost. The
    // needs-healing bucket is empty — its only occupant (bafyver1) is hidden.
    // (Whitespace-normalized: <s2s-table> puts the chip label on its own line.)
    const group2 = (root.querySelectorAll('.chips-group')[1]!.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(group2).toContain('1 healthy');
    expect(group2).not.toContain('needs healing');
    expect(group2).toContain('1 danger');
    expect(group2).toContain('1 lost');

    // Health chip 'healthy' → only the deal row (4/4) remains.
    const healthyChip = Array.from(root.querySelectorAll('button.chip')).find((b) =>
      b.textContent?.includes('healthy'),
    );
    expect(healthyChip).toBeTruthy();
    (healthyChip as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(1);
    });
    expect(el.shadowRoot!.querySelector('.cid-row .badge.deal')).toBeTruthy();
    expect(el.shadowRoot!.textContent).toContain('4/4');

    // Toggle it back off → all rows return.
    const healthyChipActive = Array.from(
      el.shadowRoot!.querySelectorAll('button.chip.active'),
    ).find((b) => b.textContent?.includes('healthy'));
    (healthyChipActive as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(10);
    });

    // 'lost' → only the assets root row (0/4).
    const lostChip = Array.from(el.shadowRoot!.querySelectorAll('button.chip')).find((b) =>
      b.textContent?.includes('lost'),
    );
    expect(lostChip).toBeTruthy();
    (lostChip as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(1);
    });
    expect(el.shadowRoot!.querySelector('.cid-row .badge.asset')).toBeTruthy();
    expect(el.shadowRoot!.textContent).toContain('0/4');

    // Combine with type 'config' (danger, not lost): nothing matches → the
    // empty-filter message shows.
    const configChip = Array.from(el.shadowRoot!.querySelectorAll('button.chip')).find((b) =>
      b.textContent?.trim().endsWith('config'),
    );
    (configChip as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('No rows match the active filters');
    });
    expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(0);

    // Clear filters → all 10 rows return.
    const clearChip = Array.from(el.shadowRoot!.querySelectorAll('button.chip')).find((b) =>
      b.textContent?.includes('clear filters'),
    );
    expect(clearChip).toBeTruthy();
    (clearChip as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(10);
    });
    expect(el.shadowRoot!.querySelectorAll('button.chip.active').length).toBe(0);
  });

  // --- sortable columns (s2s-table) ---

  /**
   * Deterministic retrievability for the sort tests: three checked CIDs with
   * distinct copy counts (bafyassets 0 / bafyconfig 1 / bafydeal1 3) plus the
   * other 7 rows unchecked. Default risk order puts the unchecked rows first,
   * then the checked ones fewest-copies-first; a user sort overrides it.
   */
  function sortSeed(): CidRetrievabilityMap {
    return {
      bafydeal1: {
        checkedAt: RECENT(),
        copies: 3,
        sources: { kubo: true, pinata: true, filebase: true, filecoin: false },
        state: 'ok',
      },
      bafyconfig: {
        checkedAt: RECENT(),
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
      bafyassets: {
        checkedAt: RECENT(),
        copies: 0,
        sources: { kubo: false, pinata: false, filebase: false, filecoin: false },
        state: 'no-providers',
      },
    };
  }

  async function mountSortedFixture() {
    cidViewMocks.loadRetrievabilityMap.mockReturnValue(sortSeed());
    cidViewMocks.checkRetrievability.mockImplementation(hangRetrievability);
    const el = await mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('.table')).toBeTruthy();
    });
    return el;
  }

  /** The sortable header button for a column key inside the section's shadow root. */
  function headerButton(el: HTMLElement, key: string): HTMLButtonElement {
    const btn = el.shadowRoot?.querySelector<HTMLButtonElement>(
      `.table-header[data-sort="${key}"]`,
    );
    expect(btn).toBeTruthy();
    return btn!;
  }

  it('default row order is the risk-sort (fewest copies first, unchecked on top)', async () => {
    const el = await mountSortedFixture();
    const cids = renderedCids(el.shadowRoot!);
    expect(cids).toHaveLength(10);
    // Unchecked rows first, then the three checked rows fewest-copies-first.
    expect(cids.slice(-3)).toEqual(['bafyassets', 'bafyconfig', 'bafydeal1']);
    // No sort indicator yet (sort starts null).
    expect(
      el.shadowRoot!.querySelector('.table-header.sortable .sort-indicator ph-caret-up'),
    ).toBeNull();
    expect(
      el.shadowRoot!.querySelector('.table-header.sortable .sort-indicator ph-caret-down'),
    ).toBeNull();
  });

  it('clicking the Copies header emits a sort event and sorts rows by copies ascending', async () => {
    const el = await mountSortedFixture();
    const events: Array<{ key: string }> = [];
    el.addEventListener('sort', (e) => events.push((e as CustomEvent).detail));

    headerButton(el, 'copies').click();
    await vi.waitFor(() => {
      expect(events).toEqual([{ key: 'copies' }]);
      expect(
        el.shadowRoot!.querySelector('.table-header[data-sort="copies"] .sort-indicator ph-caret-up'),
      ).toBeTruthy();
    });
    // Ascending by copies: the checked rows sort last, fewest first (unchecked
    // rows read as 0 copies, so they lead).
    const cids = renderedCids(el.shadowRoot!);
    expect(cids.slice(-3)).toEqual(['bafyassets', 'bafyconfig', 'bafydeal1']);
  });

  it('clicking the same header again toggles to descending', async () => {
    const el = await mountSortedFixture();
    const copies = headerButton(el, 'copies');
    copies.click(); // asc
    copies.click(); // desc
    await vi.waitFor(() => {
      expect(
        el.shadowRoot!.querySelector('.table-header[data-sort="copies"] .sort-indicator ph-caret-down'),
      ).toBeTruthy();
    });
    // Descending: the 3-copy deal row first, the 1-copy config second, then the
    // 0-value rows (unchecked + the 0-copy assets root) last.
    const cids = renderedCids(el.shadowRoot!);
    expect(cids[0]).toBe('bafydeal1');
    expect(cids[1]).toBe('bafyconfig');
    expect(cids[cids.length - 1]).toBe('bafyassets');
  });

  it('clicking a different header (Type) resets to that column ascending', async () => {
    const el = await mountSortedFixture();
    headerButton(el, 'copies').click(); // copies asc
    headerButton(el, 'type').click(); // resets to type asc
    await vi.waitFor(() => {
      expect(
        el.shadowRoot!.querySelector('.table-header[data-sort="type"] .sort-indicator ph-caret-up'),
      ).toBeTruthy();
      expect(
        el.shadowRoot!.querySelector('.table-header[data-sort="copies"] .sort-indicator ph-caret-up'),
      ).toBeNull();
    });
    // Type asc (locale/numeric): asset < cache < cache item < config < html < source.
    const badges = Array.from(el.shadowRoot!.querySelectorAll('.cid-row .badge')).map(
      (b) => b.textContent,
    );
    expect(badges).toEqual([
      'asset',
      'asset',
      'cache',
      'cache item',
      'config',
      'config',
      'config',
      'html',
      'html',
      'source',
    ]);
  });

  it('after sorting, chips filtering still works (AND composition preserved)', async () => {
    const el = await mountSortedFixture();
    // Sort by copies descending first.
    const copies = headerButton(el, 'copies');
    copies.click(); // asc
    copies.click(); // desc
    await vi.waitFor(() => {
      expect(
        el.shadowRoot!.querySelector('.table-header[data-sort="copies"] .sort-indicator ph-caret-down'),
      ).toBeTruthy();
    });

    // Filter to the 'config' type (3 rows: bafyconfig + 2 unchecked configs).
    const configChip = Array.from(el.shadowRoot!.querySelectorAll('button.chip')).find((b) =>
      b.textContent?.trim().endsWith('config'),
    );
    expect(configChip).toBeTruthy();
    (configChip as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(3);
    });
    const badges = Array.from(el.shadowRoot!.querySelectorAll('.cid-row .badge')).map(
      (b) => b.textContent,
    );
    expect(badges).toEqual(['config', 'config', 'config']);
    // Descending copies still applies within the filtered set: the 1-copy
    // bafyconfig row sorts before the two unchecked (0-copy) config rows.
    const cids = renderedCids(el.shadowRoot!);
    expect(cids[0]).toBe('bafyconfig');
  });

  // -------------------------------------------------------------------------
  // Heal (heart) — per-row heal button on the CID inventory table.
  // -------------------------------------------------------------------------

  /** Heal config the host would pass down (tokens are env-driven at runtime;
   *  the mocked healCid never hits the network, so a bare source suffices). */
  const HEAL_CONFIG = { source: 'https://ipfs.transport-union.dev' };

  /** The row that renders `cid` as its primary copy-hash (the one with an
   *  href — genesis ids on deal rows have no href). */
  function rowForCid(el: HTMLElement, cid: string): HTMLElement {
    const row = Array.from(el.shadowRoot!.querySelectorAll('.cid-row')).find((r) =>
      Array.from(r.querySelectorAll('copy-hash')).some(
        (c) =>
          (c as HTMLElement & { href: string }).href &&
          (c as HTMLElement & { value: string }).value === cid,
      ),
    );
    expect(row).toBeTruthy();
    return row as HTMLElement;
  }

  /** Seed a deterministic retrievability map + hang the auto pass so the
   *  seeded statuses stay authoritative through the heal interactions. */
  function mountHealFixture(seed: CidRetrievabilityMap) {
    cidViewMocks.loadRetrievabilityMap.mockReset().mockReturnValue(seed);
    cidViewMocks.checkRetrievability.mockImplementation(hangRetrievability);
    return mountLit('s2s-cid-view-section', {
      ctx: makeFullCtx(),
      publication: 'test.eth',
      healConfig: HEAL_CONFIG,
    });
  }

  it('shows a heal heart ONLY on red-spot rows (lost/danger/inconclusive), never on healthy or never-checked rows', async () => {
    const seed: CidRetrievabilityMap = {
      bafydeal1: {
        checkedAt: RECENT(),
        copies: 4,
        sources: { kubo: true, pinata: true, filebase: true, filecoin: true },
        state: 'ok',
      },
      bafyconfig: {
        checkedAt: RECENT(),
        copies: 0,
        sources: { kubo: false, pinata: false, filebase: false, filecoin: false },
        state: 'no-providers',
      },
      bafyassets: {
        checkedAt: RECENT(),
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
      bafyasset: {
        checkedAt: RECENT(),
        copies: 0,
        sources: { kubo: false, pinata: false, filebase: false, filecoin: false },
        state: 'inconclusive',
      },
    };
    const el = await mountHealFixture(seed);
    await vi.waitFor(() => expect(el.shadowRoot!.querySelector('.table')).toBeTruthy());
    expect(el.shadowRoot!.querySelectorAll('.cid-row').length).toBe(10);

    // Red-spot rows carry a heal button.
    for (const cid of ['bafyconfig', 'bafyassets', 'bafyasset']) {
      expect(rowForCid(el, cid).querySelector('button.heal')).toBeTruthy();
    }
    // Healthy + never-checked rows carry NO heal button (empty cell only).
    for (const cid of [
      'bafydeal1',
      'bafytemplatedag',
      'bafytemplate',
      ROOT_CID,
      'bafysitefile',
      CACHE_CID,
      'bafyarchiveitem',
    ]) {
      expect(rowForCid(el, cid).querySelector('button.heal')).toBeNull();
    }
  });

  it('clicking the heart heals the CID (healCid with cid+config) and disables the button while running', async () => {
    const seed: CidRetrievabilityMap = {
      bafyconfig: {
        checkedAt: RECENT(),
        copies: 0,
        sources: { kubo: false, pinata: false, filebase: false, filecoin: false },
        state: 'no-providers',
      },
    };
    // Never resolves — lets us observe the running (disabled) state.
    healMocks.healCid.mockReset().mockImplementation(() => new Promise(() => {}));
    const el = await mountHealFixture(seed);
    await vi.waitFor(() => expect(el.shadowRoot!.querySelector('.table')).toBeTruthy());

    const heart = rowForCid(el, 'bafyconfig').querySelector('button.heal') as HTMLButtonElement;
    expect(heart).toBeTruthy();
    heart.click();
    await vi.waitFor(() =>
      expect(healMocks.healCid).toHaveBeenCalledWith('bafyconfig', HEAL_CONFIG),
    );
    // Wait for the lit re-render to flush the running state into the DOM.
    await vi.waitFor(() => {
      const running = rowForCid(el, 'bafyconfig').querySelector('button.heal') as HTMLButtonElement;
      expect(running.disabled).toBe(true);
      expect(running.textContent).toContain('…');
    });
  });

  it('a successful heal flips the row’s 4 source dots on and persists the updated map', async () => {
    const seed: CidRetrievabilityMap = {
      bafyconfig: {
        checkedAt: RECENT(),
        copies: 0,
        sources: { kubo: false, pinata: false, filebase: false, filecoin: false },
        state: 'no-providers',
      },
    };
    const el = await mountHealFixture(seed);
    await vi.waitFor(() => expect(el.shadowRoot!.querySelector('.table')).toBeTruthy());

    const heart = rowForCid(el, 'bafyconfig').querySelector('button.heal') as HTMLButtonElement;
    heart.click();
    await vi.waitFor(() => expect(cidViewMocks.saveRetrievabilityMap).toHaveBeenCalled());
    expect(healMocks.healCid).toHaveBeenCalledWith('bafyconfig', HEAL_CONFIG);

    const row = rowForCid(el, 'bafyconfig');
    // 4 of 4 source dots flipped on.
    expect(row.querySelectorAll('.dot.on').length).toBe(4);
    // Heart flipped to the green "healed" check.
    expect(row.querySelector('button.heal.ok')).toBeTruthy();
    // Persisted map reflects the optimistic update.
    const [, map] = cidViewMocks.saveRetrievabilityMap.mock.calls.at(-1);
    const status = map['bafyconfig'];
    expect(status.copies).toBe(4);
    expect(status.sources).toEqual({
      kubo: true,
      pinata: true,
      filebase: true,
      filecoin: true,
    });
    expect(status.state).toBe('ok');
  });

  it('a failed heal keeps the row healable and does NOT mark its sources', async () => {
    const seed: CidRetrievabilityMap = {
      bafyconfig: {
        checkedAt: RECENT(),
        copies: 0,
        sources: { kubo: false, pinata: false, filebase: false, filecoin: false },
        state: 'no-providers',
      },
    };
    healMocks.healCid.mockReset().mockImplementation(async (cid: string) => ({
      cid,
      results: [{ provider: 'kubo', ok: false, error: 'boom' }],
      ok: false,
      partial: false,
      sources: {},
    }));
    const el = await mountHealFixture(seed);
    await vi.waitFor(() => expect(el.shadowRoot!.querySelector('.table')).toBeTruthy());

    const heart = rowForCid(el, 'bafyconfig').querySelector('button.heal') as HTMLButtonElement;
    heart.click();
    await vi.waitFor(() => expect(healMocks.healCid).toHaveBeenCalled());

    const row = rowForCid(el, 'bafyconfig');
    // Row stays healable: idle red heart (not .ok, not disabled, re-runnable).
    const again = row.querySelector('button.heal') as HTMLButtonElement;
    expect(again).toBeTruthy();
    expect(again.classList.contains('ok')).toBe(false);
    expect(again.disabled).toBe(false);
    // No source marked.
    expect(row.querySelectorAll('.dot.on').length).toBe(0);
  });
});
