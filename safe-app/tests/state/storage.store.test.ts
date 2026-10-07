import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installLS, type LSStub } from './_helpers.js';
import { StorageStore } from '../../src/state/storage.store.js';
import type { StoragePiece, PublicationDataSet } from '../../src/state/types.js';

const PIECE: StoragePiece = {
  pieceCid: 'pc', pieceId: 'pi', rootCid: null, dataSetId: 'ds', provider: 'p',
  attributed: true, size: 10n, metadata: {}, pdpEndEpoch: 100n, isLive: true,
  dataSetMetadata: {}, scheduledForRemoval: false, confirmed: false,
};
const DS: PublicationDataSet = {
  dataSetId: 'ds1', provider: 'p', pieceCount: 3, pdpEndEpoch: null, isLive: true, metadata: {},
};

describe('StorageStore', () => {
  let ls: LSStub;

  beforeEach(() => {
    ls = installLS();
  });

  it('starts empty (no pieces, no datasets)', () => {
    const s = new StorageStore();
    expect(s.allPieces).toEqual([]);
    expect(s.allDataSets).toEqual([]);
  });

  it('hydrates pieces from storage and marks them unconfirmed (cache)', () => {
    ls.setItem('pieces', JSON.stringify([{ ...PIECE, size: '10n', pdpEndEpoch: '100n', confirmed: true }]));
    const s = new StorageStore();
    expect(s.allPieces).toHaveLength(1);
    expect(s.allPieces[0].pieceCid).toBe('pc');
    expect(s.allPieces[0].size).toBe(10n);
    expect(s.allPieces[0].confirmed).toBe(false);
  });

  it('setPieces replaces all pieces and marks them confirmed (fresh chain data)', () => {
    const s = new StorageStore();
    s.setPieces([PIECE]);
    expect(s.allPieces).toEqual([{ ...PIECE, confirmed: true }]);
    // bigint survives the localStorage round-trip
    expect(ls.getItem('pieces')).toContain('"10n"');
  });

  it('setDataSets replaces datasets', () => {
    const s = new StorageStore();
    s.setDataSets([DS]);
    expect(s.allDataSets).toEqual([DS]);
    s.setDataSets([]);
    expect(s.allDataSets).toEqual([]);
  });

  it('clear empties both pieces and datasets', () => {
    const s = new StorageStore();
    s.setPieces([PIECE]);
    s.setDataSets([DS]);
    s.clear();
    expect(s.allPieces).toEqual([]);
    expect(s.allDataSets).toEqual([]);
  });

  it('subscribeToPieces / subscribeToDataSets notify only their own slice', () => {
    const s = new StorageStore();
    const pieces = vi.fn();
    const datasets = vi.fn();
    s.subscribeToPieces(pieces);
    s.subscribeToDataSets(datasets);

    s.setPieces([PIECE]);
    expect(pieces).toHaveBeenCalled();
    expect(datasets).not.toHaveBeenCalled();

    s.setDataSets([DS]);
    expect(datasets).toHaveBeenCalled();
  });

  it('persists pieces (only) to the pieces storage key', () => {
    const s = new StorageStore();
    s.setPieces([PIECE]);
    expect(ls._map.has('pieces')).toBe(true);
    expect(ls._map.has('deals')).toBe(false);
    expect(ls._map.has('records')).toBe(false);
    expect(ls._map.has('root')).toBe(false);
    // datasets are not persisted
    expect(ls.getItem('pieces')).not.toContain('ds1');
  });

  it('construction does not write back to storage (no feedback loop)', () => {
    ls.setItem('pieces', JSON.stringify([{ ...PIECE, size: '10n', pdpEndEpoch: '100n', confirmed: false }]));
    const snapshot = new Map(ls._map);
    new StorageStore();
    expect(ls._map).toEqual(snapshot);
  });
});
