import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyEvmError, evmRead } from './evm';
import { mapWithLimit } from './ens.factory';

// ============================================================================
// classifyEvmError — distinguish GENUINE on-chain reverts (never retry) from
// TRANSPORT / connection failures (retry with backoff).
//
// The critical case: ethers v5 can MISLABEL a dropped response as an on-chain
// revert — a CALL_EXCEPTION with reason 'missing revert data', data=0x, whose
// TRUE cause lives in the nested `error.error` chain (SERVER_ERROR reason
// 'missing response' / serverError ECONNRESET). The classifier must spot the
// transport signal at any depth and NOT retry genuine reverts.
// ============================================================================

describe('classifyEvmError', () => {
  it('classifies a genuine on-chain revert (ethers CALL_EXCEPTION) as revert', () => {
    const err = {
      code: 'CALL_EXCEPTION',
      reason: 'execution reverted: not the owner',
      data: '0x',
      message: 'call revert exception',
    };
    expect(classifyEvmError(err)).toBe('revert');
  });

  it('classifies a revert carrying a real revert payload (data != 0x) as revert', () => {
    const err = {
      code: 'CALL_EXCEPTION',
      reason: 'missing revert data',
      data: '0x08c379a000000000000000000000000000000000000000000000000000000000',
      message: 'call revert exception',
    };
    expect(classifyEvmError(err)).toBe('revert');
  });

  it('classifies a raw node error with RPC code 3 (execution reverted) as revert', () => {
    const err = { code: 3, message: 'execution reverted: some reason' };
    expect(classifyEvmError(err)).toBe('revert');
  });

  it('classifies a message containing "reverted" as revert', () => {
    const err = { message: 'VM Exception while processing transaction: reverted' };
    expect(classifyEvmError(err)).toBe('revert');
  });

  it('classifies a plain SERVER_ERROR missing-response / ECONNRESET as transport', () => {
    const err = {
      code: 'SERVER_ERROR',
      reason: 'missing response',
      serverError: { code: 'ECONNRESET', message: 'read ECONNRESET' },
      message: 'missing response',
    };
    expect(classifyEvmError(err)).toBe('transport');
  });

  it('KEY CASE: classifies the ethers-v5 MISLABELLED CALL_EXCEPTION (data=0x wrapping a SERVER_ERROR missing response / ECONNRESET) as transport', () => {
    const err = {
      code: 'CALL_EXCEPTION',
      reason: 'missing revert data',
      data: '0x',
      message: 'missing revert data',
      error: {
        code: 'SERVER_ERROR',
        reason: 'missing response',
        serverError: { code: 'ECONNRESET', message: 'The socket connection was closed unexpectedly' },
        message: 'missing response',
      },
    };
    expect(classifyEvmError(err)).toBe('transport');
  });

  it('classifies an ethers TIMEOUT error as transport (retryable)', () => {
    const err = { code: 'TIMEOUT', reason: 'timeout', message: 'timeout' };
    expect(classifyEvmError(err)).toBe('transport');
  });

  it('classifies a plain socket-closed network error as transport', () => {
    const err = { code: 'SERVER_ERROR', message: 'The socket connection was closed unexpectedly' };
    expect(classifyEvmError(err)).toBe('transport');
  });

  it('returns unknown when there is no clear revert or transport signal', () => {
    const err = { code: 'UNPREDICTABLE_GAS_LIMIT', message: 'cannot estimate gas' };
    expect(classifyEvmError(err)).toBe('unknown');
  });

  it('transport detection walks nested serverError objects at any depth', () => {
    const err = {
      code: 'CALL_EXCEPTION',
      reason: 'missing revert data',
      data: '0x',
      error: { code: 'SERVER_ERROR', reason: 'missing response', serverError: { code: 'SCONNRESET' } },
    };
    expect(classifyEvmError(err)).toBe('transport');
  });
});

// ============================================================================
// evmRead — retries ONLY on transport failures; genuine reverts propagate as-is
// with no retry, exactly once per URL.
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
// `contract[method](...)`; if it throws the error is surfaced (classifier sees
// it), otherwise the returned value is the result.
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

describe('evmRead retry-on-transport-only behaviour', () => {
  beforeEach(() => {
    delete (globalThis as any).ethers;
  });

  it('retries a transport failure and eventually succeeds', async () => {
    const seq = [
      Object.assign(new Error('RPC call to https://rpc.example failed'), {
        code: 'SERVER_ERROR',
        reason: 'missing response',
        serverError: { code: 'ECONNRESET' },
      }),
      'NAME',
    ];
    const { contractCalls } = withFakeEthers(() => seq.shift());
    const result = await evmRead('L2', '0xaddr', ABI, 'NAME', [], RPC_URLS);
    expect(result).toBe('NAME');
    expect(contractCalls()).toBe(2); // attempt 1 failed (transport), attempt 2 succeeded
  });

  it('does NOT retry a genuine on-chain revert — propagates it immediately', async () => {
    const revertErr = Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
      reason: 'execution reverted: no NAME()',
      data: '0x',
    });
    const { contractCalls } = withFakeEthers(() => revertErr);
    await expect(evmRead('L2', '0xaddr', ABI, 'NAME', [], RPC_URLS)).rejects.toBe(revertErr);
    expect(contractCalls()).toBe(1); // exactly one attempt, no retry
  });

  it('retries across multiple rpc URLs within an attempt on transport failure', async () => {
    // Two URLs; the first always transport-fails, the second succeeds. evmRead
    // must fall through to url B within the first attempt (no backoff between
    // urls of the same attempt) and return B's value.
    const urls = ['https://a.example', 'https://b.example'];
    const seenPerUrl: Record<string, number> = {};
    class PerUrlContract {
      constructor(_address: string, _abi: any, provider: any) {
        const myUrl = provider.connection.url;
        seenPerUrl[myUrl] = (seenPerUrl[myUrl] || 0) + 1;
        return new Proxy(this, {
          get: () => () => {
            if (myUrl === 'https://a.example') {
              throw Object.assign(new Error('x'), {
                code: 'SERVER_ERROR', reason: 'missing response', serverError: { code: 'ECONNRESET' },
              });
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
    // URL a was attempted once and transport-failed; URL b succeeded on first try (no retry round needed).
    expect(seenPerUrl['https://a.example']).toBe(1);
    expect(seenPerUrl['https://b.example']).toBe(1);
  });

  it('still succeeds on a later attempt after every configured url transport-fails', async () => {
    // Single URL that transport-fails twice then succeeds (exercise the backoff retry loop).
    const outcomes = [
      Object.assign(new Error('t1'), { code: 'SERVER_ERROR', reason: 'missing response', serverError: { code: 'ECONNRESET' } }),
      Object.assign(new Error('t2'), { code: 'SERVER_ERROR', reason: 'missing response', serverError: { code: 'ECONNRESET' } }),
      'ok',
    ];
    const { contractCalls } = withFakeEthers(() => outcomes.shift());
    const result = await evmRead('L2', '0xaddr', ABI, 'NAME', [], RPC_URLS);
    expect(result).toBe('ok');
    expect(contractCalls()).toBe(3);
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
