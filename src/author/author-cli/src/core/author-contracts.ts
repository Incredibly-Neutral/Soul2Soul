// ============================================================================
// The author contracts, installed per author Safe.
//
// `@s2s/author-contracts` deployed two implementations (the drafts module and
// the owner-history module) and `AuthorContractsFactory` on Base. Nothing
// installs them per author: this module does, for the Safe it is given.
//
// The install is four steps:
//
//   1. drafts         factory.createDraftsModule(safe)          — permissionless
//   2. owner history  factory.createOwnerHistoryModule(safe)    — permissionless
//                     (mints the module AND its guard, bound to the module)
//   3. both modules   the Safe's own enableModule(drafts) and
//                     enableModule(ownerHistory) — `onlySelf`, so the Safe must
//                     be both sender and target of those userOps
//   4. the guard      the Safe's own setGuard(guard) — `onlySelf` too
//
// Why the modules are enabled: an enabled module is how a gate discovers a role.
// The publication's `canPublish`/`hasDeal` gates read the author Safe's enabled
// modules and ask each one which role it answers (ERC-165); a module that is
// deployed but not enabled is invisible to them, so an author with no enabled
// drafts module cannot be discovered as an author at all.
//
// Why enabling costs no authority: `enableModule` only grants a module the right
// to call `execTransactionFromModule`, i.e. to execute anything as the Safe.
// Neither of these contracts does. The drafts module is written by the Safe
// itself (`append` is `onlySafe`), the owner-history module's `sync()` is
// permissionless, and every other entry point on both is a `view` call. So an
// enabled module here is a name in a list, not a power.
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
//     author into `pending-safe`. What is *reported* as installed is read from
//     the Safe's enabled-module list, classified by ERC-165 — the same list a
//     gate reads.
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
// `migrateAuthorContracts` is the second half: an author who keeps the Safe
// address but adopts the modules a newer factory version predicts. It absorbs
// the old drafts log into the new module in pages, swaps the guard, enables the
// new modules and disables the old ones — the old modules stay on chain and
// abandoned, never upgraded.
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
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  AuthorContractsFactory,
  DraftsModuleV1,
  OwnerHistoryGuard,
  OwnerHistoryModuleV1,
} from '@s2s/author-contracts';
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

/** Safe 1.4.1's module linked list starts (and ends) here. */
const SAFE_MODULE_SENTINEL: Address = '0x0000000000000000000000000000000000000001';

/** Modules per `getModulesPaginated` page; a Safe never has enough to matter. */
const MODULE_PAGE_SIZE = 100n;

/** A Safe with more than this many module pages is not one this CLI made. */
const MAX_MODULE_PAGES = 16;

/** Draft logs per `absorb` page. `absorb` is `onlySafe`, so each page is a userOp. */
export const ABSORB_PAGE_SIZE = 100n;

/**
 * `absorb(oldModule, offset, limit)` — copy the old drafts log into this module.
 * `onlySafe`: the Safe is the caller, so a page is a userOp to the module.
 *
 * The signature is spelled here rather than imported because the generated ABI
 * this branch ships against predates the entry point; the selector is the
 * contract's, so the call is the same once the ABI catches up.
 */
const ABSORB_SIGNATURE =
  'function absorb(address oldModule, uint256 offset, uint256 limit)' as const;

/** The same signature, parsed: `encodeFunctionData` needs the parsed form. */
const ABSORB_ABI = parseAbi([ABSORB_SIGNATURE]);

/**
 * The Safe's guard-manager slot: `getGuard()` is `internal` in Safe 1.4.1 (no
 * public getter, bytecode size), so the only way to read the installed guard is
 * this storage slot — one word, the address in its low 20 bytes.
 * SPEC-author-owner-history, "Does the Safe offer a hook on owner rotation?".
 */
export const SAFE_GUARD_SLOT: Hex =
  '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';

/**
 * The ERC-165 role ids, as the contracts answer them.
 *
 * `type(IDraftsModule).interfaceId` and `type(IOwnerHistoryModule).interfaceId`
 * are compile-time literals in the deployed bytecode (a comment in each
 * implementation says so), and `type(Guard).interfaceId` is Safe 1.4.1's guard
 * id. A role is discovered by asking for the id — never by probing `NAME()`:
 * `NAME` is a string a contract chooses, so a copycat answers it, while the id
 * is what a gate actually asks for.
 */
export const DRAFTS_ROLE_ID: Hex = '0xefb74036';
export const OWNER_HISTORY_ROLE_ID: Hex = '0xee855023';
export const GUARD_ROLE_ID: Hex = '0xe6d7a83a';

/** The two roles an author Safe's modules can carry. */
export type ModuleRole = 'drafts' | 'owner-history';

