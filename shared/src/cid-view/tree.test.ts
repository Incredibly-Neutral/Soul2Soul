import { describe, it, expect, vi } from 'vitest';
import { namehash } from 'viem/ens';
import { collectTreeCids, collectArchiveCids } from './tree';
import type { CidViewReadContext } from './context';
import { encodeContenthashWrapped, parseCID } from '../ipfs/contenthash';

const PUBLICATION = 's3ntiment.eth';
const NODE = namehash(PUBLICATION);

// Real deterministic CIDs — the walk/cat is mocked so they need not resolve.
const ROOT_CID = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
const DIR_CID = 'bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq';
const FILE_A = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';
const FILE_B = 'QmYwAPJzv5CZsnAzt8auVZRnS5YxM5kR4JxmG5N4tWkLxN';

const rootContenthash = encodeContenthashWrapped(parseCID(ROOT_CID));
const archiveContenthash = encodeContenthashWrapped(parseCID(FILE_A));

type LsEntry = { name: string; hash: string; size: number };

function makeCtx(overrides: Partial<CidViewReadContext> = {}): CidViewReadContext {
  return {
    getDeals: async () => {
      throw new Error('no getDeals stub');
    },
    getOffers: async () => {
      throw new Error('no getOffers stub');
    },
    getVersions: async () => {
      throw new Error('no getVersions stub');
    },
    getConfig: async () => {
      throw new Error('no getConfig stub');
    },
    dagGet: async () => {
      throw new Error('no dagGet stub');
    },
    ls: async () => {
      throw new Error('no ls stub');
    },
    cat: async () => {
      throw new Error('no cat stub');
    },
    getEnsText: async () => {
      throw new Error('no getEnsText stub');
    },
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// collectTreeCids
// ───────────────────────────────────────────────────────────────────────────

describe('collectTreeCids', () => {
  it('decodes contenthash_wrapped → site-root + walks tree → site-file entries with paths/sizes', async () => {
    const ls = vi.fn(async (cid: string): Promise<LsEntry[]> => {
      if (cid === ROOT_CID) {
        return [
          { name: 'index.html', hash: FILE_A, size: 1234 },
          { name: 'assets', hash: DIR_CID, size: 0 },
        ];
      }
      if (cid === DIR_CID) {
        return [{ name: 'logo.png', hash: FILE_B, size: 5678 }];
      }
      return []; // files / leaves → treated as site files
    });
    const ctx = makeCtx({
      getEnsText: async (node, key) =>
        node === NODE && key === 'contenthash_wrapped' ? rootContenthash : '',
      ls,
    });

    const entries = await collectTreeCids(ctx, PUBLICATION);

    expect(entries).toContainEqual({ cid: ROOT_CID, category: 'site-root', source: 'tree' });
    expect(entries).toContainEqual({
      cid: FILE_A,
      category: 'site-file',
      source: 'tree',
      path: 'index.html',
      size: 1234,
    });
    expect(entries).toContainEqual({
      cid: FILE_B,
      category: 'site-file',
      source: 'tree',
      path: 'assets/logo.png',
      size: 5678,
    });
    expect(entries.filter((e) => e.category === 'site-root')).toHaveLength(1);
    expect(entries.filter((e) => e.category === 'site-file')).toHaveLength(2);
  });

  it('empty contenthash_wrapped → [] (no throw)', async () => {
    const ctx = makeCtx({ getEnsText: async () => '' });
    await expect(collectTreeCids(ctx, PUBLICATION)).resolves.toEqual([]);
  });

  it('malformed contenthash → [] (no throw)', async () => {
    // wrong ipfs-ns first byte (0xe4) → decodeContenthashWrapped throws → absent
    const ctx = makeCtx({ getEnsText: async () => '0xe4deadbeef' });
    await expect(collectTreeCids(ctx, PUBLICATION)).resolves.toEqual([]);
  });

  it('walk failure → site-root still returned, no throw', async () => {
    const ls = vi.fn(async () => {
      throw new Error('ipfs down');
    });
    const ctx = makeCtx({ getEnsText: async () => rootContenthash, ls });

    const entries = await collectTreeCids(ctx, PUBLICATION);

    expect(entries).toEqual([{ cid: ROOT_CID, category: 'site-root', source: 'tree' }]);
  });

  it('dedupes exact duplicate entries', async () => {
    const child: LsEntry = { name: 'a.txt', hash: FILE_A, size: 10 };
    const ls = vi.fn(async (cid: string): Promise<LsEntry[]> =>
      cid === ROOT_CID ? [child, child] : [],
    );
    const ctx = makeCtx({ getEnsText: async () => rootContenthash, ls });

    const entries = await collectTreeCids(ctx, PUBLICATION);

    expect(entries.filter((e) => e.category === 'site-file')).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// collectArchiveCids
// ───────────────────────────────────────────────────────────────────────────

describe('collectArchiveCids', () => {
  const GEN_A =
    '0x1111111111111111111111111111111111111111111111111111111111111111';
  const GEN_B =
    '0x2222222222222222222222222222222222222222222222222222222222222222';

  it('decodes content_cache_<pub> → archive + parses Archive → archive-item entries keyed by genesis', async () => {
    const archive = {
      format: 's2s-publication-archive/2',
      publication: PUBLICATION,
      built: '2026-10-08T00:00:00.000Z',
      items: {
        [GEN_A]: {
          cid: ROOT_CID,
          item: {
            public: { title: 'Hello world' },
            objectId: 'a',
            proof: {
              type: 'eip712',
              signer: '0x1234567890123456789012345678901234567890',
              signature: '0xab',
            },
            encryption: true,
            body: '{}',
          },
        },
        // item without any title → role must be best-effort undefined
        [GEN_B]: { cid: DIR_CID, item: { objectId: 'b' } },
      },
    };
    const cat = vi.fn(async (cid: string) =>
      cid === FILE_A ? JSON.stringify(archive) : '',
    );
    const ctx = makeCtx({
      getEnsText: async (node, key) =>
        node === NODE && key === `content_cache_${PUBLICATION}`
          ? archiveContenthash
          : '',
      cat,
    });

    const entries = await collectArchiveCids(ctx, PUBLICATION);

    expect(entries).toContainEqual({ cid: FILE_A, category: 'archive', source: 'archive' });
    expect(entries).toContainEqual({
      cid: ROOT_CID,
      category: 'archive-item',
      source: 'archive',
      genesis: GEN_A,
      role: 'Hello world',
    });
    const genB = entries.find((e) => e.genesis === GEN_B);
    expect(genB).toMatchObject({
      cid: DIR_CID,
      category: 'archive-item',
      source: 'archive',
      genesis: GEN_B,
    });
    expect(genB?.role).toBeUndefined();
    expect(entries.filter((e) => e.category === 'archive')).toHaveLength(1);
    expect(entries.filter((e) => e.category === 'archive-item')).toHaveLength(2);
  });

  it('archive cat is invalid JSON → only the archive entry, no throw', async () => {
    const ctx = makeCtx({
      getEnsText: async () => archiveContenthash,
      cat: async () => 'not json {{{',
    });

    const entries = await collectArchiveCids(ctx, PUBLICATION);

    expect(entries).toEqual([{ cid: FILE_A, category: 'archive', source: 'archive' }]);
  });

  it('archive cat fails → only the archive entry, no throw', async () => {
    const ctx = makeCtx({
      getEnsText: async () => archiveContenthash,
      cat: async () => {
        throw new Error('ipfs down');
      },
    });

    const entries = await collectArchiveCids(ctx, PUBLICATION);

    expect(entries).toEqual([{ cid: FILE_A, category: 'archive', source: 'archive' }]);
  });

  it('missing content_cache record → []', async () => {
    const ctx = makeCtx({ getEnsText: async () => '' });
    await expect(collectArchiveCids(ctx, PUBLICATION)).resolves.toEqual([]);
  });
});
