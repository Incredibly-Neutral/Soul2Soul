import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { encodeFunctionData, parseAbiItem, slice, type Hex } from 'viem';

import { DEFAULT_ALLOWED_METHODS } from '../src/config.js';
import { handleCall, rpcError } from '../src/rpc.js';
import type { Config, FetchFn, RpcErrorObject, RpcResponse } from '../src/types.js';

/* ------------------------------------------------------------- fixtures */

const API_KEY = 'sk_test_secret_key_do_not_leak';
const POLICY_ID = 'sp_server_policy';
const BASE_URL = 'https://api.pimlico.io';
const CHAIN = 8453;
const OTHER_CHAIN = 1;
const ENTRY_POINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789' as const;

const TARGET = '0x2222222222222222222222222222222222222222' as const;
const OTHER = '0x4444444444444444444444444444444444444444' as const;

const TRANSFER_ABI = parseAbiItem('function transfer(address to, uint256 amount)');
const TRANSFER_DATA = encodeFunctionData({ abi: [TRANSFER_ABI], args: [OTHER, 1n] });
const TRANSFER_SELECTOR = slice(TRANSFER_DATA, 0, 4);

const EXECUTE_ABI = parseAbiItem('function execute(address dest, uint256 value, bytes data)');

function userOpCalling(target: `0x${string}`, data: Hex): { callData: Hex } {
  return {
    callData: encodeFunctionData({ abi: [EXECUTE_ABI], args: [target, 0n, data] }),
  };
}

const GOOD_OP = userOpCalling(TARGET, TRANSFER_DATA);
const BAD_OP = userOpCalling(OTHER, TRANSFER_DATA);
const BAD_OP_MESSAGE = `target ${OTHER} not allowed on chain ${CHAIN}`;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8080,
    pimlicoApiKey: API_KEY,
    sponsorshipPolicyId: POLICY_ID,
    pimlicoBaseUrl: BASE_URL,
    allowedChainIds: new Set([CHAIN]),
    allowedCalls: [{ target: TARGET, selector: TRANSFER_SELECTOR }],
    allowedMethods: new Set(DEFAULT_ALLOWED_METHODS),
    authMode: 'none',
    corsOrigins: [],
    rateLimitPerMinute: 60,
    allowNativeValue: false,
    allowDeployment: false,
    allowedFactories: [],
    trustProxy: false,
    upstreamTimeoutMs: 1000,
    ...overrides,
  };
}

type RecordedCall = { url: string; init: RequestInit };

type Recorder = { calls: RecordedCall[]; fetchFn: FetchFn };

/** A fake fetch that records the request and answers with `body` verbatim. */
function recorder(body: unknown, status = 200): Recorder {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as FetchFn;
  return { calls, fetchFn };
}

const OK_BODY = { jsonrpc: '2.0', id: 1, result: '0x1' };

function only(calls: RecordedCall[]): RecordedCall {
  assert.equal(calls.length, 1, 'expected exactly one upstream call');
  const first = calls[0];
  assert.ok(first !== undefined);
  return first;
}

function forwardedBody(recorded: RecordedCall): Record<string, unknown> {
  const body = recorded.init.body;
  assert.equal(typeof body, 'string');
  return JSON.parse(body as string) as Record<string, unknown>;
}

function errorOf(response: RpcResponse): RpcErrorObject {
  if (!('error' in response)) {
    assert.fail(`expected an error response, got ${JSON.stringify(response)}`);
  }
  return response.error;
}

function resultOf(response: RpcResponse): unknown {
  if (!('result' in response)) {
    assert.fail(`expected a result response, got ${JSON.stringify(response)}`);
  }
  return response.result;
}

/* ----------------------------------------------------------------- tests */

describe('rpcError', () => {
  test('defaults a missing id to null', () => {
    assert.deepEqual(rpcError(undefined, -32601, 'method not allowed'), {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32601, message: 'method not allowed' },
    });
  });

  test('keeps a string id', () => {
    assert.deepEqual(rpcError('abc', -32602, 'bad'), {
      jsonrpc: '2.0',
      id: 'abc',
      error: { code: -32602, message: 'bad' },
    });
  });
});

describe('handleCall allowlist', () => {
  test('rejects a method outside the allowlist without forwarding', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      { jsonrpc: '2.0', id: 7, method: 'pm_validateSponsorshipPolicies', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'method not allowed' },
    });
    assert.equal(calls.length, 0);
  });

  test('rejects an unknown method without forwarding', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      { jsonrpc: '2.0', id: 1, method: 'debug_traceCall', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.equal(errorOf(response).code, -32601);
    assert.equal(calls.length, 0);
  });
});

