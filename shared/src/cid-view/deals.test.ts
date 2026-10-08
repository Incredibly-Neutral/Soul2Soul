// cid-view deals collector tests — pure fake CidViewReadContext, no chain.
import { describe, it, expect } from 'vitest';
import type { DealRead, VersionRead } from './types';
import type { CidViewReadContext } from './context';
import { collectDealCids } from './deals';

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
  return [
    { genesis: OFFER1, author: '0xccc', cid: OFFER1_CID, timestamp: 3000, status: 'offer' },
  ];
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
    expect(entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL1)).toHaveLength(2);
    // ...DEAL2 versions absent (failed), but DEAL2 itself still there...
    expect(entries.filter((e) => e.category === 'deal-version' && e.genesis === DEAL2)).toHaveLength(0);
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
        { genesis: DEAL1, author: '0xaaa', cid: DEAL1_CID, timestamp: 1000, status: 'deal' as const },
        // exact duplicate: same cid + category + genesis
        { genesis: DEAL1, author: '0xaaa', cid: DEAL1_CID, timestamp: 1000, status: 'deal' as const },
        { genesis: DEAL2, author: '0xbbb', cid: DEAL2_CID, timestamp: 2000, status: 'deal' as const },
      ],
    });

    const entries = await collectDealCids(ctx);
    const deals = entries.filter((e) => e.category === 'deal');
    expect(deals).toHaveLength(2);
    expect(deals.filter((e) => e.genesis === DEAL1)).toHaveLength(1);
    expect(deals.filter((e) => e.genesis === DEAL2)).toHaveLength(1);
  });
});
