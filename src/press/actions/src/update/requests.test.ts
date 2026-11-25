/**
 * Request-count tests — evm-update action (`update/main.ts`).
 *
 * One Lit Action invocation is one session with a hard cap of 50 `fetch` calls
 * against Kubo and the RPC, so the action must not ask the same question twice.
 * These tests pin the reductions that are observable at the gateway:
 *
 *   (1) the destination is read ONCE (`files/read`) and answers both "is a page
 *       there / which identity does it claim" and "are these already the source
 *       bytes" — no second `files/stat` or `files/ls` is spent when the bytes
 *       decide it, and none at all on a fresh tree;
 *   (2) the source page is cat'd once per job, and the provenance check takes
 *       the same bytes the byte comparison uses;
 *   (3) unchanged assets are neither removed nor re-copied, and their assets/txt
 *       listing is reused instead of re-read;
 *   (4) a root txt file already at the root with the assets/txt file's hash is
 *       not removed and re-copied;
 *   (5) a stale root txt file the root listing does not carry is not rm'd.
 *
 * `verifyProvenance` is mocked (a real PKP signature cannot be produced here)
 * but it consumes the prefetched bytes, so the shared cat is observed. Every
 * other part of `./verify` is real, against the stubbed gateway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ethers from 'ethers5'; // protocol's v5 alias — the action runs against ethers v5 semantics

// The action references the Lit-runtime-injected global `ethers`
// (action_globals.ts); point it at the real ethers v5 so the real namehash and
// extractSignerAddress run unmocked.
(globalThis as { ethers?: unknown }).ethers = ethers;

const GENESIS = '0x' + '33'.repeat(32);
const SOURCE_CID = 'QmRenderedHtml';

// ===========================================================================
// Controllable mocks — hoisted so the vi.mock factories can read them.
// ===========================================================================

const mocks = vi.hoisted(() => ({
  prevEncoded: '0xe30101701220' + 'ab'.repeat(32), // an existing tree to copy
  canPublish: true,
  canReset: true,
  gatewayUrls: [] as string[],
  config: { assetsCid: 'QmAssets' } as any,
  evmWriteResult: { success: true } as any,
  /** The source page's bytes, as `api/v0/cat` answers them. */
  sourceHtml: '',
  /** What the mocked verifyProvenance saw in its prefetched-html argument. */
  provenanceSawHtml: '',
  /** Tree-relative destination path → what `files/read` answers. */
  destinations: {} as Record<string, { text?: string; status?: number; body?: string }>,
  /** Page directory (tree-relative) → `Name → Hash` for the `files/ls` of it. */
  pageHashes: {} as Record<string, Record<string, string>>,
  /** The tree root, as one `files/ls` reports it. */
  rootEntries: {} as Record<string, { Type?: number; Hash?: string }>,
  /** assets/txt in the PREVIOUS tree. */
  prevTxtEntries: [] as any[] | null,
  /** assets/txt in the assets tree the copy installed. */
  txtEntries: [] as any[] | null,
  assetsCopied: false,
  txtLsCalls: 0,
  lsDirs: [] as string[],
  reads: [] as string[],
  catCalls: 0,
}));

vi.mock('../libs/ens.factory', () => ({
  getDomainOwnerAndModules: vi.fn(async () => ({
    multisig: '0x' + '11'.repeat(20),
    configModule: '0x' + '22'.repeat(20),
    publicationModule: '0x' + '44'.repeat(20),
  })),
}));

vi.mock('../libs/protocol.factory', () => ({
  getManifest: vi.fn(async () => ({
    pkp: '0x' + '55'.repeat(20),
    ensRecords: '0x' + '66'.repeat(20),
    moduleFactory: '0x' + '77'.repeat(20),
  })),
}));

vi.mock('../render/config.ctrl', () => ({
  getConfig: vi.fn(async () => mocks.config),
}));

vi.mock('../libs/evm', () => ({
  enableReadCache: vi.fn(),
  evmRead: vi.fn(async (chain: string, addr: string, abi: unknown, method: string, args: any[]) => {
    if (method === 'getText' && args?.[1] === 'aliases') return '';
    // No agreement on the existing page: the path gate allows the overwrite.
    if (method === 'hasAgreement') return false;
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
    isOutOfForce: vi.fn(async () => true),
  };
});

vi.mock('./verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify')>();
  return {
    ...actual,
    // The real gate needs a PKP signature. The stub consumes the prefetched
    // bytes exactly as the real one does, so a second cat would show up as
    // catCalls > 1 — which is the point of this file.
    verifyProvenance: vi.fn(
      async (
        _cid: string,
        _genesis: string,
        _pkp: string,
        _gw: string,
        _trace: unknown,
        prefetched?: Promise<string>,
      ) => {
        if (prefetched) mocks.provenanceSawHtml = await prefetched;
        return {
          identifier: GENESIS,
          authorDid: '0x' + 'bb'.repeat(20),
          canonicalization: 'JCS-RFC8785' as const,
          signed: true,
          sha256: 'deadbeef',
        };
      },
    ),
  };
});

