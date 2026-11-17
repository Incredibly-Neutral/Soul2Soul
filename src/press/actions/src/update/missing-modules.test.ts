/**
 * update/main.ts — the factory names no module for this Safe.
 *
 * The action must refuse with the unresolved-modules sentence before it touches
 * IPFS or the gate, and it must reach that refusal through the REAL
 * `getDomainOwnerAndModules`: `../libs/ens.factory` is deliberately not mocked.
 * The chain edge (`../libs/evm`) answers the ENS walk and the zero address for
 * `moduleAddress`; `../libs/protocol.factory`, `../libs/gates`,
 * `../libs/ipfs.factory`, `../render/config.ctrl` and `./verify` are stubbed so
 * the action can start. A zero answer is "no module" without a code read, so no
 * `eth_getCode` may be issued (one request per read inside Lit's 50-request
 * session cap).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import * as ethers from 'ethers5'; // protocol's v5 alias — the action runs against ethers v5 semantics

// ens.factory derives the two kinds at module load from the Lit-injected
// global, so the real ethers v5 must be in place before that import runs.
(globalThis as { ethers?: unknown }).ethers = ethers;
const state = vi.hoisted(() => ({
  // What the factory answers for each kind address: same call, both kinds.
  answers: {} as Record<string, string>,
  reads: [] as { method: string; args: unknown[] }[],
  codeReads: [] as string[],
}));

const NAME_WRAPPER = '0x' + 'aa'.repeat(20);
const OWNER = '0x' + 'bb'.repeat(20);
const FACTORY = '0x' + '77'.repeat(20);
const ZERO_ADDRESS = '0x' + '00'.repeat(20);

vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(
    async (chain: string, address: string, abi: unknown, method: string, args: any[]) => {
      state.reads.push({ method, args });
      switch (method) {
        case 'nameWrapper':
          return NAME_WRAPPER;
        case 'ownerOf':
          return OWNER;
        case 'moduleAddress':
          return state.answers[address] ?? ZERO_ADDRESS;
        default:
          return '';
      }
    },
  ),
  evmGetCode: vi.fn(async (chain: string, address: string) => {
    state.codeReads.push(address);
    return '0x60806040';
  }),
  evmWrite: vi.fn(),
  toHexString: (cid: string) => '0x' + cid,
}));

vi.mock('../libs/protocol.factory', () => ({
  getPublicationFactory: vi.fn(async () => '0x' + '77'.repeat(20)),
  getProtocolInfo: vi.fn(async () => ({
    pkp: '0x' + '44'.repeat(20),
    ensRecords: '0x' + '55'.repeat(20),
    moduleFactory: '0x' + '77'.repeat(20),
  })),
}));

vi.mock('../libs/gates', () => ({
  extractSignerAddress: vi.fn(() => '0x' + 'cc'.repeat(20)),
  canPublish: vi.fn(),
  canReset: vi.fn(),
}));
vi.mock('../libs/ipfs.factory', () => ({ contenthashToIPFS: vi.fn(() => 'QmPrevRoot') }));
vi.mock('../render/config.ctrl', () => ({ getConfig: vi.fn() }));
vi.mock('./verify', () => ({
  verifyProvenance: vi.fn(),
  verifyPathAvailable: vi.fn(),
  verifyRevocable: vi.fn(),
  readPageIdentity: vi.fn(),
  sanitizeRemovePath: (p: string) => p,
}));

// The real discovery — deliberately NOT mocked. If it stops being real, this
// test stops proving that the action refuses on a factory that names nothing.
// Imported dynamically, after the global `ethers` exists: ens.factory derives
// both kinds at module load from the Lit-injected global.
let main: (input: unknown) => Promise<{ ok: boolean; error?: string }>;
let realDiscovery: typeof import('../libs/ens.factory').getDomainOwnerAndModules;

beforeAll(async () => {
  (globalThis as unknown as { ethers: unknown }).ethers = ethers;
  realDiscovery = (await import('../libs/ens.factory')).getDomainOwnerAndModules;
  main = (await import('./main')).main as typeof main;
});

const input = () => ({
  publication: 'alice.soul2soul.eth',
  jobs: [],
  // A reset needs no jobs, and it still goes through discovery first.
  reset: true,
  signature: '0x' + 'ab'.repeat(65),
  authorSafeAddress: '0x' + 'aa'.repeat(20),
  preview: true,
  endpoints: {
    ipfsGateway: 'http://gateway.test',
    rpcs: { L1: ['http://rpc.l1'], L2: ['http://rpc.l2'] },
  },
});

const result = () => main(input());

beforeEach(() => {
  state.answers = {};
  state.reads = [];
  state.codeReads = [];
});

describe('update — the factory names no module', () => {
  it('refuses with the unresolved-modules sentence and reads no code at a zero answer', async () => {
    const out = await result();

    expect(out.ok).toBe(false);
    expect(out.error).toBe(
      'publication modules unresolved: the factory named no module with code at it, or did not answer moduleAddress at all, as a factory older than V6 cannot, so a publication from an earlier factory is refused',
    );
    // The real discovery asked the factory once per kind, for the Safe the ENS
    // walk found, and each answer was the zero address.
    const factoryReads = state.reads.filter((read) => read.method === 'moduleAddress');
    expect(factoryReads).toHaveLength(2);
    expect(factoryReads.every((read) => read.args[0] === OWNER)).toBe(true);
    // A zero answer is no module without a code read.
    expect(state.codeReads).toEqual([]);
    // Nothing after discovery ran.
    expect(state.reads.map((read) => read.method)).toEqual([
      'nameWrapper',
      'ownerOf',
      'moduleAddress',
      'moduleAddress',
    ]);
  });

  it('is the real discovery under test, not a stub', async () => {
    // A stub would answer without any chain read at all.
    await result();
    expect(state.reads.length).toBeGreaterThan(0);
    expect(typeof realDiscovery).toBe('function');
  });
});
