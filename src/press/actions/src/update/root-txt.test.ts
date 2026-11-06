/**
 * Root-txt tests — evm-update action (`update/main.ts`).
 *
 * The site repo carries static text files at `assets/txt/*.txt`. The assets
 * builder mirrors the whole `assets/` tree verbatim into `assetsCid`, so those
 * files arrive under `<mfsPath>/assets/txt/<name>` (served at
 * `/assets/txt/<name>`). The update action additionally mirrors every FILE in
 * that directory to the tree root, so `/robots.txt` and `/llms.txt` resolve.
 *
 * Covered here:
 *   (a) a txt file in assets/txt is copied to the tree root;
 *   (b) an existing root entry is removed before the cp (Kubo cp doesn't overwrite);
 *   (c) an index.html entry in assets/txt is skipped — no cp ever targets the
 *       root front page, in any casing;
 *   (d) a missing assets/txt directory (ls not ok) is non-fatal;
 *   (e) the root txt copy is issued BEFORE the root stat, so it is part of the
 *       new root CID.
 *
 * The action's on-chain read modules are mocked exactly as in reset.test.ts;
 * the kubo gateway is stubbed via the global `fetch` so the mirror is observed
 * through the recorded gateway URLs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ethers from 'ethers5'; // protocol's v5 alias — the action runs against ethers v5 semantics

// The action references the Lit-runtime-injected global `ethers`
// (action_globals.ts); point it at the real ethers v5 so the real
// extractSignerAddress / namehash run unmocked.
(globalThis as { ethers?: unknown }).ethers = ethers;

// ===========================================================================
// Controllable mocks — hoisted so the vi.mock factories can read them.
// ===========================================================================

const mocks = vi.hoisted(() => ({
  prevEncoded: '0xe30101701220' + 'ab'.repeat(32), // non-empty contenthash_wrapped
  prevAliasesJson: '',
  canPublish: true,
  canReset: true,
  gatewayUrls: [] as string[],
  config: { assetsCid: 'QmAssets' } as any,
  evmWriteResult: { success: true } as any,
  // assets/txt directory: entries returned by files/ls, and whether the ls
  // itself succeeds (a site without an assets/txt dir → 404/500).
  txtEntries: [] as any[],
  txtDirOk: true,
  // Root-relative paths (/robots.txt, /index.html, …) that already exist in
  // the temp tree (i.e. the previous-root copy put them there).
  rootEntries: {} as Record<string, boolean>,
}));

vi.mock('../libs/ens.factory', () => ({
  getDomainOwnerAndModules: vi.fn(async () => ({
    multisig: '0x' + '11'.repeat(20),
    configModule: '0x' + '22'.repeat(20),
    publicationModule: '0x' + '33'.repeat(20),
  })),
}));

vi.mock('../libs/protocol.factory', () => ({
  getProtocolInfo: vi.fn(async () => ({
    pkp: '0x' + '44'.repeat(20),
    ensRecords: '0x' + '55'.repeat(20),
  })),
}));

vi.mock('../render/config.ctrl', () => ({
  getConfig: vi.fn(async () => mocks.config),
}));

vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(async (chain: string, addr: string, abi: unknown, method: string, args: any[]) => {
    if (method === 'getText' && args?.[1] === 'aliases') {
      return mocks.prevAliasesJson;
    }
    return mocks.prevEncoded;
  }),
  evmWrite: vi.fn(async () => mocks.evmWriteResult),
  toHexString: (cid: string) => '0x' + cid,
}));

vi.mock('../libs/ipfs.factory', () => ({
  contenthashToIPFS: vi.fn(() => 'QmPrevRoot'),
}));

vi.mock('../libs/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/gates')>();
  return {
    ...actual,
    canPublish: vi.fn(async () => mocks.canPublish),
    canReset: vi.fn(async () => mocks.canReset),
  };
});

vi.mock('./verify', () => ({
  verifyProvenance: vi.fn(async () => {}),
  verifyPathAvailable: vi.fn(async () => {}),
  verifyRevocable: vi.fn(async () => {}),
  sanitizeRemovePath: (p: string) => p,
}));

// ===========================================================================
// Kubo gateway stub — records every URL, answers per path.
// ===========================================================================

/** The `arg=` values of a gateway URL, decoded, in order. */
const argsOf = (url: string): string[] =>
  (url.split('?')[1] ?? '')
    .split('&')
    .filter((p) => p.startsWith('arg='))
    .map((p) => decodeURIComponent(p.slice('arg='.length)));

