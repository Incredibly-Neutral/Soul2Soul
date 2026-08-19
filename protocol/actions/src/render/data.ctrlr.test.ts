import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPath,
  sortCollection,
  bodiesFromReconcile,
  fetchCollections,
  shouldWriteBackCache,
  type CollectionsDrift,
} from './data.ctrlr';
import { catFile } from '../libs/ipfs.factory';
import { fetchByPublication, getDeals } from '../libs/module.factory';

// Mock the I/O boundaries so fetchCollections' archive path can be exercised
// without a chain/IPFS. The pure helpers above (createPath, sortCollection,
// bodiesFromReconcile) don't touch these, so the mocks are inert for them.
vi.mock('../libs/ipfs.factory', () => ({
  catFile: vi.fn(),
}));

vi.mock('../libs/module.factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/module.factory')>();
  return { ...actual, getDeals: vi.fn(), fetchByPublication: vi.fn() };
});

// ============================================================================
// createPath unit tests — config-driven locale routing (monolingual by default).
//
// The behavior matrix:
//   - localePaths absent  → clean pass-through, no prefix, any locale
//   - localePaths present → prefix = localePaths[body.locale] ?? localePaths.default ?? ''
//   - {slug} substitution and the `!body.encryption && body.slug` gate are
//     unchanged (no locale routing for the slug itself).
// ============================================================================

// Template path containing a slug placeholder. In the matrix rows the body has
// NO slug, so the literal `{slug}` survives — those rows isolate the prefix
// logic. Dedicated rows below exercise slug substitution.
const SLUG_PATH = '/{slug}/';

const baseBody = {
  id: 't1',
  author: '0xAuthor',
  locale: 'nl',
  parent: '',
  position: '',
  postType: 'post',
  creationDate: '2026-08-13',
  modifiedDate: '2026-08-13',
  tags: [],
  publication: 'test.s2s',
  encryption: false,
  title: 'Title',
  slug: undefined as string | undefined,
  content: 'plain',
  custom: {},
};

const body = (overrides: Record<string, unknown> = {}) => ({ ...baseBody, ...overrides }) as any;
const tpl = (path: string) => ({ reference: 'post', file: 'post', path }) as any;

