import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { Wallet, TypedDataEncoder, keccak256, recoverAddress, toUtf8Bytes } from 'ethers';
import {
  createPath,
  sortCollection,
  bodiesFromReconcile,
  fetchCollections,
  initTemplateData,
  verifyDecrypted,
  shouldWriteBackCache,
  type CollectionsDrift,
} from './data.ctrlr';
import { decryptRaw } from '../libs/decrypt';
import { catFile } from '../libs/ipfs.factory';
import {
  fetchByPublication,
  fetchByPublicationWithSkips,
  fetchByPublicationDetailed,
  getDeals,
  getLatestEntry,
  toBody,
} from '../libs/module.factory';
import { jcs, type S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { buildSigningView } from '../../../../shared/dist/manuscript/identity/signing-view';
import { S2S_DOMAIN, S2S_TYPES, toDidEthr } from '../../../../shared/dist/manuscript/types';

// The ambient ethers v5 global a Lit Action provides; stub the two functions
// the integrity verdict uses (identical EIP-712/ecrecover semantics in v6).
beforeAll(() => {
  vi.stubGlobal('ethers', {
    utils: { _TypedDataEncoder: { hash: TypedDataEncoder.hash }, recoverAddress },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// Mock the I/O boundaries so fetchCollections' archive path can be exercised
// without a chain/IPFS. The pure helpers above (createPath, sortCollection,
// bodiesFromReconcile) don't touch these, so the mocks are inert for them.
vi.mock('../libs/ipfs.factory', () => ({
  catFile: vi.fn(),
}));

// The Lit decrypt call is an I/O boundary; the post-decryption gate itself is
// pure and is what these tests pin.
vi.mock('../libs/decrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/decrypt')>();
  return { ...actual, decryptRaw: vi.fn(), decrypt: vi.fn() };
});

vi.mock('../libs/module.factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/module.factory')>();
  return {
    ...actual,
    getDeals: vi.fn(),
    getLatestEntry: vi.fn(),
    fetchByPublication: vi.fn(),
    fetchByPublicationWithSkips: vi.fn(),
    fetchByPublicationDetailed: vi.fn(),
  };
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

const AUTHOR = new Wallet('0x' + '11'.repeat(32));
const ATTACKER = new Wallet('0x' + '22'.repeat(32));

const mkEntry = (genesis: string, cid: string, author: string = AUTHOR.address) => ({
  genesis,
  author, // getDeals() returns a plain address, NOT a did:ethr
  cid,
  timestamp: 1,
});
const mkBody = (genesis: string) => ({
  id: genesis,
  title: `t-${genesis}`,
  content: `c-${genesis}`,
  encryption: false,
});

const bodyObject = (genesis: string) => ({
  title: `title-${genesis}`,
  slug: `slug-${genesis}`,
  content: `content-${genesis}`,
});

/** Honest plaintext body bytes for a genesis (what plaintextHash is taken over). */
const plainBody = (genesis: string): string => jcs(bodyObject(genesis));

const hashOf = (body: string): string => keccak256(toUtf8Bytes(body));

interface ItemOpts {
  encryption?: boolean;
  /** Mint with a different signing key (records ITS address as author). */
  signer?: Wallet;
  /** Override the author identity in `public` (defaults to the signer's). */
  author?: string;
  /** Replace the body AFTER minting (the forged-body lever). */
  body?: string;
  /** Override public.plaintextHash; `null` removes it (specVersion item ⇒ refused). */
  plaintextHash?: string | null;
  /** Also drop specVersion (true legacy item: author-bound only). */
  legacy?: boolean;
}

/**
 * Mint a genuine item the way buildSignedContentItem does (JCS body →
 * plaintextHash → EIP-712 digest/objectId → real signature), then apply the
 * tampering lever. A hand-shaped item would not exercise the real checks.
 */
const mkItem = (genesis: string, opts?: ItemOpts) => {
  const signer = opts?.signer ?? AUTHOR;
  const encryption = opts?.encryption ?? false;
  const body = encryption ? `ciphertext-${genesis}` : plainBody(genesis);
  const plaintextHash = hashOf(jcs(bodyObject(genesis)));

  const pub: Record<string, unknown> = {
    specVersion: '1',
    author: opts?.author ?? toDidEthr(signer.address),
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
    plaintextHash,
  };
  const digest = TypedDataEncoder.hash(
    S2S_DOMAIN as any,
    S2S_TYPES as any,
    buildSigningView(pub as any),
  );

  const item: Record<string, any> = {
    public: pub,
    objectId: digest,
    proof: {
      type: 'eip712',
      signer: signer.address,
      signature: signer.signingKey.sign(digest).serialized,
    },
    encryption,
    body,
  };

  if (opts?.plaintextHash === null) delete item.public.plaintextHash;
  else if (opts?.plaintextHash !== undefined) item.public.plaintextHash = opts.plaintextHash;
  if (opts?.legacy) {
    delete item.public.specVersion;
    delete item.public.plaintextHash;
  }
  if (opts?.body !== undefined) item.body = opts.body;

  return item as unknown as S2SContentItem;
};

// ============================================================================
// initTemplateData: post-decryption integrity gate.
//
// The stored encrypted body is ciphertext, so nothing can be checked at rest.
// The decryptor's RAW STRING is hashed against the author-signed plaintextHash
// (verifyDecrypted → module.factory.verifyDecryptedBody, the same function the
// collection path in render/main.ts uses). Mismatch fails the job; a decryptor
// that returns a parsed object falls back to JCS re-canonicalisation (weaker:
// semantic, not byte, equivalence) and must WARN, never throw.
// ============================================================================

const PLAIN = plainBody('g1');
const PARSED = JSON.parse(PLAIN) as Record<string, unknown>;

const decryptedRaw = (raw: string) => ({
  raw,
  parsed: JSON.parse(raw),
  rawFromDecryptor: true,
});
const decryptedParsed = (parsed: unknown) => ({
  raw: JSON.stringify(parsed), // best effort only, and deliberately not signed
  parsed: parsed as Record<string, unknown>,
  rawFromDecryptor: false,
});

const encBody = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'g1',
    author: toDidEthr(AUTHOR.address),
    locale: 'en',
    parent: '',
    position: '',
    postType: 'post',
    creationDate: '2026-08-13',
    modifiedDate: '2026-08-13',
    tags: [],
    publication: 'pub',
    encryption: true,
    content: 'ciphertext-g1',
    plaintextHash: hashOf(PLAIN),
    ...overrides,
  }) as any;

const renderTpl = { reference: 'post', file: 'post', path: '/{slug}/' } as any;

const runInit = (body: any) =>
  initTemplateData(
    { pkp: 'pkp', gateway: 'gateway' } as any,
    AUTHOR.address,
    AUTHOR.address,
    renderTpl,
    body,
    'module',
    ['rpc'],
  );

describe('initTemplateData: post-decryption integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies the decryptor’s RAW string and does ZERO extra reads (hash rides on toBody)', async () => {
    (decryptRaw as any).mockResolvedValue(decryptedRaw(PLAIN));

    const data = await runInit(encBody());

    expect(data.content).toBe('content-g1');
    expect(data.revoked).toBe(false);
    // the hash was already on the flat body — no getLatestEntry, no extra cat
    expect(getLatestEntry).not.toHaveBeenCalled();
    expect(catFile).not.toHaveBeenCalled();
  });

  it('FAILS THE JOB when the decrypted raw string does not hash to plaintextHash', async () => {
    (decryptRaw as any).mockResolvedValue(decryptedRaw(PWNED_BODY));

    await expect(runInit(encBody())).rejects.toThrow(/body integrity: decrypted content/);
  });

  it('PARSED-object decryptor: falls back to JCS, renders, and warns instead of throwing', async () => {
    (decryptRaw as any).mockResolvedValue(decryptedParsed(PARSED));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const data = await runInit(encBody({ id: 'g-parsed' }));

    expect(data.content).toBe('content-g1');
    expect(data.revoked).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('verified by JCS'))).toBe(true);
    warn.mockRestore();
  });

  it('PARSED-object decryptor whose value does not match still fails the job', async () => {
    (decryptRaw as any).mockResolvedValue(decryptedParsed(JSON.parse(PWNED_BODY)));

    await expect(runInit(encBody())).rejects.toThrow(/body integrity: decrypted content/);
  });

  it('resolves the hash from the on-chain cid when the flat body lacks it (the only extra-read path)', async () => {
    const item = mkItem('g1', { encryption: true });
    // The fallback is pinned to the body's OWN deal cid: if the deal advanced
    // mid-render, the chain's hash belongs to the NEXT version and must not be
    // compared against this body.
    (decryptRaw as any).mockResolvedValue(decryptedRaw(PLAIN));
    (getLatestEntry as any).mockResolvedValue(mkEntry('g1', 'cid1'));
    (catFile as any).mockResolvedValue(JSON.stringify(item));

    const data = await runInit(encBody({ plaintextHash: undefined, cid: 'cid1' }));

    expect(data.content).toBe('content-g1');
    // this IS the documented fallback: one RPC + one cat
    expect(getLatestEntry).toHaveBeenCalledWith('g1', 'module', ['rpc']);
    expect(catFile).toHaveBeenCalledWith('gateway', 'cid1');
  });

  it('refuses the chain fallback when the deal advanced past the rendered cid', async () => {
    // The chain's hash belongs to the NEXT version of the content. Comparing it
    // against THIS body would fail a good body (or validate it against a hash it
    // was never signed under), so the fallback refuses and the page renders
    // unverified instead.
    (decryptRaw as any).mockResolvedValue(decryptedRaw(PLAIN));
    (getLatestEntry as any).mockResolvedValue(mkEntry('g1', 'cid2'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const data = await runInit(encBody({ plaintextHash: undefined, cid: 'cid1' }));

    expect(data.content).toBe('content-g1');
    expect(catFile).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('deal advanced'))).toBe(true);
    warn.mockRestore();
  });

  it('an UNRESOLVABLE hash warns and renders unverified (never silently pretends, never throws)', async () => {
    (decryptRaw as any).mockResolvedValue(decryptedRaw(PLAIN));
    (getLatestEntry as any).mockRejectedValue(new Error('rpc down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const data = await runInit(encBody({ plaintextHash: undefined }));

    expect(data.content).toBe('content-g1');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('could not be verified'))).toBe(true);
    warn.mockRestore();
  });

  it('verifyDecrypted buckets: verified / weak / legacy / mismatch', () => {
    const hash = hashOf(PLAIN);
    expect(verifyDecrypted(decryptedRaw(PLAIN), hash)).toBe('verified');
    expect(verifyDecrypted(decryptedRaw(PWNED_BODY), hash)).toBe('mismatch');
    expect(verifyDecrypted(decryptedParsed(PARSED), hash)).toBe('weak');
    expect(verifyDecrypted(decryptedParsed(JSON.parse(PWNED_BODY)), hash)).toBe('mismatch');
    expect(verifyDecrypted(decryptedRaw(PLAIN), null)).toBe('legacy');
  });
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

  it('falls back to fetchByPublicationWithSkips when the archive cat fails', async () => {
    (catFile as any).mockRejectedValue(new Error('gateway down'));
    (getDeals as any).mockResolvedValue([mkEntry('g1', 'cid1')]);
    const fallbackBody = { id: 'g1', title: 'T', content: 'C', encryption: false };
    (fetchByPublicationWithSkips as any).mockResolvedValue({ bodies: [fallbackBody], skips: [] });

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    // archive cat was attempted, then degraded to the exact no-archive path
    expect(catFile).toHaveBeenCalledWith('gateway', 'archiveCid');
    expect(fetchByPublicationWithSkips).toHaveBeenCalledWith('module', ['rpc'], 'gateway');
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

  it('bootstrap: no archive pointer → non-null drift (all deals as needsFetch, items keyed by genesis)', async () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    const g1Item = mkItem('g1');
    const g2Item = mkItem('g2');
    // The no-archive bootstrap path asks the detailed single-pass fetcher for
    // bodies + the full items + the deal entries; stub it as a clean unit so
    // the drift constructed from its return is exercised in isolation.
    (fetchByPublicationDetailed as any).mockResolvedValue({
      bodies: [mkBody('g1'), mkBody('g2')],
      items: new Map([
        ['g1', g1Item],
        ['g2', g2Item],
      ]),
      entries: deals,
    });

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', undefined);

    // bodies built in the same single pass (one detailed call, no second fetch).
    expect(result.collections.posts.map((b: any) => b.id)).toEqual(['g1', 'g2']);
    expect(fetchByPublicationDetailed).toHaveBeenCalledTimes(1);
    expect(fetchByPublicationWithSkips).not.toHaveBeenCalled();

    // bootstrap drift: non-null, needsFetch = all entries, items keyed by genesis.
    expect(result.drift).not.toBeNull();
    expect(result.drift!.deals).toEqual(deals);
    expect(result.drift!.needsFetch).toEqual(deals);
    expect(result.drift!.fetchedItems.get('g1')).toEqual(g1Item);
    expect(result.drift!.fetchedItems.get('g2')).toEqual(g2Item);
  });

  it('bootstrap drift triggers shouldWriteBackCache for the maintainer (maintainCache && !preview)', () => {
    const deals = [mkEntry('g1', 'cid1')];
    const bootstrapDrift: CollectionsDrift = {
      deals,
      needsFetch: deals,
      fetchedItems: new Map<string, S2SContentItem>([['g1', mkItem('g1') as S2SContentItem]]),
    };
    expect(shouldWriteBackCache(true, false, bootstrapDrift)).toBe(true);
    // a maintainer whose bootstrap saw NO deals (needsFetch empty) stays read-only
    expect(
      shouldWriteBackCache(true, false, { deals: [], needsFetch: [], fetchedItems: new Map() }),
    ).toBe(false);
  });

  it('returns drift null when the archive cat fails (no-archive fallback)', async () => {
    (catFile as any).mockRejectedValue(new Error('gateway down'));
    (getDeals as any).mockResolvedValue([mkEntry('g1', 'cid1')]);
    const fallbackBody = { id: 'g1', title: 'T', content: 'C', encryption: false };
    (fetchByPublicationWithSkips as any).mockResolvedValue({ bodies: [fallbackBody], skips: [] });
    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');
    expect(result.drift).toBeNull();
    expect(result.skips).toEqual([]);
    expect(result.collections.posts).toEqual([fallbackBody]);
  });
});

