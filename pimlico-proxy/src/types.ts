/**
 * Shared contract types for the Pimlico proxy.
 *
 * Every module codes against this file. It is the interface the whole service
 * agrees on, so it changes only when the service's shape changes.
 */

export type Hex = `0x${string}`;

export type JsonRpcId = string | number | null;

export type RpcRequest = {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
};

export type RpcErrorObject = {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
};

export type RpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly error: RpcErrorObject };

/** Injected in tests so no request ever leaves the process. Defaults to `fetch`. */
export type FetchFn = typeof fetch;

/**
 * One allowed `target` + `selector` pair.
 *
 * `chainId` omitted means "every allowed chain". `selector` is `*` for "any
 * selector", otherwise the 4-byte selector as lowercase hex.
 */
export type AllowedCall = {
  chainId?: number;
  target: string;
  selector: string;
};

export type AuthMode = 'jwt' | 'none';

/** The fully parsed, validated runtime configuration. */
export type Config = {
  port: number;
  pimlicoApiKey: string;
  sponsorshipPolicyId: string;
  pimlicoBaseUrl: string;
  allowedChainIds: ReadonlySet<number>;
  allowedCalls: readonly AllowedCall[];
  allowedMethods: ReadonlySet<string>;
  authMode: AuthMode;
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  corsOrigins: readonly string[];
  rateLimitPerMinute: number;
  allowNativeValue: boolean;
  allowDeployment: boolean;
  allowedFactories: readonly string[];
  trustProxy: boolean;
  upstreamTimeoutMs: number;
};

/** What `verifyJwt` returns; the user identity the proxy logs and rate-limits on. */
export type AuthResult = {
  userId: string;
};
