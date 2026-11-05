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
import { createAuthorWriteRunner } from './author-safe';
import { activeAuthorRecord, readAuthors } from './authors';
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
  /**
   * EOA runner for L2. Reads and non-identity work ONLY — it is never used for
   * an author write, because the on-chain author is the Safe (see
   * `authorRunner` and `S2SPublicationModuleV2._append`). The EOA's only roles
   * are signing (EIP-712 content item, `lit actions auth`) and owning the Safe.
   */
  l2Runner: TxRunner;
  /**
   * Runner for author writes (`makeOffer` / `retract`): the author Safe via
   * ERC-4337, so `msg.sender` — and therefore `genesisAuthor` — is the Safe.
   * Lazily built and memoised: commands that never write on chain (upload,
   * preview, address, config) must not need a bundler or a Safe.
   */
  authorRunner: () => Promise<TxRunner>;
  /** ENS registry address for publication resolution. */
  ensRegistry: Address;
}

/** The PublicClient type that shared's chain helpers consume. */
type SharedPublicClient = Parameters<typeof getProtocolInfo>[1];

/**
 * Warn on stderr when the env key shadows the active stored author.
 *
 * `S2S_PRIVATE_KEY` outranks the store, so a shell export (or a `.env` line)
 * silently overrides `s2s author switch` — the CLI then signs as a key the user
 * did not select, and nothing in the result says so. stderr only: the stdout
 * contract (one document, `--json` parsed by hosts) is untouched.
 */
function warnEnvShadowsActiveAuthor(out: CliOut, config: CliConfig): void {
  if (config.author?.source !== 'env' || config.privateKey === undefined) return;
  const active = activeAuthorRecord(readAuthors());
  if (!active) return;
  if (active.privateKey.toLowerCase() === config.privateKey.toLowerCase()) return;
  out.warn(
    `S2S_PRIVATE_KEY overrides active author '${active.name}' — unset it to sign as that author`,
  );
}

/**
 * Build the full context. Requires S2S_PRIVATE_KEY for any authoring command;
 * callers that only need `new` still pass the key (it funds the Safe).
 */
export async function buildContext(out: CliOut, config: CliConfig): Promise<CliContext> {
  const privateKey = requireSetting(config.privateKey, 'S2S_PRIVATE_KEY');
  warnEnvShadowsActiveAuthor(out, config);

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
  const ensRegistry = (config.ens.registry ?? protocolInfo.ensRegistry) as Address;

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const signer = new ViemTypedDataSigner(account);

  const lit = createLitService(config);
  const ipfs = createIpfs(config);
  const l2Runner = createEoaRunner({ chain: base, rpcUrl: l2Rpc, privateKey: privateKey as `0x${string}` });

  let authorRunnerPromise: Promise<TxRunner> | undefined;
  const authorRunner = (): Promise<TxRunner> => {
    authorRunnerPromise ??= createAuthorWriteRunner({
      config,
      eoa: account.address,
      rpcUrl: l2Rpc,
    });
    return authorRunnerPromise;
  };

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
    authorRunner,
    ensRegistry,
  };
}
