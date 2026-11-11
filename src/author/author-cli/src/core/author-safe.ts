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
//
// Not every author Safe is derived, though. `s2s signer add <safe>` files a key
// as one owner of a Safe that already exists, and that address is a fact read
// from the chain: there is no salt to predict it from and this CLI never
// deploys it. Such a record is `given` (`core/authors.ts`), and every path here
// that would re-derive the address branches on that provenance instead.
// ============================================================================

import { base } from 'viem/chains';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createSafeRunner, type SafeRunnerHandle } from '../adapters/tx-runner';
import { UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { bundlerEndpoints, type CliConfig } from './config';
import { activeAuthorRecord, givenSafeOf, readAuthors } from './authors';
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
  /**
   * Salt the address is derived from (`s2s_0x…`); null when the Safe was given
   * rather than derived, because no salt produces that address.
   */
  salt: string | null;
  /** Chain the author Safe is deployed on (0xobsidian deploys Base only). */
  chain: 'base';
  /** Whether bytecode already exists at the address. */
  deployed: boolean;
}

/** What the chain says about a `given` Safe: everything this CLI cannot derive. */
export interface GivenSafeState {
  deployed: boolean;
  /** Signatures a userOp from this Safe needs. */
  threshold: bigint;
  owners: Address[];
}

/**
 * Read a `given` Safe. The seam: `authorSafeState`, `createAuthorWriteRunner`
 * and `ensureAuthorSafe` take one, so a test supplies a fake and touches no
 * RPC.
 */
export type GivenSafeReader = (safe: Address) => Promise<GivenSafeState>;

/** The two reads a given Safe needs; the address itself comes from the store. */
const GIVEN_SAFE_READS_ABI = [
  'function threshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
].join('\n');

/**
 * Read a given Safe over the same pinned runner every author write uses, so the
 * Safe version and EntryPoint cannot drift between reading and writing it. A
 * read needs no bundler.
 */
export async function readGivenSafe(
  safe: Address,
  opts: { config: CliConfig; privateKey: `0x${string}`; eoa: Address; rpcUrl: string },
): Promise<GivenSafeState> {
  const runner = await createAuthorSafeRunner({
    config: opts.config,
    privateKey: opts.privateKey,
    eoa: opts.eoa,
    rpcUrl: opts.rpcUrl,
    requireBundler: false,
    safe,
  });
  const threshold = BigInt(
    (await runner.genericRead(safe, GIVEN_SAFE_READS_ABI, 'threshold', [])) as bigint,
  );
  const owners = (await runner.genericRead(
    safe,
    GIVEN_SAFE_READS_ABI,
    'getOwners',
    [],
  )) as Address[];
  return { deployed: await runner.isDeployed(), threshold, owners };
}

/**
 * The stored `given` Safe that this config signs for, or undefined.
 *
 * The key that owns a given Safe is part of the fact: when `S2S_PRIVATE_KEY` or
 * a project config key shadows the store, the run is a different identity and
 * its Safe is still derived. Only the store's own key gets the stored address.
 */
export function givenSafeInUse(config: CliConfig): Address | undefined {
  const key = config.privateKey;
  if (!key || config.author?.source !== 'store') return undefined;
  return givenSafeForKey(key as `0x${string}`);
}

/**
 * The `given` Safe stored for `privateKey`, whoever resolved that key. Every
 * caller that is about to derive a Safe asks this first: a key filed as one
 * owner of an existing Safe must never be handed a derived one to deploy.
 */
function givenSafeForKey(privateKey: `0x${string}`): Address | undefined {
  const active = activeAuthorRecord(readAuthors());
  if (!active || active.privateKey.toLowerCase() !== privateKey.toLowerCase()) return undefined;
  return givenSafeOf(active);
}

/**
 * The inputs of an author-Safe runner: the config for the bundler endpoints,
 * the owner KEY explicitly, and the L2 endpoint.
 *
 * The key is a parameter rather than `config.privateKey` because the author
 * contracts are installed for a key that may not be the active one —
 * `s2s author new` files a key and then installs its contracts before it is
 * ever selected (`core/author-contracts.ts`).
 */
