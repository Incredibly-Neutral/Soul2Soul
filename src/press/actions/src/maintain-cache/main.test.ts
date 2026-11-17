/**
 * maintain-cache/main.ts — the refusal when discovery names no module.
 *
 * `maintain-cache` derives the publication module from the factory and asks the
 * factory which module this Safe owns. A factory that names none (a prediction
 * with no code at it, or a Safe created by an earlier factory) is not a module
 * the action can write through, so it throws `missing publication module`
 * rather than touching the cache pointer.
 *
 * Only that refusal is the subject: the neighbours the throw sits behind
 * (gates, protocol.factory, ens.factory, evm, ipfs) are mocked. There is no
 * happy-path harness here — the archive reconcile path has its own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ethers from 'ethers5';

// The action references the Lit-runtime-injected global `ethers`
// (action_globals.ts); point it at the real ethers v5.
(globalThis as unknown as { ethers: unknown }).ethers = ethers;

const FACTORY = '0x' + '77'.repeat(20);
const PUBLICATION = 'alice.soul2soul.eth';

vi.mock('../libs/gates', () => ({
  extractSignerAddress: vi.fn(() => '0x' + 'aa'.repeat(20)),
  canPublish: vi.fn(async () => true),
}));

vi.mock('../libs/protocol.factory', () => ({
  // The document carries the factory discovery asks; the tests set the rest.
  getManifest: vi.fn(async () => ({ moduleFactory: FACTORY })),
}));

vi.mock('../libs/ens.factory', () => ({
  getDomainOwnerAndModules: vi.fn(),
}));

vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(),
  evmWrite: vi.fn(),
  toHexString: (cid: string) => '0x' + cid,
}));

vi.mock('../libs/ipfs.factory', () => ({
  catFile: vi.fn(),
  uploadFile: vi.fn(),
  decodeArchiveCid: vi.fn(),
}));

vi.mock('../libs/module.factory', () => ({ getAgreements: vi.fn(async () => []) }));
vi.mock('../libs/archive.factory', () => ({
  parseArchive: vi.fn(),
  reconcile: vi.fn(),
  mergeArchive: vi.fn(),
  serialize: vi.fn(),
}));
vi.mock('../libs/item-integrity', () => ({ judgeRefetchedItem: vi.fn() }));

import { main } from './main';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { evmWrite } from '../libs/evm';

const input = {
  publication: PUBLICATION,
  signature: '0x' + '11'.repeat(65),
  authorSafeAddress: '0x' + 'aa'.repeat(20),
  preview: false,
  endpoints: {
    ipfsGateway: 'https://ipfs.example',
    rpcs: { L1: ['https://rpc.l1'], L2: ['https://rpc.l2'] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('maintain-cache — the factory names no publication module', () => {
  it('refuses with `missing publication module` instead of writing the cache pointer', async () => {
    vi.mocked(getDomainOwnerAndModules).mockResolvedValue({
      multisig: '0x' + '33'.repeat(20),
      configModule: '0x' + '22'.repeat(20),
      publicationModule: null,
    } as never);

    const result = await main(input as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('missing publication module');
    // The gate and the write are both downstream of discovery: neither ran.
    expect(evmWrite).not.toHaveBeenCalled();
  });
});
