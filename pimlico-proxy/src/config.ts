/**
 * Environment parsing and validation.
 *
 * `loadConfig` is the only way the rest of the service sees the environment: it
 * returns a fully validated `Config` or throws a `ConfigError` naming the
 * offending variable. Secrets never appear in an error message.
 */

import type { AllowedCall, AuthMode, Config } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_ALLOWED_METHODS: readonly string[] = [
  'eth_chainId',
  'eth_supportedEntryPoints',
  'eth_estimateUserOperationGas',
  'eth_sendUserOperation',
  'eth_getUserOperationReceipt',
  'eth_getUserOperationByHash',
  'pimlico_getUserOperationGasPrice',
  'pimlico_getUserOperationStatus',
  'pm_sponsorUserOperation',
  'pm_getPaymasterStubData',
  'pm_getPaymasterData',
];

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const SELECTOR_PATTERN = /^0x[0-9a-f]{8}$/;
const BASE_URL_DEFAULT = 'https://api.pimlico.io';
const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Trimmed value, or `undefined` when absent or empty (empty means unset). */
function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new ConfigError(`${name} is required`);
  return value;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new ConfigError(`${name} must be one of: true, false, 1, 0, yes, no`);
}

function parseInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max?: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer`);
  }
  const value = Number(raw);
  const upperBound = max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < min || value > upperBound) {
    throw new ConfigError(
      max === undefined
        ? `${name} must be an integer >= ${min}`
        : `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

/** Split a comma-separated list, trimming entries and rejecting empty fields. */
function splitList(name: string, raw: string): string[] {
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) {
    throw new ConfigError(`${name} must not contain an empty entry`);
  }
  return entries;
}

