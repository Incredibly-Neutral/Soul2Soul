import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installLS, type LSStub } from './_helpers.js';
import { ProtocolStore } from '../../src/state/protocol.store.js';
import type { S2SProtocolInfo } from '@s2s/soul2soul-shared';

const INFO: S2SProtocolInfo = {
  gateway: 'https://gateway',
  ensRegistry: '0x1',
  ensRecords: '0x2',
  publicationFactory: '0x3',
  recordsFactory: '0x4',
  pkp: '0x5',
  litActions: { prep: 'cid-prep', render: 'cid-render', update: 'cid-update' },
};

describe('ProtocolStore', () => {
  let ls: LSStub;

  beforeEach(() => {
    ls = installLS();
  });

  it('starts undefined', () => {
    const s = new ProtocolStore();
    expect(s.info).toBeUndefined();
  });

  it('set stores and get returns the info', () => {
    const s = new ProtocolStore();
    s.set(INFO);
    expect(s.info).toBe(INFO);
  });

  it('clear resets to undefined', () => {
    const s = new ProtocolStore();
    s.set(INFO);
    s.clear();
    expect(s.info).toBeUndefined();
  });

  it('subscribe notifies on set/clear', () => {
    const s = new ProtocolStore();
    const fn = vi.fn();
    s.subscribe(fn);

    s.set(INFO);
    expect(fn).toHaveBeenLastCalledWith(INFO);
    s.clear();
    expect(fn).toHaveBeenLastCalledWith(undefined);
  });

  it('is in-memory only: never touches localStorage', () => {
    const s = new ProtocolStore();
    s.set(INFO);
    s.clear();
    expect(ls._map.size).toBe(0);
  });
});
