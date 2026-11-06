// ============================================================================
// The author contracts, installed per author Safe.
//
// `@s2s/author-contracts` deployed two implementations (the drafts module and
// the owner-history module) and `AuthorContractsFactory` on Base. Nothing
// installs them per author: this module does, for the Safe it is given.
//
// The install is three steps, and none of them is `enableModule`:
//
//   1. drafts         factory.createDraftsModule(safe)          — permissionless
//   2. owner history  factory.createOwnerHistoryModule(safe)    — permissionless
//                     (mints the module AND its guard, bound to the module)
//   3. the guard      the Safe's own setGuard(guard) — `onlySelf`, so the Safe
//                     must be both sender and target of that userOp
//
// Why no module powers: an enabled module can call `execTransactionFromModule`,
// i.e. execute anything as the author Safe, and neither contract needs it —
// `sync()` is permissionless, every read is a `view` call, and the drafts
// module is written by the Safe itself. Adopting a guard therefore costs the
// Safe no new authority over itself; adopting a module would.
//
// Two consequences decide the shape of this file:
//
//   - **The factory index is forgeable.** `createDraftsModule(victimSafe)` from
//     any account pushes an entry into `getDraftsModulesForSafe(victimSafe)`
//     (SPEC-author-drafts). The index is read as "what should be installed",
//     never as proof of use. What the Safe *carries* is proved from the guard in
//     its own guard slot, from the guard's own immutables: `G.module()` → `M`,
//     `G.safe() == safe`, `M.safe() == safe`. Nobody can forge those, no factory
//     has to agree, and a griefer's extra index entry cannot turn a healthy
//     author into `pending-safe`.
//   - **A foreign guard is never overwritten.** A Safe may carry a guard this
//     package did not install (a policy guard, another product's). Replacing it
//     silently would change the Safe's transaction semantics behind its owners'
//     back, so a non-zero guard that cannot be proved ours is reported as
//     `pending-safe`, left alone, and no `safeTx` is offered for it.
//
// A userOp hash is not proof of an install: `genericTx` resolves with the hash of
// a transaction that may have reverted. Every send is therefore followed by a
// re-read of the state it was supposed to change, and only a changed read counts
// as done.
//
// Nothing here throws for a missing bundler, a dead RPC or a multisig Safe:
// `s2s author new` calls `installAuthorContracts` after it has filed the key,
// and losing that key because the network was down is not an acceptable price.
// Every one of those states is reported instead (`InstallState`).
// ============================================================================

import { base } from 'viem/chains';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { AuthorContractsFactory, OwnerHistoryGuard, OwnerHistoryModuleV1 } from '@s2s/author-contracts';
import { safeAbi } from '@s2s/soul2soul-shared';

import type { SafeRunnerHandle } from '../adapters/tx-runner';
import { describeError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import {
  createAuthorSafeRunner,
  ensureAuthorSafe,
  type EnsuredAuthorSafe,
  type EnsureAuthorSafeOptions,
} from './author-safe';
import { bundlerEndpoints, type CliConfig } from './config';
import { defaultForPath, textValue } from './configschema';

/** The zero address, spelled once: "no guard installed" is this, not `null`. */
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * The Safe's guard-manager slot: `getGuard()` is `internal` in Safe 1.4.1 (no
 * public getter, bytecode size), so the only way to read the installed guard is
 * this storage slot — one word, the address in its low 20 bytes.
 * SPEC-author-owner-history, "Does the Safe offer a hook on owner rotation?".
 */
export const SAFE_GUARD_SLOT: Hex = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';

/**
 * The `AuthorContractsFactory` this CLI installs through: the address the deploy
 * transcript reported. It cannot be re-read from a chain here, so it ships as a
 * default and is overridable (`contracts.authorFactory` / `S2S_AUTHOR_CONTRACTS_FACTORY`).
 */
export const DEFAULT_AUTHOR_CONTRACTS_FACTORY: Address = '0xbf394ea4e984D473cAFE094a27B88aeaeD788d6A';