function parseChainId(name: string, raw: string, entry: string): number {
  if (!/^\+?\d+$/.test(raw)) {
    throw new ConfigError(`${name} entry "${entry}" must contain a positive integer chain id`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${name} entry "${entry}" must contain a positive integer chain id`);
  }
  return value;
}

function parseAllowedChainIds(raw: string): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const entry of splitList('ALLOWED_CHAIN_IDS', raw)) {
    ids.add(parseChainId('ALLOWED_CHAIN_IDS', entry, entry));
  }
  return ids;
}

function parseAllowedCall(entry: string): AllowedCall {
  const fields = entry.split(':').map((field) => field.trim().toLowerCase());
  if (fields.length !== 2 && fields.length !== 3) {
    throw new ConfigError(
      `ALLOWED_CALLS entry "${entry}" must be address:selector or chainId:address:selector`,
    );
  }
  const scoped = fields.length === 3;
  const chainIdRaw = scoped ? (fields[0] ?? '') : undefined;
  const address = (scoped ? fields[1] : fields[0]) ?? '';
  const selector = (scoped ? fields[2] : fields[1]) ?? '';

  if (!ADDRESS_PATTERN.test(address)) {
    throw new ConfigError(
      `ALLOWED_CALLS entry "${entry}" has an invalid address (expected 0x followed by 40 hex characters)`,
    );
  }
  if (selector !== '*' && !SELECTOR_PATTERN.test(selector)) {
    throw new ConfigError(
      `ALLOWED_CALLS entry "${entry}" has an invalid selector (expected "*" or 0x followed by 8 hex characters)`,
    );
  }

  const call: AllowedCall = { target: address, selector };
  if (chainIdRaw !== undefined) {
    call.chainId = parseChainId('ALLOWED_CALLS', chainIdRaw, entry);
  }
  return call;
}

function parseAllowedCalls(raw: string): readonly AllowedCall[] {
  return splitList('ALLOWED_CALLS', raw).map(parseAllowedCall);
}

function parseCorsOrigins(raw: string): readonly string[] {
  return splitList('CORS_ORIGINS', raw).map((entry) => {
    if (entry.includes('*')) {
      throw new ConfigError(`CORS_ORIGINS entry "${entry}" must not be a wildcard`);
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError(`CORS_ORIGINS entry "${entry}" must be an absolute origin`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ConfigError(`CORS_ORIGINS entry "${entry}" must use http or https`);
    }
    if (url.origin !== entry) {
      throw new ConfigError(
        `CORS_ORIGINS entry "${entry}" must be a bare origin (no path, trailing slash, query or credentials)`,
      );
    }
    return url.origin;
  });
}

function parseBaseUrl(raw: string | undefined): string {
  const value = (raw ?? BASE_URL_DEFAULT).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('PIMLICO_BASE_URL must be an absolute URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError('PIMLICO_BASE_URL must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError('PIMLICO_BASE_URL must not contain a query or fragment');
  }
  const https = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && LOCALHOST_NAMES.has(url.hostname);
  if (!https && !localHttp) {
    throw new ConfigError('PIMLICO_BASE_URL must use https (http is allowed only for localhost)');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function parseAllowedFactories(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return splitList('ALLOWED_FACTORIES', raw).map((entry) => {
    const address = entry.toLowerCase();
    if (!ADDRESS_PATTERN.test(address)) {
      throw new ConfigError(
        `ALLOWED_FACTORIES entry "${entry}" is not an address (expected 0x followed by 40 hex characters)`,
      );
    }
    return address;
  });
}

function parseAuthMode(
  raw: string | undefined,
  nodeEnv: string | undefined,
  allowInsecureRaw: string | undefined,
): AuthMode {
  if (raw === undefined) return 'jwt';
  if (raw !== 'jwt' && raw !== 'none') {
    throw new ConfigError('AUTH_MODE must be "jwt" or "none"');
  }
  if (raw === 'none') {
    if (nodeEnv === 'production') {
      throw new ConfigError('AUTH_MODE=none is not allowed when NODE_ENV is production');
    }
    if (!parseBoolean('ALLOW_INSECURE_AUTH', allowInsecureRaw, false)) {
      throw new ConfigError('AUTH_MODE=none requires ALLOW_INSECURE_AUTH=true');
    }
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pimlicoApiKey = required(env, 'PIMLICO_API_KEY');
  const sponsorshipPolicyId = required(env, 'PIMLICO_SPONSORSHIP_POLICY_ID');
  const allowedChainIds = parseAllowedChainIds(required(env, 'ALLOWED_CHAIN_IDS'));
  const allowedCalls = parseAllowedCalls(required(env, 'ALLOWED_CALLS'));
  const corsOrigins = parseCorsOrigins(required(env, 'CORS_ORIGINS'));

  const authMode = parseAuthMode(
    optional(env, 'AUTH_MODE'),
    optional(env, 'NODE_ENV'),
    optional(env, 'ALLOW_INSECURE_AUTH'),
  );

  let jwtSecret: string | undefined;
  if (authMode === 'jwt') {
    jwtSecret = required(env, 'AUTH_JWT_SECRET');
    if (jwtSecret.length < 32) {
      throw new ConfigError('AUTH_JWT_SECRET must be at least 32 characters');
    }
  }
  const jwtIssuer = optional(env, 'AUTH_JWT_ISSUER');
  const jwtAudience = optional(env, 'AUTH_JWT_AUDIENCE');

  const rateLimitPerMinute = parseInteger(
    'RATE_LIMIT_PER_MINUTE',
    optional(env, 'RATE_LIMIT_PER_MINUTE'),
    60,
    1,
  );
  const allowNativeValue = parseBoolean(
    'ALLOW_NATIVE_VALUE',
    optional(env, 'ALLOW_NATIVE_VALUE'),
    false,
  );
  const allowDeployment = parseBoolean(
    'ALLOW_DEPLOYMENT',
    optional(env, 'ALLOW_DEPLOYMENT'),
    false,
  );
  const allowedFactories = parseAllowedFactories(optional(env, 'ALLOWED_FACTORIES'));

  const allowedMethodsRaw = optional(env, 'ALLOWED_METHODS');
  const allowedMethods =
    allowedMethodsRaw === undefined
      ? new Set(DEFAULT_ALLOWED_METHODS)
      : new Set(splitList('ALLOWED_METHODS', allowedMethodsRaw));

  const trustProxy = parseBoolean('TRUST_PROXY', optional(env, 'TRUST_PROXY'), false);
  const upstreamTimeoutMs = parseInteger(
    'UPSTREAM_TIMEOUT_MS',
    optional(env, 'UPSTREAM_TIMEOUT_MS'),
    15000,
    1000,
  );
  const pimlicoBaseUrl = parseBaseUrl(optional(env, 'PIMLICO_BASE_URL'));
  const port = parseInteger('PORT', optional(env, 'PORT'), 8080, 1, 65535);

  return {
    port,
    pimlicoApiKey,
    sponsorshipPolicyId,
    pimlicoBaseUrl,
    allowedChainIds,
    allowedCalls,
    allowedMethods,
    authMode,
    jwtSecret,
    jwtIssuer,
    jwtAudience,
    corsOrigins,
    rateLimitPerMinute,
    allowNativeValue,
    allowDeployment,
    allowedFactories,
    trustProxy,
    upstreamTimeoutMs,
  };
}
