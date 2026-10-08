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

// The read-context interface declares the incremental primitives as optional
// (so test fakes that only exercise the cold collectors keep compiling). The
// adapter always wires them — these aliases narrow the optional members for the
// delegation assertions.
type VersionCountFn = (genesis: string) => Promise<number>;
type VersionsRangeFn = (
  genesis: string,
  fromIndex: number,
  count?: number,
) => Promise<VersionRead[]>;

function makeDeps(overrides: Partial<CidViewAdapterDeps> = {}): CidViewAdapterDeps {
  return {
    readDeals: vi.fn(async () => [DEAL]),
    readOffers: vi.fn(async () => []),
    readVersions: vi.fn(async () => [VERSION]),
    readVersionCount: vi.fn(() => Promise.resolve(1)),
    readVersionsRange: vi.fn(() => Promise.resolve([VERSION])),
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
    expect(await (ctx.getVersionCount as VersionCountFn)('0xabc')).toBe(1);
    expect(await (ctx.getVersionsRange as VersionsRangeFn)('0xabc', 0)).toEqual([VERSION]);
    expect(await ctx.getConfig()).toEqual({ cid: 'QmConfig', config: { name: 'pub.eth' } });
    expect(await ctx.getEnsText('0xnode', 'contenthash_wrapped')).toBe('');
    expect(await ctx.dagGet('QmDag')).toEqual({ templates: [] });
    expect(await ctx.ls('QmDir')).toEqual([]);
    expect(await ctx.cat('QmLeaf')).toBe('{}');
  });

  it('delegates getVersionCount + getVersionsRange to readVersionCount + readVersionsRange, args passed through', async () => {
    // Record the dep invocations (avoiding mock-reference member access) so the
    // 1:1 arg pass-through is asserted without tripping unbound-method.
    const calls: unknown[][] = [];
    const deps = makeDeps({
      readVersionCount: vi.fn((g: string) => {
        calls.push(['count', g]);
        return Promise.resolve(1);
      }),
      readVersionsRange: vi.fn((g: string, f: number, c?: number) => {
        calls.push(['range', g, f, c]);
        return Promise.resolve([VERSION]);
      }),
    });
    const ctx = createCidViewContext(deps);

    expect(await (ctx.getVersionCount as VersionCountFn)('0xgenesis')).toBe(1);
    // the optional count (already-fetched on-chain count) passes through 1:1
    expect(await (ctx.getVersionsRange as VersionsRangeFn)('0xgenesis', 3, 7)).toEqual([VERSION]);

    expect(calls).toEqual([
      ['count', '0xgenesis'],
      ['range', '0xgenesis', 3, 7],
    ]);
  });
});
