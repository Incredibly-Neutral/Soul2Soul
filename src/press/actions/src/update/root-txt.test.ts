/**
 * Root-txt tests — evm-update action (`update/main.ts`).
 *
 * The site repo carries static text files at `assets/txt/`. The assets builder
 * mirrors the whole `assets/` tree verbatim into `assetsCid`, so those files
 * arrive under `<mfsPath>/assets/txt/<name>` (served at `/assets/txt/<name>`).
 * The update action additionally mirrors every FILE in that directory to the
 * tree root, so `/robots.txt` and `/llms.txt` resolve.
 *
 * Covered here:
 *   (a) a file in assets/txt is copied to the tree root, from the assets/txt
 *       path itself, and only ever to the root;
 *   (b) an existing root entry is removed before the cp (kubo cp doesn't overwrite);
 *   (c) a root index.html is skipped in any casing, and a name that is not a
 *       single path segment (. / .. / containing "/") is refused;
 *   (d) a page whose slug is the txt name owns a DIRECTORY at the root — the
 *       page wins (skip, no recursive rm, no throw, no wedge);
 *   (e) a MISSING assets/txt directory is non-fatal, while a FAILED ls call is
 *       fatal (a broken call must not look like "this site has no txt");
 *   (f) a root txt name the previous tree carried but the new assets/txt does
 *       not is removed from the root — including when the config has lost its
 *       assetsCid — but a root index.html is never a removal target;
 *   (g) the root txt copy is issued BEFORE the root stat, so it is part of the
 *       new root CID;
 *   plus a non-preview publish (the gate is not preview-only) and a reset run.
 *
 * The action's on-chain read modules are mocked exactly as in reset.test.ts;
 * the kubo gateway is stubbed via the global `fetch` so the mirror is observed
 * through the recorded gateway URLs. The first `files/ls` of assets/txt is the
 * PREVIOUS tree (before the assets copy replaces it), the second is the new one.
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
  // assets/txt in the PREVIOUS tree (read before the assets copy replaces it).
  // Default: the directory is not there (fresh tree / site without txt).
  prevTxtEntries: [] as any[],
  prevTxtStatus: 500,
  prevTxtBody: 'file does not exist',
  // assets/txt in the NEW assets tree.
  txtEntries: [] as any[],
  txtStatus: 200,
  txtBody: 'file does not exist',
  // Root-relative paths that already exist in the temp tree, and their kind.
  rootEntries: {} as Record<string, 'file' | 'dir'>,
  txtLsCalls: 0,
  // Set when the new /assets cp has been issued: the assets/txt ls AFTER it is
  // the new tree, the one BEFORE it is the previous tree.
  assetsCopied: false,
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
  // No page at any destination — every job is an ADD.
  readPageIdentity: vi.fn(async () => null),
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

const errorBody = (message: string): string =>
  JSON.stringify({ Message: message, Code: 0, Type: 'error' });

const gatewayResponse = (url: string): Response => {
  const [arg = ''] = argsOf(url);

  if (url.includes('files/ls')) {
    if (arg.endsWith('/assets/txt')) {
      mocks.txtLsCalls += 1;
      const isPrev = !mocks.assetsCopied;
      const status = isPrev ? mocks.prevTxtStatus : mocks.txtStatus;
      const entries = isPrev ? mocks.prevTxtEntries : mocks.txtEntries;
      const body = isPrev ? mocks.prevTxtBody : mocks.txtBody;
      if (status !== 200) return new Response(errorBody(body), { status });
      return new Response(JSON.stringify({ Entries: entries }), { status: 200 });
    }
    // Debug ls of the whole tree.
    return new Response(JSON.stringify({ Entries: [] }), { status: 200 });
  }

  if (url.includes('files/cp')) {
    const args = argsOf(url);
    if (args.length === 2 && relOf(args[1]) === '/assets') mocks.assetsCopied = true;
    return new Response('{}', { status: 200 });
  }

  if (url.includes('files/stat')) {
    // The root itself → the new CID.
    if (/^\/temp-\d+$/.test(arg)) {
      return new Response(JSON.stringify({ Hash: 'QmNewRoot' }), { status: 200 });
    }
    const rel = relOf(arg);
    const kind = mocks.rootEntries[rel];
    if (kind === 'dir') {
      // Kubo reports a directory as Type 1 / "directory".
      return new Response(JSON.stringify({ Hash: 'QmPageDir', Type: 1 }), { status: 200 });
    }
    if (kind === 'file') {
      return new Response(JSON.stringify({ Hash: 'QmExisting', Type: 'file' }), { status: 200 });
    }
    return new Response(errorBody('file does not exist'), { status: 500 });
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

/** Every cp/rm call that touches `rel`, whatever the operation. */
const mutationsOf = (rel: string): number[] =>
  mocks.gatewayUrls
    .map((u, i) => ({ u, i }))
    .filter(
      ({ u }) =>
        (u.includes('files/cp') || u.includes('files/rm')) &&
        argsOf(u).some((a) => relOf(a) === rel),
    )
    .map(({ i }) => i);

