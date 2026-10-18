// ============================================================================
// CliContext — the assembled dependency graph for a command run.
//
// Built once per invocation from the loaded config + output sink. Everything
// a command touches hangs off this object (no globals, no plugin state).
// ============================================================================

import {
  getProtocolInfo,
  LitService,
  S2SIPFSMethods,
  type S2SProtocolInfo,
} from '@s2s/soul2soul-shared';
import { createPublicClient, http, type Address } from 'viem';
import { mainnet, base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { TxRunner } from '@s2s/soul2soul-shared';

import { createEoaRunner } from '../adapters/tx-runner';
import { createLitService } from '../adapters/lit';
import { createIpfs } from '../adapters/ipfs';
import { buildRpcEndpoints, type RpcEndpoints } from '../adapters/rpc';
import { ViemTypedDataSigner } from '../adapters/signer';
import { requireSetting, type CliConfig } from './config';
import type { CliOut } from '../lib/out';

export interface CliContext {
  config: CliConfig;
  out: CliOut;
  /**
   * Mainnet (L1) + Base (L2) public clients, cast to the exact type shared's
   * chain-bound helpers expect. author-cli pins typescript 5.9.x while shared
   * builds against 7.0.2, so pnpm resolves two physical viem copies; the cast
   * (typed via Parameters, no `any`) bridges the structurally-identical
   * PublicClient across that copy boundary.
   */
  l1: SharedPublicClient;
  l2: SharedPublicClient;
  rpcs: RpcEndpoints;
  protocolInfo: S2SProtocolInfo;
  lit: LitService;
  ipfs: S2SIPFSMethods;
  signer: ViemTypedDataSigner;
  eoaAddress: Address;
  /** EOA runner for author flows on L2. */
  l2Runner: TxRunner;
  /** ENS registry address for publication resolution. */
  ensRegistry: Address;
}

/** The PublicClient type that shared's chain helpers consume. */
type SharedPublicClient = Parameters<typeof getProtocolInfo>[1];

/**
 * Build the full context. Requires S2S_PRIVATE_KEY for any authoring command;
 * callers that only need `new` still pass the key (it funds the Safe).
 */
export async function buildContext(out: CliOut, config: CliConfig): Promise<CliContext> {
  const privateKey = requireSetting(config.privateKey, 'S2S_PRIVATE_KEY');

  const rpcs = buildRpcEndpoints(config);
  const l1Rpc = rpcs.L1[0];
  const l2Rpc = rpcs.L2[0];
  if (!l1Rpc || !l2Rpc) {
    throw new Error(
      'No RPC endpoints configured. Set S2S_RPC_L1 / S2S_RPC_L2 (or the DRPC/Alchemy keys) in the environment.',
    );
  }

  const l1 = createPublicClient({ chain: mainnet, transport: http(l1Rpc) }) as SharedPublicClient;
  const l2 = createPublicClient({ chain: base, transport: http(l2Rpc) }) as SharedPublicClient;

  const protocolInfo = await getProtocolInfo(config.environment === 'dev', l1, l2);
  const ensRegistry = (config.ensRegistry ?? protocolInfo.ensRegistry) as Address;

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const signer = new ViemTypedDataSigner(account);

  const lit = createLitService(config);
  const ipfs = createIpfs(config);
  const l2Runner = createEoaRunner({ chain: base, rpcUrl: l2Rpc, privateKey: privateKey as `0x${string}` });

  return {
    config,
    out,
    l1,
    l2,
    rpcs,
    protocolInfo,
    lit,
    ipfs,
    signer,
    eoaAddress: account.address,
    l2Runner,
    ensRegistry,
  };
}
