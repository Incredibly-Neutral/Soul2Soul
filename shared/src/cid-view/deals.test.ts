// cid-view deals collector tests — pure fake CidViewReadContext, no chain.
import { describe, it, expect } from 'vitest';
import type { DealRead, PublicationCidView, VersionRead } from './types';
import type { CidViewReadContext } from './context';
import {
  collectDealCids,
  collectDealCidsIncremental,
  dealFingerprint,
  deriveDealCidSnapshot,
} from './deals';
import type { DealCidSnapshot } from './deals';
import type { CidEntry } from './types';

const DEAL1 = '0xdeal1';
const DEAL2 = '0xdeal2';
const OFFER1 = '0xoffer1';

const DEAL1_CID = 'QmDeal1Current';
const DEAL2_CID = 'QmDeal2Current';
const OFFER1_CID = 'QmOffer1Current';

function fakeDeals(): DealRead[] {
  return [
    { genesis: DEAL1, author: '0xaaa', cid: DEAL1_CID, timestamp: 1000, status: 'deal' },
    { genesis: DEAL2, author: '0xbbb', cid: DEAL2_CID, timestamp: 2000, status: 'deal' },
  ];
}

function fakeOffers(): DealRead[] {
  return [{ genesis: OFFER1, author: '0xccc', cid: OFFER1_CID, timestamp: 3000, status: 'offer' }];
}

function fakeVersions(genesis: string): VersionRead[] {
  switch (genesis) {
    case DEAL1:
      return [
        { cid: 'QmDeal1V0', timestamp: 900, tombstone: false },
        { cid: DEAL1_CID, timestamp: 1000, tombstone: false },
      ];
    case DEAL2:
      return [
        { cid: 'QmDeal2V0', timestamp: 1900, tombstone: true },
        { cid: 'QmDeal2V1', timestamp: 1950, tombstone: false },
        { cid: DEAL2_CID, timestamp: 2000, tombstone: false },
      ];
    case OFFER1:
      return [
        { cid: 'QmOffer1V0', timestamp: 2900, tombstone: false },
        { cid: OFFER1_CID, timestamp: 3000, tombstone: false },
      ];
    default:
      return [];
  }
}

/** Build a fake context; overrides let a test inject failures/dupes. */
function fakeCtx(overrides: Partial<CidViewReadContext> = {}): CidViewReadContext {
  return {
    getDeals: async () => fakeDeals(),
    getOffers: async () => fakeOffers(),
    getVersions: async (genesis: string) => fakeVersions(genesis),
    ...overrides,
  } as CidViewReadContext;
}