/** What is installed on one author Safe today. Every member is an address. */
export interface AuthorContracts {
  factory: `0x${string}`;
  drafts: `0x${string}` | null;
  ownerHistory: `0x${string}` | null;
  guard: `0x${string}` | null;
}

/**
 * 'installed' = the guard is on the Safe and this run sent the txs;
 * 'already' = the guard is on the Safe and nothing was to do;
 * 'pending-safe' = the guard is not on the Safe yet (owner signatures needed, a
 * submitted tx not visible, or one that may have reverted);
 * 'skipped' = no chain reachable/configured, or the Safe is not deployed.
 *
 * `installed` and `already` always mean the guard was read back from the Safe.
 */
export type InstallState = 'installed' | 'already' | 'pending-safe' | 'skipped';

export interface InstallResult extends AuthorContracts {
  state: InstallState;
  /** transaction hashes in the order they were sent; empty when nothing was sent. */
  txs: string[];
  /** one human line explaining 'pending-safe' / 'skipped'. */
  note?: string;
  /**
   * when 'pending-safe': the Safe self-call the owners must propose. Absent
   * whenever no call is safe to hand over — a foreign guard in the slot, a
   * submitted userOp not yet visible, or one that may have reverted.
   */
  safeTx?: { to: `0x${string}`; data: `0x${string}` };
}

// ===========================================================================
// The factory address in effect
// ===========================================================================

/**
 * `CliConfig` carries the resolved `contracts` section when the loader supplies
 * one (env already merged in). The member is optional so a `CliConfig` built
 * before this feature — `loadConfig` without the section — still type-checks,
 * and `authorContractsFactory` falls back to the env var and the shipped
 * default in that case.
 */
export type AuthorContractsConfig = Omit<CliConfig, 'contracts'> & {
  contracts?: { authorFactory?: string };
};

/** A 20-byte hex address, checksummed; throws `UsageError` for anything else. */
function asAddress(value: string, source: string): Address {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new UsageError(`${source} is not an address: '${value}'`);
  }
  return getAddress(trimmed.toLowerCase());
}

/**
 * The factory address in effect: config `contracts.authorFactory` (env
 * `S2S_AUTHOR_CONTRACTS_FACTORY`), else the shipped default.
 *
 * The env var is read here as well because a `CliConfig` assembled without the
 * `contracts` section would otherwise carry no opinion at all — the merge in
 * `core/config.ts` is the source of truth, this is only its floor.
 */
export function authorContractsFactory(config: AuthorContractsConfig): `0x${string}` {
  const fromConfig = textValue(config.contracts?.authorFactory);
  if (fromConfig !== undefined) return asAddress(fromConfig, 'contracts.authorFactory');

  const fromEnv = textValue(process.env.S2S_AUTHOR_CONTRACTS_FACTORY);
  if (fromEnv !== undefined) return asAddress(fromEnv, 'S2S_AUTHOR_CONTRACTS_FACTORY');

  return asAddress(
    defaultForPath('contracts.authorFactory') ?? DEFAULT_AUTHOR_CONTRACTS_FACTORY,
    'contracts.authorFactory',
  );
}

// ===========================================================================
// Reads
// ===========================================================================

export interface ReadAuthorContractsOptions {
  factory: `0x${string}`;
  safe: `0x${string}`;
  rpcUrl: string;
}

export interface ReadSafeOptions {
  safe: `0x${string}`;
  rpcUrl: string;
}

export interface GuardReadOptions {
  guard: `0x${string}`;
  rpcUrl: string;
}

export interface ModuleReadOptions {
  module: `0x${string}`;
  rpcUrl: string;
}

export interface GuardForOptions {
  factory: `0x${string}`;
  module: `0x${string}`;
  rpcUrl: string;
}

/** Owners and threshold of a Safe — what tells a single-owner Safe from an N-of-M one. */
export interface SafeOwners {
  owners: Address[];
  threshold: number;
}