// ===========================================================================
// Kubo gateway stub — records every URL, answers by the path it names.
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

  if (url.includes('/api/v0/cat')) {
    mocks.catCalls += 1;
    return new Response(mocks.sourceHtml, { status: 200 });
  }

  if (url.includes('files/read')) {
    const rel = relOf(arg);
    mocks.reads.push(rel);
    const dest = mocks.destinations[rel];
    if (!dest) return new Response(errorBody('file does not exist'), { status: 500 });
    if (dest.status && dest.status !== 200) {
      return new Response(dest.body ?? 'unreadable', { status: dest.status });
    }
    return new Response(dest.text ?? '', { status: 200 });
  }

  if (url.includes('files/ls')) {
    const rel = relOf(arg);
    mocks.lsDirs.push(rel);
    if (rel === '/assets/txt') {
      mocks.txtLsCalls += 1;
      // Before the assets copy, this is the previous tree; after it, the tree
      // the copy installed. `null` is Kubo's "file does not exist".
      const entries = mocks.assetsCopied ? mocks.txtEntries : mocks.prevTxtEntries;
      if (entries === null) return new Response(errorBody('file does not exist'), { status: 500 });
      return new Response(JSON.stringify({ Entries: entries }), { status: 200 });
    }
    if (rel === '') {
      const entries = Object.entries(mocks.rootEntries).map(([name, e]) => ({
        Name: name,
        Type: e.Type ?? 0,
        Hash: e.Hash ?? 'QmExisting',
        Size: 1,
      }));
      return new Response(JSON.stringify({ Entries: entries }), { status: 200 });
    }
    const hashes = mocks.pageHashes[rel] ?? {};
    return new Response(
      JSON.stringify({
        Entries: Object.entries(hashes).map(([Name, Hash]) => ({ Name, Type: 0, Hash })),
      }),
      { status: 200 },
    );
  }

  if (url.includes('files/stat')) {
    // The tree root (and, in these tests, everything else) is the same file.
    return new Response(JSON.stringify({ Hash: 'QmNewRoot', Type: 'file' }), { status: 200 });
  }

  if (url.includes('files/cp')) {
    const args = argsOf(url);
    if (args.length === 2 && relOf(args[1]) === '/assets') mocks.assetsCopied = true;
    return new Response('{}', { status: 200 });
  }

  return new Response('{}', { status: 200 });
};

// ===========================================================================
// Test subject
// ===========================================================================

import { main } from './main';

const gateway = 'http://gateway.test';

const baseInput = {
  publication: 'alice.soul2soul.eth',
  jobs: [] as any[],
  authorSafeAddress: '0x' + 'aa'.repeat(20),
  preview: false,
  endpoints: {
    ipfsGateway: gateway,
    rpcs: { L1: ['http://rpc.l1'], L2: ['http://rpc.l2'] },
  },
};

const makeSignature = async (): Promise<string> =>
  new ethers.Wallet('0x' + '11'.repeat(32)).signMessage('lit actions auth');

