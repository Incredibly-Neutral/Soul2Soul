/**
 * Reset-tree tests — evm-update action (`update/main.ts`).
 *
 * Covers the RFC-reset-tree-button.md "reset" mode:
 *   (b) a reset forces the fresh `files/mkdir` branch even when a previous root
 *       exists — the old root is NEVER `files/cp`'d (so root index.html and
 *       every page dir vanish), while assets are still re-copied and the root
 *       is rewritten; and
 *   (a) the publication-owner gate: `canReset` is required when `reset` is set,
 *       and a signer who is NOT an owner of the publication Safe is rejected
 *       even if `canPublish` would pass.
 *
 * The action's on-chain read modules (ens.factory / protocol.factory /
 * config.ctrl / evm / gates / ipfs.factory) are mocked; the kubo gateway is
 * stubbed via the global `fetch` (the real `fetchWithTimeout` drives it), so
 * the branch decision is observed through the recorded gateway URLs.
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
  canPublish: true,
  canReset: true,
  gatewayUrls: [] as string[],
}));

vi.mock('../libs/ens.factory', () => ({
  getDomainOwnerAndModules: vi.fn(async () => ({
    multisig: '0x' + '11'.repeat(20), // publication Safe
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
  getConfig: vi.fn(async () => ({ assetsCid: 'QmAssets' })),
}));

vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(async () => mocks.prevEncoded),
  evmWrite: vi.fn(async () => ({})),
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
// Kubo gateway stub — records every URL, returns branch-appropriate bodies.
// ===========================================================================

const gatewayResponse = (url: string): Response => {
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

const baseInput = {
  publication: 'alice.soul2soul.eth',
  jobs: [],
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

// A rendered job — required for the non-reset (normal publish) control cases.
const sampleJob = {
  id: '0x' + '33'.repeat(32),
  templateConfig: { reference: 'post', file: 'post.hbs', path: '/{slug}' },
  html: 'QmRenderedHtml',
  path: '/hello-world',
};

const hasCall = (needle: string): boolean =>
  mocks.gatewayUrls.some((u) => u.includes(needle));

beforeEach(() => {
  mocks.gatewayUrls = [];
  mocks.canPublish = true;
  mocks.canReset = true;
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

describe('evm-update reset — branch selection', () => {
  it('reset:true with an existing prev root forces the mkdir branch (no cp of prev root)', async () => {
    mocks.prevEncoded = '0xe30101701220' + 'ab'.repeat(32); // existing tree
    const result: any = await main({
      ...baseInput,
      signature: await makeSignature(),
      reset: true,
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('evm-update');
    expect(result.data.cid).toBe('QmNewRoot');
    // Fresh mkdir branch taken...
    expect(hasCall('files/mkdir')).toBe(true);
    // ...and the previous root is NEVER copied (old tree dropped entirely).
    expect(hasCall('arg=/ipfs/QmPrevRoot')).toBe(false);
    // Assets are still re-copied from config.assetsCid.
    expect(hasCall('arg=/ipfs/QmAssets')).toBe(true);
    // Trace records the mkdir path.
    expect(result.trace.some((t: string) => String(t).includes('mkdir'))).toBe(true);
    expect(result.trace.some((t: string) => String(t).includes('cp root'))).toBe(false);
  });

  it('non-reset publish with an existing prev root still copies the prev root (regression guard)', async () => {
    mocks.prevEncoded = '0xe30101701220' + 'ab'.repeat(32);
    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
      // reset NOT set — normal publish path
    });

    expect(result.ok).toBe(true);
    // Normal path: cp the previous root...
    expect(hasCall('arg=/ipfs/QmPrevRoot')).toBe(true);
    // ...and do NOT mkdir fresh.
    expect(hasCall('files/mkdir')).toBe(false);
    expect(result.trace.some((t: string) => String(t).includes('cp root'))).toBe(true);
  });

  it('reset:true with NO prev root still mkdirs (fresh tree)', async () => {
    mocks.prevEncoded = ''; // no previous root on-chain
    const result: any = await main({
      ...baseInput,
      signature: await makeSignature(),
      reset: true,
    });

    expect(result.ok).toBe(true);
    expect(hasCall('files/mkdir')).toBe(true);
    expect(hasCall('arg=/ipfs/QmPrevRoot')).toBe(false);
  });
});

describe('evm-update reset — publication-owner gate (canReset)', () => {
  it('requires canReset when reset is set', async () => {
    const { canReset } = await import('../libs/gates');
    mocks.canReset = true;
    await main({ ...baseInput, signature: await makeSignature(), reset: true });
    expect(canReset).toHaveBeenCalled();
  });

  it('rejects a signer who is NOT an owner of the publication Safe, even if canPublish would pass', async () => {
    mocks.canPublish = true; // canPublish passes...
    mocks.canReset = false; // ...but the signer is not a publication-Safe owner
    const result: any = await main({
      ...baseInput,
      signature: await makeSignature(),
      reset: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('reset requires publication owner');
    // Nothing was written to the gateway (the gate fails before the tree build).
    expect(mocks.gatewayUrls.length).toBe(0);
  });

  it('normal publish (no reset) is NOT gated by canReset — canPublish governs', async () => {
    const { canReset } = await import('../libs/gates');
    mocks.canReset = false; // would fail a reset...
    mocks.canPublish = true;
    const result: any = await main({
      ...baseInput,
      jobs: [sampleJob],
      signature: await makeSignature(),
      // reset NOT set
    });

    expect(result.ok).toBe(true);
    expect(canReset).not.toHaveBeenCalled();
  });
});
