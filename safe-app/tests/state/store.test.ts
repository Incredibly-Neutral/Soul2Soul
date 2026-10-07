import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installLS, seed, type LSStub } from './_helpers.js';
import type { Store } from '../../src/state/store.js';

/**
 * Build a fresh store singleton against the current localStorage contents.
 * The store module is a singleton, so to test hydration + behavior in
 * isolation we wipe the module registry and re-import after seeding storage.
 */
async function freshStore(seeds: Record<string, unknown> = {}): Promise<Store> {
  localStorage.clear();
  for (const [key, value] of Object.entries(seeds)) seed(localStorage as unknown as LSStub, key, value);
  vi.resetModules();
  const mod = await import('../../src/state/store.js');
  return mod.store;
}

const RECORD = { key: 'k1', value: 'v1', type: 'metadata' as const };
const DEAL = { genesis: 'g1', cid: 'cid1', author: 'a', status: 'deal' as const };
const OFFER = { genesis: 'g2', cid: 'cid2', author: 'b', status: 'offer' as const };
const PIECE = {
  pieceCid: 'pc', pieceId: 'pi', rootCid: null, dataSetId: 'ds', provider: 'p',
  attributed: true, size: 10n, metadata: {}, pdpEndEpoch: 100n, isLive: true,
  dataSetMetadata: {}, scheduledForRemoval: false, confirmed: false,
};

const recordsSeed = { records: { k1: RECORD } };
const dealsSeed = { deals: { g1: DEAL } };
const offersSeed = { offers: { g2: OFFER } };
const rootSeed = { root: '0xROOT' };
const piecesSeed = { pieces: [{ ...PIECE, size: '10n', pdpEndEpoch: '100n' }] };