// ============================================================================
// fetchCollections: archive read-path integrity (plaintextHash).
//
// The archive stores re-serialised items, so a stored item's cid can never be
// re-verified by hashing it — the author-signed `public.plaintextHash` is the
// substitute. Whoever can write the ENS cache pointer could otherwise serve a
// schema-valid item claiming a REAL deal cid while carrying a fake body, and it
// would render. Every served plaintext item is hash-checked; a mismatch is
// refetched from the content-addressed on-chain cid and, if that also
// mismatches, surfaced as a non-fatal skip (never a dropped page).
// ============================================================================

const mkArchiveJson = (items: Record<string, { cid: string; item: unknown }>) =>
  JSON.stringify({
    format: 's2s-publication-archive/2',
    publication: 'pub',
    built: '2026-01-01T00:00:00.000Z',
    items,
  });

const PWNED_BODY = jcs({ title: 'pwned', slug: 'pwned', content: 'pwned' });

/** Real deal cid, FAKE body, honest `public` block (so only the hash check catches it). */
const forgedItem = (genesis: string) => mkItem(genesis, { body: PWNED_BODY });

/** Whole-item forgery: the attacker's OWN public block (author, hash, proof, objectId). */
const forgedWholeItem = (genesis: string) =>
  mkItem(genesis, { signer: ATTACKER, body: PWNED_BODY });