describe('handleCall forwarding', () => {
  test('forwards an allowed non-userOp method and returns the upstream result', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      { jsonrpc: '2.0', id: 'client-id-1', method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(response, { jsonrpc: '2.0', id: 'client-id-1', result: '0x1' });
    assert.equal(calls.length, 1);
  });

  test('posts to the exact Pimlico URL and replays method, params and id', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    await handleCall(
      {
        jsonrpc: '2.0',
        id: 42,
        method: 'eth_getUserOperationReceipt',
        params: ['0xabc'],
      },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    const recorded = only(calls);
    assert.equal(recorded.url, `${BASE_URL}/v2/${CHAIN}/rpc?apikey=${API_KEY}`);
    assert.equal(recorded.init.method, 'POST');
    assert.deepEqual(recorded.init.headers, { 'content-type': 'application/json' });
    assert.deepEqual(forwardedBody(recorded), {
      jsonrpc: '2.0',
      id: 42,
      method: 'eth_getUserOperationReceipt',
      params: ['0xabc'],
    });
    assert.ok(recorded.init.signal instanceof AbortSignal);
  });

  test('sends a null id when the client omitted one', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    await handleCall({ jsonrpc: '2.0', method: 'eth_chainId' }, CHAIN, makeConfig(), fetchFn);

    assert.equal(forwardedBody(only(calls))['id'], null);
  });

  test('forwards non-array params as an empty array', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    await handleCall(
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: { not: 'an array' } },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(forwardedBody(only(calls))['params'], []);
  });
});

describe('handleCall calldata policy', () => {
  test('rejects an off-allowlist userOp with the policy message', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'eth_estimateUserOperationGas',
        params: [BAD_OP, ENTRY_POINT],
      },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32602, message: BAD_OP_MESSAGE },
    });
    assert.equal(calls.length, 0);
  });

  test('rejects a userOp with unusable callData', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'eth_sendUserOperation',
        params: [{ callData: '0x1234' }, ENTRY_POINT],
      },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.equal(errorOf(response).code, -32602);
    assert.equal(calls.length, 0);
  });

  test('rejects a userOp carrying an EIP-7702 authorization before forwarding', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      {
        jsonrpc: '2.0',
        id: 26,
        method: 'eth_sendUserOperation',
        params: [{ ...GOOD_OP, eip7702Auth: `0x${'11'.repeat(97)}` }, ENTRY_POINT],
      },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(errorOf(response), { code: -32602, message: 'eip7702Auth not allowed' });
    assert.equal(calls.length, 0);
  });

  test('does not run the calldata policy on read-only methods', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'eth_getUserOperationByHash',
        params: ['0xdeadbeef'],
      },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(resultOf(response), '0x1');
    assert.equal(calls.length, 1);
  });
});

describe('handleCall pm_sponsorUserOperation injection', () => {
  test('overwrites the client policy id and keeps the rest of the metadata', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);
    const metadata = { sponsorshipPolicyId: 'client-chosen', keep: 'me' };

    const response = await handleCall(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'pm_sponsorUserOperation',
        params: [GOOD_OP, ENTRY_POINT, metadata],
      },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(resultOf(response), '0x1');
    const params = forwardedBody(only(calls))['params'] as unknown[];
    assert.deepEqual(params[2], { sponsorshipPolicyId: POLICY_ID, keep: 'me' });
    // The caller's object was cloned, not rewritten.
    assert.deepEqual(metadata, { sponsorshipPolicyId: 'client-chosen', keep: 'me' });
  });

  test('adds the policy id when metadata is missing', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    await handleCall(
      { jsonrpc: '2.0', id: 13, method: 'pm_sponsorUserOperation', params: [GOOD_OP, ENTRY_POINT] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    const params = forwardedBody(only(calls))['params'] as unknown[];
    assert.deepEqual(params[2], { sponsorshipPolicyId: POLICY_ID });
  });

  test('replaces non-object metadata instead of spreading it', async () => {
    for (const junk of [null, 'client-metadata', ['a', 'b']]) {
      const { calls, fetchFn } = recorder(OK_BODY);

      await handleCall(
        {
          jsonrpc: '2.0',
          id: 14,
          method: 'pm_sponsorUserOperation',
          params: [GOOD_OP, ENTRY_POINT, junk],
        },
        CHAIN,
        makeConfig(),
        fetchFn,
      );

      const params = forwardedBody(only(calls))['params'] as unknown[];
      assert.deepEqual(params[2], { sponsorshipPolicyId: POLICY_ID });
    }
  });
});