export interface AuthorSafeRunnerOptions {
  config: CliConfig;
  /** Owner and sole signer of the Safe. */
  privateKey: `0x${string}`;
  /** The owner's address (derived by the caller when it already knows it). */
  eoa: Address;
  rpcUrl: string;
  /**
   * true → a missing bundler is a `UsageError`; false → prediction only (the
   * address is derived locally from the factory's create2 inputs, no userOp is
   * sent), so the bundler is not required.
   */
  requireBundler: boolean;
  /**
   * A Safe the key was filed into. When set the runner connects to it with
   * `connectToExistingSafe` and the salt never enters the address.
   */
  safe?: Address;
}

/**
 * Build a Safe runner bound to the author's counterfactual Safe on Base.
 * Exported so every author write goes through the SAME pinned SafeL2 v1.4.1
 * singleton / proxy factory / EntryPoint — a second copy of those constants
 * would be a second author id.
 */
export async function createAuthorSafeRunner(
  opts: AuthorSafeRunnerOptions,
): Promise<SafeRunnerHandle> {
  const { config, eoa, rpcUrl, requireBundler, privateKey } = opts;
  const endpoints = bundlerEndpoints(config, base.id);
  if (requireBundler && !endpoints) {
    throw new UsageError(
      'author writes (and deploying the author Safe) need an ERC-4337 bundler — set S2S_PIMLICO_KEY (or S2S_BUNDLER_URL)',
    );
  }

  const runner = await createSafeRunner({
    chain: base,
    rpcUrl,
    privateKey,
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
  if (opts.safe) await runner.connectToExistingSafe(opts.safe);
  else await runner.connectToFreshSafe(authorSafeSalt(eoa));
  return runner;
}

/**
 * The runner for AUTHOR WRITES — `makeOffer` / `retract` — bound to the author
 * Safe on Base (ERC-4337, Pimlico bundler + paymaster).
 *
 * This exists because the author identity on chain is the Safe, not the EOA:
 * 0xobsidian sends the same writes through `ctrlr.account[L2]`, a
 * `PermissionlessSafeService` connected to `user.safe`, so `msg.sender` is the
 * Safe and `genesisAuthor[genesis]` becomes the Safe. `S2SPublicationModuleV2`
 * then refuses anything else: a first append requires `canPublish(msg.sender)`
 * (safe ∨ whitelisted), and appending to an existing genesis requires
 * `msg.sender == genesisAuthor` (or the publication Safe). Sending from the
 * EOA therefore reverts `OnlySafe()` on any document the whitelist was not
 * told about — and permanently locks the Safe out of any genesis the EOA
 * created first. One document, one author address: the Safe.
 */
export async function createAuthorWriteRunner(opts: {
  config: CliConfig;
  /** The Safe's owner and sole signer. Never the identity itself. */
  eoa: Address;
  rpcUrl: string;
  /** A given Safe: connect to it instead of deriving one from the key. */
  safe?: Address;
  /** Seam for the threshold/owner read of a given Safe (tests). */
  readSafe?: GivenSafeReader;
}): Promise<SafeRunnerHandle> {
  if (opts.safe) {
    const safe = opts.safe;
    const read =
      opts.readSafe ??
      ((target: Address) =>
        readGivenSafe(target, {
          config: opts.config,
          privateKey: opts.config.privateKey as `0x${string}`,
          eoa: opts.eoa,
          rpcUrl: opts.rpcUrl,
        }));
    const state = await read(safe);
    // A userOp from this runner carries one signature. That is enough only when
    // the Safe needs one: above that, the write has to be proposed to the other
    // owners, and guessing would send a userOp that reverts.
    if (state.threshold > 1n) {
      throw new UsageError(
        `author Safe ${safe} needs ${state.threshold.toString()} signatures — a single-key userOp cannot meet that threshold; propose the write to the owners instead (s2s signer queue)`,
      );
    }
    if (!state.owners.some((owner) => owner.toLowerCase() === opts.eoa.toLowerCase())) {
      throw new UsageError(
        `the signing key ${opts.eoa} is not an owner of author Safe ${safe} — an owner has to add it first (s2s signer queue)`,
      );
    }
  }
  return createAuthorSafeRunner({
    config: opts.config,
    // The write runner is only built for the key the config resolved; a caller
    // holding another key builds its runner directly.
    privateKey: opts.config.privateKey as `0x${string}`,
    eoa: opts.eoa,
    rpcUrl: opts.rpcUrl,
    requireBundler: true,
    ...(opts.safe ? { safe: opts.safe } : {}),
  });
}

/**
 * What prediction needs: the config for the bundler endpoints, the EOA the Safe
 * is owned by, and the L2 endpoint to read the counterfactual address from.
 * Deliberately not a `CliContext` — `s2s author new` predicts a Safe for a key
 * that is not in the config yet.
 */
export interface AuthorSafeTarget {
  config: CliConfig;
  /** Owner and sole signer of the Safe. */
  eoa: Address;
  rpcUrl: string;
}

export interface AuthorSafePrediction {
  /** The author id: the Safe, not the EOA. */
  address: Address;
  /** Salt the address is derived from (`s2s_0x…`). */
  salt: string;
  /** Whether bytecode already exists at the address. */
  deployed: boolean;
}

/**
 * Predict the author Safe from a target without a `CliContext`: its
 * counterfactual address plus whether it has been deployed yet. Reads one RPC
 * (the Safe proxy creation code + a bytecode check), so this is not the offline
 * `config get` path.
 */
export async function predictAuthorSafe(target: AuthorSafeTarget): Promise<AuthorSafePrediction> {
  const salt = authorSafeSalt(target.eoa);
  const runner = await createAuthorSafeRunner({
    config: target.config,
    privateKey: target.config.privateKey as `0x${string}`,
    eoa: target.eoa,
    rpcUrl: target.rpcUrl,
    requireBundler: false,
  });
  const address = (await runner.connectToFreshSafe(salt)) as Address;
  return { address, salt, deployed: await runner.isDeployed() };
}

/**
 * Predict the author Safe: its counterfactual address plus whether it has been
 * deployed yet. Reads one RPC (the Safe proxy creation code + bytecode check),
 * so this is not the offline `config get` path.
 */
export async function authorSafeState(
  ctx: CliContext,
  readSafe?: GivenSafeReader,
): Promise<AuthorSafeState> {
  const rpcUrl = ctx.rpcs.L2[0];
  if (!rpcUrl) {
    throw new UsageError('no L2 RPC endpoint configured — set S2S_RPC_L2 (or BASE_RPC_URL)');
  }
  // A given Safe is taken as stored: predicting from the key would name a Safe
  // this key does not own, which is a different author id.
  const given = givenSafeInUse(ctx.config);
  if (given) {
    const read =
      readSafe ??
      ((safe: Address) =>
        readGivenSafe(safe, {
          config: ctx.config,
          privateKey: ctx.config.privateKey as `0x${string}`,
          eoa: ctx.eoaAddress,
          rpcUrl,
        }));
    const state = await read(given);
    return {
      address: given,
      eoa: ctx.eoaAddress,
      salt: null,
      chain: 'base',
      deployed: state.deployed,
    };
  }
  const prediction = await predictAuthorSafe({
    config: ctx.config,
    eoa: ctx.eoaAddress,
    rpcUrl,
  });
  return {
    address: prediction.address,
    eoa: ctx.eoaAddress,
    salt: prediction.salt,
    chain: 'base',
    deployed: prediction.deployed,
  };
}

export interface AuthorSafeInitResult extends AuthorSafeState {
  /** Set when this call deployed the Safe; undefined when it was already live. */
  txHash: string | undefined;
}

/** What deploying-if-needed needs. The key is explicit: `s2s author new`
 * passes the key it just filed, not the active one. */
export interface EnsureAuthorSafeOptions {
  config: CliConfig;
  privateKey: `0x${string}`;
  rpcUrl: string;
  out: CliOut;
  /** A given Safe: reported from the chain, never deployed by this CLI. */
  safe?: Address;
  /** Seam for the given Safe read (tests). */
  readSafe?: GivenSafeReader;
}

export interface EnsuredAuthorSafe {
  /** The author id: the Safe, not the EOA. */
  address: Address;
  /** The EOA that owns (and signs for) the Safe. */
  eoa: Address;
  /** Whether bytecode exists now — false when the userOp had not landed yet. */
  deployed: boolean;
  /** Set when this call sent the deployment; undefined when already live. */
  txHash: string | undefined;
}

/** How long to wait for a submitted deployment before reporting "not yet". */
const DEPLOY_POLL_ATTEMPTS = 30;
const DEPLOY_POLL_INTERVAL_MS = 2000;

/**
 * Deploy the author Safe if it is not deployed yet, and report the address plus
 * whether THIS call deployed it. Idempotent by construction: a live Safe is a
 * read and a return.
 *
 * The key is a parameter rather than `config.privateKey` so `s2s author new`
 * can deploy the Safe for the identity it just filed — the store's active key is
 * still the OLD one at that moment.
 */
export async function ensureAuthorSafe(opts: EnsureAuthorSafeOptions): Promise<EnsuredAuthorSafe> {
  const eoa = privateKeyToAccount(opts.privateKey).address;
  // A caller that does not name the Safe still cannot deploy a derived one for
  // a key whose record is `given` (`author init` installs its contracts through
  // an ensure call that names no address).
  const safe = opts.safe ?? givenSafeForKey(opts.privateKey);

  // A given Safe is a fact, not something this CLI creates: report what the
  // chain says and stop. Deploying here would put a Safe at an address nobody
  // owns, since the key is not its only owner.
  if (safe) {
    const read =
      opts.readSafe ??
      ((target: Address) =>
        readGivenSafe(target, {
          config: opts.config,
          privateKey: opts.privateKey,
          eoa,
          rpcUrl: opts.rpcUrl,
        }));
    const state = await read(safe);
    return { address: safe, eoa, deployed: state.deployed, txHash: undefined };
  }

  const runner = await createAuthorSafeRunner({
    config: opts.config,
    privateKey: opts.privateKey,
    eoa,
    rpcUrl: opts.rpcUrl,
    requireBundler: true,
  });
  const address = (await runner.connectToFreshSafe(authorSafeSalt(eoa))) as Address;

  if (await runner.isDeployed()) {
    return { address, eoa, deployed: true, txHash: undefined };
  }

  opts.out.log(`deploying author Safe ${address} (owner ${eoa})…`);
  const txHash = await runner.deploy();

  // The userOp is submitted; give the bundler a short window to land it so the
  // caller learns "deployed" rather than a maybe.
  let deployed = false;
  for (let i = 0; i < DEPLOY_POLL_ATTEMPTS && !deployed; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, DEPLOY_POLL_INTERVAL_MS));
    deployed = await runner.isDeployed();
  }

  return { address, eoa, deployed, txHash };
}