beforeEach(() => {
  mocks.gatewayUrls = [];
  mocks.prevEncoded = '0xe30101701220' + 'ab'.repeat(32);
  mocks.prevAliasesJson = '';
  mocks.canPublish = true;
  mocks.canReset = true;
  mocks.config = { assetsCid: 'QmAssets' };
  mocks.evmWriteResult = { success: true };
  mocks.prevTxtEntries = [];
  mocks.prevTxtStatus = 500; // fresh tree: no previous assets/txt
  mocks.prevTxtBody = 'file does not exist';
  mocks.txtEntries = [];
  mocks.txtStatus = 200;
  mocks.txtBody = 'file does not exist';
  mocks.rootEntries = {};
  mocks.txtLsCalls = 0;
  mocks.assetsCopied = false;
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
  it('(a) copies a file from assets/txt to the tree root, and nowhere else', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    const cp = cpTo('/robots.txt');
    expect(cp.length).toBe(1);
    // Source is the assets/txt file itself (a mirror, not a re-fetch)…
    const args = argsOf(mocks.gatewayUrls[cp[0]]);
    expect(relOf(args[0])).toBe('/assets/txt/robots.txt');
    expect(relOf(args[1])).toBe('/robots.txt');
    expect(mocks.gatewayUrls[cp[0]]).toContain('parents=false');
    expect(mocks.gatewayUrls[cp[0]]).toContain('flush=false');
    // …and the only destination is the root (the page copy is a separate call).
    for (const i of cp) {
      expect(relOf(argsOf(mocks.gatewayUrls[i])[1])).toBe('/robots.txt');
    }
    expect(result.trace.some((t: string) => t.includes('✓ root txt robots.txt'))).toBe(true);
  });

  it('(b) removes an existing root entry before the cp (kubo cp does not overwrite)', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    mocks.rootEntries['/robots.txt'] = 'file'; // previous-root copy put it there
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    const rm = rmOf('/robots.txt');
    const cp = cpTo('/robots.txt');
    expect(rm.length).toBe(1);
    expect(cp.length).toBe(1);
    expect(rm[0]).toBeLessThan(cp[0]);
    expect(result.trace.some((t: string) => t.includes('rm existing root robots.txt'))).toBe(true);
  });

  it('(c) skips a root index.html in any casing, and mirrors its sibling', async () => {
    mocks.txtEntries = [txtFile('index.html'), txtFile('INDEX.HTML'), txtFile('llms.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    expect(mutationsOf('/index.html')).toEqual([]);
    expect(
      result.trace.filter((t: string) => t.includes('root index.html is reserved')).length,
    ).toBe(2);
    expect(cpTo('/llms.txt').length).toBe(1);
  });

  it('(c) refuses a name that is not a single path segment, before it touches a path', async () => {
    mocks.txtEntries = [
      txtFile('../evil.txt'),
      txtFile('a/b.txt'),
      txtFile('..'),
      txtFile('.'),
      txtFile('robots.txt'),
    ];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    // Nothing targets a traversal-shaped root path…
    expect(indicesOf('files/cp', (a) => a.some((x) => x.includes('evil')))).toEqual([]);
    expect(indicesOf('files/rm', (a) => a.some((x) => x.includes('evil')))).toEqual([]);
    expect(mutationsOf('/a/b.txt')).toEqual([]);
    // …they are traced as refused…
    expect(result.trace.filter((t: string) => t.includes('not a file name')).length).toBe(4);
    // …and the ordinary file in the same directory still lands.
    expect(cpTo('/robots.txt').length).toBe(1);
  });

  it('(d) a page occupying the path wins: skip, no recursive rm, no throw, no wedge', async () => {
    // A page at slug "robots.txt" is a DIRECTORY at <root>/robots.txt.
    mocks.txtEntries = [txtFile('robots.txt')];
    mocks.rootEntries['/robots.txt'] = 'dir';
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    expect(mutationsOf('/robots.txt')).toEqual([]); // neither rm'd nor cp'd
    expect(
      result.trace.some((t: string) => t.includes('skip root txt robots.txt: a page occupies')),
    ).toBe(true);
    // Never recursive over a root txt path — a page directory is never deleted.
    // The two legitimate recursive rms are the /assets swap and the finally
    // block dropping the whole temp tree (rel '/'), both skipped here.
    for (const i of indicesOf('files/rm')) {
      const [target = ''] = argsOf(mocks.gatewayUrls[i]);
      const rel = relOf(target);
      // Finally-block temp-tree drop ('/temp-<ts>', which relOf collapses) and
      // the /assets swap.
      if (/^\/temp-\d+$/.test(target) || rel === '' || rel === '/assets') continue;
      expect(mocks.gatewayUrls[i]).not.toContain('recursive=true');
    }
  });

  it('(g) the root txt copy is issued before the root stat — it is in the new root CID', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    const cp = cpTo('/robots.txt');
    const rootStat = rootStatIndex();
    expect(cp.length).toBe(1);
    expect(rootStat).toBeDefined();
    expect(cp[0]).toBeLessThan(rootStat!);
    expect(cp[0]).toBeLessThan(indicesOf('pin/add')[0] ?? Number.MAX_SAFE_INTEGER);
    expect(result.data.cid).toBe('QmNewRoot');
  });
});

