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
  // Previously-tracked alias NAMES (the canonical node's auxiliary 'aliases'
  // record). Empty by default — nothing tracked (first run after upgrade).
  prevAliasesJson: '',
  canPublish: true,
  canReset: true,
  gatewayUrls: [] as string[],
  // getConfig return value — no domain by default (fallback write target)
  config: { assetsCid: 'QmAssets' } as any,
  // evmWrite outcome — { success:true } by default; tests override to simulate
  // a failed/reverted on-chain write (see the write-failure describe below).
  evmWriteResult: { success: true } as any,
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
  getConfig: vi.fn(async () => mocks.config),
}));

vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(
    async (chain: string, addr: string, abi: unknown, method: string, args: any[]) => {
      // The auxiliary alias-tracking record read is distinguished by its key.
      if (method === 'getText' && args?.[1] === 'aliases') {
        return mocks.prevAliasesJson;
      }
      return mocks.prevEncoded;
    },
  ),
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
  mocks.config = { assetsCid: 'QmAssets' };
  mocks.prevAliasesJson = '';
  mocks.evmWriteResult = { success: true };
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

describe('evm-update — contenthash_wrapped write failure propagation', () => {
  it('reset:true returns ok:false with a contenthash_wrapped error when evmWrite fails', async () => {
    mocks.evmWriteResult = { success: false, error: 'transaction reverted (status 0)' };
    const result: any = await main({
      ...baseInput,
      preview: false, // a real (non-preview) write drives evmWrite
      signature: await makeSignature(),
      reset: true,
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('evm-update');
    expect(result.error).toContain('contenthash_wrapped');
    expect(result.error).toContain('transaction reverted');
  });

  it('normal publish also fails loudly when the on-chain write fails', async () => {
    mocks.evmWriteResult = { success: false, error: 'rpc down' };
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
      // reset NOT set — normal publish path
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('evm-update');
    expect(result.error).toContain('contenthash_wrapped');
    expect(result.error).toContain('rpc down');
  });

  it('reports ok:true when evmWrite succeeds (write path, preview:false)', async () => {
    mocks.evmWriteResult = { success: true, hash: '0x' + 'aa'.repeat(32) };
    const result: any = await main({
      ...baseInput,
      preview: false,
      signature: await makeSignature(),
      reset: true,
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('evm-update');
    expect(result.data.cid).toBe('QmNewRoot');
    // The evmWrite result (success) is recorded in the trace.
    expect(result.trace.some((t: any) => String(t).includes('success'))).toBe(true);
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

describe('evm-update — contenthash_wrapped write target (config.domain / aliases)', () => {
  /** Return the batchSetRecords evmWrite call, or undefined. */
  const batchCallOf = async (): Promise<any[] | undefined> => {
    const { evmWrite } = await import('../libs/evm');
    const calls = (evmWrite as any).mock.calls as any[][];
    return calls.find((c) => c[4] === 'batchSetRecords');
  };

  /** Return the write-node array of the single batchSetRecords call. */
  const batchNodesOf = async (): Promise<string[] | undefined> => {
    const call = await batchCallOf();
    return call ? call[5][0] : undefined;
  };

  /** Return the per-node key arrays of the batchSetRecords call. */
  const batchKeysOf = async (): Promise<string[][] | undefined> => {
    const call = await batchCallOf();
    return call ? call[5][2] : undefined;
  };

  /** Return the per-node value arrays of the batchSetRecords call. */
  const batchValuesOf = async (): Promise<string[][] | undefined> => {
    const call = await batchCallOf();
    return call ? call[5][3] : undefined;
  };

  it('writes to namehash(publication) when config.domain is absent (fallback)', async () => {
    mocks.config = { assetsCid: 'QmAssets' }; // no domain, no aliases
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(await batchNodesOf()).toEqual([
      ethers.utils.namehash('alice.soul2soul.eth'),
    ]);
  });

  it('writes to namehash(config.domain) when config.domain is set (legacy single-node override)', async () => {
    mocks.config = { assetsCid: 'QmAssets', domain: 'custom.soul2soul.eth' };
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(await batchNodesOf()).toEqual([
      ethers.utils.namehash('custom.soul2soul.eth'),
    ]);
    // The write target changed, not the publication identity — the canonical
    // publication node is NOT in the batch (identical to today's swap).
    const nodes = (await batchNodesOf()) ?? [];
    expect(nodes).not.toContain(ethers.utils.namehash('alice.soul2soul.eth'));
  });

  it('writes contenthash to namehash(publication) + EVERY alias in ONE batchSetRecords call', async () => {
    mocks.config = { assetsCid: 'QmAssets', aliases: ['a.eth', 'b.eth'] };
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(await batchNodesOf()).toEqual([
      ethers.utils.namehash('alice.soul2soul.eth'),
      ethers.utils.namehash('a.eth'),
      ethers.utils.namehash('b.eth'),
    ]);
    // A single batchSetRecords tx (never parallel Promise.all evmWrite calls).
    const { evmWrite } = await import('../libs/evm');
    const batchCalls = (evmWrite as any).mock.calls.filter(
      (c: any[]) => c[4] === 'batchSetRecords',
    );
    expect(batchCalls.length).toBe(1);
    const setTextCalls = (evmWrite as any).mock.calls.filter(
      (c: any[]) => c[4] === 'setText',
    );
    expect(setTextCalls.length).toBe(0);
  });

  it('writes the same encoded value to every node (per-node key arrays) + tracks the alias list on the canonical node', async () => {
    mocks.config = { assetsCid: 'QmAssets', aliases: ['a.eth', 'b.eth'] };
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    const encoded = '0x' + 'QmNewRoot'; // mock toHexString(cid) === '0x' + cid
    const keys = await batchKeysOf();
    const values = await batchValuesOf();
    expect(keys).toEqual([
      ['contenthash_wrapped', 'aliases'], // canonical node also tracks the list
      ['contenthash_wrapped'],
      ['contenthash_wrapped'],
    ]);
    expect(values).toEqual([
      [encoded, '["a.eth","b.eth"]'],
      [encoded],
      [encoded],
    ]);
  });

  it('dedupes the node list when an alias duplicates the publication name or another alias', async () => {
    mocks.config = {
      assetsCid: 'QmAssets',
      aliases: ['alice.soul2soul.eth', 'a.eth', 'a.eth'],
    };
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    expect(await batchNodesOf()).toEqual([
      ethers.utils.namehash('alice.soul2soul.eth'),
      ethers.utils.namehash('a.eth'),
    ]);
  });

  it('clears an alias present in the previous config but not in the new list (clear-on-removal)', async () => {
    mocks.prevAliasesJson = '["old.eth","kept.eth"]';
    mocks.config = { assetsCid: 'QmAssets', aliases: ['kept.eth'] };
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    const encoded = '0x' + 'QmNewRoot';
    expect(await batchNodesOf()).toEqual([
      ethers.utils.namehash('alice.soul2soul.eth'), // canonical — always written
      ethers.utils.namehash('kept.eth'), // kept alias — written
      ethers.utils.namehash('old.eth'), // removed alias — cleared
    ]);
    const values = await batchValuesOf();
    expect(values).toEqual([
      [encoded, '["kept.eth"]'],
      [encoded],
      [''], // removed alias gets an empty value so it stops resolving
    ]);
  });

  it('never clears the canonical publication node even if it was previously tracked as an alias', async () => {
    mocks.prevAliasesJson = '["alice.soul2soul.eth","old.eth"]';
    mocks.config = { assetsCid: 'QmAssets', aliases: [] };
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(true);
    // No aliases now → only the canonical node is written; old.eth (and the
    // canonical, if it were ever tracked) is cleared, but the canonical node
    // itself is NEVER cleared — it is always a write target.
    expect(await batchNodesOf()).toEqual([
      ethers.utils.namehash('alice.soul2soul.eth'),
      ethers.utils.namehash('old.eth'),
    ]);
    const values = await batchValuesOf();
    const canonicalNode = ethers.utils.namehash('alice.soul2soul.eth');
    const canonicalIdx = (await batchNodesOf())!.indexOf(canonicalNode);
    // The canonical node's contenthash value is the encoded root, never ''.
    expect(values![canonicalIdx][0]).toBe('0xQmNewRoot');
  });

  it('reset clears the same node list atomically (single batchSetRecords)', async () => {
    mocks.config = { assetsCid: 'QmAssets', aliases: ['a.eth'] };
    const result: any = await main({
      ...baseInput,
      preview: false,
      signature: await makeSignature(),
      reset: true,
    });

    expect(result.ok).toBe(true);
    expect(await batchNodesOf()).toEqual([
      ethers.utils.namehash('alice.soul2soul.eth'),
      ethers.utils.namehash('a.eth'),
    ]);
    const { evmWrite } = await import('../libs/evm');
    const batchCalls = (evmWrite as any).mock.calls.filter(
      (c: any[]) => c[4] === 'batchSetRecords',
    );
    expect(batchCalls.length).toBe(1);
  });

  it('still fails loudly on write failure when a domain is configured', async () => {
    mocks.config = { assetsCid: 'QmAssets', domain: 'custom.soul2soul.eth' };
    mocks.evmWriteResult = { success: false, error: 'reverted' };
    const result: any = await main({
      ...baseInput,
      preview: false,
      jobs: [sampleJob],
      signature: await makeSignature(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('contenthash_wrapped');
  });
});
