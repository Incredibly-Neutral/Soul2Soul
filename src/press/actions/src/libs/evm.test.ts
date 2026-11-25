import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  evmRead,
  evmGetCode,
  evmWrite,
  toHexString,
  enableReadCache,
  disableReadCache,
  readFresh,
  rpcEnqueue,
} from './evm';
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
const realFetch = (globalThis as any).fetch;

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

  it('does NOT wait when confirm is false (fire-and-forget unchanged)', async () => {    // confirm:false must not touch getTransactionReceipt at all.
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

  it('polls the first receipt only after one block (2000 ms)', async () => {
    // A tx cannot be in a block before ~2s on Base; ethers' own 0ms first poll
    // could never see a receipt and only spent session requests. The first ask
    // now waits one block.
    vi.useFakeTimers();
    const savedFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
      throw new Error('offline');
    };
    try {
      const { receiptCalls } = withFakeEthersWrite(() => minedReceipt(1, 1));
      const done = evmWrite(
        'L2',
        '0x' + '11'.repeat(20),
        '0x' + '22'.repeat(20),
        ABI,
        'setText',
        ['contenthash_wrapped', '0xabc'],
        true,
        'https://rpc.example',
      );

      await vi.advanceTimersByTimeAsync(1999);
      expect(receiptCalls()).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(receiptCalls()).toBe(1);

      await done;
    } finally {
      vi.useRealTimers();
      (globalThis as any).fetch = savedFetch;
    }
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

  // The decrypt action reads the draft entry at the block the ownership gate
  // judged it at, so eth_call carries `{ blockTag }`. A tag of 0 is this
  // protocol's "no block recorded" marker, not a height: it must not be passed.
  it('passes a positive blockTag as the last contract argument', async () => {
    const { calls } = withFakeEthers(() => 'NAME');
    await evmRead('L2', '0xaddr', ABI, 'NAME', ['0x' + 'ab'.repeat(32)], RPC_URLS, 880);
    expect(calls[0].args).toEqual(['0x' + 'ab'.repeat(32), { blockTag: 880 }]);
  });

  it('passes no overrides for block 0, undefined or a non-finite tag', async () => {
    for (const tag of [0, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { calls } = withFakeEthers(() => 'NAME');
      await evmRead('L2', '0xaddr', ABI, 'NAME', [], RPC_URLS, tag);
      expect(calls[0].args).toEqual([]);
    }
  });
});

// ============================================================================
// evmGetCode — the same fail-fast transport contract as evmRead, one request
// per URL and no retry. Discovery uses it to tell a recorded module from a
// CREATE2 prediction with nothing deployed at it.
// ============================================================================

describe('read cache (one invocation, one budget)', () => {
  beforeEach(() => {
    delete (globalThis as any).ethers;
    enableReadCache();
  });

  afterEach(() => {
    disableReadCache();
  });

  it('answers an identical read once, for every item that asks', async () => {
    // The render's collection loop judges four items; the module resolution and
    // the ownership answer are the same for all of them.
    const { contractCalls } = withFakeEthers(() => '0xDrafts');
    for (let i = 0; i < 4; i++) {
      await evmRead('L2', '0xSafe', ABI, 'getModulesPaginated', ['0x01', 100], RPC_URLS);
    }
    expect(contractCalls()).toBe(1);
  });

  it('keeps reads with different arguments apart', async () => {
    const { contractCalls } = withFakeEthers(() => '0xAuthor');
    await evmRead('L2', '0xDrafts', ABI, 'authorOf', ['0xa1'], RPC_URLS);
    await evmRead('L2', '0xDrafts', ABI, 'authorOf', ['0xa2'], RPC_URLS);
    expect(contractCalls()).toBe(2);
  });

  it('does not remember a failed read as an answer — the next ask retries', async () => {
    let n = 0;
    const { contractCalls } = withFakeEthers(() => {
      n++;
      if (n === 1) return new Error('missing response');
      return '0xSafe';
    });
    await expect(evmRead('L2', '0xF', ABI, 'safe', [], RPC_URLS)).rejects.toThrow(
      /missing response/,
    );
    await expect(evmRead('L2', '0xF', ABI, 'safe', [], RPC_URLS)).resolves.toBe('0xSafe');
    expect(contractCalls()).toBe(2);
  });
});

describe('readFresh (a retry must reach the chain)', () => {
  beforeEach(() => {
    delete (globalThis as any).ethers;
    enableReadCache();
  });

  afterEach(() => {
    disableReadCache();
  });

  it('skips the cache for that call, and only that call', async () => {
    const { contractCalls } = withFakeEthers(() => 'true');

    await evmRead('L2', '0xF', ABI, 'hasAgreement', ['0x01'], RPC_URLS);
    await evmRead('L2', '0xF', ABI, 'hasAgreement', ['0x01'], RPC_URLS);
    // The cache answered the second ask without a request.
    expect(contractCalls()).toBe(1);

    await readFresh('L2', '0xF', ABI, 'hasAgreement', ['0x01'], RPC_URLS);
    expect(contractCalls()).toBe(2);

    // The cached answer stays the cached answer: the bypass is per call.
    await evmRead('L2', '0xF', ABI, 'hasAgreement', ['0x01'], RPC_URLS);
    expect(contractCalls()).toBe(2);
  });
});

// ============================================================================
// JSON-RPC batching — independent reads made in one tick share one request.
//
// Every request spends one of Lit's 50 per session. Two reads that start in the
// same tick go out as one batch; a lone read falls through to the per-URL path
// unchanged; and no failure shape is allowed to change the caller's answer.
// ============================================================================

describe('JSON-RPC batching', () => {
  const fakeInterface = () =>
    class FakeInterface {
      getFunction(method: string) {
        return { method, outputs: [{ type: 'bytes' }] };
      }
      encodeFunctionData(fragment: any) {
        return '0xcall' + fragment.method;
      }
      decodeFunctionResult(_fragment: any, raw: any) {
        return [raw];
      }
    };

  // Fake `ethers` with the call path the batch uses (Interface/hexValue) and
  // the per-URL fallback (Contract) so both can be counted.
  const withBatchEthers = (contractAnswer: (method: string) => any = () => '0xfallback') => {
    const contractCalls: string[] = [];
    const FakeInterface = fakeInterface();
    class FakeContract {
      constructor(_a: string, _b: any, _p: any) {
        return new Proxy(this, {
          get: (_t: any, prop: string) => () => {
            contractCalls.push(prop);
            const outcome = contractAnswer(prop);
            if (outcome instanceof Error) throw outcome;
            return outcome;
          },
        });
      }
    }
    (globalThis as any).ethers = {
      providers: { StaticJsonRpcProvider: FakeStaticJsonRpcProvider },
      Contract: FakeContract,
      utils: { Interface: FakeInterface, hexValue: (n: number) => '0x' + n.toString(16) },
    };
    return { contractCalls };
  };

  const stubFetch = (answer: (url: string, body: any[]) => any) => {
    const seen: Array<{ url: string; body: any[] }> = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      seen.push({ url, body });
      return { json: async () => answer(url, body) };
    };
    return seen;
  };

  beforeEach(() => {
    delete (globalThis as any).ethers;
    disableReadCache();
  });

  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  it('answers two reads made in one tick with one HTTP request', async () => {
    withBatchEthers();
    const seen = stubFetch((_url, body) =>
      body.map((call) => ({
        jsonrpc: '2.0',
        id: call.id,
        result: call.params[0].data === '0xcalla' ? '0xaaa' : '0xbbb',
      })),
    );

    const [a, b] = await Promise.all([
      evmRead('L2', '0xaddr', ABI, 'a', [], RPC_URLS),
      evmRead('L2', '0xaddr', ABI, 'b', [], RPC_URLS),
    ]);

    expect(a).toBe('0xaaa');
    expect(b).toBe('0xbbb');
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toHaveLength(2);
    expect(seen[0].body.map((call) => call.method)).toEqual(['eth_call', 'eth_call']);
  });

  it('sends a lone read through the per-URL path, not a one-call batch', async () => {
    const { contractCalls } = withBatchEthers(() => '0xsolo');
    const seen = stubFetch(() => {
      throw new Error('a lone read must not be sent as a batch');
    });

    const value = await evmRead('L2', '0xaddr', ABI, 'a', [], RPC_URLS);

    expect(value).toBe('0xsolo');
    expect(seen).toHaveLength(0);
    expect(contractCalls).toEqual(['a']);
  });

  it('falls back to the per-URL path when the node refuses the batch', async () => {
    const { contractCalls } = withBatchEthers(() => '0xfallback');
    const seen = stubFetch(() => ({ error: { code: -32000, message: 'batch refused' } }));

    const [a, b] = await Promise.all([
      evmRead('L2', '0xaddr', ABI, 'a', [], RPC_URLS),
      evmRead('L2', '0xaddr', ABI, 'b', [], RPC_URLS),
    ]);

    expect([a, b]).toEqual(['0xfallback', '0xfallback']);
    // One refused batch, then each read's own request.
    expect(seen).toHaveLength(1);
    expect(contractCalls).toEqual(['a', 'b']);
  });

  it('rejects only the errored entry of a batch, keeping the node message', async () => {
    stubFetch((_url, body) =>
      body.map((call) =>
        call.id === 0
          ? { jsonrpc: '2.0', id: 0, error: { code: -32000, message: 'execution reverted: nope' } }
          : { jsonrpc: '2.0', id: 1, result: '0xok' },
      ),
    );

    const bad = rpcEnqueue(RPC_URLS, 'eth_call', [{}]);
    const good = rpcEnqueue(RPC_URLS, 'eth_call', [{}]);

    const err: any = await bad.catch((e) => e);
    await expect(good).resolves.toBe('0xok');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('execution reverted: nope');
    // The node answered, it just said no — distinct from a transport failure.
    expect(err.rpcAnswered).toBe(true);
  });
});

// ============================================================================
// evmWrite — the nonce and the gas estimate are independent reads, so they go
// out in one batch instead of two sequential requests.
// ============================================================================

describe('evmWrite nonce and gas in one request', () => {
  const HASH = '0x' + 'ab'.repeat(32);

  const withWriteBatchEthers = () => {
    const providerCalls = { nonce: 0, gas: 0 };
    let signedTx: any;
    class FakeBigNumber {
      bn: number;
      constructor(n: any) {
        this.bn = Number(n);
      }
      toNumber() {
        return this.bn;
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
        providerCalls.nonce++;
        return 11;
      }
      async estimateGas() {
        providerCalls.gas++;
        return new FakeBigNumber(50000);
      }
      async sendTransaction() {
        return { hash: HASH };
      }
    }
    class FakeContract {
      interface = { encodeFunctionData: () => '0xdeadbeef' };
      constructor(_a: any, _b: any, _p: any) {}
    }
    class FakeWallet {
      async signTransaction(tx: any) {
        signedTx = tx;
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
    return { providerCalls, signedTx: () => signedTx };
  };

  const stubFetch = (answer: (body: any[]) => any) => {
    const seen: any[][] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      return { json: async () => answer(body) };
    };
    return seen;
  };

  beforeEach(() => {
    delete (globalThis as any).ethers;
    delete (globalThis as any).Lit;
  });

  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  it('asks for the nonce and the estimate in one request', async () => {
    const { providerCalls, signedTx } = withWriteBatchEthers();
    const seen = stubFetch((body) =>
      body.map((call) => ({
        jsonrpc: '2.0',
        id: call.id,
        result: call.method === 'eth_getTransactionCount' ? '0x7' : '0x5208',
      })),
    );

    const result = await evmWrite(
      'L2',
      '0x' + '11'.repeat(20),
      '0x' + '22'.repeat(20),
      ABI,
      'setText',
      ['contenthash_wrapped', '0xabc'],
      false,
      'https://rpc.example',
    );

    expect(result.success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].map((call) => call.method)).toEqual([
      'eth_getTransactionCount',
      'eth_estimateGas',
    ]);
    // The batch answered both, so the provider was not asked either.
    expect(providerCalls).toEqual({ nonce: 0, gas: 0 });
    expect(signedTx().nonce).toBe(7);
    // 21000 estimated + the 20% buffer.
    expect(signedTx().gasLimit.toString()).toBe('25200');
  });

  it('keeps 60000 when the node answers the estimate with an error', async () => {
    const { providerCalls, signedTx } = withWriteBatchEthers();
    stubFetch((body) =>
      body.map((call) =>
        call.method === 'eth_getTransactionCount'
          ? { jsonrpc: '2.0', id: call.id, result: '0x5' }
          : {
              jsonrpc: '2.0',
              id: call.id,
              error: { code: -32000, message: 'gas estimation reverted' },
            },
      ),
    );

    const result = await evmWrite(
      'L2',
      '0x' + '11'.repeat(20),
      '0x' + '22'.repeat(20),
      ABI,
      'setText',
      ['contenthash_wrapped', '0xabc'],
      false,
      'https://rpc.example',
    );

    expect(result.success).toBe(true);
    expect(providerCalls).toEqual({ nonce: 0, gas: 0 });
    expect(signedTx().nonce).toBe(5);
    expect(signedTx().gasLimit.toString()).toBe('72000');
  });

  it('retries a transport failure through ethers, still logging the message', async () => {
    const { providerCalls } = withWriteBatchEthers();
    stubFetch(() => {
      throw new Error('missing response');
    });

    await evmWrite(
      'L2',
      '0x' + '11'.repeat(20),
      '0x' + '22'.repeat(20),
      ABI,
      'setText',
      ['contenthash_wrapped', '0xabc'],
      false,
      'https://rpc.example',
    );

    expect(providerCalls).toEqual({ nonce: 1, gas: 1 });
  });
});

describe('evmGetCode fail-fast (single pass, no in-session retry)', () => {
  beforeEach(() => {
    delete (globalThis as any).ethers;
  });

  it('fails over to the second URL within the single pass and returns its code', async () => {
    const seenPerUrl: Record<string, number> = {};
    class PerUrlProvider {
      connection: any;
      constructor(connection: any) {
        this.connection = connection;
        const myUrl = connection.url;
        seenPerUrl[myUrl] = (seenPerUrl[myUrl] || 0) + 1;
        this.url = myUrl;
      }
      url: string;
      async getCode() {
        if (this.url === 'https://a.example') throw new Error('missing response');
        return '0x6080';
      }
    }
    (globalThis as any).ethers = { providers: { StaticJsonRpcProvider: PerUrlProvider } };

    const code = await evmGetCode('L2', '0x' + '11'.repeat(20), [
      'https://a.example',
      'https://b.example',
    ]);

    expect(code).toBe('0x6080');
    expect(seenPerUrl['https://a.example']).toBe(1);
    expect(seenPerUrl['https://b.example']).toBe(1);
  });

  it('throws an aggregated error when every URL fails', async () => {
    class AlwaysFailProvider {
      connection: any;
      constructor(connection: any) {
        this.connection = connection;
      }
      async getCode() {
        throw new Error('missing response');
      }
    }
    (globalThis as any).ethers = { providers: { StaticJsonRpcProvider: AlwaysFailProvider } };

    const err: any = await evmGetCode('L2', '0x' + '11'.repeat(20), [
      'https://a.example',
      'https://b.example',
    ]).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.failures.length).toBe(2); // one failure per URL, no retries
    expect(err.message).toContain('https://a.example');
    expect(err.message).toContain('https://b.example');
  });
});