/**
 * Initialise the author Safe: deploy it if it isn't already, then report.
 * Idempotent — a second `init` is a no-op that returns `txHash: undefined`.
 * The contracts install (`core/author-contracts.ts`) is the next step; the
 * deployment is the first one only.
 *
 * A `given` Safe is the exception: it is reported as read and never deployed,
 * and its salt is null because no salt produces its address.
 */
export async function initAuthorSafe(
  ctx: CliContext,
  readSafe?: GivenSafeReader,
): Promise<AuthorSafeInitResult> {
  const rpcUrl = ctx.rpcs.L2[0];
  if (!rpcUrl) {
    throw new UsageError('no L2 RPC endpoint configured — set S2S_RPC_L2 (or BASE_RPC_URL)');
  }
  const given = givenSafeInUse(ctx.config);
  const ensured = await ensureAuthorSafe({
    config: ctx.config,
    privateKey: ctx.config.privateKey as `0x${string}`,
    rpcUrl,
    out: ctx.out,
    ...(given ? { safe: given } : {}),
    ...(readSafe ? { readSafe } : {}),
  });
  return {
    address: ensured.address,
    eoa: ensured.eoa,
    salt: given ? null : authorSafeSalt(ensured.eoa),
    chain: 'base',
    deployed: ensured.deployed,
    txHash: ensured.txHash,
  };
}
