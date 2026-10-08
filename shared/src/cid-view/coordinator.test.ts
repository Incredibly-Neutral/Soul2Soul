// cid-view coordinator tests — deterministic fake CidViewReadContext, no chain.
//
// Fixture summary (hand-computed):
//   deals   : 2 deals + 1 offer + full version history (1 tombstoned).
//             The current version cid == the deal/offer cid, so cross-collector
//             content dedupe folds each 'current version' into its deal/offer
//             entry → deals block = 7 entries (2 deal, 3 deal-version, 1 offer,
//             1 offer-version).
//   config  : configCid + template-dag + 2 templates + assets-root + 2 assets = 7
//   tree    : site-root + 2 site-files = 3
//   archive : archive + 2 archive-items = 3
//   TOTAL   = 20 entries, 20 unique cids.
import { describe, it, expect, vi } from 'vitest';
import { namehash } from 'viem/ens';
import type { CidViewReadContext } from './context';
import type { DealRead, VersionRead } from './types';
import { buildPublicationCidView } from './coordinator';
import { parsePublicationCidView } from './validation';
import { encodeContenthashWrapped, parseCID } from '../ipfs/contenthash';

const PUBLICATION = 's3ntiment.eth';
const NODE = namehash(PUBLICATION);

// Genesis ids (bytes32).
const G1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
const G2 = '0x2222222222222222222222222222222222222222222222222222222222222222';
const O1 = '0x3333333333333333333333333333333333333333333333333333333333333333';

// Deals ledger cids.
const D1C = 'QmD1C';
const D1V0 = 'QmD1V0';
const D2C = 'QmD2C';
const D2V0 = 'QmD2V0';
const D2V1 = 'QmD2V1';
const O1C = 'QmO1C';
const O1V0 = 'QmO1V0';

// Config cids.
const CCFG = 'QmConfig';
const TDAG = 'QmTemplateDag';
const TPL1 = 'QmTpl1';
const TPL2 = 'QmTpl2';
const AROOT = 'QmAssetsRoot';
const ADIR = 'QmImgDir';
const ASSET1 = 'QmStyle';
const ASSET2 = 'QmLogo';

// Site tree cids.
const SROOT = 'QmSiteRoot';
const SDIR = 'QmAssetsDir';
const SFILE1 = 'QmIndexHtml';
const SFILE2 = 'QmLogoPng';

// Archive cids.
const ACID = 'QmArchiveCid';
const ARCH1 = 'QmArchItem1';
const ARCH2 = 'QmArchItem2';

const rootContenthash = encodeContenthashWrapped(parseCID(SROOT));
const archiveContenthash = encodeContenthashWrapped(parseCID(ACID));

type LsEntry = { name: string; hash: string; size: number };

function fakeDeals(): DealRead[] {
  return [
    { genesis: G1, author: '0xaaa', cid: D1C, timestamp: 1000, status: 'deal' },
    { genesis: G2, author: '0xbbb', cid: D2C, timestamp: 2000, status: 'deal' },
  ];
}

function fakeOffers(): DealRead[] {
  return [{ genesis: O1, author: '0xccc', cid: O1C, timestamp: 3000, status: 'offer' }];
}

function fakeVersions(genesis: string): VersionRead[] {
  switch (genesis) {
    case G1:
      return [
        { cid: D1V0, timestamp: 900, tombstone: false },
        { cid: D1C, timestamp: 1000, tombstone: false },
      ];
    case G2:
      return [
        { cid: D2V0, timestamp: 1900, tombstone: true },
        { cid: D2V1, timestamp: 1950, tombstone: false },
        { cid: D2C, timestamp: 2000, tombstone: false },
      ];
    case O1:
      return [
        { cid: O1V0, timestamp: 2900, tombstone: false },
        { cid: O1C, timestamp: 3000, tombstone: false },
      ];
    default:
      return [];
  }
}

function archiveJson(extra: Record<string, { cid: string }> = {}): string {
  return JSON.stringify({
    format: 's2s-publication-archive/2',
    publication: PUBLICATION,
    built: '2026-10-08T00:00:00.000Z',
    items: {
      [G1]: { cid: ARCH1 },
      [G2]: { cid: ARCH2 },
      ...extra,
    },
  });
}