/** Minimal ERC-165 ABI: the one question role discovery asks. */
const SUPPORTS_INTERFACE_ABI = [
  {
    inputs: [{ internalType: 'bytes4', name: 'interfaceId', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * The `AuthorContractsFactory` this CLI installs through: the address the deploy
 * transcript reported. It cannot be re-read from a chain here, so it ships as a
 * default and is overridable (`contracts.authorFactory` / `S2S_AUTHOR_CONTRACTS_FACTORY`).
 */
export const DEFAULT_AUTHOR_CONTRACTS_FACTORY: Address =
  '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E';

/** What is installed on one author Safe today. Every member is an address. */
export interface AuthorContracts {
  factory: `0x${string}`;
  drafts: `0x${string}` | null;
  ownerHistory: `0x${string}` | null;
  guard: `0x${string}` | null;
}

/**
 * 'installed' = the modules are enabled and the guard is on the Safe, and this
 * run sent the txs;
 * 'already' = the same, and nothing was to do;
 * 'pending-safe' = that state is not reached yet (owner signatures needed, a
 * submitted tx not visible, one that may have reverted, or a guard this package
 * will not replace);
 * 'skipped' = no chain reachable/configured, or the Safe is not deployed.
 *
 * `installed` and `already` always mean the modules and the guard were read back
 * from the Safe.
 */
export type InstallState = 'installed' | 'already' | 'pending-safe' | 'skipped';

/** A Safe self-call the owners of a multisig Safe must propose. */
export interface SafeCall {
  to: `0x${string}`;
  data: `0x${string}`;
}

export interface InstallResult extends AuthorContracts {
  state: InstallState;
  /** transaction hashes in the order they were sent; empty when nothing was sent. */
  txs: string[];
  /** one human line explaining 'pending-safe' / 'skipped'. */
  note?: string;
  /**
   * when 'pending-safe': the `setGuard` self-call the owners must propose. It is
   * the last entry of `safeTxs`; absent whenever no call is safe to hand over —
   * a foreign guard in the slot, a submitted userOp not yet visible, or one that
   * may have reverted.
   */
  safeTx?: SafeCall;
  /**
   * when 'pending-safe': every self-call the owners must propose, in send order
   * (`enableModule` for each module, then `setGuard`). `safeTx` is the last one.
   */
  safeTxs?: SafeCall[];
}

/** What a migration run did, on top of the resulting install. */
export interface MigrateResult extends AuthorContracts {
  state: InstallState;
  txs: string[];
  note?: string;
  safeTx?: SafeCall;
  safeTxs?: SafeCall[];
  /** absorb pages this run sent (0 when there was no old drafts log). */
  pages: number;
  /** the drafts module the Safe had enabled before this run; now disabled. */
  oldDrafts: `0x${string}` | null;
  /** the owner-history module the old guard was minted for; now disabled. */
  oldOwnerHistory: `0x${string}` | null;
}

/** What a Safe has enabled, in the Safe's own list order. */
export interface EnabledAuthorModules {
  /** every enabled module, in list order (the order `getModulesPaginated` answers). */
  modules: Address[];
  /**
   * every enabled module answering each role, in list order. A migration reads
   * this to find the previous generation: the last of a role is the live module,
   * and an earlier one of the same role is a module left behind. `drafts` and
   * `ownerHistory` below are its last elements.
   */
  byRole: { drafts: Address[]; ownerHistory: Address[] };
  /** the last enabled module answering the drafts role, or null. */
  drafts: Address | null;
  /** the last enabled module answering the owner-history role, or null. */
  ownerHistory: Address | null;
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

export interface AddressReadOptions {
  address: `0x${string}`;
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
 *
 * The index answers "what should be created", not "what the Safe enabled": only
 * `readEnabledAuthorModules` answers that.
 */
export async function readAuthorContracts(
  opts: ReadAuthorContractsOptions,
): Promise<AuthorContracts> {
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
 * an answer: the address does not expose `module()` / `safe()` / the interface
 * id. A transport or node failure is NOT an answer, and must propagate —
 * treating it as "foreign" would tell a healthy author to remove a guard that is
 * ours.
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
 * The role an address answers, or null when it answers none.
 *
 * ERC-165, not `NAME()`: the id is a compile-time literal of the deployed
 * bytecode (`type(IDraftsModule).interfaceId` / `type(IOwnerHistoryModule)`), so
 * it cannot drift from the contract, and it is the exact question a gate asks.
 * A `NAME()` probe answers whatever string a contract chooses to print, which a
 * copycat can print too.
 */
export async function readModuleRole(opts: AddressReadOptions): Promise<ModuleRole | null> {
  const client = clientFor(opts.rpcUrl);
  const asks = (interfaceId: Hex) =>
    client.readContract({
      address: opts.address,
      abi: SUPPORTS_INTERFACE_ABI,
      functionName: 'supportsInterface',
      args: [interfaceId],
    });

  try {
    const [drafts, ownerHistory] = await Promise.all([
      asks(DRAFTS_ROLE_ID),
      asks(OWNER_HISTORY_ROLE_ID),
    ]);
    if (drafts) return 'drafts';
    if (ownerHistory) return 'owner-history';
    return null;
  } catch (err) {
    if (answersForeign(err)) return null;
    throw err;
  }
}

/** Whether an address answers the Safe 1.4.1 guard id (what `setGuard` asks). */
export async function readGuardRole(opts: GuardReadOptions): Promise<boolean> {
  try {
    return await clientFor(opts.rpcUrl).readContract({
      address: opts.guard,
      abi: SUPPORTS_INTERFACE_ABI,
      functionName: 'supportsInterface',
      args: [GUARD_ROLE_ID],
    });
  } catch (err) {
    if (answersForeign(err)) return false;
    throw err;
  }
}

/**
 * What the Safe has enabled, classified by ERC-165 role. This — not the factory
 * index — is what an install records and what a gate will see.
 *
 * `modules` keeps the Safe's list order: `disableModule(prev, module)` needs the
 * preceding entry, so the order is load-bearing for a migration.
 */
export async function readEnabledAuthorModules(
  opts: ReadSafeOptions,
): Promise<EnabledAuthorModules> {
  const client = clientFor(opts.rpcUrl);
  const modules: Address[] = [];
  let start = SAFE_MODULE_SENTINEL;

  for (let page = 0; page < MAX_MODULE_PAGES; page += 1) {
    const [list, next] = (await client.readContract({
      address: opts.safe,
      abi: safeAbi,
      functionName: 'getModulesPaginated',
      args: [start, MODULE_PAGE_SIZE],
    })) as [Address[], Address];

    for (const module of list) modules.push(getAddress(module.toLowerCase()));
    // The list ends at the sentinel (and an empty page always does).
    if (list.length === 0 || next === SAFE_MODULE_SENTINEL || next === ZERO_ADDRESS) break;
    start = getAddress(next.toLowerCase());
  }

  const byRole: { drafts: Address[]; ownerHistory: Address[] } = { drafts: [], ownerHistory: [] };
  for (const module of modules) {
    const role = await readModuleRole({ address: module, rpcUrl: opts.rpcUrl });
    // The last of a role wins: an append-only module list puts a replacement
    // after the one it replaces, so the newest enabled module is the live one.
    if (role === 'drafts') byRole.drafts.push(module);
    if (role === 'owner-history') byRole.ownerHistory.push(module);
  }

  return {
    modules,
    byRole,
    drafts: byRole.drafts[byRole.drafts.length - 1] ?? null,
    ownerHistory: byRole.ownerHistory[byRole.ownerHistory.length - 1] ?? null,
  };
}

/** The module a guard names (`OwnerHistoryGuard.module()`), or null when the
 * guard does not answer — an address that is not an owner-history guard.
 * Transport errors propagate: an unreadable guard is not a foreign one. */
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
  const guard = await clientFor(opts.rpcUrl).readContract({
    address: opts.factory,
    abi: AuthorContractsFactory,
    functionName: 'guardFor',
    args: [opts.module],
  });
  return guard === ZERO_ADDRESS ? null : getAddress(guard.toLowerCase());
}

/**
 * The addresses the factory predicts for a Safe's modules (CREATE2, so they are
 * known before either is deployed). Zero means this factory has no prediction —
 * an older deployment — and a migration has nothing to aim at.
 */
export async function readPredictedModules(opts: ReadAuthorContractsOptions): Promise<{
  drafts: Address | null;
  ownerHistory: Address | null;
}> {
  const client = clientFor(opts.rpcUrl);
  const [drafts, ownerHistory] = await Promise.all([
    client.readContract({
      address: opts.factory,
      abi: AuthorContractsFactory,
      functionName: 'draftsModuleAddress',
      args: [opts.safe],
    }),
    client.readContract({
      address: opts.factory,
      abi: AuthorContractsFactory,
      functionName: 'ownerHistoryModuleAddress',
      args: [opts.safe],
    }),
  ]);

  return {
    drafts: drafts === ZERO_ADDRESS ? null : getAddress(drafts.toLowerCase()),
    ownerHistory: ownerHistory === ZERO_ADDRESS ? null : getAddress(ownerHistory.toLowerCase()),
  };
}

/** Whether an address carries bytecode — the read-back that a create landed. */
export async function readHasCode(opts: AddressReadOptions): Promise<boolean> {
  const code = await clientFor(opts.rpcUrl).getCode({ address: opts.address });
  return code !== undefined && code !== '0x';
}

/** How many genesis logs a drafts module holds (`count()`). */
export async function readDraftsCount(opts: ModuleReadOptions): Promise<bigint> {
  return await clientFor(opts.rpcUrl).readContract({
    address: opts.module,
    abi: DraftsModuleV1,
    functionName: 'count',
  });
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

  return {
    owners: owners.map((owner) => getAddress(owner.toLowerCase())),
    threshold: Number(threshold),
  };
}

// ===========================================================================
// The seam
// ===========================================================================

/**
 * The calls the install and the migration make to the outside world, as one
 * injectable object. The tests replace all of them; production uses
 * `defaultSeam`.
 *
 * This is the smallest seam that reaches every branch (four states, the guard
 * proof, the foreign guard, the multisig path, the absorb pages): the reads, the
 * Safe deployment and the runner are the only calls that leave the process, so
 * faking them fakes the decision logic without a chain or a bundler.
 */
export interface AuthorContractsSeam {
  readContracts(opts: ReadAuthorContractsOptions): Promise<AuthorContracts>;
  /** What the Safe has enabled, classified by ERC-165 role. */
  readEnabled(opts: ReadSafeOptions): Promise<EnabledAuthorModules>;
  readGuard(opts: ReadSafeOptions): Promise<Address | null>;
  /** `guard.module()` — what the guard in the slot was minted for. */
  readGuardModule(opts: GuardReadOptions): Promise<Address | null>;
  /** `guard.safe()` — the Safe the guard is bound to. */
  readGuardSafe(opts: GuardReadOptions): Promise<Address | null>;
  /** `guard.supportsInterface(type(Guard).interfaceId)`. */
  readGuardRole(opts: GuardReadOptions): Promise<boolean>;
  /** `module.safe()` — the Safe a module is bound to. */
  readModuleSafe(opts: ModuleReadOptions): Promise<Address | null>;
  readOwners(opts: ReadSafeOptions): Promise<SafeOwners>;
  /** `guardFor(module)` — the guard the factory minted with that module. */
  readGuardFor(opts: GuardForOptions): Promise<Address | null>;
  /** `draftsModuleAddress(safe)` / `ownerHistoryModuleAddress(safe)`. */
  readPredicted(opts: ReadAuthorContractsOptions): Promise<{
    drafts: Address | null;
    ownerHistory: Address | null;
  }>;
  /** Whether an address carries bytecode — the read-back for a create. */
  readHasCode(opts: AddressReadOptions): Promise<boolean>;
  /** `drafts.count()` — how many genesis logs a module holds. */
  readDraftsCount(opts: ModuleReadOptions): Promise<bigint>;
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
  readEnabled: readEnabledAuthorModules,
  readGuard: readSafeGuard,
  readGuardModule,
  readGuardSafe,
  readGuardRole,
  readModuleSafe,
  readOwners: readSafeOwners,
  readGuardFor,
  readPredicted: readPredictedModules,
  readHasCode,
  readDraftsCount,
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
// The Safe self-calls
// ===========================================================================

/** `setGuard(guard)` — `onlySelf`, so the Safe is both sender and target. */
function guardSafeTx(safe: `0x${string}`, guard: `0x${string}`): SafeCall {
  return {
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'setGuard', args: [guard] }),
  };
}

/** `enableModule(module)` — an enabled module is how a gate discovers a role. */
function enableModuleSafeTx(safe: `0x${string}`, module: `0x${string}`): SafeCall {
  return {
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [module] }),
  };
}

/** `disableModule(prev, module)` — the old modules are left disabled, not removed. */
function disableModuleSafeTx(
  safe: `0x${string}`,
  prev: `0x${string}`,
  module: `0x${string}`,
): SafeCall {
  return {
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'disableModule', args: [prev, module] }),
  };
}

/** `absorb(oldModule, offset, limit)` — one page of the old drafts log. */
function absorbSafeTx(
  module: `0x${string}`,
  oldModule: `0x${string}`,
  offset: bigint,
  limit: bigint,
): SafeCall {
  return {
    to: module,
    data: encodeFunctionData({
      abi: ABSORB_ABI,
      functionName: 'absorb',
      args: [oldModule, offset, limit],
    }),
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

function includesAddress(list: readonly Address[], address: `0x${string}`): boolean {
  return list.some((entry) => entry.toLowerCase() === address.toLowerCase());
}

/**
 * `disableModule` needs the preceding entry in the Safe's linked list. Walk the
 * given order, removing as we go, so a batch of disables is valid when the Safe
 * executes it in this order.
 */
function disablePairs(
  modules: readonly Address[],
  targets: readonly Address[],
): { prev: Address; module: Address }[] {
  const list = [...modules];
  const pairs: { prev: Address; module: Address }[] = [];
  for (const target of targets) {
    const index = list.findIndex((entry) => sameAddress(entry, target));
    const module = list[index];
    if (module === undefined) continue;
    const prev = index === 0 ? SAFE_MODULE_SENTINEL : list[index - 1];
    if (prev === undefined) continue;
    pairs.push({ prev, module });
    list.splice(index, 1);
  }
  return pairs;
}

/** Whether this key is the Safe's only owner at threshold 1 — the only shape that can take a self-call. */
function solelyOwned(owners: SafeOwners, eoa: Address): boolean {
  return (
    owners.threshold === 1 &&
    owners.owners.length === 1 &&
    owners.owners[0]?.toLowerCase() === eoa.toLowerCase()
  );
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
  let index: AuthorContracts;
  let enabled: EnabledAuthorModules;
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
    index = await seam.readContracts({ factory, safe, rpcUrl });
    enabled = await seam.readEnabled({ safe, rpcUrl });
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
  const send = async (
    to: `0x${string}`,
    abi: string,
    method: string,
    args: unknown[],
  ): Promise<void> => {
    const hash = await (await getRunner()).genericTx(to, abi, method, args, false);
    txs.push(hash);
  };

  try {
    // 1. What the Safe carries decides. A guard in the slot whose own immutables
    //    name a module bound to this Safe IS the install — the index only says
    //    what could be created, and any address can append to it.
    const slotGuard = await seam.readGuard({ safe, rpcUrl });
    const proof =
      slotGuard === null
        ? null
        : await proveInstalledGuard({ safe, guard: slotGuard, rpcUrl }, seam);

    if (slotGuard !== null && proof === null) {
      // Never overwrite: it may be why the Safe behaves the way its owners
      // expect, and there is no call to offer that would be safe to make.
      return {
        ...index,
        state: 'pending-safe',
        txs: [],
        note: `the Safe already carries a guard this package did not install (${slotGuard}) — this package never replaces a guard; remove it through the Safe first if the owner-history guard is wanted`,
      };
    }

    // 2. Create what the factory index lacks. A re-read after each send is the
    //    only proof it landed — `genericTx` resolves with the hash of a userOp
    //    that may have reverted.
    let current: AuthorContracts = index;

    let draftsModule: Address | null = current.drafts;
    if (draftsModule === null) {
      out.log(`installing the drafts module for ${safe}…`);
      await send(factory, JSON.stringify(AuthorContractsFactory), 'createDraftsModule', [safe]);
      current = await seam.readContracts({ factory, safe, rpcUrl });
      draftsModule = current.drafts;
      if (draftsModule === null) {
        return {
          ...current,
          state: 'pending-safe',
          txs,
          note: 'the drafts module transaction did not change the factory index — it may have reverted; run again',
        };
      }
    }

    if (proof === null && current.ownerHistory === null) {
      out.log(`installing the owner-history module for ${safe}…`);
      await send(factory, JSON.stringify(AuthorContractsFactory), 'createOwnerHistoryModule', [
        safe,
      ]);
      current = await seam.readContracts({ factory, safe, rpcUrl });
      if (current.ownerHistory === null) {
        return {
          ...current,
          state: 'pending-safe',
          txs,
          note: 'the owner-history module transaction did not change the factory index — it may have reverted; run again',
        };
      }
    }

    // A proven guard names its own module — that module is installed whatever
    // the index has accumulated since; without one, the newest index entry is
    // what a `createOwnerHistoryModule` just minted.
    const historyModule: Address | null = proof?.module ?? current.ownerHistory;
    const guard: Address | null = proof?.guard ?? current.guard;
    if (guard === null || historyModule === null) {
      // The modules may exist, but nothing is on the Safe yet: `installed` must
      // always mean the guard is bound, because that is what makes the author
      // usable.
      return {
        ...current,
        ownerHistory: historyModule,
        state: 'pending-safe',
        txs,
        note: 'the modules are submitted; run again to install the guard',
      };
    }

    // 3. Enable whatever is not enabled yet. A module the Safe does not have
    //    enabled is invisible to a gate, whatever the factory index says.
    enabled = await seam.readEnabled({ safe, rpcUrl });
    const toEnable: Address[] = [];
    if (!includesAddress(enabled.modules, draftsModule)) toEnable.push(draftsModule);
    if (!includesAddress(enabled.modules, historyModule)) toEnable.push(historyModule);
    const needsGuard = proof === null;

    if (toEnable.length === 0 && !needsGuard) {
      return {
        factory,
        drafts: enabled.drafts,
        ownerHistory: enabled.ownerHistory,
        guard,
        state: 'already',
        txs: [],
      };
    }

    // A multisig (or a Safe this key does not solely own) cannot take a self-call
    // from one signer: create what is permissionless (done above), then hand the
    // owners every call to propose — the enables and, if it is still to do, the
    // guard.
    const owners = await seam.readOwners({ safe, rpcUrl });
    if (!solelyOwned(owners, eoa)) {
      const calls: SafeCall[] = toEnable.map((module) => enableModuleSafeTx(safe, module));
      if (needsGuard) calls.push(guardSafeTx(safe, guard));
      const what = needsGuard ? 'enable the modules and install the guard' : 'enable the modules';
      const proposal: InstallResult = {
        ...current,
        ownerHistory: historyModule,
        state: 'pending-safe',
        txs,
        note: `the Safe needs owner signatures (${String(owners.threshold)}-of-${String(owners.owners.length)}) to ${what} — propose the Safe transactions in safeTxs`,
      };
      const lastCall = calls[calls.length - 1];
      if (lastCall !== undefined) {
        proposal.safeTxs = calls;
        proposal.safeTx = needsGuard ? guardSafeTx(safe, guard) : lastCall;
      }
      return proposal;
    }

    for (const module of toEnable) {
      out.log(`enabling module ${module} on ${safe}…`);
      await send(safe, JSON.stringify(safeAbi), 'enableModule', [module]);
    }

    if (toEnable.length > 0) {
      // The userOp hash proves nothing: require the module list to show them.
      const afterEnable = await seam.readEnabled({ safe, rpcUrl });
      const stillOff = toEnable.filter((module) => !includesAddress(afterEnable.modules, module));
      if (stillOff.length > 0) {
        return {
          ...current,
          ownerHistory: historyModule,
          state: 'pending-safe',
          txs,
          note: `the enableModule transaction did not enable ${stillOff.join(', ')} on the Safe — it may have reverted; run again`,
        };
      }
      enabled = afterEnable;
    }

    // 4. the guard. `guardFor(module)` says what the module was MINTED with;
    //    only the slot can prove what the Safe carries.
    if (needsGuard) {
      out.log(`installing the owner-history guard on ${safe}…`);
      await send(safe, JSON.stringify(safeAbi), 'setGuard', [guard]);

      const installed = await seam.readGuard({ safe, rpcUrl });
      if (!sameAddress(installed, guard)) {
        return {
          ...current,
          ownerHistory: historyModule,
          state: 'pending-safe',
          txs,
          note: `the setGuard transaction did not install the guard (the Safe's guard slot is ${installed ?? 'empty'}) — it may have reverted; run again`,
        };
      }
    }

    // Record what the Safe enabled, not what the index claims: this is the list
    // a gate reads, and the one `rememberAuthorContracts` stores.
    const finalEnabled = await seam.readEnabled({ safe, rpcUrl });
    return {
      factory,
      drafts: finalEnabled.drafts,
      ownerHistory: finalEnabled.ownerHistory,
      guard,
      state: 'installed',
      txs,
    };
  } catch (err) {
    // A bundler that refused, an encode error, a dead RPC mid-run: report the
    // state reached so far. With no re-read there is no proof of an install.
    return {
      ...index,
      state: txs.length > 0 ? 'pending-safe' : 'skipped',
      txs,
      note: `installing the author contracts stopped: ${describeError(err)}`,
    };
  }
}

// ===========================================================================
// Migration — a new module generation on the same Safe
// ===========================================================================

/**
 * Move an author Safe onto the modules a newer factory version predicts, without
 * changing its address.
 *
 * The steps, in order:
 *
 *   1. Resolve the predicted drafts and owner-history addresses from the factory
 *      (`draftsModuleAddress(safe)` / `ownerHistoryModuleAddress(safe)`), and
 *      create whichever has no code yet.
 *   2. Absorb the old drafts log into the new drafts module, in pages of
 *      `ABSORB_PAGE_SIZE`: `absorb` is `onlySafe`, so every page is a userOp.
 *   3. `setGuard(newGuard)`.
 *   4. `enableModule` for both new modules.
 *   5. Disable the old modules. They stay on chain, abandoned: nothing is
 *      upgraded, nothing is deleted, and their logs remain readable by address.
 *
 * A guard in the slot is replaced only when it is this package's owner-history
 * guard for the old module — `G.safe() == safe`, `G.module() == old module`, and
 * the guard answers `type(Guard).interfaceId`. Any other guard is never replaced:
 * the run stops with a note naming the guard it found.
 *
 * A second run is a no-op: the guard in the slot is then the new one, both new
 * modules are enabled and the old ones are gone from the list.
 */
export async function migrateAuthorContracts(
  opts: InstallAuthorContractsOptions,
  seam: AuthorContractsSeam = defaultAuthorContractsSeam,
): Promise<MigrateResult> {
  const { config, safe, rpcUrl, privateKey, out } = opts;
  const factory = authorContractsFactory(config);
  const eoa = privateKeyToAccount(privateKey).address;

  const nothing = (current?: Partial<AuthorContracts>): MigrateResult => ({
    factory,
    drafts: null,
    ownerHistory: null,
    guard: null,
    ...(current ?? {}),
    state: 'skipped',
    txs: [],
    pages: 0,
    oldDrafts: null,
    oldOwnerHistory: null,
  });

  if (!bundlerEndpoints(config, base.id)) {
    return { ...nothing(), note: BUNDLER_NOTE };
  }

  let predicted: { drafts: Address | null; ownerHistory: Address | null };
  let enabled: EnabledAuthorModules;
  try {
    const ensured: EnsuredAuthorSafe = await seam.ensureSafe({ config, privateKey, rpcUrl, out });
    if (!ensured.deployed) {
      return {
        ...nothing(),
        note: `the author Safe ${safe} is not deployed — run \`s2s author init\` first`,
      };
    }
    predicted = await seam.readPredicted({ factory, safe, rpcUrl });
    enabled = await seam.readEnabled({ safe, rpcUrl });
  } catch (err) {
    return { ...nothing(), note: unreachableNote(rpcUrl, err) };
  }

  const seen = (): AuthorContracts => ({
    factory,
    drafts: enabled.drafts,
    ownerHistory: enabled.ownerHistory,
    guard: null,
  });

  if (predicted.drafts === null || predicted.ownerHistory === null) {
    return {
      ...nothing({ drafts: enabled.drafts, ownerHistory: enabled.ownerHistory }),
      state: 'pending-safe',
      note: `the factory ${factory} predicts no module addresses for ${safe} — it predates CREATE2 prediction; run \`s2s author init\` against a current factory`,
    };
  }

  // The prediction is known good from here on; two plain addresses keep that
  // narrowing, which a nullable object loses inside the closures below.
  const newDrafts: Address = predicted.drafts;
  const newHistory: Address = predicted.ownerHistory;

  let runner: Pick<SafeRunnerHandle, 'genericTx'> | undefined;
  const getRunner = async (): Promise<Pick<SafeRunnerHandle, 'genericTx'>> => {
    runner ??= await seam.openRunner({ config, privateKey, rpcUrl, safe });
    return runner;
  };
  const txs: string[] = [];
  const send = async (
    to: `0x${string}`,
    abi: string,
    method: string,
    args: unknown[],
  ): Promise<void> => {
    const hash = await (await getRunner()).genericTx(to, abi, method, args, false);
    txs.push(hash);
  };

  try {
    // The slot guard is read and proved before any write: a foreign guard means
    // the run touches nothing at all. The proof is also the only place the old
    // history module's address comes from.
    const slotGuard = await seam.readGuard({ safe, rpcUrl });
    let oldOwnerHistory: Address | null = null;
    if (slotGuard !== null) {
      // Replacing a guard is allowed only for this package's own guard of the
      // old module. Anything else stays, and the run says which guard it found.
      const proof = await proveInstalledGuard({ safe, guard: slotGuard, rpcUrl }, seam);
      const answersGuardId = await seam.readGuardRole({ guard: slotGuard, rpcUrl });
      if (proof === null || !answersGuardId) {
        return {
          ...nothing({ drafts: enabled.drafts, ownerHistory: enabled.ownerHistory }),
          state: 'pending-safe',
          note: `refusing to replace the guard ${slotGuard} in the Safe's slot — it is not this package's owner-history guard (wrong Safe, wrong module, or it does not answer type(Guard).interfaceId ${GUARD_ROLE_ID}); this package never replaces a foreign guard`,
        };
      }
      oldOwnerHistory = proof.module;
    }

    // Create whichever predicted module has no code. The read-back is the code
    // itself: a create is permissionless and CREATE2, so the address is known
    // before the transaction and unchanged by it.
    for (const [address, method] of [
      [newDrafts, 'createDraftsModule'],
      [newHistory, 'createOwnerHistoryModule'],
    ] as const) {
      if (await seam.readHasCode({ address, rpcUrl })) continue;
      out.log(`creating ${method} for ${safe}…`);
      await send(factory, JSON.stringify(AuthorContractsFactory), method, [safe]);
      if (!(await seam.readHasCode({ address, rpcUrl }))) {
        return {
          ...nothing(),
          drafts: enabled.drafts,
          ownerHistory: enabled.ownerHistory,
          guard: null,
          state: 'pending-safe',
          txs,
          note: `the ${method} transaction did not deploy ${address} — it may have reverted; run again`,
        };
      }
    }

    // Only now can the factory answer: `guardFor` is written by
    // `createOwnerHistoryModule`, so on a first run the guard does not exist
    // until the loop above has run. A null here is the factory failing to record
    // its own module, not a missing install step.
    const newGuard = await seam.readGuardFor({ factory, module: newHistory, rpcUrl });
    if (newGuard === null) {
      return {
        ...nothing({ drafts: enabled.drafts, ownerHistory: enabled.ownerHistory }),
        state: 'pending-safe',
        txs,
        note: `the factory ${factory} recorded no guard for the owner-history module ${newHistory} — guardFor still answers nothing after the module was created; nothing was enabled and the run stopped`,
      };
    }

    const guardMove = !sameAddress(slotGuard, newGuard);

    const enabledHas = (module: Address) => includesAddress(enabled.modules, module);
    const toEnable: Address[] = [];
    if (!enabledHas(newDrafts)) toEnable.push(newDrafts);
    if (!enabledHas(newHistory)) toEnable.push(newHistory);

    // Every enabled module that answers a role and is not the predicted one is a
    // previous generation: disabled below, never reused, never upgraded.
    const staleDrafts = enabled.byRole.drafts.filter((module) => !sameAddress(module, newDrafts));
    const staleHistory = enabled.byRole.ownerHistory.filter(
      (module) => !sameAddress(module, newHistory),
    );
    const replacements = [...staleDrafts, ...staleHistory];
    // The absorb source: the newest old drafts module, and only on the run that
    // moves the guard — a repeat must not copy the log twice.
    const absorbFrom = guardMove ? (staleDrafts[staleDrafts.length - 1] ?? null) : null;
    if (oldOwnerHistory === null) {
      oldOwnerHistory = staleHistory[staleHistory.length - 1] ?? null;
    }

    if (!guardMove && toEnable.length === 0 && replacements.length === 0) {
      return {
        factory,
        drafts: enabled.drafts,
        ownerHistory: enabled.ownerHistory,
        guard: newGuard,
        state: 'already',
        txs: [],
        pages: 0,
        oldDrafts: null,
        oldOwnerHistory: null,
      };
    }

    // The pages the absorb needs, from the old log's size.
    const oldCount =
      absorbFrom === null ? 0n : await seam.readDraftsCount({ module: absorbFrom, rpcUrl });
    const pages: { offset: bigint; limit: bigint }[] = [];
    for (let offset = 0n; offset < oldCount; offset += ABSORB_PAGE_SIZE) {
      const remaining = oldCount - offset;
      pages.push({ offset, limit: remaining < ABSORB_PAGE_SIZE ? remaining : ABSORB_PAGE_SIZE });
    }

    const owners = await seam.readOwners({ safe, rpcUrl });
    if (!solelyOwned(owners, eoa)) {
      // Nothing downstream is permissionless: absorb, setGuard, enable and
      // disable are all Safe self-calls. Hand the owners the whole sequence.
      const calls: SafeCall[] = [];
      if (absorbFrom !== null) {
        for (const page of pages)
          calls.push(absorbSafeTx(newDrafts, absorbFrom, page.offset, page.limit));
      }
      if (guardMove) calls.push(guardSafeTx(safe, newGuard));
      for (const module of toEnable) calls.push(enableModuleSafeTx(safe, module));
      for (const pair of disablePairs(enabled.modules, replacements)) {
        calls.push(disableModuleSafeTx(safe, pair.prev, pair.module));
      }
      const proposal: MigrateResult = {
        ...seen(),
        guard: newGuard,
        drafts: enabled.drafts,
        ownerHistory: enabled.ownerHistory,
        state: 'pending-safe',
        txs,
        pages: 0,
        oldDrafts: absorbFrom,
        oldOwnerHistory,
        note: `the Safe needs owner signatures (${String(owners.threshold)}-of-${String(owners.owners.length)}) to migrate — propose the ${String(calls.length)} Safe transactions in safeTxs, in order`,
      };
      const lastCall = calls[calls.length - 1];
      if (lastCall !== undefined) {
        proposal.safeTxs = calls;
        proposal.safeTx = lastCall;
      }
      return proposal;
    }

    let sentPages = 0;
    if (absorbFrom !== null && pages.length > 0) {
      out.log(`absorbing ${String(oldCount)} draft logs from ${absorbFrom} into ${newDrafts}…`);
      for (const page of pages) {
        await send(newDrafts, ABSORB_SIGNATURE, 'absorb', [absorbFrom, page.offset, page.limit]);
        sentPages += 1;
      }
      // The userOp hash is not proof: the new module's own count is.
      const carried = await seam.readDraftsCount({ module: newDrafts, rpcUrl });
      if (carried === 0n) {
        return {
          ...seen(),
          guard: newGuard,
          state: 'pending-safe',
          txs,
          pages: sentPages,
          oldDrafts: absorbFrom,
          oldOwnerHistory,
          note: `the absorb pages did not reach ${newDrafts} (its count is still 0) — they may have reverted; run again`,
        };
      }
    }

    if (guardMove) {
      out.log(`replacing the guard on ${safe} with ${newGuard}…`);
      await send(safe, JSON.stringify(safeAbi), 'setGuard', [newGuard]);
      const installed = await seam.readGuard({ safe, rpcUrl });
      if (!sameAddress(installed, newGuard)) {
        return {
          ...seen(),
          guard: newGuard,
          state: 'pending-safe',
          txs,
          pages: sentPages,
          oldDrafts: absorbFrom,
          oldOwnerHistory,
          note: `the setGuard transaction did not install the guard (the Safe's guard slot is ${installed ?? 'empty'}) — it may have reverted; run again`,
        };
      }
    }

    for (const module of toEnable) {
      out.log(`enabling module ${module} on ${safe}…`);
      await send(safe, JSON.stringify(safeAbi), 'enableModule', [module]);
    }
    if (toEnable.length > 0) {
      const afterEnable = await seam.readEnabled({ safe, rpcUrl });
      const stillOff = toEnable.filter((module) => !includesAddress(afterEnable.modules, module));
      if (stillOff.length > 0) {
        return {
          ...seen(),
          guard: newGuard,
          state: 'pending-safe',
          txs,
          pages: sentPages,
          oldDrafts: absorbFrom,
          oldOwnerHistory,
          note: `the enableModule transaction did not enable ${stillOff.join(', ')} on the Safe — it may have reverted; run again`,
        };
      }
      enabled = afterEnable;
    }

    // The old modules are left on chain and abandoned, but disabled: two enabled
    // modules of one role would make the role ambiguous for every gate.
    for (const target of replacements) {
      const list = await seam.readEnabled({ safe, rpcUrl });
      if (!includesAddress(list.modules, target)) continue;
      const [pair] = disablePairs(list.modules, [target]);
      if (!pair) continue;
      out.log(`disabling the old module ${target} on ${safe}…`);
      await send(safe, JSON.stringify(safeAbi), 'disableModule', [pair.prev, pair.module]);
      const after = await seam.readEnabled({ safe, rpcUrl });
      if (includesAddress(after.modules, target)) {
        return {
          ...seen(),
          guard: newGuard,
          state: 'pending-safe',
          txs,
          pages: sentPages,
          oldDrafts: absorbFrom,
          oldOwnerHistory,
          note: `the disableModule transaction did not disable ${target} on the Safe — it may have reverted; run again`,
        };
      }
    }

    const finalEnabled = await seam.readEnabled({ safe, rpcUrl });
    return {
      factory,
      drafts: finalEnabled.drafts,
      ownerHistory: finalEnabled.ownerHistory,
      guard: newGuard,
      state: 'installed',
      txs,
      pages: sentPages,
      oldDrafts: absorbFrom,
      oldOwnerHistory,
    };
  } catch (err) {
    return {
      ...nothing({ drafts: enabled.drafts, ownerHistory: enabled.ownerHistory }),
      state: txs.length > 0 ? 'pending-safe' : 'skipped',
      txs,
      note: `migrating the author contracts stopped: ${describeError(err)}`,
    };
  }
}
