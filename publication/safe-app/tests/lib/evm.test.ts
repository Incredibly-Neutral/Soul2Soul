import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CID } from 'multiformats';

// ethers is only used for the provider/contract plumbing in `evmSetup` (which
// is private). We mock it so evmRead's wiring can be asserted without any RPC.
const eth = vi.hoisted(() => {
  const rpcUrls: string[] = [];
  // NB: must be a constructible function (the source uses `new ethers.X`).
  const providerCtor = vi.fn(function (this: any, url: string) {
    this.url = url;
    return { url };
  });
  // Proxy-based contract stub: any method name resolves to a recorder fn.
  const calls: Record<string, unknown[][]> = {};
  const contractCtor = vi.fn(function () {
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        calls[prop] ??= [];
        return (...args: unknown[]) => {
          calls[prop].push(args);
          return '0xRESULT';
        };
      },
    });
  });
  return { rpcUrls, calls, providerCtor, contractCtor };
});

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: eth.providerCtor,
    Contract: eth.contractCtor,
  },
}));

import { getRpcUrl, evmRead, toHexString } from '../../src/lib/evm';

beforeEach(() => {
  // Keep DRPC URL assertions deterministic regardless of the local root .env
  // (which supplies a real VITE_DRPC_API_KEY on some machines). A truthy key
  // exercises the DRPC branch of getRpcUrl.
  vi.stubEnv('VITE_DRPC_API_KEY', 'testkey');
});

describe('getRpcUrl', () => {
  beforeEach(() => {
    eth.rpcUrls.length = 0;
  });

  it('returns the mainnet DRPC URL for chain 1 when a key is configured', () => {
    expect(getRpcUrl(1)).toBe('https://lb.drpc.live/ethereum/testkey');
  });

  it('returns the base DRPC URL for chain 8453 when a key is configured', () => {
    expect(getRpcUrl(8453)).toBe('https://lb.drpc.live/base/testkey');
  });

  it('returns an empty string for an unknown chain', () => {
    expect(getRpcUrl(137)).toBe('');
  });

  describe('keyless build (no VITE_DRPC_API_KEY)', () => {
    // DRPC's keyless `.../default` endpoint is retired ("Your token is
    // invalid or expired"), so a keyless build must use public RPCs instead
    // of shipping a guaranteed-dead URL.
    beforeEach(() => {
      vi.stubEnv('VITE_DRPC_API_KEY', '');
    });

    it('falls back to the public mainnet RPC for chain 1', () => {
      expect(getRpcUrl(1)).toBe('https://ethereum-rpc.publicnode.com');
    });

    it('falls back to the public base RPC for chain 8453', () => {
      expect(getRpcUrl(8453)).toBe('https://mainnet.base.org');
    });

    it('still returns an empty string for an unknown chain', () => {
      expect(getRpcUrl(137)).toBe('');
    });
  });
});

describe('evmRead', () => {
  const ABI = [{ name: 'foo', type: 'function', stateMutability: 'view' }];

  beforeEach(() => {
    eth.rpcUrls.length = 0;
    for (const k of Object.keys(eth.calls)) delete eth.calls[k];
    eth.contractCtor.mockClear();
    eth.providerCtor.mockClear();
  });

  it('creates a JsonRpcProvider for the chain and a Contract, then calls the method', async () => {
    const result = await evmRead(8453, '0xContract', ABI, 'getFoo', [1, 'two']);
    expect(result).toBe('0xRESULT');
    expect(eth.providerCtor).toHaveBeenCalledTimes(1);
    expect(eth.providerCtor).toHaveBeenCalledWith('https://lb.drpc.live/base/testkey');
    expect(eth.contractCtor).toHaveBeenCalledTimes(1);
    expect(eth.contractCtor).toHaveBeenCalledWith(
      '0xContract',
      ABI,
      expect.objectContaining({ url: 'https://lb.drpc.live/base/testkey' }),
    );
    expect(eth.calls['getFoo']).toEqual([[1, 'two']]);
  });

  it('passes through the resolved value of the contract call', async () => {
    // getFoo returns '0xRESULT' from the stub; evmRead should surface it.
    await expect(evmRead(1, '0xContract', ABI, 'getBar', [])).resolves.toBe('0xRESULT');
  });
});

describe('toHexString', () => {
  it('prefixes the CID bytes with the ipfs-ns (0xe3) + version (0x01) contenthash prefix', () => {
    const cid = 'bafybeigadpvuv4m3txrx4r3wtjclnkte5mvxb2hoyyvt4jlaqdeo6qrbwm';
    const expected =
      '0x' +
      [0xe3, 0x01, ...CID.parse(cid).bytes]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    expect(toHexString(cid)).toBe(expected);
    expect(toHexString(cid)).toMatch(/^0xe301/);
  });

  it('round-trips through multiformats CID.parse (same bytes used)', () => {
    const cid = 'bafybeigadpvuv4m3txrx4r3wtjclnkte5mvxb2hoyyvt4jlaqdeo6qrbwm';
    const hex = toHexString(cid);
    // The contenthash is CID bytes verbatim: e3 01 then exactly the CID bytes.
    expect(hex.slice(6)).toBe(
      Array.from(CID.parse(cid).bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    );
  });

  it('handles a CIDv0 (34-byte multihash) input', () => {
    const cid = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
    const hex = toHexString(cid);
    expect(hex).toMatch(/^0xe301/);
    // 0x prefix (2) + e3 01 (4) + 34-byte CIDv0 multihash (68) = 74 chars.
    expect(hex).toHaveLength(74);
  });

  it('throws on a malformed CID string', () => {
    expect(() => toHexString('not-a-cid')).toThrow();
  });
});
