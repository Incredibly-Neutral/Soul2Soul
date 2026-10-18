// ============================================================================
// RPC adapter — resolves the L1 (Ethereum) / L2 (Base) endpoint lists.
//
// Explicit S2S_RPC_L1 / S2S_RPC_L2 overrides win; otherwise shared's
// `buildFallbackRpcs` builds the DRPC → public → Alchemy → Infura chain from
// the standard env keys (MAINNET_RPC_URL / BASE_RPC_URL / VITE_DRPC_API_KEY /
// VITE_ALCHEMY_KEY / VITE_INFURA_KEY), the same chain the render pipeline uses.
// ============================================================================

import { buildFallbackRpcs, type RenderRpcs } from '@s2s/soul2soul-shared';

import type { CliConfig } from '../core/config';

export type RpcEndpoints = RenderRpcs;

export function buildRpcEndpoints(
  config: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
): RpcEndpoints {
  if (config.rpc.L1.length > 0 && config.rpc.L2.length > 0) {
    return { L1: config.rpc.L1, L2: config.rpc.L2 };
  }
  return buildFallbackRpcs(env);
}
