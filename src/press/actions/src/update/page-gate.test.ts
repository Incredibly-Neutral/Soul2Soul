/**
 * Per-page gate tests — evm-update action (`update/main.ts`, `update/verify.ts`).
 *
 * The update gate used to be one question per REQUEST (canPublish, before
 * anything was read). It is now one question per PAGE, asked after reading the
 * page already at that page's destination:
 *
 *   - REFRESH (the page at the destination already carries this job's
 *     identifier) — a new render of the content item that owns the path. It
 *     introduces no path and displaces no page, so it needs no permission and
 *     canPublish is never asked.
 *   - ADD (a free path, or a different page there) — canPublish, asked at most
 *     once per request however many pages are added.
 *   - remove — a repair, decided by isOutOfForce (via verifyRevocable) alone.
 *   - reset — canReset only.
 *   - preview — every job is an ADD, so preview still needs canPublish.
 *
 * The on-chain modules (ens.factory / protocol.factory / config.ctrl / evm /
 * gates) are mocked; `verifyProvenance` is mocked (it needs a real PKP
 * signature) while the rest of `./verify` — readPageIdentity,
 * verifyPathAvailable, verifyRevocable — runs for real against a stubbed kubo
 * gateway, so the classification and the reuse of the destination read are
 * observed rather than assumed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ethers from 'ethers5'; // protocol's v5 alias — the action runs against ethers v5 semantics

// The action references the Lit-runtime-injected global `ethers`
// (action_globals.ts); point it at the real ethers v5 so the real
// extractSignerAddress / namehash / keccak256 run unmocked.
(globalThis as { ethers?: unknown }).ethers = ethers;

const GENESIS = '0x' + '33'.repeat(32);

// ===========================================================================
// Controllable mocks — hoisted so the vi.mock factories can read them.
// ===========================================================================

const mocks = vi.hoisted(() => ({
  prevEncoded: '0xe30101701220' + 'ab'.repeat(32), // an existing tree to copy
  prevAliasesJson: '',
  canPublish: true,
  canReset: true,
  isOutOfForce: true,
  gatewayUrls: [] as string[],
  config: { assetsCid: 'QmAssets' } as any,
  evmWriteResult: { success: true } as any,
  // Tree-relative MFS path ('/hello-world/index.html') → the page already there.
  pages: {} as Record<string, string>,
  // What the mocked verifyProvenance reports about the incoming page.
  incoming: null as any,
}));

vi.mock('../libs/ens.factory', () => ({
  getDomainOwnerAndModules: vi.fn(async () => ({
    multisig: '0x' + '11'.repeat(20), // publication Safe
    configModule: '0x' + '22'.repeat(20),
    publicationModule: '0x' + '44'.repeat(20),
  })),
}));

vi.mock('../libs/protocol.factory', () => ({
  getProtocolInfo: vi.fn(async () => ({
    pkp: '0x' + '55'.repeat(20),
    ensRecords: '0x' + '66'.repeat(20),
  })),
}));

vi.mock('../render/config.ctrl', () => ({
  getConfig: vi.fn(async () => mocks.config),
}));

vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(async (chain: string, addr: string, abi: unknown, method: string, args: any[]) => {
    if (method === 'getText' && args?.[1] === 'aliases') return mocks.prevAliasesJson;
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
    isOutOfForce: vi.fn(async () => mocks.isOutOfForce),
  };
});

vi.mock('./verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify')>();
  return {
    ...actual,
    // A real PKP signature cannot be produced here; everything else in
    // verify.ts (the identity read, the path gate, the revocable check) is real.
    verifyProvenance: vi.fn(async () => mocks.incoming),
  };
});

// ===========================================================================
// Kubo gateway stub — records every URL, answers by the MFS path it names.
// ===========================================================================

/** The `arg=` values of a gateway URL, decoded, in order. */
const argsOf = (url: string): string[] =>
  (url.split('?')[1] ?? '')
    .split('&')
    .filter((p) => p.startsWith('arg='))
    .map((p) => decodeURIComponent(p.slice('arg='.length)));

/** Strip the run's `/temp-<ts>` prefix (and doubled slashes) → tree-relative path. */
const relOf = (mfsPath: string): string =>
  mfsPath.replace(/^\/temp-\d+/, '').replace(/\/{2,}/g, '/');

