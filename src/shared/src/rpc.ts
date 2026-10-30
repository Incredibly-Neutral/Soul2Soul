/**
 * Render-pipeline RPC fallback chains.
 *
 * Single source of truth for the L1 (Ethereum) / L2 (Base) RPC endpoint
 * ordering used by the render pipeline and its tests:
 *
 *   DRPC (env key) → public RPC → Alchemy (env key) → Infura (env key)
 *
 * The Lit action's `evmRead` failover loop iterates these arrays, so a single
 * flaky endpoint (e.g. DRPC returning an empty `0x` for an eth_call) never
 * fails the render. Callers that build viem clients wrap the same chains in
 * viem `fallback([...])` for transport-level failover.
 */

/** Public, keyless Ethereum endpoints (L1). */
const PUBLIC_L1_RPCS = [
  'https://eth.llamarpc.com',
  'https://ethereum.publicnode.com',
  'https://cloudflare-eth.com',
];

/** Public, keyless Base endpoints (L2). */
const PUBLIC_L2_RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
];

export interface RenderRpcs {
  L1: string[];
  L2: string[];
}

/**
 * Build the L1/L2 RPC fallback chains from the environment.
 *
 * Order per chain: DRPC → public RPC → Alchemy → Infura. Entries whose backing
 * key is absent are skipped. `MAINNET_RPC_URL` / `BASE_RPC_URL` (the explicit
 * env RPCs) take the DRPC slot when set; otherwise the DRPC lb URL is derived
 * from `VITE_DRPC_API_KEY`.
 */
export function buildFallbackRpcs(env: NodeJS.ProcessEnv = process.env): RenderRpcs {
  const drpc = (n: 'eth' | 'base'): string | null => {
    const explicit = env[n === 'eth' ? 'MAINNET_RPC_URL' : 'BASE_RPC_URL'];
    if (explicit) return explicit;
    return env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/${n}/${env.VITE_DRPC_API_KEY}`
      : null;
  };

  const alchemy = (n: 'eth' | 'base'): string | null =>
    env.VITE_ALCHEMY_KEY
      ? n === 'eth'
        ? `https://eth-mainnet.g.alchemy.com/v2/${env.VITE_ALCHEMY_KEY}`
        : `https://base-mainnet.g.alchemy.com/v2/${env.VITE_ALCHEMY_KEY}`
      : null;

  const infura = (n: 'eth' | 'base'): string | null => {
    const key = env.VITE_INFURA_KEY ?? env.INFURA_KEY;
    return key
      ? n === 'eth'
        ? `https://mainnet.infura.io/v3/${key}`
        : `https://base-mainnet.infura.io/v3/${key}`
      : null;
  };

  const chain = (n: 'eth' | 'base', publics: string[]): string[] =>
    [drpc(n), ...publics, alchemy(n), infura(n)].filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    );

  return { L1: chain('eth', PUBLIC_L1_RPCS), L2: chain('base', PUBLIC_L2_RPCS) };
}