/** A public client per read: a client is cheap, a cached one is stale chain state. */
function clientFor(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

/**
 * The last address in a factory index.
 *
 * The lists are append-only, and an install reads the newest entry: after a
 * `create*Module` the address this package just deployed is the one at the end.
 * An earlier entry is a proxy that may never have been used.
 */
function newest(addresses: readonly Address[] | undefined): Address | null {
  const last = addresses?.[addresses.length - 1];
  return last ?? null;
}

/**
 * Read-only: the factory index plus the guard the history module was minted
 * with. No writes, no bundler — this is the call `s2s author address` and any
 * status command can make.
 */
export async function readAuthorContracts(opts: ReadAuthorContractsOptions): Promise<AuthorContracts> {
  const client = clientFor(opts.rpcUrl);
  const factory = opts.factory;
  const safe = opts.safe;

  const [draftsList, historyList] = (await Promise.all([
    client.readContract({
      address: factory,
      abi: AuthorContractsFactory,
      functionName: 'getDraftsModulesForSafe',
      args: [safe],
    }),
    client.readContract({
      address: factory,
      abi: AuthorContractsFactory,
      functionName: 'getOwnerHistoryModulesForSafe',
      args: [safe],
    }),
  ])) as [Address[], Address[]];

  const drafts = newest(draftsList);
  const ownerHistory = newest(historyList);

  // `guardFor` is the factory's own binding: the guard minted WITH that history
  // module. Zero for an unknown module — never a revert (it is the read a gate
  // leans on), so a zero means "this module has no guard we may install".
  // This is what SHOULD be on the Safe, not what is: only the guard slot (plus
  // `proveInstalledGuard`, which uses the guard's own immutables) answers that,
  // and the index is permissionless. It also only answers for THIS factory, so
  // it must never decide whether an installed guard is ours.
  const guard =
    ownerHistory === null
      ? null
      : await readGuardFor({ factory, module: ownerHistory, rpcUrl: opts.rpcUrl });

  return { factory, drafts, ownerHistory, guard };
}

/**
 * Whether a failed read means "this address is not the contract we hoped", as
 * opposed to "the network failed".
 *
 * A revert, or empty return data from an address with no matching function, is
 * an answer: the address does not expose `module()` / `safe()`. A transport or
 * node failure is NOT an answer, and must propagate — treating it as "foreign"
 * would tell a healthy author to remove a guard that is ours.
 */
function answersForeign(err: unknown): boolean {
  if (err instanceof ContractFunctionRevertedError) return true;
  if (err instanceof ContractFunctionZeroDataError) return true;
  // `readContract` wraps both in `ContractFunctionExecutionError`; the cause is
  // what distinguishes them, since a transport failure lands there too.
  if (err instanceof ContractFunctionExecutionError) return answersForeign(err.cause);
  return false;
}

/**
 * The module a guard names (`OwnerHistoryGuard.module()`), or null when the
 * guard does not answer — an address that is not an owner-history guard.
 * Transport errors propagate: an unreadable guard is not a foreign one.
 */
export async function readGuardModule(opts: GuardReadOptions): Promise<Address | null> {
  try {
    const module = await clientFor(opts.rpcUrl).readContract({
      address: opts.guard,
      abi: OwnerHistoryGuard,
      functionName: 'module',
    });
    return module === ZERO_ADDRESS ? null : getAddress(module.toLowerCase());
  } catch (err) {
    if (answersForeign(err)) return null;
    throw err;
  }
}

/** The Safe a guard is bound to (`OwnerHistoryGuard.safe()`), or null. */
export async function readGuardSafe(opts: GuardReadOptions): Promise<Address | null> {
  try {
    const safe = await clientFor(opts.rpcUrl).readContract({
      address: opts.guard,
      abi: OwnerHistoryGuard,
      functionName: 'safe',
    });
    return safe === ZERO_ADDRESS ? null : getAddress(safe.toLowerCase());
  } catch (err) {
    if (answersForeign(err)) return null;
    throw err;
  }
}

/** The Safe a module is bound to (`OwnerHistoryModuleV1.safe()`), or null. */
export async function readModuleSafe(opts: ModuleReadOptions): Promise<Address | null> {
  try {
    const safe = await clientFor(opts.rpcUrl).readContract({
      address: opts.module,
      abi: OwnerHistoryModuleV1,
      functionName: 'safe',
    });
    return safe === ZERO_ADDRESS ? null : getAddress(safe.toLowerCase());
  } catch (err) {
    if (answersForeign(err)) return null;
    throw err;
  }
}

/** The guard the factory minted for `module` (`guardFor`), or null for zero. */
export async function readGuardFor(opts: GuardForOptions): Promise<Address | null> {
  const guard = (await clientFor(opts.rpcUrl).readContract({
    address: opts.factory,
    abi: AuthorContractsFactory,
    functionName: 'guardFor',
    args: [opts.module],
  }));
  return guard === ZERO_ADDRESS ? null : getAddress(guard.toLowerCase());
}

/**
 * The guard in the Safe's guard slot, or null when the slot is zero.
 *
 * `getStorageAt` rather than a call: Safe 1.4.1 makes `getGuard()` internal.
 * The read tolerates an empty / short word (an undeployed or non-Safe address
 * answers nothing) by reporting "no guard", which is also the truthful reading.
 */
export async function readSafeGuard(opts: ReadSafeOptions): Promise<Address | null> {
  const client = clientFor(opts.rpcUrl);
  const word = await client.getStorageAt({ address: opts.safe, slot: SAFE_GUARD_SLOT });
  if (!word || word === '0x') return null;
  const hex = word.slice(2).padStart(64, '0');
  const low20 = `0x${hex.slice(-40)}`;
  if (low20 === ZERO_ADDRESS) return null;
  return getAddress(low20);
}

/** The Safe's owners and threshold. */
export async function readSafeOwners(opts: ReadSafeOptions): Promise<SafeOwners> {
  const client = clientFor(opts.rpcUrl);
  const [owners, threshold] = (await Promise.all([
    client.readContract({
      address: opts.safe,
      abi: safeAbi,
      functionName: 'getOwners',
    }),
    client.readContract({
      address: opts.safe,
      abi: safeAbi,
      functionName: 'getThreshold',
    }),
  ])) as [Address[], bigint];

  return { owners: owners.map((owner) => getAddress(owner.toLowerCase())), threshold: Number(threshold) };
}

// ===========================================================================
// The seam
// ===========================================================================

/**
 * The eight things the install does to the outside world, as one injectable
 * object. The tests replace all of them; production uses `defaultSeam`.
 *
 * This is the smallest seam that reaches every branch (four states, the guard
 * proof, the foreign guard, the multisig path): the reads, the Safe deployment
 * and the runner are the only calls that leave the process, so faking them
 * fakes the decision logic without a chain or a bundler.
 */
export interface AuthorContractsSeam {
  readContracts(opts: ReadAuthorContractsOptions): Promise<AuthorContracts>;
  readGuard(opts: ReadSafeOptions): Promise<Address | null>;
  /** `guard.module()` — what the guard in the slot was minted for. */
  readGuardModule(opts: GuardReadOptions): Promise<Address | null>;
  /** `guard.safe()` — the Safe the guard is bound to. */
  readGuardSafe(opts: GuardReadOptions): Promise<Address | null>;
  /** `module.safe()` — the Safe a module is bound to. */
  readModuleSafe(opts: ModuleReadOptions): Promise<Address | null>;
  readOwners(opts: ReadSafeOptions): Promise<SafeOwners>;
  ensureSafe(opts: EnsureAuthorSafeOptions): Promise<EnsuredAuthorSafe>;
  /** A runner bound to `safe`; only `genericTx` is used. */
  openRunner(opts: {
    config: CliConfig;
    privateKey: `0x${string}`;
    rpcUrl: string;
    safe: `0x${string}`;
  }): Promise<Pick<SafeRunnerHandle, 'genericTx'>>;
}

export const defaultAuthorContractsSeam: AuthorContractsSeam = {
  readContracts: readAuthorContracts,
  readGuard: readSafeGuard,
  readGuardModule,
  readGuardSafe,
  readModuleSafe,
  readOwners: readSafeOwners,
  ensureSafe: ensureAuthorSafe,
  openRunner: async (opts) => {
    const eoa = privateKeyToAccount(opts.privateKey).address;
    const runner = await createAuthorSafeRunner({
      config: opts.config,
      privateKey: opts.privateKey,
      eoa,
      rpcUrl: opts.rpcUrl,
      requireBundler: false,
    });
    // Existing-Safe connect: by the time a userOp is sent the deployment has
    // landed, so the runner must target the address (not a fresh counterfactual).
    await runner.connectToExistingSafe(opts.safe);
    return runner;
  },
};

// ===========================================================================
// Install
// ===========================================================================

export interface InstallAuthorContractsOptions {
  config: CliConfig;
  safe: `0x${string}`;
  rpcUrl: string;
  privateKey: `0x${string}`;
  out: CliOut;
}

/** The `setGuard(guard)` self-call the owners of a multisig Safe must propose. */
function guardSafeTx(safe: `0x${string}`, guard: `0x${string}`): { to: `0x${string}`; data: `0x${string}` } {
  return {
    // `setGuard` is `onlySelf`: the Safe transaction targets the Safe itself.
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'setGuard', args: [guard] }),
  };
}