/** In-memory fake read context; overrides let a test inject failures/dupes. */
function makeCtx(overrides: Partial<CidViewReadContext> = {}): CidViewReadContext {
  return {
    getDeals: async () => fakeDeals(),
    getOffers: async () => fakeOffers(),
    getVersions: async (genesis: string) => fakeVersions(genesis),
    getConfig: async () => ({ cid: CCFG, config: { templateCid: TDAG, assetsCid: AROOT } }),
    dagGet: async () => [
      { path: 'templates/post.hbs', cid: TPL1 },
      { path: 'templates/about.hbs', cid: TPL2 },
    ],
    ls: async (cid: string): Promise<LsEntry[]> => {
      switch (cid) {
        case AROOT:
          return [
            { name: 'style.css', hash: ASSET1, size: 100 },
            { name: 'img', hash: ADIR, size: 0 },
          ];
        case ADIR:
          return [{ name: 'logo.png', hash: ASSET2, size: 50 }];
        case SROOT:
          return [
            { name: 'index.html', hash: SFILE1, size: 2000 },
            { name: 'assets', hash: SDIR, size: 0 },
          ];
        case SDIR:
          return [{ name: 'logo.png', hash: SFILE2, size: 500 }];
        default:
          return [];
      }
    },
    cat: async () => archiveJson(),
    getEnsText: async (node: string, key: string) => {
      if (node !== NODE) return '';
      if (key === 'contenthash_wrapped') return rootContenthash;
      if (key === `content_cache_${PUBLICATION}`) return archiveContenthash;
      return '';
    },
    ...overrides,
  };
}

