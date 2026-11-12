import { describe, it, expect, beforeEach } from 'vitest';
import { evmRead, evmWrite, toHexString } from './evm';
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

// ============================================================================
// evmWrite receipt-wait retry (WRITE-CONFIRMATION path only).
//
// Regression context (see evm.ts header): the single-shot ethers v5
// txResponse.wait(1) -> waitForTransaction -> poll() retries with backoff while
// the receipt is still null (pending/indexing) but REJECTS IMMEDIATELY on a
// transient RPC transport error (SERVER_ERROR / 'missing response' —
// @ethersproject/web index.js:395-399). The write path has one RPC URL and no
// retry, so a single DRPC load-balancer hiccup during the receipt wait failed
// the whole contenthash_wrapped write. waitForReceipt now polls
// getTransactionReceipt with bounded retry+backoff, treating BOTH a null
// receipt AND a transient transport error as 'not ready yet'.
// ============================================================================

describe('evmWrite receipt-wait retry (confirm:true)', () => {
  // Writes a fake global `ethers` (the bundle injects it at runtime) plus the
  // `Lit` global evmWrite touches, driving provider.getTransactionReceipt from
  // `receiptBehavior(callIndex)` so each test controls the receipt sequence
  // (throw SERVER_ERROR once / return null / return a mined receipt).
  const withFakeEthersWrite = (receiptBehavior: (callIndex: number) => any) => {
    let receiptCalls = 0;
    const HASH = '0x' + 'ab'.repeat(32);

    class FakeBigNumber {
      bn: number;
      constructor(n: any) {
        this.bn = Number(n);
      }
      mul(x: any) {
        return new FakeBigNumber(this.bn * Number(x));
      }
      div(x: any) {
        return new FakeBigNumber(Math.floor(this.bn / Number(x)));
      }
      toString() {
        return String(this.bn);
      }
    }

    class FakeProvider {
      connection: any;
      constructor(connection: any) {
        this.connection = connection;
      }
      async getTransactionCount() {
        return 5;
      }
      async estimateGas() {
        return new FakeBigNumber(60000);
      }
      async sendTransaction() {
        return { hash: HASH };
      }
      async getTransactionReceipt() {
        receiptCalls++;
        return receiptBehavior(receiptCalls);
      }
    }

    class FakeContract {
      interface = { encodeFunctionData: () => '0xdeadbeef' };
      constructor(_a: any, _b: any, _p: any) {}
    }

    class FakeWallet {
      async signTransaction() {
        return '0x' + 'cd'.repeat(32);
      }
    }

    (globalThis as any).ethers = {
      providers: { StaticJsonRpcProvider: FakeProvider },
      Contract: FakeContract,
      Wallet: FakeWallet,
      utils: { parseUnits: () => ({ toString: () => '0' }) },
      BigNumber: { from: (n: any) => new FakeBigNumber(n) },
    };
    (globalThis as any).Lit = {
      Actions: { getPrivateKey: async () => '0x' + '11'.repeat(32) },
    };

    return { receiptCalls: () => receiptCalls, HASH };
  };

  const minedReceipt = (blockNumber: number, status: number) => ({
    blockNumber,
    status,
    confirmations: 1,
    transactionHash: '0x' + 'ab'.repeat(32),
  });

  beforeEach(() => {
    delete (globalThis as any).ethers;
    delete (globalThis as any).Lit;
  });

  it('retries a transient SERVER_ERROR and succeeds on the next poll', async () => {
    // First getTransactionReceipt throws the exact DRPC transport error that
    // used to fail the whole write; the second returns a mined receipt.
    const seq = [
      new Error(
        'missing response (requestBody="{...}", url="https://lb.drpc.live/base/<key>", code=SERVER_ERROR, version=web/5.7.1)',
      ),
      minedReceipt(123, 1),
    ];
    const { receiptCalls, HASH } = withFakeEthersWrite((i) => seq[i - 1]);

    const result = await evmWrite(
      'L2',
      '0x' + '11'.repeat(20),
      '0x' + '22'.repeat(20),
      ABI,
      'setText',
      ['contenthash_wrapped', '0xabc'],
      true, // confirm:true — the WRITE-CONFIRMATION path this fix targets
      'https://lb.drpc.live/base/<key>',
    );

    expect(result.success).toBe(true);
    expect(result.hash).toBe(HASH);
    expect(result.receipt.blockNumber).toBe(123);
    // One failed poll (SERVER_ERROR, retried) + one success = two calls.
    expect(receiptCalls()).toBe(2);
  });

  it('treats a null receipt (still indexing) as not-ready and retries until mined', async () => {
    // Pending/indexing returns null (ethers returns null while not mined); the
    // second poll returns a mined receipt.
    const seq = [null, minedReceipt(456, 1)];
    const { receiptCalls, HASH } = withFakeEthersWrite((i) => seq[i - 1]);

    const result = await evmWrite(
      'L2',
      '0x' + '11'.repeat(20),
      '0x' + '22'.repeat(20),
      ABI,
      'setText',
      ['contenthash_wrapped', '0xabc'],
      true,
      'https://rpc.example',
    );

    expect(result.success).toBe(true);
    expect(result.hash).toBe(HASH);
    expect(result.receipt.blockNumber).toBe(456);
    expect(receiptCalls()).toBe(2);
  });

  it('still reports a mined-but-reverted receipt (status 0) as a failure', async () => {
    // Regression guard: the status === 0 reverted check must keep working on
    // the now-retried receipt path.
    const seq = [minedReceipt(789, 0)];
    const { receiptCalls } = withFakeEthersWrite((i) => seq[i - 1]);

    const result = await evmWrite(
      'L2',
      '0x' + '11'.repeat(20),
      '0x' + '22'.repeat(20),
      ABI,
      'setText',
      ['contenthash_wrapped', '0xabc'],
      true,
      'https://rpc.example',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('transaction reverted (status 0)');
    expect(receiptCalls()).toBe(1);
  });

  it('does NOT wait when confirm is false (fire-and-forget unchanged)', async () => {
    // confirm:false must not touch getTransactionReceipt at all.
    let called = false;
    const { receiptCalls } = withFakeEthersWrite(() => {
      called = true;
      return minedReceipt(1, 1);
    });

    const result = await evmWrite(
      'L2',
      '0x' + '11'.repeat(20),
      '0x' + '22'.repeat(20),
      ABI,
      'setText',
      ['contenthash_wrapped', '0xabc'],
      false, // confirm:false — no receipt wait
      'https://rpc.example',
    );

    expect(result.success).toBe(true);
    expect(called).toBe(false);
    expect(receiptCalls()).toBe(0);
  });
});

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