describe('store (aggregate)', () => {
  let ls: LSStub;

  beforeEach(() => {
    ls = installLS();
  });

  describe('localStorage hydration', () => {
    it('hydrates records, deals, offers, root and pieces from storage', async () => {
      const store = await freshStore({ ...recordsSeed, ...dealsSeed, ...offersSeed, ...rootSeed, ...piecesSeed });

      expect(store.getRoot()).toBe('0xROOT');
      expect(store.getAllRecords()).toEqual({ k1: RECORD });
      expect(store.getRecord('k1')).toBe('v1');
      expect(store.deals).toEqual([DEAL]);
      expect(store.offers).toEqual([OFFER]);
      expect(store.pieces).toEqual([{ ...PIECE, size: 10n, pdpEndEpoch: 100n, confirmed: false }]);
    });

    it('starts empty when nothing is stored', async () => {
      const store = await freshStore();
      expect(store.getRoot()).toBeNull();
      expect(store.getAllRecords()).toBeNull();
      expect(store.deals).toEqual([]);
      expect(store.offers).toEqual([]);
      expect(store.pieces).toEqual([]);
      expect(store.dataSets).toEqual([]);
      expect(store.safeInfo).toBeUndefined();
      expect(store.protocolInfo).toBeUndefined();
    });

    it('marks hydrated pieces as not confirmed (cache, not fresh chain data)', async () => {
      const store = await freshStore({ pieces: [{ ...PIECE, size: '10n', pdpEndEpoch: '100n', confirmed: true }] });
      expect(store.pieces[0].confirmed).toBe(false);
    });

    it('guard: hydration does NOT write back to localStorage (no re-render feedback loop)', async () => {
      // Seed the map directly (no setItem) so we can count every write that
      // happens during construction of the aggregate store.
      ls._map.set('deals', JSON.stringify({ g1: DEAL }));
      ls._map.set('records', JSON.stringify({ k1: RECORD }));
      ls._map.set('root', '0xROOT');
      ls._map.set('pieces', JSON.stringify([{ ...PIECE, size: '10n', pdpEndEpoch: '100n', confirmed: false }]));

      const writes: Array<[string, string]> = [];
      const origSet = ls.setItem.bind(ls);
      const origRemove = ls.removeItem.bind(ls);
      ls.setItem = (k: string, v: string) => { writes.push([k, v]); return origSet(k, v); };
      ls.removeItem = (k: string) => { writes.push([k, '<remove>']); return origRemove(k); };

      vi.resetModules();
      const { store } = await import('../../src/state/store.js');

      // Hydration is read-only: constructing the store must not re-write the
      // seeded values (slice stores only auto-save after `initialized` flips,
      // and Observable.subscribe never fires synchronously). A write-back here
      // would feed connectedCallback subscribers and loop.
      expect(writes).toEqual([]);
      expect(store.deals).toEqual([DEAL]);
      expect(store.getAllRecords()).toEqual({ k1: RECORD });
      expect(store.getRoot()).toBe('0xROOT');
    });

    it('guard: subscribers added during connectedCallback-style setup are not fired by hydration', async () => {
      ls.setItem('root', '0xROOT');
      const store = await freshStore();
      const onRoot = vi.fn();
      const onRecords = vi.fn();
      // Attach subscriptions after the store exists (as a component would).
      store.subscribeToRoot(onRoot);
      store.subscribeToRecords(onRecords);
      expect(onRoot).not.toHaveBeenCalled();
      expect(onRecords).not.toHaveBeenCalled();
    });
  });

  describe('root', () => {
    it('setRoot persists to localStorage and notifies subscribers', async () => {
      const store = await freshStore();
      const fn = vi.fn();
      store.subscribeToRoot(fn);

      store.setRoot('0xNEW');
      expect(store.getRoot()).toBe('0xNEW');
      expect(ls.getItem('root')).toBe('0xNEW');
      expect(fn).toHaveBeenCalledWith('0xNEW');
    });

    it('web root is not cleared by store.clear()', async () => {
      const store = await freshStore(rootSeed);
      store.clear();
      expect(store.getRoot()).toBe('0xROOT');
    });
  });

  describe('records', () => {
    it('get/set/remove/clear and slice subscriptions', async () => {
      const store = await freshStore();
      const fn = vi.fn();
      store.subscribeToRecords(fn);

      store.setRecord(RECORD);
      expect(store.getRecord('k1')).toBe('v1');
      expect(fn).toHaveBeenLastCalledWith({ k1: RECORD });

      store.removeRecord('k1');
      expect(store.getRecord('k1')).toBeNull();
      expect(fn).toHaveBeenLastCalledWith({});

      store.setAllRecords([RECORD, { key: 'k2', value: 'v2', type: 'content' }]);
      expect(store.getAllRecords()).toEqual({
        k1: RECORD,
        k2: { key: 'k2', value: 'v2', type: 'content' },
      });

      store.clearRecords();
      expect(store.getAllRecords()).toBeNull();
      expect(fn).toHaveBeenLastCalledWith(null);
    });

    it('setRecord upserts by key', async () => {
      const store = await freshStore(recordsSeed);
      store.setRecord({ ...RECORD, value: 'v1b' });
      expect(store.getAllRecords()).toEqual({ k1: { ...RECORD, value: 'v1b' } });
    });
  });

  describe('deals and offers', () => {
    it('set/add/forget deals with slice subscription', async () => {
      const store = await freshStore();
      const fn = vi.fn();
      store.subscribeToDeals(fn);

      store.addDeal(DEAL);
      expect(store.deals).toEqual([DEAL]);
      expect(fn).toHaveBeenLastCalledWith([DEAL]);

      store.addDeal({ ...DEAL, cid: 'cid-updated' });
      expect(store.deals).toEqual([{ ...DEAL, cid: 'cid-updated' }]); // upsert by genesis

      store.forgetDeal('g1');
      expect(store.deals).toEqual([]);
    });

    it('setOffers/addOffer/forgetOffer with slice subscription', async () => {
      const store = await freshStore();
      const fn = vi.fn();
      store.subscribeToOffers(fn);

      store.addOffer(OFFER);
      expect(store.offers).toEqual([OFFER]);
      expect(fn).toHaveBeenLastCalledWith([OFFER]);

      store.forgetOffer('g2');
      expect(store.offers).toEqual([]);
    });

    it('deals and offers persist to their own keys on change', async () => {
      const store = await freshStore();
      store.addDeal(DEAL);
      expect(ls.getItem('deals')).toBe(JSON.stringify({ g1: DEAL }));

      store.addOffer(OFFER);
      expect(ls.getItem('offers')).toBe(JSON.stringify({ g2: OFFER }));
    });

    it('store.clear() wipes deals but not offers... (matches implementation: clear() clears records+deals only)', async () => {
      const store = await freshStore(dealsSeed);
      store.addOffer(OFFER);
      store.clear();
      expect(store.deals).toEqual([]);
      // Note: store.clear() only clears the deal slice, not pending offers.
      expect(store.offers).toEqual([OFFER]);
    });
  });

  describe('protocolInfo / safeInfo', () => {
    it('setProtocolInfo/getProtocolInfo round-trip and notify', async () => {
      const store = await freshStore();
      const fn = vi.fn();
      store.subscribeToProtocolInfo(fn);

      const info = { version: '1.0' } as never;
      store.setProtocolInfo(info);
      expect(store.protocolInfo).toBe(info);
      expect(fn).toHaveBeenCalledWith(info);

      store.setProtocolInfo(undefined); // ignored (set only when defined)
      expect(store.protocolInfo).toBe(info);
    });

    it('setSafeInfo/getSafeInfo round-trip and notify', async () => {
      const store = await freshStore();
      const fn = vi.fn();
      store.subscribeToSafeInfo(fn);

      const info = { safeAddress: '0x', chainId: 1, network: 'mainnet', modules: [], owners: [], threshold: 1 };
      store.setSafeInfo(info);
      expect(store.safeInfo).toBe(info);
      expect(fn).toHaveBeenCalledWith(info);
    });
  });

  describe('storage pieces and datasets', () => {
    it('setPieces replaces pieces, marks them confirmed, notifies', async () => {
      const store = await freshStore();
      const fn = vi.fn();
      store.subscribeToPieces(fn);

      store.setPieces([PIECE]);
      expect(store.pieces).toEqual([{ ...PIECE, confirmed: true }]);
      expect(fn).toHaveBeenCalledWith([{ ...PIECE, confirmed: true }]);
      expect(ls.getItem('pieces')).toContain('"10n"'); // bigint serialized
    });

    it('setDataSets replaces datasets and notifies', async () => {
      const store = await freshStore();
      const fn = vi.fn();
      store.subscribeToDataSets(fn);

      const ds = { dataSetId: 'ds1', provider: 'p', pieceCount: 3, pdpEndEpoch: null, isLive: true, metadata: {} };
      store.setDataSets([ds]);
      expect(store.dataSets).toEqual([ds]);
      expect(fn).toHaveBeenCalledWith([ds]);
    });
  });
});