/** Strip the run's `/temp-<ts>` prefix → the tree-relative path. */
const relOf = (mfsPath: string): string =>
  mfsPath.replace(/^\/temp-\d+/, '').replace(/\/{2,}/g, '/');

const gatewayResponse = (url: string): Response => {
  const [arg = ''] = argsOf(url);

  if (url.includes('files/ls')) {
    if (arg.endsWith('/assets/txt')) {
      if (!mocks.txtDirOk) return new Response('file does not exist', { status: 500 });
      return new Response(JSON.stringify({ Entries: mocks.txtEntries }), { status: 200 });
    }
    // Debug ls of the whole tree.
    return new Response(JSON.stringify({ Entries: [] }), { status: 200 });
  }

  if (url.includes('files/stat')) {
    // The root itself → the new CID.
    if (/^\/temp-\d+$/.test(arg)) {
      return new Response(JSON.stringify({ Hash: 'QmNewRoot' }), { status: 200 });
    }
    const rel = relOf(arg);
    if (mocks.rootEntries[rel]) {
      return new Response(JSON.stringify({ Hash: 'QmExisting' }), { status: 200 });
    }
    return new Response('file does not exist', { status: 500 });
  }

  return new Response('{}', { status: 200 });
};

// ===========================================================================
// Test subject
// ===========================================================================

import { main } from './main';

const gateway = 'http://gateway.test';

const sampleJob = {
  id: '0x' + '33'.repeat(32),
  templateConfig: { reference: 'post', file: 'post.hbs', path: '/{slug}' },
  html: 'QmRenderedHtml',
  path: '/hello-world',
};

const baseInput = {
  publication: 'alice.soul2soul.eth',
  // A publish always carries at least one job (or a remove/reset).
  jobs: [sampleJob] as any[],
  authorSafeAddress: '0x' + 'aa'.repeat(20),
  preview: true,
  endpoints: {
    ipfsGateway: gateway,
    rpcs: { L1: ['http://rpc.l1'], L2: ['http://rpc.l2'] },
  },
};

const makeSignature = async (): Promise<string> => {
  const wallet = new ethers.Wallet('0x' + '11'.repeat(32));
  return wallet.signMessage('lit actions auth');
};

/** Indices of recorded gateway URLs matching `needle` (and, optionally, args). */
const indicesOf = (needle: string, argTest?: (args: string[]) => boolean): number[] =>
  mocks.gatewayUrls
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.includes(needle) && (!argTest || argTest(argsOf(u))))
    .map(({ i }) => i);

/** Indices of `files/cp` calls whose destination (2nd arg) is `rel`. */
const cpTo = (rel: string): number[] =>
  indicesOf('files/cp', (args) => args.length === 2 && relOf(args[1]) === rel);

/** Indices of `files/rm` calls targeting `rel`. */
const rmOf = (rel: string): number[] =>
  indicesOf('files/rm', (args) => args.length > 0 && relOf(args[0]) === rel);

/** Index of the `files/stat` on the tree root itself. */
const rootStatIndex = (): number | undefined =>
  indicesOf('files/stat', (args) => /^\/temp-\d+$/.test(args[0] ?? ''))[0];