const BUNDLER_NOTE =
  'no ERC-4337 bundler configured — set S2S_PIMLICO_KEY (or S2S_BUNDLER_URL) to deploy the Safe and install the author contracts';

function unreachableNote(rpcUrl: string, err: unknown): string {
  return `could not reach Base (${rpcUrl}) — ${describeError(err)}. Check S2S_RPC_L2 (or BASE_RPC_URL) and the bundler keys S2S_PIMLICO_KEY / S2S_BUNDLER_URL`;
}

/** Address equality, checksum-insensitively. */
function sameAddress(a: `0x${string}` | null, b: `0x${string}`): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Prove the guard in the Safe's slot is ours, from the guard's own immutables:
 * `G.module()` → `M`, `G.safe() == safe`, `M.safe() == safe`.
 *
 * No factory appears here on purpose: the addresses are immutable constructor
 * arguments, so this holds whatever `contracts.authorFactory` points at (a dev
 * chain, a redeploy) — and it is what a factory-index entry can never fake.
 *
 * `null` means "cannot prove": an address that answers none of the reads, or
 * answers with a different Safe. A transport failure propagates instead — an
 * unreadable guard is not a foreign one.
 */
async function proveInstalledGuard(
  args: { safe: `0x${string}`; guard: Address; rpcUrl: string },
  seam: AuthorContractsSeam,
): Promise<{ module: Address; guard: Address } | null> {
  const read = { rpcUrl: args.rpcUrl };
  const module = await seam.readGuardModule({ guard: args.guard, ...read });
  if (module === null) return null;

  const [guardSafe, moduleSafe] = await Promise.all([
    seam.readGuardSafe({ guard: args.guard, ...read }),
    seam.readModuleSafe({ module, ...read }),
  ]);
  if (!sameAddress(guardSafe, args.safe)) return null;
  if (!sameAddress(moduleSafe, args.safe)) return null;

  return { module, guard: args.guard };
}