describe('createPath: monolingual default (no localePaths)', () => {
  it('returns "/" when templateConfig.path is null', () => {
    expect(createPath(body(), tpl(null as any))).toBe('/');
  });

  it('no prefix for any locale when localePaths is absent', () => {
    expect(createPath(body({ locale: 'nl' }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
    expect(createPath(body({ locale: 'en' }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
    expect(createPath(body({ locale: 'de' }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
  });

  it('no prefix for unspecified paths (non-slug) with no localePaths', () => {
    expect(createPath(body({ locale: 'en' }), tpl('/posts'))).toBe('/posts');
  });
});

describe('createPath: localePaths map', () => {
  it('locale undefined falls back to { default: "" } → no prefix', () => {
    expect(createPath(body({ locale: undefined }), tpl(SLUG_PATH), { default: '' })).toBe(
      SLUG_PATH,
    );
  });

  it('{ nl: "", en: "/en" }, locale "nl" → no prefix', () => {
    expect(createPath(body({ locale: 'nl' }), tpl(SLUG_PATH), { nl: '', en: '/en' })).toBe(
      SLUG_PATH,
    );
  });

  it('{ nl: "", en: "/en" }, locale "en" → /en prefix', () => {
    expect(createPath(body({ locale: 'en' }), tpl(SLUG_PATH), { nl: '', en: '/en' })).toBe(
      '/en' + SLUG_PATH,
    );
  });

  it('{ nl: "", en: "/en", de: "/de" }, locale "de" → /de prefix', () => {
    expect(
      createPath(body({ locale: 'de' }), tpl(SLUG_PATH), {
        nl: '',
        en: '/en',
        de: '/de',
      }),
    ).toBe('/de' + SLUG_PATH);
  });

  it('unlisted locale falls back to the default prefix', () => {
    expect(
      createPath(body({ locale: 'fr' }), tpl(SLUG_PATH), {
        nl: '',
        en: '/en',
        default: '/x',
      }),
    ).toBe('/x' + SLUG_PATH);
  });

  it('unlisted locale with no default → empty prefix (no prefix)', () => {
    expect(createPath(body({ locale: 'fr' }), tpl(SLUG_PATH), { nl: '', en: '/en' })).toBe(
      SLUG_PATH,
    );
  });
});

describe('createPath: {slug} substitution (unchanged)', () => {
  it('substitutes {slug} when unencrypted and slug present (no prefix)', () => {
    expect(createPath(body({ slug: 'hello-world' }), tpl(SLUG_PATH))).toBe('/hello-world/');
  });

  it('substitutes {slug} together with a locale prefix', () => {
    expect(
      createPath(body({ locale: 'en', slug: 'hi' }), tpl(SLUG_PATH), {
        nl: '',
        en: '/en',
      }),
    ).toBe('/en/hi/');
  });

  it('does NOT substitute {slug} when body.encryption is true', () => {
    expect(createPath(body({ encryption: true, slug: 'secret' }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
  });

  it('does NOT substitute when slug is missing', () => {
    expect(createPath(body({ slug: undefined }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
  });
});

// ============================================================================
// sortCollection unit tests — optional per-collection `sortBy`.
//
// Semantics: 'position' -> ascending numeric; 'creationDate'/'modifiedDate' ->
// ascending by Date.parse; 'title' or absent -> ascending alphabetical by
// title. Missing/null/non-parseable fields sort LAST. Never mutates input.
// ============================================================================

const items = [
  {
    id: 'p3',
    title: 'Charlie',
    position: '30',
    creationDate: '2026-08-01',
    modifiedDate: '2026-08-10',
  },
  {
    id: 'p1',
    title: 'Alpha',
    position: '10',
    creationDate: '2026-08-03',
    modifiedDate: '2026-08-08',
  },
  {
    id: 'p2',
    title: 'Bravo',
    position: '20',
    creationDate: '2026-08-02',
    modifiedDate: '2026-08-09',
  },
];

const ids = (result: any[]) => result.map((i) => i.id);

describe('sortCollection: position', () => {
  it('sorts ascending by numeric position', () => {
    expect(ids(sortCollection(items, { slug: 'x', sortBy: 'position' }))).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = items.slice();
    sortCollection(input, { slug: 'x', sortBy: 'position' });
    expect(input.map((i) => i.id)).toEqual(['p3', 'p1', 'p2']);
  });
});

describe('sortCollection: creationDate / modifiedDate', () => {
  it('sorts ascending by creationDate', () => {
    expect(ids(sortCollection(items, { slug: 'x', sortBy: 'creationDate' }))).toEqual([
      'p3',
      'p2',
      'p1',
    ]);
  });

  it('sorts ascending by modifiedDate', () => {
    expect(ids(sortCollection(items, { slug: 'x', sortBy: 'modifiedDate' }))).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });
});

describe('sortCollection: title', () => {
  it('defaults to alphabetical by title when sortBy is absent', () => {
    expect(ids(sortCollection(items, { slug: 'x' }))).toEqual(['p1', 'p2', 'p3']);
  });

  it('sorts alphabetically by title for explicit sortBy "title"', () => {
    expect(ids(sortCollection(items, { slug: 'x', sortBy: 'title' }))).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('sortCollection: defensive missing/null fields', () => {
  it('sorts items with missing/null sort fields LAST', () => {
    const withMissing = [
      { id: 'has', title: 'Zulu', position: '99', creationDate: '2026-08-05' },
      { id: 'noPos', title: 'Alpha', position: null },
      { id: 'noTitle', title: null, position: '1' },
      { id: 'noDate', title: 'Bravo', creationDate: 'not-a-date' },
    ];
    // position: valid keys first in ascending order -> noTitle(1), has(99);
    // then missing-position items last (stable input order: noPos, noDate)
    expect(ids(sortCollection(withMissing, { slug: 'x', sortBy: 'position' }))).toEqual([
      'noTitle',
      'has',
      'noPos',
      'noDate',
    ]);
    // title default: null title sorts last
    expect(ids(sortCollection(withMissing, { slug: 'x' }))).toEqual([
      'noPos',
      'noDate',
      'has',
      'noTitle',
    ]);
    // creationDate: 'has' parses, the rest are unparseable/missing -> last
    // (stable input order among the undefined group)
    expect(ids(sortCollection(withMissing, { slug: 'x', sortBy: 'creationDate' }))).toEqual([
      'has',
      'noPos',
      'noTitle',
      'noDate',
    ]);
  });

  it('treats empty-string position as missing (sorts last)', () => {
    const emptyPos = [
      { id: 'a', title: 'Alpha', position: '1' },
      { id: 'b', title: 'Beta', position: '' },
      { id: 'c', title: 'Gamma', position: '2' },
    ];
    expect(ids(sortCollection(emptyPos, { slug: 'x', sortBy: 'position' }))).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('handles null/undefined items defensively without throwing', () => {
    const mixed = [
      null,
      { id: 'b', title: 'Beta', position: '2' },
      undefined,
      { id: 'a', title: 'Alpha', position: '1' },
    ];
    const survivor = sortCollection(mixed, { slug: 'x', sortBy: 'position' });
    expect(survivor.length).toBe(4);
    expect(survivor.filter(Boolean).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

// ============================================================================
// bodiesFromReconcile — the read-path reconcile wiring (pure).
//
// Assembles the deal-ordered body list from a reconcile() result: archive
// bodies (`fresh`) plus freshly-fetched drift bodies (`fetched`, same order as
// `needsFetch`). Emits in deal order so filterCollection/sortCollection see
// byte-identical input to the no-archive `fetchByPublication` path.
// ============================================================================

const mkEntry = (genesis: string, cid: string) => ({
  genesis,
  author: '0xauthor',
  cid,
  timestamp: 1,
});
const mkBody = (genesis: string) => ({
  id: genesis,
  title: `t-${genesis}`,
  content: `c-${genesis}`,
  encryption: false,
});

/** A schema-valid canonical content item (plain by default; encrypted on demand). */
const mkItem = (genesis: string, opts?: { encryption?: boolean }) => ({
  public: {
    specVersion: '1',
    author: ('did:ethr:0x' + 'a'.repeat(40)) as `did:ethr:0x${string}`,
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '0',
    publication: 'pub',
    locale: 'en',
    createdAt: 1234,
    base: '',
    tags: [],
    attributes: {},
    plaintextHash: '0x' + '0'.repeat(64),
  },
  objectId: '0x' + '1'.repeat(64),
  proof: {
    type: 'eip712',
    signer: ('0x' + 'b'.repeat(40)) as `0x${string}`,
    signature: ('0x' + '2'.repeat(130)) as `0x${string}`,
  },
  encryption: opts?.encryption ?? false,
  body: opts?.encryption
    ? `ciphertext-${genesis}`
    : JSON.stringify({
        title: `title-${genesis}`,
        slug: `slug-${genesis}`,
        content: `content-${genesis}`,
      }),
});

describe('bodiesFromReconcile', () => {
  it('emits bodies in deal order, mixing fresh archive bodies and fetched drift', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2'), mkEntry('g3', 'cid3')];
    const fresh = new Map<string, any>([
      ['g1', mkBody('g1')], // archive body, fresh
      ['g3', mkBody('g3')], // archive body, fresh
    ]);
    const needsFetch = [deals[1]]; // g2 was stale/miss → refetched
    const fetched = [mkBody('g2')];

    const bodies = bodiesFromReconcile(deals, fresh, needsFetch, fetched);
    expect(bodies.map((b) => b.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('skips fetched bodies that failed to fetch (null), keeping deal order', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    const fresh = new Map<string, any>([['g1', mkBody('g1')]]);
    const needsFetch = [deals[1]];
    const fetched = [null]; // cat/toBody failed for g2

    const bodies = bodiesFromReconcile(deals, fresh, needsFetch, fetched);
    expect(bodies.map((b) => b.id)).toEqual(['g1']);
  });

  it('drops a genesis absent from both fresh and fetched (deal-set floor)', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    // g2 has no archive body and its fetch failed → absent from the output
    const bodies = bodiesFromReconcile(deals, new Map(), [deals[1]], [null]);
    expect(bodies.map((b) => b.id)).toEqual([]);
  });

  it('returns an empty array for no deals', () => {
    expect(bodiesFromReconcile([], new Map(), [], [])).toEqual([]);
  });
});

// ============================================================================
// fetchCollections: archive cat-failure fallback (Fix 1).
//
// When the pointer is set but the archive blob can't be catted (gateway
// hiccup, IPFS GC, unpinned), the render must NOT fail — it degrades to the
// exact no-archive path (fetchByPublication = today's N cats).
// ============================================================================

describe('fetchCollections: archive cat-failure fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to fetchByPublication when the archive cat fails', async () => {
    (catFile as any).mockRejectedValue(new Error('gateway down'));
    (getDeals as any).mockResolvedValue([mkEntry('g1', 'cid1')]);
    const fallbackBody = { id: 'g1', title: 'T', content: 'C', encryption: false };
    (fetchByPublication as any).mockResolvedValue([fallbackBody]);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    // archive cat was attempted, then degraded to the exact no-archive path
    expect(catFile).toHaveBeenCalledWith('gateway', 'archiveCid');
    expect(fetchByPublication).toHaveBeenCalledWith('module', ['rpc'], 'gateway');
    // cat-first ordering: a failed cat never wastes the getDeals RPC
    expect(getDeals).not.toHaveBeenCalled();
    // same filter/sort pipeline as the no-archive path
    expect(result.collections.posts).toEqual([fallbackBody]);
  });
});

// ============================================================================
// shouldWriteBackCache — the T4 drift-gating decision (pure).
//
// A write fires only when ALL hold: maintainCache === true (undefined is
// falsy — the zod field has no .default(false)), not preview, and the read
// path observed drift (archive used + needsFetch non-empty). Steady state
// (drift === 0) and the no-archive path perform zero writes.
// ============================================================================

const mkDrift = (needsFetch: string[] = []): CollectionsDrift => ({
  deals: needsFetch.map((g) => mkEntry(g, `cid-${g}`)),
  needsFetch: needsFetch.map((g) => mkEntry(g, `cid-${g}`)),
  fetchedItems: new Map(),
});

describe('shouldWriteBackCache', () => {
  it('fires when maintainCache === true, not preview, and drift > 0', () => {
    expect(shouldWriteBackCache(true, false, mkDrift(['g1']))).toBe(true);
  });

  it('treats undefined maintainCache as falsy (zod has no .default(false))', () => {
    expect(shouldWriteBackCache(undefined, false, mkDrift(['g1']))).toBe(false);
    expect(shouldWriteBackCache(false, false, mkDrift(['g1']))).toBe(false);
  });

  it('never fires when preview is explicitly true', () => {
    expect(shouldWriteBackCache(true, true, mkDrift(['g1']))).toBe(false);
  });

  it('treats undefined preview as not-preview (live render) — write-back fires', () => {
    expect(shouldWriteBackCache(true, undefined, mkDrift(['g1']))).toBe(true);
  });

  it('never fires when drift is null (no archive path used)', () => {
    expect(shouldWriteBackCache(true, false, null)).toBe(false);
  });

  it('never fires on steady state (drift === 0 → zero writes)', () => {
    expect(shouldWriteBackCache(true, false, mkDrift([]))).toBe(false);
  });
});

// ============================================================================
// fetchCollections: archive drift tracking (T4 write-back input).
//
// The read path surfaces the drift it observed — deals, needsFetch and the
// FULL fetched items — so the write-back can merge them into the next archive
// snapshot. Behavior of the collections output itself is unchanged.
// ============================================================================

describe('fetchCollections: archive drift tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces deals, needsFetch and fetchedItems when the archive path is used', async () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    const archive = JSON.stringify({
      format: 's2s-publication-archive/2',
      publication: 'pub',
      built: '2026-01-01T00:00:00.000Z',
      items: { g1: { cid: 'cid1', item: mkItem('g1') } }, // g1 fresh; g2 miss
    });
    const g2Item = mkItem('g2');

    (catFile as any)
      .mockResolvedValueOnce(archive) // archive cat
      .mockResolvedValueOnce(JSON.stringify(g2Item)); // drift refetch of g2
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    // read path unchanged: bodies in deal order, both items present
    expect(result.collections.posts.map((b: any) => b.id)).toEqual(['g1', 'g2']);
    // drift surfaced for the write-back
    expect(result.drift).not.toBeNull();
    expect(result.drift!.deals).toEqual(deals);
    expect(result.drift!.needsFetch.map((e) => e.genesis)).toEqual(['g2']);
    expect(result.drift!.fetchedItems.get('g2')).toEqual(g2Item);
  });

  it('returns drift null when no archive pointer is set (no-archive path)', async () => {
    (fetchByPublication as any).mockResolvedValue([
      { id: 'g1', title: 'T', content: 'C', encryption: false },
    ]);
    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', undefined);
    expect(result.drift).toBeNull();
    expect(result.collections.posts.map((b: any) => b.id)).toEqual(['g1']);
  });

  it('returns drift null when the archive cat fails (no-archive fallback)', async () => {
    (catFile as any).mockRejectedValue(new Error('gateway down'));
    (getDeals as any).mockResolvedValue([mkEntry('g1', 'cid1')]);
    const fallbackBody = { id: 'g1', title: 'T', content: 'C', encryption: false };
    (fetchByPublication as any).mockResolvedValue([fallbackBody]);
    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');
    expect(result.drift).toBeNull();
    expect(result.collections.posts).toEqual([fallbackBody]);
  });
});
