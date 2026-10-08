// cid-view adapter factory tests — verifies the 1:1 delegation contract.
import { describe, it, expect, vi } from 'vitest';
import { createCidViewContext } from './adapter';
import type { CidViewAdapterDeps } from './adapter';
import type { DealRead, VersionRead } from './types';

const DEAL: DealRead = {
  genesis: '0x1111111111111111111111111111111111111111111111111111111111111111',
  author: '0xaaa',
  cid: 'QmDeal',
  timestamp: 1000,
  status: 'deal',
};
const VERSION: VersionRead = { cid: 'QmVersion', timestamp: 900, tombstone: false };

function makeDeps(overrides: Partial<CidViewAdapterDeps> = {}): CidViewAdapterDeps {
  return {
    readDeals: vi.fn(async () => [DEAL]),
    readOffers: vi.fn(async () => []),
    readVersions: vi.fn(async () => [VERSION]),
    readConfig: vi.fn(async () => ({ cid: 'QmConfig', config: { name: 'pub.eth' } })),
    readEnsText: vi.fn(async () => ''),
    ipfs: {
      dagGet: vi.fn(async () => ({
        templates: [],
      })) as unknown as CidViewAdapterDeps['ipfs']['dagGet'],
      ls: vi.fn(async () => []),
      cat: vi.fn(async () => '{}'),
    },
    ...overrides,
  };
}

describe('createCidViewContext', () => {
  it('delegates every context method 1:1 to the matching dep', async () => {
    const deps = makeDeps();
    const ctx = createCidViewContext(deps);

    expect(await ctx.getDeals()).toEqual([DEAL]);
    expect(await ctx.getOffers()).toEqual([]);
    expect(await ctx.getVersions('0xabc')).toEqual([VERSION]);
    expect(await ctx.getConfig()).toEqual({ cid: 'QmConfig', config: { name: 'pub.eth' } });
    expect(await ctx.getEnsText('0xnode', 'contenthash_wrapped')).toBe('');
    expect(await ctx.dagGet('QmDag')).toEqual({ templates: [] });
    expect(await ctx.ls('QmDir')).toEqual([]);
    expect(await ctx.cat('QmLeaf')).toBe('{}');

    // Delegation is 1:1 — args are passed through untouched.
    expect(deps.readVersions).toHaveBeenCalledWith('0xabc');
    expect(deps.readEnsText).toHaveBeenCalledWith('0xnode', 'contenthash_wrapped');
    expect(deps.ipfs.dagGet).toHaveBeenCalledWith('QmDag');
    expect(deps.ipfs.ls).toHaveBeenCalledWith('QmDir');
    expect(deps.ipfs.cat).toHaveBeenCalledWith('QmLeaf');
  });
});
