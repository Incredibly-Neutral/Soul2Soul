/**
 * App configuration — loaded from environment variables.
 */

export interface AppConfig {
  /** Publication URL: an ENS name (e.g. xxx.soul2soul.eth) or a bare CID string. */
  publicationUrl: string;

  /**
   * L1 RPC URL — Ethereum mainnet (chainId 1).
   * Used by the s2s ENS controller discovery leg (registry.nameWrapper →
   * ownerOf → parentDomainController). The root CID is NOT read here.
   */
  l1RpcUrl: string;

  /**
   * L2 RPC URL — Base mainnet (chainId 8453).
   * s2s stores the root CID as the text record `contenthash_wrapped` on the
   * ensRecords records contract on this chain; this is where it is read.
   */
  l2RpcUrl: string;

  /**
   * Optional override for the s2s ensRecords records contract address.
   * When unset, the records contract is discovered at runtime via the s2s
   * ENS flow (controller → configModule → getRecords('ens_records')).
   */
  recordsContract: string;

  /** Kubo (IPFS) RPC API base URL, e.g. http://localhost:5001. */
  ipfsApiUrl: string;

  /** HTTP port for the mirror API. */
  port: number;

  /** Optional auto-refresh interval in milliseconds. Off if not set. */
  refreshIntervalMs: number | null;

  /** Optional kubo RPC auth token (sent as Authorization header). */
  ipfsApiAuth: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function loadConfig(): AppConfig {
  return {
    publicationUrl: requireEnv('PUBLICATION_URL'),
    l1RpcUrl: requireEnv('L1_RPC_URL'),
    l2RpcUrl: requireEnv('L2_RPC_URL'),
    recordsContract: optionalEnv('RECORDS_CONTRACT', ''),
    ipfsApiUrl: optionalEnv('IPFS_API_URL', 'http://127.0.0.1:5001'),
    port: parseInt(optionalEnv('PORT', '3000'), 10),
    refreshIntervalMs: optionalIntEnv('REFRESH_INTERVAL_MS'),
    ipfsApiAuth: optionalEnv('IPFS_API_AUTH', ''),
  };
}
