import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installLS, type LSStub } from './_helpers.js';
import { DealStore } from '../../src/state/deal.store.js';

const DEAL = { genesis: 'g1', cid: 'cid1', author: 'a', status: 'deal' as const };
const OFFER = { genesis: 'g2', cid: 'cid2', author: 'b', status: 'offer' as const };

describe('DealStore', () => {
  let ls: LSStub;

  beforeEach(() => {
    ls = installLS();
  });

  it('starts with empty deals and offers when storage is empty', () => {
    const s = new DealStore();
    expect(s.all).toEqual([]);
    expect(s.allPending).toEqual([]);
  });

  it('hydrates deals and offers from their storage keys', () => {
    ls.setItem('deals', JSON.stringify({ g1: DEAL }));
    ls.setItem('offers', JSON.stringify({ g2: OFFER }));
    const s = new DealStore();
    expect(s.all).toEqual([DEAL]);
    expect(s.allPending).toEqual([OFFER]);
  });

  it('set replaces the deal list', () => {
    const s = new DealStore();
    s.set([DEAL]);
    expect(s.all).toEqual([DEAL]);
    s.set([]);
    expect(s.all).toEqual([]);
  });

  it('add upserts by genesis', () => {
    const s = new DealStore();
    s.add(DEAL);
    s.add({ ...DEAL, cid: 'cid-updated' });
    expect(s.all).toEqual([{ ...DEAL, cid: 'cid-updated' }]);
    expect(s.all).toHaveLength(1);
  });

  it('remove filters by genesis', () => {
    const s = new DealStore();
    s.add(DEAL);
    s.add({ genesis: 'g9', cid: 'c', author: 'x', status: 'deal' });
    s.remove('g1');
    expect(s.all).toEqual([{ genesis: 'g9', cid: 'c', author: 'x', status: 'deal' }]);
  });

  it('clear empties the deal list', () => {
    const s = new DealStore();
    s.add(DEAL);
    s.clear();
    expect(s.all).toEqual([]);
  });

  it('offers mirror deals API on the pending slice', () => {
    const s = new DealStore();
    s.setPending([OFFER]);
    s.addPending({ ...OFFER, cid: 'c2' });
    expect(s.allPending).toEqual([{ ...OFFER, cid: 'c2' }]);
    s.removePending('g2');
    expect(s.allPending).toEqual([]);
    s.addPending(OFFER);
    s.clearPending();
    expect(s.allPending).toEqual([]);
  });

  it('subscribe / subscribeToPending notify only their own slice', () => {
    const s = new DealStore();
    const deals = vi.fn();
    const pending = vi.fn();
    s.subscribe(deals);
    s.subscribeToPending(pending);

    s.add(DEAL);
    expect(deals).toHaveBeenCalledWith([DEAL]);
    expect(pending).not.toHaveBeenCalled();

    s.addPending(OFFER);
    expect(pending).toHaveBeenCalledWith([OFFER]);
    expect(deals).toHaveBeenCalledTimes(1); // pending change does not touch deals
  });

  it('persists deals and offers to their own storage keys on change', () => {
    const s = new DealStore();
    s.add(DEAL);
    expect(ls.getItem('deals')).toBe(JSON.stringify({ g1: DEAL }));
    expect(ls._map.has('offers')).toBe(false);

    s.addPending(OFFER);
    expect(ls.getItem('offers')).toBe(JSON.stringify({ g2: OFFER }));
  });

  it('empty list persists as an empty map (not removed)', () => {
    const s = new DealStore();
    s.set([]);
    expect(ls.getItem('deals')).toBe('{}');
  });

  it('does not touch records/root/pieces keys', () => {
    const s = new DealStore();
    s.add(DEAL);
    s.addPending(OFFER);
    expect([...ls._map.keys()].sort()).toEqual(['deals', 'offers']);
  });

  it('construction does not write back to storage (no feedback loop)', () => {
    ls.setItem('deals', JSON.stringify({ g1: DEAL }));
    ls.setItem('offers', JSON.stringify({ g2: OFFER }));
    const snapshot = new Map(ls._map);
    new DealStore();
    expect(ls._map).toEqual(snapshot);
  });
});