/** A JCS-signed page, as both the source and the destination carry it. */
const pageHtml = (identifier: string): string =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    identifier,
    proof: {
      type: 'DataIntegrityProof',
      canonicalization: 'JCS-RFC8785',
      proofValue: '0x' + 'aa'.repeat(65),
    },
    encoding: { sha256: 'deadbeef' },
    author: {
      '@type': 'Person',
      identifier: {
        '@type': 'PropertyValue',
        propertyID: 'account',
        value: '0x' + 'bb'.repeat(20),
      },
    },
  })}</script></head><body>page</body></html>`;

const sampleJob = {
  id: GENESIS,
  templateConfig: { reference: 'post', file: 'post.hbs', path: '/{slug}' },
  html: SOURCE_CID,
  path: '/hello-world',
};

const DEST = '/hello-world/index.html';
/** The trace names the path as rendered, without the run's `/temp-<ts>` prefix. */
const FILE_PATH = DEST;

/** Indices of `files/cp` calls whose destination (2nd arg) is `rel`. */
const cpTo = (rel: string): number[] =>
  mocks.gatewayUrls
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.includes('files/cp') && relOf(argsOf(u)[1] ?? '') === rel)
    .map(({ i }) => i);

/** Indices of `files/rm` calls targeting `rel`. */
const rmOf = (rel: string): number[] =>
  mocks.gatewayUrls
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.includes('files/rm') && relOf(argsOf(u)[0] ?? '') === rel)
    .map(({ i }) => i);

const hasTrace = (result: any, needle: string): boolean =>
  (result.trace ?? []).some((t: unknown) => String(t).includes(needle));

const txtFile = (name: string) => ({ Name: name, Type: 0, Size: 12, Hash: 'QmTxt' });

beforeEach(() => {
  mocks.prevEncoded = '0xe30101701220' + 'ab'.repeat(32);
  mocks.canPublish = true;
  mocks.canReset = true;
  mocks.gatewayUrls = [];
  mocks.config = { assetsCid: 'QmAssets' };
  mocks.evmWriteResult = { success: true };
  mocks.sourceHtml = pageHtml(GENESIS);
  mocks.provenanceSawHtml = '';
  mocks.destinations = {};
  mocks.pageHashes = {};
  mocks.rootEntries = {};
  mocks.prevTxtEntries = null;
  mocks.txtEntries = null;
  mocks.assetsCopied = false;
  mocks.txtLsCalls = 0;
  mocks.lsDirs = [];
  mocks.reads = [];
  mocks.catCalls = 0;
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

describe('evm-update — the destination is read once, or not at all', () => {
  it('an absent destination costs one read: no listing, no rm, one cp', async () => {
    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(mocks.reads).toEqual([DEST]);
    expect(mocks.lsDirs).not.toContain('/hello-world');
    expect(cpTo(DEST).length).toBe(1);
    expect(rmOf(DEST)).toEqual([]);
  });

  it('the same bytes at the destination skip on the CID, without a copy', async () => {
    mocks.destinations[DEST] = { text: mocks.sourceHtml };
    mocks.pageHashes['/hello-world'] = { 'index.html': SOURCE_CID };

    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    // Same bytes → the listing decides, and it is the only extra request.
    expect(mocks.reads).toEqual([DEST]);
    expect(mocks.lsDirs).toContain('/hello-world');
    expect(hasTrace(result, `skip (unchanged): ${FILE_PATH}`)).toBe(true);
    expect(cpTo(DEST)).toEqual([]);
    expect(rmOf(DEST)).toEqual([]);
  });

  it('different bytes overwrite without a listing — a different CID follows', async () => {
    mocks.destinations[DEST] = { text: pageHtml('0x' + '88'.repeat(32)) };

    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(mocks.reads).toEqual([DEST]);
    // No listing was needed to know the file must go before the cp.
    expect(mocks.lsDirs).not.toContain('/hello-world');
    expect(rmOf(DEST).length).toBe(1);
    expect(cpTo(DEST).length).toBe(1);
  });

  it('an unreadable destination falls back to the listing and still compares CIDs', async () => {
    mocks.destinations[DEST] = { status: 401, body: 'invalid auth token' };
    mocks.pageHashes['/hello-world'] = { 'index.html': SOURCE_CID };

    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(mocks.reads).toEqual([DEST]);
    expect(mocks.lsDirs).toContain('/hello-world');
    expect(hasTrace(result, `skip (unchanged): ${FILE_PATH}`)).toBe(true);
    expect(cpTo(DEST)).toEqual([]);
  });

  it('a fresh tree reads no destination at all', async () => {
    mocks.prevEncoded = '';

    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(mocks.reads).toEqual([]);
    expect(mocks.lsDirs).not.toContain('/hello-world');
    expect(cpTo(DEST).length).toBe(1);
  });
});

describe('evm-update — the source page is cat once per job', () => {
  it('the provenance check and the byte comparison share one cat', async () => {
    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(mocks.catCalls).toBe(1);
    // The verify gate consumed the prefetched bytes — not its own cat.
    expect(mocks.provenanceSawHtml).toBe(mocks.sourceHtml);
    expect(hasTrace(result, `✓ ${FILE_PATH}`)).toBe(true);
  });
});

describe('evm-update — unchanged assets and root txt cost no writes', () => {
  it('assets already at the config CID: no rm, no cp, and the txt listing is reused', async () => {
    mocks.destinations[DEST] = { text: mocks.sourceHtml };
    mocks.pageHashes['/hello-world'] = { 'index.html': SOURCE_CID };
    mocks.rootEntries = {
      assets: { Type: 1, Hash: 'QmAssets' },
      'robots.txt': { Type: 0, Hash: 'QmTxt' },
    };
    mocks.prevTxtEntries = [txtFile('robots.txt')];
    mocks.txtEntries = [txtFile('robots.txt')];

    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(rmOf('/assets')).toEqual([]);
    expect(cpTo('/assets')).toEqual([]);
    expect(hasTrace(result, 'already in place')).toBe(true);
    // The previous tree's listing IS the current one — no second ls.
    expect(mocks.txtLsCalls).toBe(1);
    // The root copy already carries the assets/txt file's hash: no rm, no cp.
    expect(rmOf('/robots.txt')).toEqual([]);
    expect(cpTo('/robots.txt')).toEqual([]);
    expect(hasTrace(result, '✓ root txt robots.txt (unchanged)')).toBe(true);
  });

  it('a stale root txt name absent from the listing is skipped, not rm\u2019d', async () => {
    mocks.prevTxtEntries = [txtFile('robots.txt'), txtFile('llms.txt')];
    mocks.txtEntries = [txtFile('llms.txt')];
    // The previous-root copy did not leave robots.txt at the root.

    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(rmOf('/robots.txt')).toEqual([]);
    expect(hasTrace(result, 'skip stale root robots.txt: not present')).toBe(true);
    // The name that IS still in assets/txt is mirrored.
    expect(cpTo('/llms.txt').length).toBe(1);
  });
});