describe('collectDealCids', () => {
  it('maps each deal to a "deal" entry with genesis/author/timestamp', async () => {
    const entries = await collectDealCids(fakeCtx());
    const deals = entries.filter((e) => e.category === 'deal');

    expect(deals).toHaveLength(2);
    expect(deals[0]).toMatchObject({
      cid: DEAL1_CID,
      category: 'deal',
      source: 'deals',
      genesis: DEAL1,
      author: '0xaaa',
      timestamp: 1000,
    });
    expect(deals[1]).toMatchObject({
      cid: DEAL2_CID,
      category: 'deal',
      source: 'deals',
      genesis: DEAL2,
      author: '0xbbb',
      timestamp: 2000,
    });
  });

  it('emits full version history as "deal-version" with tombstoned + last marked current', async () => {
    const entries = await collectDealCids(fakeCtx());
    const versions = entries.filter((e) => e.category === 'deal-version');

    expect(versions).toHaveLength(5); // 2 + 3 across the two deals

    const d1 = versions.filter((e) => e.genesis === DEAL1);
    expect(d1[0]).toMatchObject({
      cid: 'QmDeal1V0',
      category: 'deal-version',
      source: 'deals',
      genesis: DEAL1,
      timestamp: 900,
      tombstoned: undefined,
      note: undefined,
    });
    expect(d1[1]).toMatchObject({ cid: DEAL1_CID, note: 'current version' });

    const d2 = versions.filter((e) => e.genesis === DEAL2);
    expect(d2[0]).toMatchObject({ cid: 'QmDeal2V0', tombstoned: true, note: undefined });
    expect(d2[1]).toMatchObject({ cid: 'QmDeal2V1', tombstoned: undefined, note: undefined });
    expect(d2[2]).toMatchObject({ cid: DEAL2_CID, note: 'current version' });
  });

  it('maps offers to "offer" and "offer-version" entries', async () => {
    const entries = await collectDealCids(fakeCtx());

    const offers = entries.filter((e) => e.category === 'offer');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      cid: OFFER1_CID,
      category: 'offer',
      source: 'deals',
      genesis: OFFER1,
      author: '0xccc',
      timestamp: 3000,
    });

    const offerVersions = entries.filter((e) => e.category === 'offer-version');
    expect(offerVersions).toHaveLength(2);
    expect(offerVersions[0]).toMatchObject({
      cid: 'QmOffer1V0',
      category: 'offer-version',
      source: 'deals',
      genesis: OFFER1,
      timestamp: 2900,
    });
    expect(offerVersions[1]).toMatchObject({ cid: OFFER1_CID, note: 'current version' });
  });

  it('does not throw when a sub-call fails — returns the successful entries', async () => {
    const ctx = fakeCtx({
      getVersions: async (genesis: string) => {
        if (genesis === DEAL2) throw new Error('boom: version read failed');
        return fakeVersions(genesis);
      },
    });

    // Resolves without throwing despite the failing getVersions call.
    const entries = await collectDealCids(ctx);
    // Both deal entries still present...
    expect(entries.filter((e) => e.category === 'deal')).toHaveLength(2);
    // ...DEAL1 versions present...
    expect(
      entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL1),
    ).toHaveLength(2);
    // ...DEAL2 versions absent (failed), but DEAL2 itself still there...
    expect(
      entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL2),
    ).toHaveLength(0);
    // ...and the whole offers side unaffected.
    expect(entries.filter((e) => e.category === 'offer')).toHaveLength(1);
    expect(entries.filter((e) => e.category === 'offer-version')).toHaveLength(2);
  });

  it('does not throw when getDeals or getOffers fails', async () => {
    const noDeals = fakeCtx({
      getDeals: async () => {
        throw new Error('deals down');
      },
    });
    const entriesNoDeals = await collectDealCids(noDeals);
    expect(entriesNoDeals.filter((e) => e.category === 'deal')).toHaveLength(0);
    expect(entriesNoDeals.filter((e) => e.category === 'offer')).toHaveLength(1);

    const noOffers = fakeCtx({
      getOffers: async () => {
        throw new Error('offers down');
      },
    });
    const entriesNoOffers = await collectDealCids(noOffers);
    expect(entriesNoOffers.filter((e) => e.category === 'offer')).toHaveLength(0);
    expect(entriesNoOffers.filter((e) => e.category === 'deal')).toHaveLength(2);
  });

  it('dedupes exact duplicates (same cid + category + genesis)', async () => {
    const ctx = fakeCtx({
      getDeals: async () => [
        {
          genesis: DEAL1,
          author: '0xaaa',
          cid: DEAL1_CID,
          timestamp: 1000,
          status: 'deal' as const,
        },
        // exact duplicate: same cid + category + genesis
        {
          genesis: DEAL1,
          author: '0xaaa',
          cid: DEAL1_CID,
          timestamp: 1000,
          status: 'deal' as const,
        },
        {
          genesis: DEAL2,
          author: '0xbbb',
          cid: DEAL2_CID,
          timestamp: 2000,
          status: 'deal' as const,
        },
      ],
    });

    const entries = await collectDealCids(ctx);
    const deals = entries.filter((e) => e.category === 'deal');
    expect(deals).toHaveLength(2);
    expect(deals.filter((e) => e.genesis === DEAL1)).toHaveLength(1);
    expect(deals.filter((e) => e.genesis === DEAL2)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Incremental collection
// ─────────────────────────────────────────────────────────────────────────────

interface FakeChain {
  deals: DealRead[];
  offers: DealRead[];
  versions: Partial<Record<string, VersionRead[]>>;
}

interface VersionCalls {
  count: string[];
  range: string[];
}

/**
 * Fake ctx with recording getVersionCount/getVersionsRange. Non-async arrows
 * returning Promise.resolve/reject keep eslint's require-await off the new
 * lines (the collector only awaits, never needs the fakes to be async).
 */
function fakeIncrementalCtx(
  chain: FakeChain,
  calls: VersionCalls = { count: [], range: [] },
  overrides: Partial<CidViewReadContext> = {},
): CidViewReadContext {
  return {
    getDeals: () => Promise.resolve(chain.deals),
    getOffers: () => Promise.resolve(chain.offers),
    getVersions: () => Promise.resolve([]),
    getVersionCount: (genesis: string) => {
      calls.count.push(genesis);
      return Promise.resolve(chain.versions[genesis]?.length ?? 0);
    },
    getVersionsRange: (genesis: string, fromIndex: number) => {
      calls.range.push(`${genesis}:${String(fromIndex)}`);
      return Promise.resolve((chain.versions[genesis] ?? []).slice(fromIndex));
    },
    getConfig: () => Promise.resolve({ cid: '', config: {} }),
    getEnsText: () => Promise.resolve(''),
    dagGet: () => Promise.resolve(null),
    ls: () => Promise.resolve([]),
    cat: () => Promise.resolve(''),
    ...overrides,
  };
}

const V0: VersionRead = { cid: 'QmDealV0', timestamp: 900, tombstone: false };
const V1: VersionRead = { cid: 'QmDealV1', timestamp: 1000, tombstone: false };
const V2: VersionRead = { cid: 'QmDealV2', timestamp: 1100, tombstone: false };

const DEAL_SNAP: DealRead = {
  genesis: DEAL1,
  author: '0xaaa',
  cid: V1.cid,
  timestamp: V1.timestamp,
  status: 'deal',
};

describe('dealFingerprint', () => {
  it('is canonical — order-independent, status-sensitive', () => {
    const d1: DealRead = {
      genesis: DEAL1,
      author: '0xaaa',
      cid: 'QmD1',
      timestamp: 1,
      status: 'deal',
    };
    const d2: DealRead = {
      genesis: DEAL2,
      author: '0xbbb',
      cid: 'QmD2',
      timestamp: 2,
      status: 'deal',
    };
    const o1: DealRead = {
      genesis: OFFER1,
      author: '0xccc',
      cid: 'QmO1',
      timestamp: 3,
      status: 'offer',
    };

    expect(dealFingerprint([d1, d2], [o1])).toBe(dealFingerprint([d2, d1], [o1]));
    // a deal vs an offer with identical fields must not collide
    expect(dealFingerprint([d1], [])).not.toBe(dealFingerprint([], [{ ...d1, status: 'offer' }]));
    // changed cid/timestamp changes the fingerprint
    expect(dealFingerprint([d1], [])).not.toBe(dealFingerprint([{ ...d1, cid: 'QmD1b' }], []));
    expect(dealFingerprint([d1], [])).not.toBe(dealFingerprint([{ ...d1, timestamp: 99 }], []));
  });
});

describe('deriveDealCidSnapshot', () => {
  function makeView(entries: Partial<CidEntry>[]): PublicationCidView {
    return {
      publication: 'pub.eth',
      generatedAt: '2026-10-08T00:00:00.000Z',
      entries: entries as CidEntry[],
      sources: { deals: true, config: false, tree: false, archive: false },
      summary: { total: entries.length, uniqueCids: entries.length, byCategory: {} },
    };
  }

  it('round-trips deal/offer/version entries into a snapshot', () => {
    const view = makeView([
      {
        cid: V1.cid,
        category: 'deal',
        source: 'deals',
        genesis: DEAL1,
        author: '0xaaa',
        timestamp: 1000,
      },
      {
        cid: V0.cid,
        category: 'deal-version',
        source: 'deals',
        genesis: DEAL1,
        timestamp: 900,
        tombstoned: true,
      },
      {
        cid: 'QmDeal2Cur',
        category: 'deal',
        source: 'deals',
        genesis: DEAL2,
        author: '0xbbb',
        timestamp: 2000,
      },
      {
        cid: 'QmOfferCur',
        category: 'offer',
        source: 'deals',
        genesis: OFFER1,
        author: '0xccc',
        timestamp: 3000,
      },
      {
        cid: 'QmOfferV0',
        category: 'offer-version',
        source: 'deals',
        genesis: OFFER1,
        timestamp: 2900,
      },
    ]);

    const snap = deriveDealCidSnapshot(view);
    expect(snap.deals).toEqual([
      { genesis: DEAL1, author: '0xaaa', cid: V1.cid, timestamp: 1000, status: 'deal' },
      { genesis: DEAL2, author: '0xbbb', cid: 'QmDeal2Cur', timestamp: 2000, status: 'deal' },
    ]);
    expect(snap.offers).toEqual([
      { genesis: OFFER1, author: '0xccc', cid: 'QmOfferCur', timestamp: 3000, status: 'offer' },
    ]);
    expect(snap.versions[DEAL1]).toEqual([{ cid: V0.cid, timestamp: 900, tombstone: true }]);
    expect(snap.versions[OFFER1]).toEqual([
      { cid: 'QmOfferV0', timestamp: 2900, tombstone: false },
    ]);
  });

  it('is tolerant of missing optional fields', () => {
    const view = makeView([
      // deal missing cid → skipped entirely
      { category: 'deal', source: 'deals', genesis: DEAL1, author: '0xaaa', timestamp: 1000 },
      // deal missing genesis → skipped entirely
      { cid: 'QmNoGenesis', category: 'deal', source: 'deals', timestamp: 1000 },
      // deal missing author/timestamp → ''/0 fallbacks
      { cid: 'QmSparse', category: 'deal', source: 'deals', genesis: DEAL2 },
      // version missing timestamp/tombstoned → 0/false fallbacks
      { cid: 'QmSparseV', category: 'deal-version', source: 'deals', genesis: DEAL2 },
    ]);

    const snap = deriveDealCidSnapshot(view);
    expect(snap.deals).toEqual([
      { genesis: DEAL2, author: '', cid: 'QmSparse', timestamp: 0, status: 'deal' },
    ]);
    expect(snap.versions[DEAL2]).toEqual([{ cid: 'QmSparseV', timestamp: 0, tombstone: false }]);
  });
});

describe('collectDealCidsIncremental', () => {
  it('unchanged fingerprint → zero version calls; emits live deal + prev version entries', async () => {
    const prev: DealCidSnapshot = {
      deals: [DEAL_SNAP],
      offers: [],
      versions: { [DEAL1]: [V0, V1] },
    };
    const calls: VersionCalls = { count: [], range: [] };
    const ctx = fakeIncrementalCtx(
      { deals: [DEAL_SNAP], offers: [], versions: { [DEAL1]: [V0, V1] } },
      calls,
    );

    const result = await collectDealCidsIncremental(ctx, prev);

    expect(calls.count).toEqual([]);
    expect(calls.range).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.fingerprint).toBe(dealFingerprint(prev.deals, prev.offers));
    expect(result.entries).toContainEqual({
      cid: V1.cid,
      category: 'deal',
      source: 'deals',
      genesis: DEAL1,
      author: '0xaaa',
      timestamp: 1000,
    });
    expect(result.entries).toContainEqual({
      cid: V0.cid,
      category: 'deal-version',
      source: 'deals',
      genesis: DEAL1,
      timestamp: 900,
      tombstoned: undefined,
      note: undefined,
    });
    expect(result.entries).toContainEqual({
      cid: V1.cid,
      category: 'deal-version',
      source: 'deals',
      genesis: DEAL1,
      timestamp: 1000,
      tombstoned: undefined,
      note: 'current version',
    });
  });

  it('new version appended → only getVersionsRange(g, N) fetches the merged tail', async () => {
    const prev: DealCidSnapshot = {
      deals: [{ ...DEAL_SNAP, cid: V1.cid, timestamp: V1.timestamp }],
      offers: [],
      versions: { [DEAL1]: [V0, V1] }, // N = 2 cached
    };
    const liveDeal: DealRead = { ...DEAL_SNAP, cid: V2.cid, timestamp: V2.timestamp };
    const calls: VersionCalls = { count: [], range: [] };
    const ctx = fakeIncrementalCtx(
      { deals: [liveDeal], offers: [], versions: { [DEAL1]: [V0, V1, V2] } }, // N+1 = 3
      calls,
    );

    const result = await collectDealCidsIncremental(ctx, prev);

    expect(calls.count).toEqual([DEAL1]);
    expect(calls.range).toEqual([`${DEAL1}:2`]);
    expect(result.complete).toBe(true);

    const dealVersions = result.entries.filter(
      (e) => e.category === 'deal-version' && e.genesis === DEAL1,
    );
    expect(dealVersions).toHaveLength(3); // cached tail + appended
    expect(dealVersions[2]).toMatchObject({
      cid: V2.cid,
      timestamp: 1100,
      note: 'current version',
    });
  });

  it('brand-new deal → full history fetched from index 0', async () => {
    const prev: DealCidSnapshot = { deals: [], offers: [], versions: {} };
    const liveDeal: DealRead = { ...DEAL_SNAP, cid: V2.cid, timestamp: V2.timestamp };
    const calls: VersionCalls = { count: [], range: [] };
    const ctx = fakeIncrementalCtx(
      { deals: [liveDeal], offers: [], versions: { [DEAL1]: [V0, V1, V2] } },
      calls,
    );

    const result = await collectDealCidsIncremental(ctx, prev);

    expect(calls.count).toEqual([DEAL1]);
    expect(calls.range).toEqual([`${DEAL1}:0`]);
    expect(result.complete).toBe(true);
    expect(
      result.entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL1),
    ).toHaveLength(3);
  });

  it('revoked deal (in prev, not live) → version entries retained, no deal entry', async () => {
    const prev: DealCidSnapshot = {
      deals: [DEAL_SNAP],
      offers: [],
      versions: { [DEAL1]: [V0, V1] },
    };
    const calls: VersionCalls = { count: [], range: [] };
    // live state no longer lists DEAL1 (revocation removes it from the list)
    const ctx = fakeIncrementalCtx(
      { deals: [], offers: [], versions: { [DEAL1]: [V0, V1] } },
      calls,
    );

    const result = await collectDealCidsIncremental(ctx, prev);

    expect(calls.count).toEqual([]);
    expect(calls.range).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.entries.some((e) => e.category === 'deal' && e.genesis === DEAL1)).toBe(false);
    expect(
      result.entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL1),
    ).toHaveLength(2);
  });

  it('count-0 guard: unchanged fingerprint + 0 cached versions → full history refetched, complete recovers', async () => {
    const prev: DealCidSnapshot = {
      deals: [DEAL_SNAP],
      offers: [],
      versions: {}, // cachedCount 0 for DEAL1 — an earlier incomplete fetch
    };
    const calls: VersionCalls = { count: [], range: [] };
    const ctx = fakeIncrementalCtx(
      { deals: [DEAL_SNAP], offers: [], versions: { [DEAL1]: [V0, V1] } },
      calls,
    );

    const result = await collectDealCidsIncremental(ctx, prev);

    expect(calls.count).toEqual([DEAL1]);
    expect(calls.range).toEqual([`${DEAL1}:0`]);
    expect(result.complete).toBe(true);
    expect(
      result.entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL1),
    ).toHaveLength(2);
  });

  it('fail-open: getDeals throws → prev-derived entries, complete false, no throw', async () => {
    const prev: DealCidSnapshot = {
      deals: [DEAL_SNAP],
      offers: [],
      versions: { [DEAL1]: [V0, V1] },
    };
    const calls: VersionCalls = { count: [], range: [] };
    const ctx = fakeIncrementalCtx({ deals: [], offers: [], versions: {} }, calls, {
      getDeals: () => Promise.reject(new Error('deals down')),
    });

    const result = await collectDealCidsIncremental(ctx, prev);

    expect(result.complete).toBe(false);
    expect(result.fingerprint).toBe('');
    expect(calls.count).toEqual([]);
    expect(calls.range).toEqual([]);
    // prev-derived entries: live deal + cached version entries
    expect(result.entries).toContainEqual({
      cid: V1.cid,
      category: 'deal',
      source: 'deals',
      genesis: DEAL1,
      author: '0xaaa',
      timestamp: 1000,
    });
    expect(
      result.entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL1),
    ).toHaveLength(2);
  });

  it('fail-open: a failing range read keeps cached history and reports complete false', async () => {
    const prev: DealCidSnapshot = {
      deals: [DEAL_SNAP],
      offers: [],
      versions: { [DEAL1]: [V0, V1] },
    };
    const liveDeal: DealRead = { ...DEAL_SNAP, cid: V2.cid, timestamp: V2.timestamp };
    const calls: VersionCalls = { count: [], range: [] };
    const ctx = fakeIncrementalCtx(
      { deals: [liveDeal], offers: [], versions: { [DEAL1]: [V0, V1, V2] } },
      calls,
      { getVersionsRange: () => Promise.reject(new Error('range down')) },
    );

    const result = await collectDealCidsIncremental(ctx, prev);

    expect(result.complete).toBe(false);
    // cached history retained despite the failed tail fetch
    expect(
      result.entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL1),
    ).toHaveLength(2);
  });
});
