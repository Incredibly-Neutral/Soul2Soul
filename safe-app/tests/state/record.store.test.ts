import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installLS, type LSStub } from './_helpers.js';
import { RecordStore } from '../../src/state/record.store.js';

const REC = { key: 'k1', value: 'v1', type: 'metadata' as const };

describe('RecordStore', () => {
  let ls: LSStub;

  beforeEach(() => {
    ls = installLS();
  });

  it('starts empty (null map) when localStorage has no records', () => {
    const s = new RecordStore();
    expect(s.all()).toBeNull();
    expect(s.get('k1')).toBeNull();
    expect(s.initialized).toBe(true);
  });

  it('hydrates from the records storage key', () => {
    ls.setItem('records', JSON.stringify({ k1: REC }));
    const s = new RecordStore();
    expect(s.all()).toEqual({ k1: REC });
    expect(s.get('k1')).toEqual(REC);
  });

  it('set upserts by record key', () => {
    const s = new RecordStore();
    s.set(REC);
    s.set({ key: 'k2', value: 'v2', type: 'content' });
    expect(s.all()).toEqual({
      k1: REC,
      k2: { key: 'k2', value: 'v2', type: 'content' },
    });

    s.set({ ...REC, value: 'v1b' });
    expect(s.all()).toEqual({
      k1: { ...REC, value: 'v1b' },
      k2: { key: 'k2', value: 'v2', type: 'content' },
    });
  });

  it('setAll replaces the whole map', () => {
    const s = new RecordStore();
    s.set(REC);
    s.setAll([{ key: 'x', value: 'xv', type: 'metadata' }]);
    expect(s.all()).toEqual({ x: { key: 'x', value: 'xv', type: 'metadata' } });
    expect(s.get('k1')).toBeNull();
  });

  it('remove deletes a single key', () => {
    const s = new RecordStore();
    s.set(REC);
    s.set({ key: 'k2', value: 'v2', type: 'content' });
    s.remove('k1');
    expect(s.get('k1')).toBeNull();
    expect(s.all()).toEqual({ k2: { key: 'k2', value: 'v2', type: 'content' } });
  });

  it('remove on an empty store is a no-op (stays null)', () => {
    const s = new RecordStore();
    s.remove('nope');
    expect(s.all()).toBeNull();
  });

  it('clear resets to null', () => {
    const s = new RecordStore();
    s.set(REC);
    s.clear();
    expect(s.all()).toBeNull();
    expect(s.get('k1')).toBeNull();
  });

  it('subscribe notifies on mutations and can be unsubscribed', () => {
    const s = new RecordStore();
    const fn = vi.fn();
    const unsub = s.subscribe(fn);

    s.set(REC);
    expect(fn).toHaveBeenLastCalledWith({ k1: REC });
    s.clear();
    expect(fn).toHaveBeenLastCalledWith(null);

    unsub();
    s.set({ key: 'k3', value: 'v3', type: 'content' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('mutates ONLY its own slice: never writes to localStorage', () => {
    ls.setItem('root', '0xROOT');
    ls.setItem('deals', JSON.stringify({}));
    const s = new RecordStore();
    s.set(REC);
    s.setAll([REC]);
    s.remove('k1');
    s.clear();
    // RecordStore has no persistence hook — nothing may be written.
    expect(ls._map.has('records')).toBe(false);
    expect(ls._map.has('root')).toBe(true);
    expect(ls._map.has('deals')).toBe(true);
    expect(ls._map.size).toBe(2);
  });
});
