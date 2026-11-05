// ============================================================================
// RPC adapter — exposes the resolved L1 (Ethereum) / L2 (Base) endpoint lists.
//
// The chain is resolved once, in core/config.ts (`config.rpc`): custom
// `rpc.custom.l1`/`l2` first, else shared's `buildFallbackRpcs` over the
// configured DRPC / Alchemy / Infura keys — the same chain the render pipeline
// uses. There is nothing left to decide here, so the adapter is a shape cast.
// ============================================================================

import type { RenderRpcs } from '@s2s/soul2soul-shared';

import type { CliConfig } from '../core/config';

export type RpcEndpoints = RenderRpcs;

export function buildRpcEndpoints(config: CliConfig): RpcEndpoints {
  return { L1: config.rpc.l1, L2: config.rpc.l2 };
}