describe('buildPublicationCidView', () => {
  it('merges all four sources in order, grouped by collector, with correct category/source', async () => {
    const view = await buildPublicationCidView(makeCtx(), PUBLICATION);

    expect(view.entries.map((e) => e.cid)).toEqual([
      // deals block
      D1C, D1V0, D2C, D2V0, D2V1, O1C, O1V0,
      // config block
      CCFG, TDAG, TPL1, TPL2, AROOT, ASSET1, ASSET2,
      // tree block
      SROOT, SFILE1, SFILE2,
      // archive block
      ACID, ARCH1, ARCH2,
    ]);

    const deal = view.entries.find((e) => e.cid === D1C);
    expect(deal).toMatchObject({
      category: 'deal',
      source: 'deals',
      genesis: G1,
      author: '0xaaa',
      timestamp: 1000,
    });

    const tombstoned = view.entries.find((e) => e.cid === D2V0);
    expect(tombstoned).toMatchObject({
      category: 'deal-version',
      source: 'deals',
      genesis: G2,
      tombstoned: true,
    });

    const template = view.entries.find((e) => e.cid === TPL1);
    expect(template).toMatchObject({
      category: 'template',
      source: 'config',
      path: 'templates/post.hbs',
      role: 'templates/post.hbs',
    });

    const asset = view.entries.find((e) => e.cid === ASSET2);
    expect(asset).toMatchObject({
      category: 'asset',
      source: 'config',
      path: 'img/logo.png',
      size: 50,
    });

    const siteFile = view.entries.find((e) => e.cid === SFILE1);
    expect(siteFile).toMatchObject({
      category: 'site-file',
      source: 'tree',
      path: 'index.html',
      size: 2000,
    });

    const archiveItem = view.entries.find((e) => e.cid === ARCH1);
    expect(archiveItem).toMatchObject({
      category: 'archive-item',
      source: 'archive',
      genesis: G1,
    });
  });

  it('cross-collector dedupe removes an exact duplicate (same cid+genesis as a deal and an archive-item)', async () => {
    // The archive references genesis G1 with the SAME content cid as deal G1.
    const ctx = makeCtx({ cat: async () => archiveJson({ [G1]: { cid: D1C } }) });
    const view = await buildPublicationCidView(ctx, PUBLICATION);

    // Listed once — folded into the deal entry (first occurrence), not repeated as an archive-item.
    expect(view.entries.filter((e) => e.cid === D1C)).toHaveLength(1);
    expect(view.entries.filter((e) => e.category === 'deal' && e.genesis === G1)).toHaveLength(1);
    expect(view.entries.filter((e) => e.category === 'archive-item' && e.genesis === G1)).toHaveLength(0);

    // 20 entries in the base fixture − 1 folded archive-item = 19; 19 unique cids.
    expect(view.summary.total).toBe(19);
    expect(view.summary.uniqueCids).toBe(19);
    expect(view.summary.byCategory['archive-item']).toBe(1);
  });

  it('computes summary.total / uniqueCids / byCategory correctly for the fixture', async () => {
    const view = await buildPublicationCidView(makeCtx(), PUBLICATION);

    expect(view.summary.total).toBe(20);
    expect(view.summary.uniqueCids).toBe(20);
    expect(view.summary.byCategory).toEqual({
      deal: 2,
      'deal-version': 3,
      offer: 1,
      'offer-version': 1,
      config: 1,
      'template-dag': 1,
      template: 2,
      'assets-root': 1,
      asset: 2,
      'site-root': 1,
      'site-file': 2,
      archive: 1,
      'archive-item': 2,
    });
  });

  it('flags all sources true when every collector contributes', async () => {
    const view = await buildPublicationCidView(makeCtx(), PUBLICATION);
    expect(view.sources).toEqual({ deals: true, config: true, tree: true, archive: true });
  });

  it('empty collectors → sources all false, total 0, uniqueCids 0', async () => {
    const empty = makeCtx({
      getDeals: async () => [],
      getOffers: async () => [],
      getVersions: async () => [],
      getConfig: async () => {
        throw new Error('no config');
      },
      dagGet: async () => {
        throw new Error('no dag');
      },
      ls: async () => {
        throw new Error('no ls');
      },
      cat: async () => {
        throw new Error('no cat');
      },
      getEnsText: async () => '',
    });

    const view = await buildPublicationCidView(empty, PUBLICATION);

    expect(view.entries).toEqual([]);
    expect(view.sources).toEqual({ deals: false, config: false, tree: false, archive: false });
    expect(view.summary.total).toBe(0);
    expect(view.summary.uniqueCids).toBe(0);
    expect(view.summary.byCategory).toEqual({});
  });

  it('output passes parsePublicationCidView (schema round-trips)', async () => {
    const view = await buildPublicationCidView(makeCtx(), PUBLICATION);
    const parsed = parsePublicationCidView(view);
    expect(parsed).toEqual(view);

    // A structurally-invalid view must throw (ZodError).
    expect(() => parsePublicationCidView({ ...view, entries: 'not-an-array' })).toThrow();
    expect(() => parsePublicationCidView({ ...view, summary: 'nope' })).toThrow();
    expect(() => parsePublicationCidView({ ...view, sources: { deals: true } })).toThrow();
  });

  it('`now` option overrides generatedAt', async () => {
    const fixed = new Date('2026-01-02T03:04:05.000Z');
    const view = await buildPublicationCidView(makeCtx(), PUBLICATION, { now: () => fixed });
    expect(view.generatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('fails open when a collector throws — still returns the other sources', async () => {
    const ctx = makeCtx({
      getConfig: async () => {
        throw new Error('config down');
      },
    });
    const view = await buildPublicationCidView(ctx, PUBLICATION);

    expect(view.sources.config).toBe(false);
    expect(view.sources.deals).toBe(true);
    expect(view.sources.tree).toBe(true);
    expect(view.sources.archive).toBe(true);
    expect(view.summary.total).toBe(13); // 7 deals + 3 tree + 3 archive
    expect(() => parsePublicationCidView(view)).not.toThrow();
  });

  it('spies used by collectors are called with the publication for tree/archive', async () => {
    const ensText = vi.fn(async (node: string, key: string) => {
      if (node === NODE && key === 'contenthash_wrapped') return rootContenthash;
      if (node === NODE && key === `content_cache_${PUBLICATION}`) return archiveContenthash;
      return '';
    });
    const view = await buildPublicationCidView(makeCtx({ getEnsText: ensText }), PUBLICATION);

    expect(ensText).toHaveBeenCalledWith(NODE, 'contenthash_wrapped');
    expect(ensText).toHaveBeenCalledWith(NODE, `content_cache_${PUBLICATION}`);
    expect(view.sources.tree).toBe(true);
    expect(view.sources.archive).toBe(true);
  });
});
