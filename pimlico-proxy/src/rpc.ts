/**
 * The per-call pipeline: method allowlist, calldata policy, sponsorship
 * policy-id injection, forward.
 *
 * No ambient state: the chain, the config and the fetch implementation all
 * arrive as arguments, so a test drives the whole path without a socket. No
 * logging either — the caller logs, and all it sees is the returned response.
 */
import { PolicyError, checkUserOp } from './callPolicy.js';

import type {
  Config,
  FetchFn,
  JsonRpcId,
  RpcErrorObject,
  RpcRequest,
  RpcResponse,
} from './types.js';

/** Methods whose `params[0]` is a user operation that must pass the call policy. */
const CALLDATA_METHODS: ReadonlySet<string> = new Set([
  'eth_estimateUserOperationGas',
  'eth_sendUserOperation',
  'pm_sponsorUserOperation',
  'pm_getPaymasterStubData',
  'pm_getPaymasterData',
]);

/** ERC-7677 paymaster methods: `params[3]` is the context object we patch. */
const PAYMASTER_CONTEXT_METHODS: ReadonlySet<string> = new Set([
  'pm_getPaymasterStubData',
  'pm_getPaymasterData',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for the DOMExceptions `AbortSignal.timeout` and `fetch` raise. */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** A fresh context/metadata object carrying our policy id; junk is dropped. */
function withPolicy(target: unknown, policyId: string): Record<string, unknown> {
  const base = isPlainObject(target) ? target : {};
  return { ...base, sponsorshipPolicyId: policyId };
}

/** Copy only `code` and `message` out of an upstream error object. */
function toErrorObject(value: unknown): RpcErrorObject {
  const record = isPlainObject(value) ? value : {};
  const code = record['code'];
  const message = record['message'];
  return {
    code: typeof code === 'number' && Number.isFinite(code) ? code : -32603,
    message: typeof message === 'string' ? message : 'upstream error',
  };
}

/** The one error shape every rejection uses. */
export function rpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Filter, rewrite and forward one JSON-RPC call for `chainId`.
 *
 * The first failure returns and nothing is forwarded. Upstream messages are
 * replaced with fixed strings because the URL carries the API key.
 */
export async function handleCall(
  call: RpcRequest,
  chainId: number,
  cfg: Config,
  fetchFn: FetchFn = fetch,
): Promise<RpcResponse> {
  if (!cfg.allowedMethods.has(call.method)) {
    return rpcError(call.id, -32601, 'method not allowed');
  }

  // A copy, so the caller's object is never rewritten by the injection below.
  const params: unknown[] = Array.isArray(call.params) ? structuredClone(call.params) : [];

  if (CALLDATA_METHODS.has(call.method)) {
    try {
      checkUserOp(params[0], chainId, cfg);
    } catch (error) {
      if (error instanceof PolicyError) {
        return rpcError(call.id, -32602, error.message);
      }
      return rpcError(call.id, -32603, 'internal error');
    }
  }

  if (call.method === 'pm_sponsorUserOperation') {
    params[2] = withPolicy(params[2], cfg.sponsorshipPolicyId);
  } else if (PAYMASTER_CONTEXT_METHODS.has(call.method)) {
    if (Number(params[2]) !== chainId) {
      return rpcError(call.id, -32602, 'chainId mismatch');
    }
    params[3] = withPolicy(params[3], cfg.sponsorshipPolicyId);
  }

  return forward(call, chainId, cfg, params, fetchFn);
}

async function forward(
  call: RpcRequest,
  chainId: number,
  cfg: Config,
  params: unknown[],
  fetchFn: FetchFn,
): Promise<RpcResponse> {
  // One attempt, no retry, no redirect: the body and the timeout are the only
  // knobs. The query string holds the key, so it never reaches a message.
  const query = `apikey=${encodeURIComponent(cfg.pimlicoApiKey)}`;
  const url = `${cfg.pimlicoBaseUrl}/v2/${chainId}/rpc?${query}`;

  let response: Response;
  let parsed: unknown;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: call.id ?? null,
        method: call.method,
        params,
      }),
      signal: AbortSignal.timeout(cfg.upstreamTimeoutMs),
    });
    parsed = await response.json();
  } catch (error) {
    return isAbortError(error)
      ? rpcError(call.id, -32603, 'upstream timeout')
      : rpcError(call.id, -32603, 'upstream unavailable');
  }

  const id = call.id ?? null;

  if (!isPlainObject(parsed)) {
    return rpcError(call.id, -32603, 'upstream error');
  }

  // Pimlico answers 4xx with a JSON-RPC error body, so the body decides, not
  // the status. Only a non-2xx without an error body is a transport failure.
  const upstreamError = parsed['error'];
  if (upstreamError !== undefined && upstreamError !== null) {
    return { jsonrpc: '2.0', id, error: toErrorObject(upstreamError) };
  }

  if (!response.ok) {
    return rpcError(call.id, -32603, 'upstream error');
  }

  return { jsonrpc: '2.0', id, result: parsed['result'] };
}
