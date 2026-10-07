import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installLS, type LSStub } from './_helpers.js';
import {
  loadRootFromStorage,
  saveRootToStorage,
  loadRecordFromStorage,
  saveRecordToStorage,
  loadDealsFromStorage,
  saveDealsToStorage,
  loadOffersFromStorage,
  saveOffersToStorage,
  loadPiecesFromStorage,
  savePiecesToStorage,
} from '../../src/state/storage.js';

describe('storage (localStorage persistence layer)', () => {
  let ls: LSStub;

  beforeEach(() => {
    ls = installLS();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('root', () => {
    it('round-trips a root string', () => {
      expect(loadRootFromStorage()).toBeNull();
      saveRootToStorage('0x123abc');
      expect(loadRootFromStorage()).toBe('0x123abc');
      expect(ls.getItem('root')).toBe('0x123abc');
    });

    it('saveRootToStorage(null) removes the key', () => {
      saveRootToStorage('x');
      saveRootToStorage(null);
      expect(ls.getItem('root')).toBeNull();
      expect(loadRootFromStorage()).toBeNull();
    });

    it('returns null when nothing is stored', () => {
      expect(loadRootFromStorage()).toBeNull();
    });
  });

  describe('records', () => {
    it('round-trips a record map (JSON)', () => {
      const rec = { k1: { key: 'k1', value: 'v1', type: 'metadata' } };
      expect(loadRecordFromStorage()).toBeNull();
      saveRecordToStorage(rec);
      expect(loadRecordFromStorage()).toEqual(rec);
      expect(ls.getItem('records')).toBe(JSON.stringify(rec));
    });

    it('saveRecordToStorage(null) removes the key', () => {
      saveRecordToStorage({ a: {} });
      saveRecordToStorage(null);
      expect(ls.getItem('records')).toBeNull();
      expect(loadRecordFromStorage()).toBeNull();
    });

    it('falls back to null on corrupt JSON and warns', () => {
      ls.setItem('records', '{not valid json');
      expect(loadRecordFromStorage()).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe('deals', () => {
    it('round-trips a deal map keyed by genesis', () => {
      const deals = { g1: { genesis: 'g1', cid: 'cid', author: 'a', status: 'deal' } };
      expect(loadDealsFromStorage()).toBeNull();
      saveDealsToStorage(deals);
      expect(loadDealsFromStorage()).toEqual(deals);
    });

    it('saveDealsToStorage(null) removes the key', () => {
      saveDealsToStorage({ g: {} });
      saveDealsToStorage(null);
      expect(ls.getItem('deals')).toBeNull();
      expect(loadDealsFromStorage()).toBeNull();
    });
  });

  describe('offers', () => {
    it('round-trips an offer map keyed by genesis', () => {
      const offers = { g2: { genesis: 'g2', cid: 'cid2', author: 'b', status: 'offer' } };
      expect(loadOffersFromStorage()).toBeNull();
      saveOffersToStorage(offers);
      expect(loadOffersFromStorage()).toEqual(offers);
    });

    it('saveOffersToStorage(null) removes the key', () => {
      saveOffersToStorage({ g: {} });
      saveOffersToStorage(null);
      expect(ls.getItem('offers')).toBeNull();
      expect(loadOffersFromStorage()).toBeNull();
    });
  });

  describe('pieces (bigint-aware)', () => {
    it('round-trips a piece list including bigint fields', () => {
      const pieces = [
        { pieceCid: 'cid', size: 5n, pdpEndEpoch: 100n, confirmed: false },
      ];
      savePiecesToStorage(pieces);
      const stored = ls.getItem('pieces');
      expect(stored).toContain('"5n"');
      expect(stored).toContain('"100n"');

      const loaded = loadPiecesFromStorage();
      expect(loaded).toHaveLength(1);
      expect(loaded![0].size).toBe(5n);
      expect(loaded![0].pdpEndEpoch).toBe(100n);
      expect(loaded![0].pieceCid).toBe('cid');
    });

    it('does not convert ordinary numeric strings that lack the n suffix', () => {
      const pieces = [{ size: 'not-a-bigint' }];
      savePiecesToStorage(pieces);
      const loaded = loadPiecesFromStorage<{ size: string | bigint }>();
      expect(loaded![0].size).toBe('not-a-bigint');
    });

    it('savePiecesToStorage(null) removes the key', () => {
      savePiecesToStorage([{}]);
      savePiecesToStorage(null);
      expect(ls.getItem('pieces')).toBeNull();
      expect(loadPiecesFromStorage()).toBeNull();
    });
  });

  describe('corrupt / unavailable storage fallbacks', () => {
    it('falls back to null and warns on corrupt JSON for every load function', () => {
      ls.setItem('records', '{');
      ls.setItem('deals', '{');
      ls.setItem('offers', '{');
      ls.setItem('pieces', '{');
      expect(loadRecordFromStorage()).toBeNull();
      expect(loadDealsFromStorage()).toBeNull();
      expect(loadOffersFromStorage()).toBeNull();
      expect(loadPiecesFromStorage()).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('returns null and warns when localStorage is unavailable on read', () => {
      installLS({ failGet: true });
      expect(loadRootFromStorage()).toBeNull();
      expect(loadRecordFromStorage()).toBeNull();
      expect(loadDealsFromStorage()).toBeNull();
      expect(loadOffersFromStorage()).toBeNull();
      expect(loadPiecesFromStorage()).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('does not throw and warns when writes fail (quota / unavailable)', () => {
      installLS({ failSet: true });
      expect(() => saveRootToStorage('x')).not.toThrow();
      expect(() => saveRecordToStorage({ a: {} })).not.toThrow();
      expect(() => saveDealsToStorage({ g: {} })).not.toThrow();
      expect(() => saveOffersToStorage({ g: {} })).not.toThrow();
      expect(() => savePiecesToStorage([{ size: 1n }])).not.toThrow();
      expect(console.warn).toHaveBeenCalled();
    });

    it('does not throw when removal fails', () => {
      installLS({ failSet: true });
      expect(() => saveRootToStorage(null)).not.toThrow();
      expect(() => saveRecordToStorage(null)).not.toThrow();
    });
  });

  describe('key isolation', () => {
    it('each function only touches its own storage key', () => {
      saveRootToStorage('r');
      saveRecordToStorage({ a: {} });
      saveDealsToStorage({ g: {} });
      saveOffersToStorage({ o: {} });
      savePiecesToStorage([{}]);
      expect([...ls._map.keys()].sort()).toEqual([
        'deals',
        'offers',
        'pieces',
        'records',
        'root',
      ]);
    });
  });
});
