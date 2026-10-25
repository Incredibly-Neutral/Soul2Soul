// ============================================================================
// The author Safe — the author's on-chain identity.
//
// Neutralpress does NOT use the EOA as the manuscript owner: the author id is
// the Safe (0xobsidian's `user.safe`), the ERC-4337 Safe smart account owned by
// the EOA. Its address is counterfactual — derived from the owner plus a salt
// — so it can be predicted before anything is deployed, and it is identical on
// every chain because the salt contains no chain id:
//
//   salt = `s2s_${eoa}`  →  saltNonce = keccak256(salt)  →  same address on L1/L2
//
// 0xobsidian deploys it on Base only (`newAuthor` → `deploySafe()`); mainnet is
// initialised but left undeployed until a publication needs it. This module
// reproduces exactly that derivation (same Safe version, same canonical
// singleton/proxy-factory, same unmasked salt-nonce) so a CLI author is the
// same identity as a plugin author.
// ============================================================================

import { base } from 'viem/chains';
import type { Address } from 'viem';

import { createSafeRunner, type SafeRunnerHandle } from '../adapters/tx-runner';
import { UsageError } from '../lib/errors';
import { bundlerEndpoints, type CliConfig } from './config';
import type { CliContext } from './context';

/** Salt prefix 0xobsidian uses for an author's personal Safe. */
export const AUTHOR_SAFE_SALT_PREFIX = 's2s_';

/**
 * Safe contracts 0xobsidian pins (SafeL2 v1.4.1). Both are part of the
 * counterfactual address; permissionless' 1.4.1 defaults are the L1 singleton
 * and a different module set, which yields a different address.
 */
export const SAFE_L2_SINGLETON: Address = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
export const SAFE_PROXY_FACTORY: Address = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
export const AUTHOR_SAFE_VERSION = '1.4.1' as const;
export const AUTHOR_SAFE_ENTRY_POINT = '0.7' as const;

/** The salt an author Safe's counterfactual address is derived from. */
export function authorSafeSalt(eoa: Address | string): string {
  return `${AUTHOR_SAFE_SALT_PREFIX}${eoa}`;
}

export interface AuthorSafeState {
  /** The author id: the Safe, not the EOA. */
  address: Address;
  /** The EOA that owns (and signs for) the Safe. */
  eoa: Address;
  /** Salt the address is derived from (`s2s_0x…`). */
  salt: string;
  /** Chain the author Safe is deployed on (0xobsidian deploys Base only). */
  chain: 'base';
  /** Whether bytecode already exists at the address. */
  deployed: boolean;
}

/**
 * Build a Safe runner bound to the author's counterfactual Safe on Base.
 * `requireBundler` is false for pure prediction: the address is derived
 * locally from the factory's create2 inputs, no userOp is sent.
 */
async function authorSafeRunner(
  config: CliConfig,
  eoa: Address,
  rpcUrl: string,
  requireBundler: boolean,
): Promise<SafeRunnerHandle> {
  const endpoints = bundlerEndpoints(config, base.id);
  if (requireBundler && !endpoints) {
    throw new UsageError(
      'deploying the author Safe needs an ERC-4337 bundler — set S2S_PIMLICO_KEY (or S2S_BUNDLER_URL)',
    );
  }

  const runner = await createSafeRunner({
    chain: base,
    rpcUrl,
    privateKey: config.privateKey as `0x${string}`,
    bundlerUrl: endpoints?.bundlerUrl ?? 'http://127.0.0.1:0',
    paymasterUrl: endpoints?.paymasterUrl,
    // Pinned, not config-driven: 0xobsidian hardcodes EntryPoint v0.7, and the
    // 4337 module address is part of the Safe's initializer — so the entry
    // point changes the counterfactual address. An override here would predict
    // a different "author" than the plugin deploys.
    entryPointVersion: AUTHOR_SAFE_ENTRY_POINT,
    safeVersion: AUTHOR_SAFE_VERSION,
    safeSingletonAddress: SAFE_L2_SINGLETON,
    safeProxyFactoryAddress: SAFE_PROXY_FACTORY,
  });
  await runner.connectToFreshSafe(authorSafeSalt(eoa));
  return runner;
}

/**
 * Predict the author Safe: its counterfactual address plus whether it has been
 * deployed yet. Reads one RPC (the Safe proxy creation code + bytecode check),
 * so this is not the offline `config get` path.
 */
export async function authorSafeState(ctx: CliContext): Promise<AuthorSafeState> {
  const rpcUrl = ctx.rpcs.L2[0];
  if (!rpcUrl) {
    throw new UsageError('no L2 RPC endpoint configured — set S2S_RPC_L2 (or BASE_RPC_URL)');
  }
  const runner = await authorSafeRunner(ctx.config, ctx.eoaAddress, rpcUrl, false);
  const address = (await runner.connectToFreshSafe(authorSafeSalt(ctx.eoaAddress))) as Address;
  return {
    address,
    eoa: ctx.eoaAddress,
    salt: authorSafeSalt(ctx.eoaAddress),
    chain: 'base',
    deployed: await runner.isDeployed(),
  };
}

export interface AuthorSafeInitResult extends AuthorSafeState {
  /** Set when this call deployed the Safe; undefined when it was already live. */
  txHash: string | undefined;
}

/**
 * Initialise the author Safe: deploy it if it isn't already, then report.
 * Idempotent — a second `init` is a no-op that returns `txHash: undefined`.
 * Modules will be installed from here (the plugin extends `newAuthor` the same
 * way); the deployment is the first step only.
 */
export async function initAuthorSafe(ctx: CliContext): Promise<AuthorSafeInitResult> {
  const rpcUrl = ctx.rpcs.L2[0];
  if (!rpcUrl) {
    throw new UsageError('no L2 RPC endpoint configured — set S2S_RPC_L2 (or BASE_RPC_URL)');
  }
  const runner = await authorSafeRunner(ctx.config, ctx.eoaAddress, rpcUrl, true);
  const address = (await runner.connectToFreshSafe(authorSafeSalt(ctx.eoaAddress))) as Address;
  const salt = authorSafeSalt(ctx.eoaAddress);

  if (await runner.isDeployed()) {
    return { address, eoa: ctx.eoaAddress, salt, chain: 'base', deployed: true, txHash: undefined };
  }

  ctx.out.log(`deploying author Safe ${address} (owner ${ctx.eoaAddress})…`);
  const txHash = await runner.deploy();

  // The userOp is submitted; give the bundler a short window to land it so the
  // caller learns "deployed" rather than a maybe.
  let deployed = false;
  for (let i = 0; i < 30 && !deployed; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    deployed = await runner.isDeployed();
  }

  return { address, eoa: ctx.eoaAddress, salt, chain: 'base', deployed, txHash };
}
