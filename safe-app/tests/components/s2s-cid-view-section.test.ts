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
import type { CidViewReadContext } from '@s2s/soul2soul-shared/safe-app';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-cid-view-section';

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
  // browser test stays light).
  const real = await import('../../../shared/src/cid-view/coordinator.ts');
  realBuild.fn = real.buildPublicationCidView;
  return { buildPublicationCidView: buildSpy };
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
      { genesis: '0xgen1', author: '0xAuthor1', cid: 'bafydeal1', timestamp: 1700000000, status: 'deal' },
    ],
    getOffers: async () => [
      { genesis: '0xgen2', author: '0xAuthor2', cid: 'bafyoffer1', timestamp: 1700002000, status: 'offer' },
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
  });

  afterEach(() => {
    buildSpy.mockReset();
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
});
