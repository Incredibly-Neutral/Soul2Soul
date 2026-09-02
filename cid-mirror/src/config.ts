/**
 * App configuration — loaded from environment variables.
 */

export interface AppConfig {
  /** Publication URL: an ENS name (e.g. xxx.soul2soul.eth) or a bare CID string. */
  publicationUrl: string;

  /** L1 RPC URL for ENS resolution (e.g. Mainnet). */
  l1RpcUrl: string;

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
    ipfsApiUrl: optionalEnv('IPFS_API_URL', 'http://127.0.0.1:5001'),
    port: parseInt(optionalEnv('PORT', '3000'), 10),
    refreshIntervalMs: optionalIntEnv('REFRESH_INTERVAL_MS'),
    ipfsApiAuth: optionalEnv('IPFS_API_AUTH', ''),
  };
}