describe('handleCall ERC-7677 paymaster injection', () => {
  for (const method of ['pm_getPaymasterStubData', 'pm_getPaymasterData']) {
    test(`${method} overwrites context.sponsorshipPolicyId and keeps other keys`, async () => {
      const { calls, fetchFn } = recorder(OK_BODY);

      const response = await handleCall(
        {
          jsonrpc: '2.0',
          id: 15,
          method,
          params: [
            GOOD_OP,
            ENTRY_POINT,
            String(CHAIN),
            { sponsorshipPolicyId: 'client-chosen', keep: 'me' },
          ],
        },
        CHAIN,
        makeConfig(),
        fetchFn,
      );

      assert.deepEqual(resultOf(response), '0x1');
      const params = forwardedBody(only(calls))['params'] as unknown[];
      assert.deepEqual(params[3], { sponsorshipPolicyId: POLICY_ID, keep: 'me' });
    });

    test(`${method} adds a fresh context when it is missing`, async () => {
      const { calls, fetchFn } = recorder(OK_BODY);

      await handleCall(
        { jsonrpc: '2.0', id: 16, method, params: [GOOD_OP, ENTRY_POINT, CHAIN] },
        CHAIN,
        makeConfig(),
        fetchFn,
      );

      const params = forwardedBody(only(calls))['params'] as unknown[];
      assert.deepEqual(params[3], { sponsorshipPolicyId: POLICY_ID });
    });

    test(`${method} rejects a chainId that contradicts the route`, async () => {
      const { calls, fetchFn } = recorder(OK_BODY);

      const response = await handleCall(
        {
          jsonrpc: '2.0',
          id: 17,
          method,
          params: [GOOD_OP, ENTRY_POINT, String(OTHER_CHAIN), { foo: 'bar' }],
        },
        CHAIN,
        makeConfig(),
        fetchFn,
      );

      assert.deepEqual(response, {
        jsonrpc: '2.0',
        id: 17,
        error: { code: -32602, message: 'chainId mismatch' },
      });
      assert.equal(calls.length, 0);
    });
  }

  test('rejects a missing params[2] as a chainId mismatch', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      {
        jsonrpc: '2.0',
        id: 18,
        method: 'pm_getPaymasterData',
        params: [GOOD_OP, ENTRY_POINT],
      },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.equal(errorOf(response).code, -32602);
    assert.equal(errorOf(response).message, 'chainId mismatch');
    assert.equal(calls.length, 0);
  });

  test('a bad userOp fails the calldata policy before the chainId check', async () => {
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      {
        jsonrpc: '2.0',
        id: 19,
        method: 'pm_getPaymasterStubData',
        params: [BAD_OP, ENTRY_POINT, String(OTHER_CHAIN), {}],
      },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(errorOf(response), { code: -32602, message: BAD_OP_MESSAGE });
    assert.equal(calls.length, 0);
  });
});