beforeEach(() => {
  mocks.gatewayUrls = [];
  mocks.prevEncoded = '0xe30101701220' + 'ab'.repeat(32);
  mocks.prevAliasesJson = '';
  mocks.canPublish = true;
  mocks.canReset = true;
  mocks.config = { assetsCid: 'QmAssets' };
  mocks.evmWriteResult = { success: true };
  mocks.txtEntries = [];
  mocks.txtDirOk = true;
  mocks.rootEntries = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      mocks.gatewayUrls.push(url);
      return gatewayResponse(url);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const txtFile = (name: string) => ({ Name: name, Type: 0, Size: 12, Hash: 'QmTxt' });

describe('evm-update — assets/txt mirror to the site root', () => {
  it('(a) copies a txt file from assets/txt to the tree root', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    const cp = cpTo('/robots.txt');
    expect(cp.length).toBe(1);
    // Source is the assets/txt file itself (a mirror, not a re-fetch).
    const args = argsOf(mocks.gatewayUrls[cp[0]]);
    expect(relOf(args[0])).toBe('/assets/txt/robots.txt');
    expect(relOf(args[1])).toBe('/robots.txt');
    expect(mocks.gatewayUrls[cp[0]]).toContain('parents=false');
    expect(mocks.gatewayUrls[cp[0]]).toContain('flush=false');
    // The assets tree itself is untouched (still served at /assets/txt/...).
    expect(relOf(args[0])).toContain('/assets/txt/');
    expect(result.trace.some((t: string) => String(t).includes('✓ root txt robots.txt'))).toBe(
      true,
    );
  });

  it('(b) removes an existing root entry before the cp (kubo cp does not overwrite)', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    mocks.rootEntries['/robots.txt'] = true; // previous-root copy put it there
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    const rm = rmOf('/robots.txt');
    const cp = cpTo('/robots.txt');
    expect(rm.length).toBe(1);
    expect(cp.length).toBe(1);
    expect(rm[0]).toBeLessThan(cp[0]);
    expect(
      result.trace.some((t: string) => String(t).includes('rm existing root robots.txt')),
    ).toBe(true);
  });

  it('(c) skips an index.html entry in assets/txt — the root front page is never a target', async () => {
    mocks.txtEntries = [txtFile('index.html'), txtFile('INDEX.HTML'), txtFile('llms.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    // No cp (or rm) anywhere touches the root index.html, whatever the casing.
    const indexTargets = mocks.gatewayUrls.filter((u) => {
      if (!u.includes('files/cp') && !u.includes('files/rm')) return false;
      return argsOf(u).some((a) => relOf(a).toLowerCase() === '/index.html');
    });
    expect(indexTargets).toEqual([]);
    expect(
      result.trace.filter((t: string) => String(t).includes('root index.html is reserved')).length,
    ).toBe(2);
    // The non-colliding sibling in the same directory is still mirrored.
    expect(cpTo('/llms.txt').length).toBe(1);
  });

  it('(c2) never copies a txt entry onto a job path either (only the root)', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    for (const i of cpTo('/robots.txt')) {
      expect(relOf(argsOf(mocks.gatewayUrls[i])[1])).toBe('/robots.txt');
    }
    // The page copy still happened.
    expect(cpTo('/hello-world/index.html').length).toBe(1);
  });

  it('(d) a missing assets/txt directory does not throw and the publish still succeeds', async () => {
    mocks.txtDirOk = false; // ls → not ok
    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(result.data.cid).toBe('QmNewRoot');
    expect(cpTo('/robots.txt').length).toBe(0);
    expect(result.trace.some((t: string) => String(t).includes('no '))).toBe(true);
  });

  it('(e) the root txt copy is issued before the root stat — it is in the new root CID', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    const cp = cpTo('/robots.txt');
    const rootStat = rootStatIndex();
    expect(cp.length).toBe(1);
    expect(rootStat).toBeDefined();
    expect(cp[0]).toBeLessThan(rootStat!);
    // …and before the pin of the resulting root.
    expect(cp[0]).toBeLessThan(indicesOf('pin/add')[0] ?? Number.MAX_SAFE_INTEGER);
    expect(result.data.cid).toBe('QmNewRoot');
  });

  it('does not run when the config has no assetsCid (no assets → no txt)', async () => {
    mocks.config = {}; // no assetsCid
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    expect(indicesOf('files/ls', (a) => (a[0] ?? '').endsWith('/assets/txt')).length).toBe(0);
    expect(cpTo('/robots.txt').length).toBe(0);
  });

  it('throws when copying a root txt file fails (a publish never silently keeps a stale file)', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        mocks.gatewayUrls.push(url);
        if (url.includes('files/cp') && argsOf(url).some((a) => relOf(a) === '/robots.txt')) {
          return new Response('context deadline exceeded', { status: 500 });
        }
        return gatewayResponse(url);
      }),
    );

    const result: any = await main({ ...baseInput, signature: await makeSignature() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Failed to cp root txt robots.txt');
  });
});
