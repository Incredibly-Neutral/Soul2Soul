import { describe, it, expect, beforeEach } from 'vitest';
import { evmRead, toHexString } from './evm';
import { mapWithLimit } from './ens.factory';
import { decodeContenthashWrapped } from '@s2s/soul2soul-shared/lit-actions';

// ============================================================================
// evmRead — FAIL-FAST, single pass over the RPC URL list.
//
// Regression context (see evm.ts header): an in-session retry loop (MAX_ATTEMPTS
// x the RPC URLs, with backoff) multiplied HTTP requests against Lit's
// 50-request-per-session cap and blew the budget on multi-collection renders.
// evmRead now tries each URL exactly once (failover) and throws when every URL
// fails. The orchestrator (shared/src/rendering/sequence.ts) re-runs the whole
// render in a fresh session on a transient failure instead.
// ============================================================================

// Minimal constructable stand-in for ethers' StaticJsonRpcProvider so the
// `new ethers.providers.StaticJsonRpcProvider(connection, network)` in evmSetup
// works under test. Keeps the connection object (url + timeout) on the instance.
class FakeStaticJsonRpcProvider {
  connection: any;
  constructor(connection: any) {
    this.connection = connection;
  }
}

// Builds a fake global `ethers` (the bundle injects it at runtime) that lets us
// drive the call outcome per invocation. `scenario` is called for every
// `contract[method](...)`; if it throws the error is surfaced, otherwise the
// returned value is the result. Counts total contract-method invocations so we
// can assert the fail-fast (single-pass, no retry) contract.
function withFakeEthers(scenario: () => any) {
  const calls: Array<{ method: string; args: any[] }> = [];
  let contractCalls = 0;
  class FakeContract {
    constructor(_address: string, _abi: any, _provider: any) {
      return new Proxy(this, {
        get: (_t: any, prop: string) => {
          return (...args: any[]) => {
            contractCalls++;
            calls.push({ method: prop, args });
            const outcome = scenario();
            if (outcome instanceof Error) throw outcome;
            return outcome;
          };
        },
      });
    }
  }
  (globalThis as any).ethers = {
    providers: {
      StaticJsonRpcProvider: FakeStaticJsonRpcProvider,
    },
    Contract: FakeContract,
  };
  return {
    contractCalls: () => contractCalls,
    calls,
  };
}

const ABI = ['function NAME() view returns (string)'];
const RPC_URLS = ['https://rpc.example'];

describe('evmRead fail-fast (single pass, no in-session retry)', () => {
  beforeEach(() => {
    delete (globalThis as any).ethers;
  });

  it('fails over to the next URL within the single pass and returns its value', async () => {
    // Two URLs within the same attempt: the first always fails (transport),
    // the second succeeds. evmRead must fall through to URL B exactly once
    // (single pass — no retry round) and return B's value.
    const urls = ['https://a.example', 'https://b.example'];
    const seenPerUrl: Record<string, number> = {};
    class PerUrlContract {
      constructor(_address: string, _abi: any, provider: any) {
        const myUrl = provider.connection.url;
        seenPerUrl[myUrl] = (seenPerUrl[myUrl] || 0) + 1;
        return new Proxy(this, {
          get: () => () => {
            if (myUrl === 'https://a.example') {
              throw new Error('RPC call to https://a.example failed: missing response');
            }
            return 'ok';
          },
        });
      }
    }
    (globalThis as any).ethers = {
      providers: { StaticJsonRpcProvider: FakeStaticJsonRpcProvider },
      Contract: PerUrlContract,
    };
    const result = await evmRead('L2', '0xaddr', ABI, 'NAME', [], urls);
    expect(result).toBe('ok');
    // Each URL attempted exactly once — there is NO retry round on failure.
    expect(seenPerUrl['https://a.example']).toBe(1);
    expect(seenPerUrl['https://b.example']).toBe(1);
  });

  it('succeeds on the first URL (single request)', async () => {
    const { contractCalls } = withFakeEthers(() => 'NAME');
    const result = await evmRead('L2', '0xaddr', ABI, 'NAME', [], RPC_URLS);
    expect(result).toBe('NAME');
    expect(contractCalls()).toBe(1);
  });

  it('does NOT retry a single failure — throws after exactly one attempt per URL', async () => {
    const err = new Error('RPC call to https://rpc.example failed: missing response');
    const { contractCalls } = withFakeEthers(() => err);
    await expect(evmRead('L2', '0xaddr', ABI, 'NAME', [], RPC_URLS)).rejects.toThrow();
    // Exactly one attempt on the single URL: fail-fast, no in-session retry.
    expect(contractCalls()).toBe(1);
  });

  it('throws an aggregated error when EVERY url fails (single pass, no retry loop)', async () => {
    const urls = ['https://a.example', 'https://b.example'];
    class AlwaysFailContract {
      constructor(_a: any, _b: any, provider: any) {
        const myUrl = provider.connection.url;
        return new Proxy(this, {
          get: () => () => {
            throw new Error(`RPC call to ${myUrl} failed: missing response`);
          },
        });
      }
    }
    (globalThis as any).ethers = {
      providers: { StaticJsonRpcProvider: FakeStaticJsonRpcProvider },
      Contract: AlwaysFailContract,
    };
    const err: any = await evmRead('L2', '0xaddr', ABI, 'NAME', [], urls).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(Array.isArray(err.failures)).toBe(true);
    expect(err.failures.length).toBe(2); // one failure per URL, no retries
    expect(err.message).toContain('https://a.example');
    expect(err.message).toContain('https://b.example');
  });
});