describe('handleCall upstream responses', () => {
  test('passes a JSON-RPC error through with the client id and only code and message', async () => {
    const { fetchFn } = recorder(
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32500, message: 'userOp rejected', data: { secret: 'x' } },
      },
      400,
    );

    const response = await handleCall(
      { jsonrpc: '2.0', id: 'client-id-2', method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 'client-id-2',
      error: { code: -32500, message: 'userOp rejected' },
    });
  });

  test('falls back to -32603 when the error object has the wrong types', async () => {
    const { fetchFn } = recorder({ jsonrpc: '2.0', id: 1, error: { code: 'no', message: 5 } }, 400);

    const response = await handleCall(
      { jsonrpc: '2.0', id: 20, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(errorOf(response), { code: -32603, message: 'upstream error' });
  });

  test('falls back to -32603 for a non-2xx without a JSON-RPC error body', async () => {
    const { fetchFn } = recorder({ jsonrpc: '2.0', id: 1 }, 500);

    const response = await handleCall(
      { jsonrpc: '2.0', id: 21, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(errorOf(response), { code: -32603, message: 'upstream error' });
  });

  test('a 200 body with neither result nor error becomes -32603', async () => {
    const { fetchFn } = recorder({ jsonrpc: '2.0', id: 1 }, 200);

    const response = await handleCall(
      { jsonrpc: '2.0', id: 27, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 27,
      error: { code: -32603, message: 'upstream error' },
    });
  });

  test('a null result is still a result', async () => {
    const { fetchFn } = recorder({ jsonrpc: '2.0', id: 1, result: null });

    const response = await handleCall(
      { jsonrpc: '2.0', id: 28, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(response, { jsonrpc: '2.0', id: 28, result: null });
  });

  test('scrubs the API key out of an upstream message', async () => {
    const { fetchFn } = recorder(
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32500, message: `invalid key ${API_KEY} for this chain` },
      },
      401,
    );

    const response = await handleCall(
      { jsonrpc: '2.0', id: 29, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    const error = errorOf(response);
    assert.equal(error.code, -32500);
    assert.equal(error.message, 'invalid key [redacted] for this chain');
    assert.ok(!JSON.stringify(response).includes(API_KEY));
  });

  test('scrubs the sponsorship policy id out of an upstream message', async () => {
    const { fetchFn } = recorder(
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32500, message: `policy ${POLICY_ID} is not configured` },
      },
      400,
    );

    const response = await handleCall(
      { jsonrpc: '2.0', id: 30, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.equal(errorOf(response).message, 'policy [redacted] is not configured');
    assert.ok(!JSON.stringify(response).includes(POLICY_ID));
  });

  test('relays a normal revert reason untouched', async () => {
    const reason = 'execution reverted: ERC20: transfer amount exceeds balance';
    const { fetchFn } = recorder(
      { jsonrpc: '2.0', id: 1, error: { code: -32521, message: reason } },
      400,
    );

    const response = await handleCall(
      { jsonrpc: '2.0', id: 31, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(errorOf(response), { code: -32521, message: reason });
  });

  test('drops an upstream message longer than 4096 characters', async () => {
    const { fetchFn } = recorder(
      { jsonrpc: '2.0', id: 1, error: { code: -32500, message: `revert ${'x'.repeat(4096)}` } },
      400,
    );

    const response = await handleCall(
      { jsonrpc: '2.0', id: 32, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.deepEqual(errorOf(response), { code: -32500, message: 'upstream error' });
  });

  test('keeps an upstream message of exactly 4096 characters', async () => {
    const message = 'y'.repeat(4096);
    const { fetchFn } = recorder({ jsonrpc: '2.0', id: 1, error: { code: -32500, message } }, 400);

    const response = await handleCall(
      { jsonrpc: '2.0', id: 33, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    assert.equal(errorOf(response).message, message);
  });

  test('a non-JSON body becomes -32603 and leaks neither the URL nor the key', async () => {
    const { fetchFn } = recorder('<html>gateway error</html>');

    const response = await handleCall(
      { jsonrpc: '2.0', id: 22, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    const error = errorOf(response);
    assert.equal(error.code, -32603);
    const text = JSON.stringify(response);
    assert.ok(!text.includes(BASE_URL));
    assert.ok(!text.includes(API_KEY));
  });
});

describe('handleCall upstream failures', () => {
  test('a rejecting fetch becomes -32603 without the URL or key in the message', async () => {
    const fetchFn = (async () => {
      throw new Error(`connect ECONNREFUSED ${BASE_URL}?apikey=${API_KEY}`);
    }) as unknown as FetchFn;

    const response = await handleCall(
      { jsonrpc: '2.0', id: 23, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig(),
      fetchFn,
    );

    const error = errorOf(response);
    assert.equal(error.code, -32603);
    assert.ok(!error.message.includes(BASE_URL));
    assert.ok(!error.message.includes(API_KEY));
    const text = JSON.stringify(response);
    assert.ok(!text.includes(API_KEY));
  });

  test('a hung fetch is cut off by upstreamTimeoutMs', async () => {
    const calls: RecordedCall[] = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        });
      });
    }) as unknown as FetchFn;

    const response = await handleCall(
      { jsonrpc: '2.0', id: 24, method: 'eth_chainId', params: [] },
      CHAIN,
      makeConfig({ upstreamTimeoutMs: 5 }),
      fetchFn,
    );

    assert.equal(errorOf(response).code, -32603);
    assert.equal(response.id, 24);
    assert.ok(!JSON.stringify(response).includes(API_KEY));
    assert.equal(calls.length, 1);
  });
});

describe('handleCall internal errors', () => {
  test('an unexpected throw inside the policy becomes -32603 without details', async () => {
    // A config whose allowlist entry is not an object: the policy throws a
    // TypeError (not a PolicyError) while evaluating the target.
    const brokenCfg = makeConfig({
      allowedCalls: [{ target: null, selector: '*' }] as unknown as Config['allowedCalls'],
    });
    const { calls, fetchFn } = recorder(OK_BODY);

    const response = await handleCall(
      {
        jsonrpc: '2.0',
        id: 25,
        method: 'eth_sendUserOperation',
        params: [GOOD_OP, ENTRY_POINT],
      },
      CHAIN,
      brokenCfg,
      fetchFn,
    );

    assert.deepEqual(errorOf(response), { code: -32603, message: 'internal error' });
    assert.equal(calls.length, 0);
  });
});