/**
 * Idempotent install of the author contracts on `safe`. Deploys the Safe first
 * if needed. Never throws for a missing bundler or a multisig Safe — it reports
 * (see `InstallState`), because the caller has already filed a key.
 */
export async function installAuthorContracts(
  opts: InstallAuthorContractsOptions,
  seam: AuthorContractsSeam = defaultAuthorContractsSeam,
): Promise<InstallResult> {
  const { config, safe, rpcUrl, privateKey, out } = opts;
  const factory = authorContractsFactory(config);
  const eoa = privateKeyToAccount(privateKey).address;

  const empty = (current?: AuthorContracts): AuthorContracts => ({
    factory,
    drafts: null,
    ownerHistory: null,
    guard: null,
    ...(current ?? {}),
  });

  // No bundler: nothing can be sent. Still read what is installed — a read is a
  // plain RPC call and the caller deserves to know what it already has.
  if (!bundlerEndpoints(config, base.id)) {
    let current: AuthorContracts | undefined;
    try {
      current = await seam.readContracts({ factory, safe, rpcUrl });
    } catch {
      // A dead RPC as well: report the state we know (nothing).
    }
    return { ...empty(current), state: 'skipped', txs: [], note: BUNDLER_NOTE };
  }

  // Deploy the Safe if it is not live yet, then read the indexes. Either
  // failing means "we could not even look" — skipped.
  let contracts: AuthorContracts;
  try {
    const ensured: EnsuredAuthorSafe = await seam.ensureSafe({ config, privateKey, rpcUrl, out });
    if (!ensured.deployed) {
      // No code at the address: every userOp would be sent to nothing.
      return {
        ...empty(),
        state: 'skipped',
        txs: [],
        note: `the author Safe ${safe} is not deployed${ensured.txHash ? ` (deployment ${ensured.txHash} submitted)` : ''} — run again once it is on chain`,
      };
    }
    contracts = await seam.readContracts({ factory, safe, rpcUrl });
  } catch (err) {
    return { ...empty(), state: 'skipped', txs: [], note: unreachableNote(rpcUrl, err) };
  }

  let runner: Pick<SafeRunnerHandle, 'genericTx'> | undefined;
  /** Built on the first write: an 'already' Safe never needs a bundler client. */
  const getRunner = async (): Promise<Pick<SafeRunnerHandle, 'genericTx'>> => {
    runner ??= await seam.openRunner({ config, privateKey, rpcUrl, safe });
    return runner;
  };

  const txs: string[] = [];
  /** One userOp; its hash is recorded in send order for the caller's report. */
  const send = async (to: `0x${string}`, abi: string, method: string, args: unknown[]): Promise<void> => {
    const hash = await (await getRunner()).genericTx(to, abi, method, args, false);
    txs.push(hash);
  };

  try {
    // 1. What the Safe carries decides. A guard in the slot whose own immutables
    //    name a module bound to this Safe IS the install — the index only says
    //    what could be created, and any address can append to it.
    const slotGuard = await seam.readGuard({ safe, rpcUrl });
    if (slotGuard !== null) {
      const proof = await proveInstalledGuard({ safe, guard: slotGuard, rpcUrl }, seam);
      if (proof !== null) {
        // The guard is right, so nothing else may move — but the drafts proxy is
        // still missing on a Safe installed by hand (step 1 skipped) or by a
        // `createDraftsModule` that reverted earlier. An `already` with
        // `drafts: null` would leave it missing for ever.
        if (contracts.drafts === null) {
          out.log(`installing the drafts module for ${safe}…`);
          await send(factory, JSON.stringify(AuthorContractsFactory), 'createDraftsModule', [safe]);
          contracts = await seam.readContracts({ factory, safe, rpcUrl });
          if (contracts.drafts === null) {
            return {
              ...contracts,
              state: 'pending-safe',
              txs,
              note: 'the Safe carries the owner-history guard but has no drafts proxy — the createDraftsModule transaction may have reverted; run again',
            };
          }

          return {
            factory,
            drafts: contracts.drafts,
            ownerHistory: proof.module,
            guard: proof.guard,
            state: 'installed',
            txs,
          };
        }

        return {
          factory,
          drafts: contracts.drafts,
          ownerHistory: proof.module,
          guard: proof.guard,
          state: 'already',
          txs: [],
        };
      }

      // Never overwrite: it may be why the Safe behaves the way its owners
      // expect, and there is no call to offer that would be safe to make.
      return {
        ...contracts,
        state: 'pending-safe',
        txs: [],
        note: `the Safe already carries a guard this package did not install (${slotGuard}) — this package never replaces a guard; remove it through the Safe first if the owner-history guard is wanted`,
      };
    }

    // 2. Nothing in the slot: the index decides what to create. A re-read after
    //    each send is the only proof it landed — `genericTx` resolves with the
    //    hash of a userOp that may have reverted.
    if (contracts.drafts === null) {
      out.log(`installing the drafts module for ${safe}…`);
      await send(factory, JSON.stringify(AuthorContractsFactory), 'createDraftsModule', [safe]);
      contracts = await seam.readContracts({ factory, safe, rpcUrl });
      if (contracts.drafts === null) {
        return {
          ...contracts,
          state: 'pending-safe',
          txs,
          note: 'the drafts module transaction did not change the factory index — it may have reverted; run again',
        };
      }
    }

    // 3. owner history — also mints the guard, bound to that module.
    if (contracts.ownerHistory === null) {
      out.log(`installing the owner-history module for ${safe}…`);
      await send(factory, JSON.stringify(AuthorContractsFactory), 'createOwnerHistoryModule', [safe]);
      contracts = await seam.readContracts({ factory, safe, rpcUrl });
      if (contracts.ownerHistory === null) {
        return {
          ...contracts,
          state: 'pending-safe',
          txs,
          note: 'the owner-history module transaction did not change the factory index — it may have reverted; run again',
        };
      }
    }

    const guard = contracts.guard;
    if (guard === null) {
      // The modules may exist, but nothing is on the Safe yet: `installed` must
      // always mean the guard is bound, because that is what makes the author
      // usable.
      return {
        ...contracts,
        state: 'pending-safe',
        txs,
        note: 'the modules are submitted; run again to install the guard',
      };
    }

    // 4. the guard. `guardFor(module)` says what the module was MINTED with;
    //    only the slot can prove what the Safe carries.
    const owners = await seam.readOwners({ safe, rpcUrl });

    // A multisig (or a Safe this key does not solely own) cannot take a self-call
    // from one signer: install what is permissionless, then hand the owners the
    // exact transaction to propose.
    const soleOwner =
      owners.threshold === 1 &&
      owners.owners.length === 1 &&
      owners.owners[0]?.toLowerCase() === eoa.toLowerCase();
    if (!soleOwner) {
      return {
        ...contracts,
        state: 'pending-safe',
        txs,
        safeTx: guardSafeTx(safe, guard),
        note: `the Safe needs owner signatures (${String(owners.threshold)}-of-${String(owners.owners.length)}) to install the guard — propose the Safe transaction in safeTx`,
      };
    }

    out.log(`installing the owner-history guard on ${safe}…`);
    await send(safe, JSON.stringify(safeAbi), 'setGuard', [guard]);

    // The userOp hash proves nothing: require the slot to carry the guard we
    // sent, else the transaction reverted (a GS300 `setGuard`, e.g.).
    const installed = await seam.readGuard({ safe, rpcUrl });
    if (!sameAddress(installed, guard)) {
      return {
        ...contracts,
        state: 'pending-safe',
        txs,
        note: `the setGuard transaction did not install the guard (the Safe's guard slot is ${installed ?? 'empty'}) — it may have reverted; run again`,
      };
    }

    return { ...contracts, state: 'installed', txs };
  } catch (err) {
    // A bundler that refused, an encode error, a dead RPC mid-run: report the
    // state reached so far. With no re-read there is no proof of an install.
    return {
      ...contracts,
      state: txs.length > 0 ? 'pending-safe' : 'skipped',
      txs,
      note: `installing the author contracts stopped: ${describeError(err)}`,
    };
  }
}