// ============================================================================
// toHexString — EIP-1577 contenthash encode (CIDv0 AND CIDv1).
//
// Regression context: files/stat now returns CIDv1 (bafy...) roots, but the
// old toHexString base58-decoded the CID string as a big number (CIDv0-only),
// so a CIDv1 root was encoded on-chain as 0xe3 0x01 + a 44-byte misparse that
// decodeRootCid later rendered as an invalid CID (tree sync failed with
// 'invalid path'). toHexString now parses the CID (v0 or v1) and wraps its raw
// bytes (version varint + codec varint + multihash) in the EIP-1577 ipfs-ns
// envelope, so the value round-trips through decodeContenthashWrapped.
// ============================================================================

const TEST_V0 = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
const TEST_V1 = 'bafybeigadpvuv4m3txrx4r3wtjclnkte5mvxb2hoyyvt4jlaqdeo6qrbwm';

describe('toHexString (EIP-1577 contenthash encode)', () => {
  it('round-trips a CIDv0 through decodeContenthashWrapped', () => {
    const hex = toHexString(TEST_V0);
    expect(hex).toMatch(/^0xe301/);
    const decoded = decodeContenthashWrapped(hex);
    expect(decoded.toString()).toBe(TEST_V0);
  });

  it('round-trips a CIDv1 through decodeContenthashWrapped', () => {
    const hex = toHexString(TEST_V1);
    expect(hex).toMatch(/^0xe301/);
    const decoded = decodeContenthashWrapped(hex);
    expect(decoded.toString()).toBe(TEST_V1);
    expect(decoded.toV1().toString()).toBe(TEST_V1);
  });

  it('does not base58-decode the CID string (the CIDv0-only bug)', () => {
    // The old implementation turned a CIDv1 string into 0xe301 + 44 garbage
    // bytes. The fixed implementation encodes the raw CID bytes: 0x (2) +
    // e301 (4) + version 01 (2) + codec 70 (2) + multihash 12 20 (4) + 32-byte
    // digest (64) = 78 hex chars.
    expect(toHexString(TEST_V1).length).toBe(78);
    expect(toHexString(TEST_V0).length).toBe(78);
  });
});

// ============================================================================
// mapWithLimit — the concurrency cap used for the NAME() fan-out preserves
// Promise.allSettled semantics (order + fulfilled/rejected per index) while
// never running more than `limit` promises at once.
// ============================================================================

describe('mapWithLimit (NAME() fan-out concurrency cap)', () => {
  it('returns per-index PromiseSettledResult in input order, preserving fulfilled + rejected', async () => {
    const results = await mapWithLimit([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error('no NAME');
      return `ok-${n}`;
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok-1' });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok-3' });
  });

  it('never runs more than `limit` promises concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithLimit([0, 1, 2, 3, 4, 5, 6], 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return true;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3);
  });

  it('handles an empty input array', async () => {
    await expect(mapWithLimit([], 3, async () => 1)).resolves.toEqual([]);
  });
});