describe('fetchCollections: archive read-path integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT serve a forged archive item and refetches it from the on-chain cid', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    const honest = mkItem('g1');
    (catFile as any)
      .mockResolvedValueOnce(mkArchiveJson({ g1: { cid: 'cid1', item: forgedItem('g1') } }))
      .mockResolvedValueOnce(JSON.stringify(honest)); // drift refetch of the REAL cid
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    // the forged body never reaches the template data …
    expect(result.collections.posts.map((b: any) => b.title)).toEqual(['title-g1']);
    expect(JSON.stringify(result.collections.posts)).not.toContain('pwned');
    // … the forged entry is treated as MISS and the real cid was catted …
    expect(catFile).toHaveBeenCalledWith('gateway', 'cid1');
    expect(result.drift!.needsFetch.map((e) => e.genesis)).toEqual(['g1']);
    // … the write-back stores the HONEST refetched item, not the forged one.
    expect(result.drift!.fetchedItems.get('g1')).toEqual(honest);
    // tamper evidence reaches the caller: the refused archive entry is reported
    // (non-fatal — the page is served from the refetch)
    expect(result.skips).toHaveLength(1);
    expect(result.skips[0].reason).toMatch(/^integrity\(hash-mismatch\): /);
    // same failure taxonomy as the direct read path
    expect(result.skips[0].cause).toBe('integrity');
    expect(result.collections.posts).toHaveLength(1);
  });

  it('does NOT serve a WHOLE-ITEM forgery (attacker’s own public block) — refetched too', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    const honest = mkItem('g1');
    (catFile as any)
      .mockResolvedValueOnce(mkArchiveJson({ g1: { cid: 'cid1', item: forgedWholeItem('g1') } }))
      .mockResolvedValueOnce(JSON.stringify(honest));
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    // internally self-consistent (own hash + own valid signature) and still refused,
    // because the on-chain deal author is somebody else
    expect(JSON.stringify(result.collections.posts)).not.toContain('pwned');
    expect(result.collections.posts.map((b: any) => b.title)).toEqual(['title-g1']);
    expect(result.skips[0].reason).toMatch(/^integrity\(author-mismatch\): /);
  });

  it('refetched item that ALSO mismatches produces a non-fatal skip with a reason (never renders it)', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    (catFile as any)
      .mockResolvedValueOnce(mkArchiveJson({ g1: { cid: 'cid1', item: forgedItem('g1') } }))
      .mockResolvedValueOnce(JSON.stringify(forgedItem('g1'))); // refetch is forged too
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    expect(result.collections.posts).toEqual([]);
    // two entries: the archive item was refused, and the refetched bytes were refused
    expect(result.skips).toHaveLength(2);
    expect(result.skips[0].reason).toMatch(/^integrity\(hash-mismatch\): /);
    expect(result.skips[1]).toMatchObject({ genesis: 'g1', cid: 'cid1' });
    expect(result.skips[1].reason).toMatch(/^integrity\(hash-mismatch\): refetched item rejected/);
    expect(result.skips[1].cause).toBe('integrity');
    // a mismatching refetch is NEVER cached into the next archive snapshot
    expect(result.drift!.fetchedItems.has('g1')).toBe(false);
  });

  it('a refetched item that is not a content item at all is reported distinctly (not "retrieval failed")', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    (catFile as any)
      .mockResolvedValueOnce(mkArchiveJson({})) // archive has nothing for g1
      .mockResolvedValueOnce('{"not":"an item"}');
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    expect(result.collections.posts).toEqual([]);
    expect(result.skips).toHaveLength(1);
    expect(result.skips[0].reason).toMatch(
      /^unavailable: refetched item rejected: refetched content is not a valid content item/,
    );
    expect(result.skips[0].reason).not.toMatch(/retrieval failed/);
    // a malformed item is "could not be read", NOT "signed and then altered"
    expect(result.skips[0].cause).toBe('unavailable');
    expect(result.drift!.fetchedItems.has('g1')).toBe(false);
  });

  it('serves an honest archive item through toBody (identity fields follow the deal)', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    const honest = mkItem('g1');
    (catFile as any).mockResolvedValueOnce(mkArchiveJson({ g1: { cid: 'cid1', item: honest } }));
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    // archive-served bodies go through toBody(deal, item) — same shape as the
    // cold path (whatever identity fields toBody emits ride along automatically).
    expect(result.collections.posts).toEqual([toBody(deals[0] as any, honest)]);
    expect(result.drift!.needsFetch).toEqual([]);
    expect(result.skips).toEqual([]);
  });

  it('does NOT reject an encrypted archive item (ciphertext body — checked after decryption)', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    const enc = mkItem('g1', { encryption: true });
    (catFile as any).mockResolvedValueOnce(mkArchiveJson({ g1: { cid: 'cid1', item: enc } }));
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    expect(result.collections.posts).toEqual([toBody(deals[0] as any, enc)]);
    expect(result.collections.posts[0].encryption).toBe(true);
    expect(result.drift!.needsFetch).toEqual([]);
    expect(result.skips).toEqual([]);
    // no drift refetch: only the archive cat happened
    expect(catFile).toHaveBeenCalledTimes(1);
  });

  it('serves a LEGACY archive item without plaintextHash (unverifiable, not invalid)', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    const legacy = mkItem('g1', { legacy: true });
    (catFile as any).mockResolvedValueOnce(mkArchiveJson({ g1: { cid: 'cid1', item: legacy } }));
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    expect(result.collections.posts.map((b: any) => b.title)).toEqual(['title-g1']);
    expect(result.drift!.needsFetch).toEqual([]);
    expect(result.skips).toEqual([]);
    // only the archive was catted — a legacy item is served, not refetched
    expect(catFile).toHaveBeenCalledTimes(1);
  });

  it('does NOT serve a specVersion item whose plaintextHash was stripped (refuses the opt-out)', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    const stripped = mkItem('g1', { plaintextHash: null });
    (catFile as any)
      .mockResolvedValueOnce(mkArchiveJson({ g1: { cid: 'cid1', item: stripped } }))
      .mockResolvedValueOnce(''); // refetch fails → nothing served
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    expect(result.collections.posts).toEqual([]);
    expect(result.skips[0].reason).toMatch(/^integrity\(hash-missing\): /);
  });

  it('binds an ENCRYPTED archive item to the author (the ciphertext itself is not checked)', async () => {
    const deals = [mkEntry('g1', 'cid1')];
    (catFile as any).mockResolvedValueOnce(
      mkArchiveJson({
        g1: { cid: 'cid1', item: mkItem('g1', { encryption: true, signer: ATTACKER }) },
      }),
    );
    (getDeals as any).mockResolvedValue(deals);

    const tpl = { collections: [{ slug: 'posts' }] } as any;
    const result = await fetchCollections(tpl, 'module', ['rpc'], 'gateway', 'archiveCid');

    expect(result.collections.posts).toEqual([]);
    expect(result.skips[0].reason).toMatch(/^integrity\(author-mismatch\): /);
  });
});