describe('evm-update — assets/txt ls: absent directory vs failed call', () => {
  it('(e) a MISSING assets/txt directory is traced and does not fail the publish', async () => {
    mocks.txtStatus = 500;
    mocks.txtBody = 'file does not exist';
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    expect(result.data.cid).toBe('QmNewRoot');
    expect(cpTo('/robots.txt').length).toBe(0);
    // The absent-directory wording, which a failed call never produces.
    expect(result.trace.some((t: string) => /^no .*assets\/txt: no root txt files$/.test(t))).toBe(
      true,
    );
  });

  it('(e) a FAILED ls (401 from the token gate) throws — it is not read as "no txt"', async () => {
    mocks.txtStatus = 401;
    mocks.txtBody = 'invalid auth token';
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Failed to ls');
    expect(result.error).toContain('401');
    expect(result.error).toContain('invalid auth token');
  });

  it('(e) a failed ls of the PREVIOUS tree also throws — the stale set is unknown', async () => {
    mocks.prevTxtStatus = 502;
    mocks.prevTxtBody = 'Bad Gateway';
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Failed to ls');
    expect(result.error).toContain('502');
  });
});

describe('evm-update — stale root txt cleanup', () => {
  it('removes a root txt name the new assets/txt no longer carries', async () => {
    mocks.prevTxtStatus = 200;
    mocks.prevTxtEntries = [txtFile('robots.txt'), txtFile('llms.txt')];
    mocks.txtEntries = [txtFile('llms.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    expect(rmOf('/robots.txt').length).toBe(1);
    // The surviving name is re-copied, not removed then re-added twice.
    expect(rmOf('/llms.txt')).toEqual([]);
    expect(result.trace.some((t: string) => t.includes('rm stale root robots.txt'))).toBe(true);
  });

  it('clears the old root txt when the config has lost its assetsCid altogether', async () => {
    mocks.config = {}; // no assetsCid → nothing to mirror…
    mocks.prevTxtStatus = 200;
    mocks.prevTxtEntries = [txtFile('robots.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    expect(rmOf('/robots.txt').length).toBe(1); // …but the stale copy still goes
    // Only the PREVIOUS-tree ls ran: the mirror block did not.
    expect(mocks.txtLsCalls).toBe(1);
  });

  it('never removes a root index.html, even if the old assets/txt held one', async () => {
    mocks.prevTxtStatus = 200;
    mocks.prevTxtEntries = [txtFile('index.html')];
    mocks.rootEntries['/index.html'] = 'file';
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    expect(mutationsOf('/index.html')).toEqual([]);
    expect(
      result.trace.some((t: string) =>
        t.includes('skip stale root txt index.html: root index.html'),
      ),
    ).toBe(true);
  });

  it('a failed stale rm is a trace, never a throw', async () => {
    mocks.prevTxtStatus = 200;
    mocks.prevTxtEntries = [txtFile('robots.txt')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        mocks.gatewayUrls.push(url);
        if (url.includes('files/rm') && argsOf(url).some((a) => relOf(a) === '/robots.txt')) {
          return new Response(errorBody('cannot delete: target is a directory'), { status: 500 });
        }
        return gatewayResponse(url);
      }),
    );

    const result: any = await main({ ...baseInput, signature: await makeSignature() });
    expect(result.ok).toBe(true);
    expect(
      result.trace.some((t: string) => t.includes('warn: rm stale root robots.txt failed')),
    ).toBe(true);
  });
});

describe('evm-update — root txt outside the preview path', () => {
  it('mirrors on a non-preview publish (the gate is not preview-only)', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({
      ...baseInput,
      preview: false,
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(cpTo('/robots.txt').length).toBe(1);
    expect(result.data.cid).toBe('QmNewRoot');
  });

  it('mirrors on a reset run (fresh tree, no previous assets/txt to clear)', async () => {
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({
      ...baseInput,
      reset: true,
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(cpTo('/robots.txt').length).toBe(1);
    expect(rmOf('/robots.txt')).toEqual([]); // nothing stale in a fresh tree
    // The reset branch still never copies the previous root.
    expect(indicesOf('arg=/ipfs/QmPrevRoot')).toEqual([]);
    expect(result.data.cid).toBe('QmNewRoot');
  });
});

describe('evm-update — root txt copy failure', () => {
  it('throws when copying a root txt file fails (a publish never keeps a stale file)', async () => {
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

  it('does not run the mirror when the config has no assetsCid (no assets → no txt)', async () => {
    mocks.config = {};
    mocks.txtEntries = [txtFile('robots.txt')];
    const result: any = await main({ ...baseInput, signature: await makeSignature() });

    expect(result.ok).toBe(true);
    expect(cpTo('/robots.txt').length).toBe(0);
    expect(mocks.txtLsCalls).toBe(1); // only the previous-tree probe
  });
});
