import { describe, it, expect, vi } from 'vitest';
import { collectConfigCids, readConfigRoot } from './config';
import type { CidViewReadContext } from './context';

interface LsEntry {
  name: string;
  hash: string;
  size: number;
}

/** In-memory fake read context. Only the members a test exercises need values. */
function makeCtx(overrides: Partial<CidViewReadContext> = {}): CidViewReadContext {
  return {
    getDeals: vi.fn(() => Promise.resolve([])),
    getOffers: vi.fn(() => Promise.resolve([])),
    getVersions: vi.fn(() => Promise.resolve([])),
    getConfig: overrides.getConfig ?? (() => Promise.resolve({ cid: 'config-cid', config: {} })),
    dagGet: overrides.dagGet ?? (() => Promise.resolve([])),
    ls: overrides.ls ?? (() => Promise.resolve([])),
    cat: vi.fn(() => Promise.resolve('')),
    getEnsText: vi.fn(() => Promise.resolve('')),
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// readConfigRoot
// ───────────────────────────────────────────────────────────────────────────

describe('readConfigRoot', () => {
  it('successful getConfig → { ok: true, cid }', async () => {
    const ctx = makeCtx({
      getConfig: () => Promise.resolve({ cid: 'QmConfig', config: { name: 'pub.eth' } }),
    });
    await expect(readConfigRoot(ctx)).resolves.toEqual({
      ok: true,
      cid: 'QmConfig',
    });
  });

  it('getConfig throws → { ok: false, cid: "" }', async () => {
    const ctx = makeCtx({
      getConfig: () => {
        throw new Error('no config');
      },
    });
    await expect(readConfigRoot(ctx)).resolves.toEqual({ ok: false, cid: '' });
  });
});

describe('collectConfigCids', () => {
  it('emits the configCid as category "config"', async () => {
    const ctx = makeCtx({
      getConfig: () => Promise.resolve({ cid: 'QmConfig', config: { name: 'pub.eth' } }),
    });
    const result = await collectConfigCids(ctx);
    expect(result).toContainEqual({ cid: 'QmConfig', category: 'config', source: 'config' });
    expect(result.length).toBe(1);
  });

  it('emits template-dag plus a template entry per {path,cid} in the dagGet array', async () => {
    const templates = [
      { path: 'templates/post.hbs', cid: 'QmT1', body: 'x' },
      { path: 'templates/about/index.hbs', cid: 'QmT2' },
    ];
    const ctx = makeCtx({
      getConfig: () =>
        Promise.resolve({ cid: 'QmConfig', config: { templateCid: 'QmDag', assetsCid: '' } }),
      dagGet: () => Promise.resolve(templates),
    });
    const result = await collectConfigCids(ctx);
    expect(result).toContainEqual({ cid: 'QmDag', category: 'template-dag', source: 'config' });
    expect(result).toContainEqual({
      cid: 'QmT1',
      category: 'template',
      source: 'config',
      path: 'templates/post.hbs',
      role: 'templates/post.hbs',
    });
    expect(result).toContainEqual({
      cid: 'QmT2',
      category: 'template',
      source: 'config',
      path: 'templates/about/index.hbs',
      role: 'templates/about/index.hbs',
    });
  });

  it('emits assets-root and recursively walks the tree into asset entries with paths and sizes', async () => {
    const tree: Record<string, LsEntry[]> = {
      QmAssets: [
        { name: 'images', hash: 'QmDirImages', size: 0 },
        { name: 'style.css', hash: 'QmStyle', size: 123 },
      ],
      QmDirImages: [{ name: 'logo.png', hash: 'QmLogo', size: 456 }],
    };
    const ctx = makeCtx({
      getConfig: () =>
        Promise.resolve({ cid: 'QmConfig', config: { templateCid: '', assetsCid: 'QmAssets' } }),
      ls: (cid: string) => Promise.resolve(tree[cid] ?? []),
    });
    const result = await collectConfigCids(ctx);
    expect(result).toContainEqual({ cid: 'QmAssets', category: 'assets-root', source: 'config' });
    expect(result).toContainEqual({
      cid: 'QmStyle',
      category: 'asset',
      source: 'config',
      path: 'style.css',
      size: 123,
    });
    expect(result).toContainEqual({
      cid: 'QmLogo',
      category: 'asset',
      source: 'config',
      path: 'images/logo.png',
      size: 456,
    });
  });

  it('emits no template/asset entries for empty templateCid/assetsCid strings (no throw)', async () => {
    const ctx = makeCtx({
      getConfig: () =>
        Promise.resolve({ cid: 'QmConfig', config: { templateCid: '', assetsCid: '' } }),
      dagGet: vi.fn(() => {
        throw new Error('should not be called');
      }),
      ls: vi.fn(() => {
        throw new Error('should not be called');
      }),
    });
    const result = await collectConfigCids(ctx);
    expect(result).toEqual([{ cid: 'QmConfig', category: 'config', source: 'config' }]);
  });

  it('still emits template-dag when dagGet throws (no template entries, no throw)', async () => {
    const ctx = makeCtx({
      getConfig: () =>
        Promise.resolve({ cid: 'QmConfig', config: { templateCid: 'QmDag', assetsCid: '' } }),
      dagGet: () => {
        throw new Error('dag unavailable');
      },
    });
    const result = await collectConfigCids(ctx);
    expect(result).toContainEqual({ cid: 'QmDag', category: 'template-dag', source: 'config' });
    expect(result.filter((e) => e.category === 'template')).toEqual([]);
  });

  it('returns [] when getConfig throws', async () => {
    const ctx = makeCtx({
      getConfig: () => {
        throw new Error('no config');
      },
    });
    const result = await collectConfigCids(ctx);
    expect(result).toEqual([]);
  });

  it('uses a legacy dagGet object wrapping the array under `templates`', async () => {
    const ctx = makeCtx({
      getConfig: () =>
        Promise.resolve({ cid: 'QmConfig', config: { templateCid: 'QmDag', assetsCid: '' } }),
      dagGet: () => Promise.resolve({ templates: [{ path: 'templates/a.hbs', cid: 'QmTA' }] }),
    });
    const result = await collectConfigCids(ctx);
    expect(result).toContainEqual({
      cid: 'QmTA',
      category: 'template',
      source: 'config',
      path: 'templates/a.hbs',
      role: 'templates/a.hbs',
    });
  });

  it('keeps the config entry (and prior entries) when the config is not an object', async () => {
    const ctx = makeCtx({
      getConfig: () => Promise.resolve({ cid: 'QmConfig', config: 'not-an-object' }),
    });
    const result = await collectConfigCids(ctx);
    expect(result).toEqual([{ cid: 'QmConfig', category: 'config', source: 'config' }]);
  });

  it('treats a branch whose ls throws as a leaf (asset emitted, walk continues, no throw)', async () => {
    const tree: Record<string, LsEntry[]> = {
      QmAssets: [
        { name: 'broken', hash: 'QmBroken', size: 0 },
        { name: 'ok.txt', hash: 'QmOk', size: 7 },
      ],
    };
    const ctx = makeCtx({
      getConfig: () =>
        Promise.resolve({ cid: 'QmConfig', config: { templateCid: '', assetsCid: 'QmAssets' } }),
      ls: (cid: string) => {
        if (cid === 'QmBroken') throw new Error('read failed');
        return Promise.resolve(tree[cid] ?? []);
      },
    });
    const result = await collectConfigCids(ctx);
    expect(result).toContainEqual({ cid: 'QmAssets', category: 'assets-root', source: 'config' });
    // the throwing node is treated as a leaf: emitted as an asset (size from the parent listing)
    expect(result).toContainEqual({
      cid: 'QmBroken',
      category: 'asset',
      source: 'config',
      path: 'broken',
      size: 0,
    });
    // sibling still emitted; no recursion below the broken node
    expect(result).toContainEqual({
      cid: 'QmOk',
      category: 'asset',
      source: 'config',
      path: 'ok.txt',
      size: 7,
    });
  });

  it('refactor regression: still emits config + template-dag + assets-root via readConfigRoot', async () => {
    const tree: Record<string, LsEntry[]> = {
      QmAssets: [{ name: 'style.css', hash: 'QmStyle', size: 123 }],
    };
    const ctx = makeCtx({
      getConfig: () =>
        Promise.resolve({
          cid: 'QmConfig',
          config: { templateCid: 'QmDag', assetsCid: 'QmAssets' },
        }),
      dagGet: () => Promise.resolve([{ path: 'templates/post.hbs', cid: 'QmT1' }]),
      ls: (cid: string) => Promise.resolve(tree[cid] ?? []),
    });
    const result = await collectConfigCids(ctx);
    expect(result).toContainEqual({ cid: 'QmConfig', category: 'config', source: 'config' });
    expect(result).toContainEqual({ cid: 'QmDag', category: 'template-dag', source: 'config' });
    expect(result).toContainEqual({
      cid: 'QmT1',
      category: 'template',
      source: 'config',
      path: 'templates/post.hbs',
      role: 'templates/post.hbs',
    });
    expect(result).toContainEqual({ cid: 'QmAssets', category: 'assets-root', source: 'config' });
    expect(result).toContainEqual({
      cid: 'QmStyle',
      category: 'asset',
      source: 'config',
      path: 'style.css',
      size: 123,
    });
  });
});
