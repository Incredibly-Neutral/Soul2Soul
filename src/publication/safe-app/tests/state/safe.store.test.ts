import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installLS, type LSStub } from './_helpers.js';
import { SafeStore } from '../../src/state/safe.store.js';
import type { SafeInfo } from '../../src/types/index.js';

const INFO: SafeInfo = {
  safeAddress: '0xSafe',
  chainId: 8453,
  network: 'base',
  modules: ['0xM'],
  owners: ['0xO1'],
  threshold: 1,
};

describe('SafeStore', () => {
  let ls: LSStub;

  beforeEach(() => {
    ls = installLS();
  });

  it('starts undefined', () => {
    const s = new SafeStore();
    expect(s.info).toBeUndefined();
  });

  it('set stores and get returns the info', () => {
    const s = new SafeStore();
    s.set(INFO);
    expect(s.info).toBe(INFO);
  });

  it('clear resets to undefined', () => {
    const s = new SafeStore();
    s.set(INFO);
    s.clear();
    expect(s.info).toBeUndefined();
  });

  it('subscribe notifies on set/clear', () => {
    const s = new SafeStore();
    const fn = vi.fn();
    s.subscribe(fn);

    s.set(INFO);
    expect(fn).toHaveBeenLastCalledWith(INFO);
    s.clear();
    expect(fn).toHaveBeenLastCalledWith(undefined);
  });

  it('is in-memory only: never touches localStorage', () => {
    const s = new SafeStore();
    s.set(INFO);
    s.clear();
    expect(ls._map.size).toBe(0);
  });
});