// ============================================================================
// toHexString — EIP-1577 contenthash encode. The record is ALWAYS CIDv1.
//
// Two regressions live here. The old base58-big-number encode turned a CIDv1
// root into 0xe3 0x01 + a 44-byte misparse. The replacement then wrapped a
// CIDv0 root as-is, emitting synthetic `00 70` version/codec bytes
// (0xe30100701220…): no standard parser accepts that, so eth.limo read the
// contenthash, rejected it and refused the name — the reset of an older
// publication got a CIDv0 root and wrote exactly that. toHexString now
// normalises to v1 before encoding, so the same root version cannot change the
// on-chain value's validity.
// ============================================================================

const TEST_V0 = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
const TEST_V0_AS_V1 = 'bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq';
const TEST_V1 = 'bafybeigadpvuv4m3txrx4r3wtjclnkte5mvxb2hoyyvt4jlaqdeo6qrbwm';

describe('toHexString (EIP-1577 contenthash encode)', () => {
  it('encodes a CIDv0 root as the v1 form, not the synthetic 00 70 form', () => {
    const hex = toHexString(TEST_V0);
    // e3 (ipfs-ns) 01 (contenthash version) 01 (CIDv1) 70 (dag-pb) 12 20 (sha2-256, 32)
    expect(hex.slice(0, 14)).toBe('0xe30101701220');
    expect(hex.slice(0, 8)).not.toBe('0xe30100');
    expect(hex).toBe(
      '0xe301017012208cb97a00a6c90a14ecf182d8363583d402f69919e38f0498edd9d92a5c02a7b4',
    );
    // Same multihash, so the same blocks — only the label and the encoding change.
    expect(decodeContenthashWrapped(hex).toString()).toBe(TEST_V0_AS_V1);
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
    // digest (64) = 78 hex chars, whatever the root's own version was.
    expect(toHexString(TEST_V1).length).toBe(78);
    expect(toHexString(TEST_V0).length).toBe(78);
    expect(toHexString(TEST_V0)).toBe(toHexString(TEST_V0_AS_V1));
  });
});