const gatewayResponse = (url: string): Response => {
  const [arg = ''] = argsOf(url);
  if (url.includes('files/read')) {
    const html = mocks.pages[relOf(arg)];
    return html
      ? new Response(html, { status: 200 })
      : new Response('no such file', { status: 404 });
  }
  if (url.includes('files/stat')) {
    return new Response(JSON.stringify({ Hash: 'QmNewRoot' }), { status: 200 });
  }
  if (url.includes('files/ls')) {
    return new Response(JSON.stringify({ Entries: [] }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

// ===========================================================================
// Test subject
// ===========================================================================

import { main } from './main';

const gateway = 'http://gateway.test';
const PUBLICATION_MODULE = '0x' + '44'.repeat(20);
const RPC_L2 = 'http://rpc.l2';

const baseInput = {
  publication: 'alice.soul2soul.eth',
  jobs: [],
  authorSafeAddress: '0x' + 'aa'.repeat(20),
  preview: false,
  endpoints: {
    ipfsGateway: gateway,
    rpcs: { L1: ['http://rpc.l1'], L2: [RPC_L2] },
  },
};

const makeSignature = async (): Promise<string> =>
  new ethers.Wallet('0x' + '11'.repeat(32)).signMessage('lit actions auth');

/** A JCS-signed page as it sits on the tree (what readPageIdentity parses). */
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

/** The identity the mocked verifyProvenance reports for the incoming page. */
const incomingIdentity = (identifier: string) => ({
  identifier,
  authorDid: '0x' + 'bb'.repeat(20),
  canonicalization: 'JCS-RFC8785' as const,
  signed: true,
  sha256: 'deadbeef',
});

const makeJob = (path: string, id: string = GENESIS) => ({
  id,
  templateConfig: { reference: 'post', file: 'post.hbs', path: '/{slug}' },
  html: 'QmRenderedHtml',
  path,
});

/** Every gateway URL of one operation, as decoded `arg=` lists. */
const callsOf = (op: string): string[][] =>
  mocks.gatewayUrls.filter((u) => u.includes(op)).map((u) => argsOf(u));

/** How many times the page at a tree-relative path was cat'd from MFS. */
const readsOf = (rel: string): number =>
  callsOf('files/read').filter((args) => relOf(args[0] ?? '') === rel).length;

/** Removals of a tree-relative path (recursive rm of the page dir). */
const removalsOf = (rel: string): string[][] =>
  callsOf('files/rm').filter((args) => relOf(args[0] ?? '') === rel);

const hasTrace = (result: any, needle: string): boolean =>
  (result.trace ?? []).some((t: unknown) => String(t).includes(needle));

beforeEach(() => {
  mocks.gatewayUrls = [];
  mocks.canPublish = true;
  mocks.canReset = true;
  mocks.isOutOfForce = true;
  mocks.prevEncoded = '0xe30101701220' + 'ab'.repeat(32);
  mocks.prevAliasesJson = '';
  mocks.config = { assetsCid: 'QmAssets' };
  mocks.evmWriteResult = { success: true };
  mocks.pages = {};
  mocks.incoming = incomingIdentity(GENESIS);
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

describe('evm-update — REFRESH (the page at the destination is this job’s)', () => {
  it('succeeds with canPublish answering false, and never asks it', async () => {
    mocks.pages = { '/hello-world/index.html': pageHtml(GENESIS) };
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      jobs: [makeJob('/hello-world')],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    const { canPublish } = await import('../libs/gates');
    expect(canPublish).not.toHaveBeenCalled();
    expect(hasTrace(result, 'refresh: /hello-world/index.html')).toBe(true);
  });

  it('reads the destination page once — the path gate reuses the identity', async () => {
    mocks.pages = { '/hello-world/index.html': pageHtml(GENESIS) };
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      jobs: [makeJob('/hello-world')],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    // One read for the classification; verifyPathAvailable is handed the result
    // instead of cat'ing the same page again.
    expect(readsOf('/hello-world/index.html')).toBe(1);
  });
});

describe('evm-update — ADD (a free path, or a different page there)', () => {
  it('fails with "cannot publish" at a free path when canPublish answers false', async () => {
    mocks.pages = {}; // nothing at the destination
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      jobs: [makeJob('/hello-world')],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('evm-update');
    expect(result.error).toBe('cannot publish');
    // Nothing was written: the gate fires before the cp.
    expect(
      mocks.gatewayUrls.some(
        (u) => u.includes('files/cp') && relOf(argsOf(u)[1] ?? '') === '/hello-world/index.html',
      ),
    ).toBe(false);
  });

  it('succeeds at a free path when canPublish answers true', async () => {
    mocks.pages = {};
    mocks.canPublish = true;

    const result: any = await main({
      ...baseInput,
      jobs: [makeJob('/hello-world')],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(result.data.cid).toBe('QmNewRoot');
    expect(hasTrace(result, '✓ /hello-world/index.html')).toBe(true);
    const { canPublish } = await import('../libs/gates');
    expect(canPublish).toHaveBeenCalledTimes(1);
  });

  it('asks canPublish once for a request that adds several pages', async () => {
    mocks.pages = {};
    mocks.canPublish = true;

    const result: any = await main({
      ...baseInput,
      jobs: [makeJob('/one', '0x' + '66'.repeat(32)), makeJob('/two', '0x' + '77'.repeat(32))],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    const { canPublish } = await import('../libs/gates');
    expect(canPublish).toHaveBeenCalledTimes(1);
  });

  it('treats a page carrying a DIFFERENT identifier at the path as an ADD', async () => {
    // The destination holds someone else's content item, not this job's.
    mocks.pages = { '/hello-world/index.html': pageHtml('0x' + '88'.repeat(32)) };
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      jobs: [makeJob('/hello-world')],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('cannot publish');
  });
});

describe('evm-update — remove is a repair, never a canPublish question', () => {
  const OUT_OF_FORCE = '0x' + '22'.repeat(32);

  it('removes an out-of-force page with canPublish answering false', async () => {
    mocks.pages = { '/hello-world/index.html': pageHtml(OUT_OF_FORCE) };
    mocks.isOutOfForce = true;
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      jobs: [],
      remove: [{ path: '/hello-world' }],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(hasTrace(result, 'removed: /hello-world')).toBe(true);
    const { canPublish, isOutOfForce } = await import('../libs/gates');
    expect(canPublish).not.toHaveBeenCalled();
    expect(isOutOfForce).toHaveBeenCalledWith(OUT_OF_FORCE, PUBLICATION_MODULE, [RPC_L2]);
    // The page dir was removed and the result reported as a repair.
    expect(removalsOf('/hello-world').length).toBeGreaterThan(0);
  });

  it('skips and traces the remove of a page still in force', async () => {
    mocks.pages = { '/hello-world/index.html': pageHtml(OUT_OF_FORCE) };
    mocks.isOutOfForce = false; // an active deal: the press still owes this manuscript
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      jobs: [],
      remove: [{ path: '/hello-world' }],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true); // a refused remove does not fail the request
    expect(
      hasTrace(
        result,
        `skip remove /hello-world: Refusing to remove: genesis ${OUT_OF_FORCE.slice(0, 12)}… is still in force`,
      ),
    ).toBe(true);
    expect(removalsOf('/hello-world').length).toBe(0);
    const { canPublish } = await import('../libs/gates');
    expect(canPublish).not.toHaveBeenCalled();
  });
});

describe('evm-update — reset and preview', () => {
  it('reset goes through canReset only — canPublish is never asked', async () => {
    mocks.canReset = true;
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      signature: await makeSignature(),
      reset: true,
    });

    expect(result.ok).toBe(true);
    const { canPublish, canReset } = await import('../libs/gates');
    expect(canReset).toHaveBeenCalled();
    expect(canPublish).not.toHaveBeenCalled();
  });

  it('a reset carrying a job that would otherwise be an ADD adds it with canPublish answering false', async () => {
    // 'Reset & rebuild' in the Safe app passes every deal genesis with
    // reset:true — so the jobs of a reset are ADDs by classification. canReset
    // already gated the signer as a publication-Safe owner, which is stricter
    // than canPublish, so the ADD question must not be asked again.
    mocks.pages = {}; // free path: this job is an ADD
    mocks.canReset = true;
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      jobs: [makeJob('/hello-world')],
      signature: await makeSignature(),
      reset: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data.cid).toBe('QmNewRoot');
    expect(hasTrace(result, '✓ /hello-world/index.html')).toBe(true);
    const { canPublish, canReset } = await import('../libs/gates');
    expect(canReset).toHaveBeenCalled();
    expect(canPublish).not.toHaveBeenCalled();
  });

  it('preview is never a refresh: a page already at the destination still needs canPublish', async () => {
    // The destination page carries this job's identifier — but a preview writes
    // nothing, so the job is only ever judged as an ADD.
    mocks.pages = { '/hello-world/index.html': pageHtml(GENESIS) };
    mocks.canPublish = false;

    const result: any = await main({
      ...baseInput,
      preview: true,
      jobs: [makeJob('/hello-world')],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('cannot publish');
    // No destination read was needed: preview does not classify by page.
    expect(readsOf('/hello-world/index.html')).toBe(0);
  });
});
