// ============================================================================
// The author records module, per author Safe.
//
// One module per author Safe, deployed by `AuthorFactory` from the records
// implementation its deployer set. Its contents are plain string-to-string
// records — no CID, no JSON document, no IPFS. The author writes two of them:
//
//   pen_name   the author's pet name, so a reader can name the author without
//              the store (`s2s author new` / `s2s author init` write it)
//   bio        a short public biography (`s2s author bio` reads, sets, clears)
//
// Where the addresses come from, and in what order:
//
//   1. the factory is the author factory the CLI already installs through:
//      `contracts.authorFactory`, then `S2S_AUTHOR_CONTRACTS_FACTORY`, then the
//      shipped `DEFAULT_AUTHOR_CONTRACTS_FACTORY`. A factory with no code is
//      reported as not deployed.
//   2. `recordsImplementation()` — the implementation the factory's deployer
//      set. Zero means no module can be created: `createRecordsModule` would
//      revert `NoImplementation()`.
//   3. `recordsModuleAddress(safe)` — the recorded module, else a CREATE2
//      prediction, else zero. It answers whether or not the proxy exists, so it
//      is what a create is aimed at and what an `enableModule`/`setRecord` would
//      name. It is NOT proof: the proof that a module is installed is code at
//      the address, and the proof that a Safe carries it is the Safe's own
//      enabled-module list.
//   4. `recordsModule(safe)` — only the module the factory has recorded. Zero
//      means `createRecordsModule` has not run for this Safe, even when
//      `recordsModuleAddress` predicts an address for it.
//
// `createRecordsModule(safe)` requires `msg.sender == safe`, so it goes out as a
// Safe self-call: the runner is bound to the Safe, which makes the Safe
// `msg.sender`. It is idempotent — a second call answers the module that
// already exists — so the read before it only avoids a pointless userOp; the
// read after it is the proof that it landed.
//
// A records module is `onlySafe` for every write. The Safe is the sender of
// every `setRecord` / `deleteRecord`, which is the same route `enableModule`
// takes. Nothing in this file opens a runner of its own; the install and the
// bio command hand it the one they already have.
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
import { AuthorFactory } from '@s2s/author-contracts';
import { S2SRecordsModuleV0_1 } from '@s2s/publication-contracts';
import { safeAbi } from '@s2s/soul2soul-shared';

import { describeError } from '../lib/errors';

/** The record holding the author's pet name. */
export const PEN_NAME_KEY = 'pen_name';

/** The record holding the author's public biography. */
export const BIO_KEY = 'bio';

/** A bio longer than this is refused before anything is encoded or sent. */
export const BIO_MAX_LENGTH = 1024;

/** The zero address: "no implementation", "no prediction", "not deployed". */
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** A Safe self-call the owners of a multisig must propose. */
export interface RecordsCall {
  to: Address;
  data: Hex;
}

/** What the factory says about this Safe, read-only. */
export interface RecordsResolution {
  /** The factory the config names. */
  factory: Address;
  /** False when `factory` carries no code: it is not deployed. */
  deployed: boolean;
  /** `recordsImplementation()`; null for the zero address (nothing deployable). */
  implementation: Address | null;
  /** `recordsModuleAddress(safe)`; null for zero (no record and no prediction). */
  address: Address | null;
  /** `recordsModule(safe)`; null for zero (the factory has recorded no module). */
  recorded: Address | null;
}

/**
 * The reads and writes to the outside world. The install and the bio command
 * take the seam they are given (`AuthorContractsSeam` extends this), so neither
 * has a second runner or a second client.
 */
export interface RecordsSeam {
  /** Whether an address carries bytecode — a factory that is deployed, a module that exists. */
  readHasCode(opts: { address: Address; rpcUrl: string }): Promise<boolean>;
  /** `recordsImplementation()`, null for the zero address. */
  recordsImplementation(opts: { factory: Address; rpcUrl: string }): Promise<Address | null>;
  /** `recordsModuleAddress(safe)`, null for the zero address. */
  recordsModuleAddress(opts: {
    factory: Address;
    safe: Address;
    rpcUrl: string;
  }): Promise<Address | null>;
  /** `recordsModule(safe)`, null for the zero address. */
  recordsModule(opts: { factory: Address; safe: Address; rpcUrl: string }): Promise<Address | null>;
  /** `getRecord(key)`, null when absent (`KeyNotFound`) or empty. */
  record(opts: { module: Address; key: string; rpcUrl: string }): Promise<string | null>;
}

/** A public client per read: a client is cheap, a cached one is stale chain state. */
function clientFor(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

/** Whether an address carries bytecode. */
export async function readHasCode(opts: { address: Address; rpcUrl: string }): Promise<boolean> {
  const code = await clientFor(opts.rpcUrl).getCode({ address: opts.address });
  return code !== undefined && code !== '0x';
}

/**
 * Whether a failed read means "this record/address answers nothing", as opposed
 * to "the network failed". Same rule as the author-contracts reads: a revert or
 * empty data is an answer, a transport failure is not.
 */
function answersAbsent(err: unknown): boolean {
  if (err instanceof ContractFunctionRevertedError) return true;
  if (err instanceof ContractFunctionZeroDataError) return true;
  if (err instanceof ContractFunctionExecutionError) return answersAbsent(err.cause);
  return false;
}

/** `recordsImplementation()`; the zero address is reported as null. */
export async function readRecordsImplementation(opts: {
  factory: Address;
  rpcUrl: string;
}): Promise<Address | null> {
  const implementation = await clientFor(opts.rpcUrl).readContract({
    address: opts.factory,
    abi: AuthorFactory,
    functionName: 'recordsImplementation',
  });
  return implementation === ZERO_ADDRESS ? null : getAddress(implementation.toLowerCase());
}

/** `recordsModuleAddress(safe)`; the zero address is reported as null. */
export async function readRecordsModuleAddress(opts: {
  factory: Address;
  safe: Address;
  rpcUrl: string;
}): Promise<Address | null> {
  const module = await clientFor(opts.rpcUrl).readContract({
    address: opts.factory,
    abi: AuthorFactory,
    functionName: 'recordsModuleAddress',
    args: [opts.safe],
  });
  return module === ZERO_ADDRESS ? null : getAddress(module.toLowerCase());
}

/** `recordsModule(safe)`; the zero address is reported as null. */
export async function readRecordsModule(opts: {
  factory: Address;
  safe: Address;
  rpcUrl: string;
}): Promise<Address | null> {
  const module = await clientFor(opts.rpcUrl).readContract({
    address: opts.factory,
    abi: AuthorFactory,
    functionName: 'recordsModule',
    args: [opts.safe],
  });
  return module === ZERO_ADDRESS ? null : getAddress(module.toLowerCase());
}

/** `getRecord(key)`; an absent record (a revert) reads as null, not an error. */
export async function readRecord(opts: {
  module: Address;
  key: string;
  rpcUrl: string;
}): Promise<string | null> {
  try {
    const value = await clientFor(opts.rpcUrl).readContract({
      address: opts.module,
      abi: S2SRecordsModuleV0_1,
      functionName: 'getRecord',
      args: [opts.key],
    });
    return value === '' ? null : value;
  } catch (err) {
    if (answersAbsent(err)) return null;
    throw err;
  }
}

export const defaultRecordsSeam: RecordsSeam = {
  readHasCode,
  recordsImplementation: readRecordsImplementation,
  recordsModuleAddress: readRecordsModuleAddress,
  recordsModule: readRecordsModule,
  record: readRecord,
};

// ===========================================================================
// Resolution
// ===========================================================================

/**
 * Factory → implementation → recorded module → predicted address. A read-only
 * resolution; a factory with no code, no records implementation or no address
 * for this Safe answers nulls, and the caller says why.
 */
export async function resolveRecords(
  opts: { safe: Address; rpcUrl: string; factory: Address },
  seam: RecordsSeam = defaultRecordsSeam,
): Promise<RecordsResolution> {
  const { factory } = opts;
  if (!(await seam.readHasCode({ address: factory, rpcUrl: opts.rpcUrl }))) {
    return { factory, deployed: false, implementation: null, address: null, recorded: null };
  }
  const implementation = await seam.recordsImplementation({
    factory,
    rpcUrl: opts.rpcUrl,
  });
  if (implementation === null) {
    return { factory, deployed: true, implementation: null, address: null, recorded: null };
  }
  const [address, recorded] = await Promise.all([
    seam.recordsModuleAddress({ factory, safe: opts.safe, rpcUrl: opts.rpcUrl }),
    seam.recordsModule({ factory, safe: opts.safe, rpcUrl: opts.rpcUrl }),
  ]);
  return { factory, deployed: true, implementation, address, recorded };
}

// ===========================================================================
// The Safe self-calls
// ===========================================================================

/** `createRecordsModule(safe)` — the Safe is the caller, the factory the target. */
export function createRecordsModuleCall(factory: Address, safe: Address): RecordsCall {
  return {
    to: factory,
    data: encodeFunctionData({
      abi: AuthorFactory,
      functionName: 'createRecordsModule',
      args: [safe],
    }),
  };
}

/** `enableModule(module)` — an enabled module is what a reader, or a gate, sees. */
export function enableRecordsCall(safe: Address, module: Address): RecordsCall {
  return {
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [module] }),
  };
}

/** `setRecord(key, value)` — `onlySafe`, so the Safe is the sender and the target. */
export function setRecordCall(module: Address, key: string, value: string): RecordsCall {
  return {
    to: module,
    data: encodeFunctionData({ abi: S2SRecordsModuleV0_1, functionName: 'setRecord', args: [key, value] }),
  };
}

// ===========================================================================
// Install
// ===========================================================================

export interface PlanRecordsOptions {
  safe: Address;
  rpcUrl: string;
  /**
   * The pet name to write as `pen_name`; absent or empty (after trimming)
   * means the write is skipped, in the plan and in the write alike.
   */
  penName?: string;
  /** True when this key is the Safe's only owner, so a self-call can be sent. */
  soleOwner: boolean;
}

/** The reads the plan and the write need: the caller's seam, narrowed. */
export interface RecordsReadDeps {
  resolve(opts: { safe: Address; rpcUrl: string }): Promise<RecordsResolution>;
  readRecord(opts: { module: Address; key: string; rpcUrl: string }): Promise<string | null>;
  /** The Safe's enabled-module list, in the Safe's order. */
  readEnabled(opts: { safe: Address; rpcUrl: string }): Promise<Address[]>;
  /** Whether an address carries bytecode — the read-back for a create. */
  readHasCode(opts: { address: Address; rpcUrl: string }): Promise<boolean>;
}

/** Everything the write needs, including the one userOp seam. */
export interface WriteRecordsDeps extends RecordsReadDeps {
  /** One userOp; its hash is the caller's to record. */
  send(to: Address, abi: string, method: string, args: unknown[]): Promise<void>;
  log(message: string): void;
}

export interface RecordsPlan {
  /**
   * The records module the factory names for this Safe — its recorded module,
   * else its CREATE2 prediction. Not proof that it exists: non-null for a
   * multisig whose owners have not proposed the create yet, and for a create
   * that reverted; null means the factory is not deployed, has no
   * implementation, or answers no address, in which case `note` says why.
   */
  records: Address | null;
  /** The factory the create/enable calls target, when the factory is deployed. */
  factory?: Address;
  /** One human line: the skip reason or the proposal reason, when there is one. */
  note?: string;
  /** When the Safe is a multisig: the calls its owners must propose, in order. */
  calls?: RecordsCall[];
  /** Sole owner: true when at least one of create / enable / pen_name is to do. */
  needed?: boolean;
  /**
   * True when `createRecordsModule` still has to run: nothing is recorded and
   * there is no code at the module address. The write reads this instead of
   * asking again.
   */
  create?: boolean;
}

/**
 * Why the factory cannot create anything: it carries no code. The drafts and
 * owner-history install is untouched.
 */
export function factoryNotDeployedNote(factory: Address): string {
  return `the author factory ${factory} has no code — the factory is not deployed; the drafts and owner-history install is unchanged`;
}

/**
 * Why the factory cannot create anything: its deployer has set no
 * implementation. Only that deployer can fix it, so the CLI names the ops step
 * rather than pretending it can repair this.
 */
export function recordsUnavailableNote(factory: Address): string {
  return `the author factory ${factory} has no records implementation set — run \`pnpm deploy:impl -- --kind records --factory ${factory}\`, then the factory deployer's \`setRecordsImplementation\`; the drafts and owner-history install is unchanged`;
}

function includesAddress(list: readonly Address[], address: Address): boolean {
  return list.some((entry) => entry.toLowerCase() === address.toLowerCase());
}

/**
 * The one definition of "there is a pet name to write": non-empty after
 * trimming. The plan and the writer both go through it, so a blank name is
 * neither proposed to a multisig's owners nor sent by a sole owner.
 */
function penNameToWrite(penName: string | undefined): string | undefined {
  if (penName === undefined) return undefined;
  const trimmed = penName.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Decide what the records module needs, without sending.
 *
 * The reads decide whether a write is `needed` at all, so a Safe that is fully
 * installed — records included — reports `already` and opens no bundler client.
 * A factory that is not deployed, or has no implementation set, is a note, not
 * a failure.
 */
export async function planRecords(
  opts: PlanRecordsOptions,
  deps: RecordsReadDeps,
): Promise<RecordsPlan> {
  let resolved: RecordsResolution;
  try {
    resolved = await deps.resolve({ safe: opts.safe, rpcUrl: opts.rpcUrl });
  } catch (err) {
    return {
      records: null,
      note: `the records module was not installed: ${describeError(err)}`,
    };
  }

  if (!resolved.deployed) {
    return {
      records: null,
      factory: resolved.factory,
      note: factoryNotDeployedNote(resolved.factory),
    };
  }
  if (resolved.implementation === null || resolved.address === null) {
    return { records: null, factory: resolved.factory, note: recordsUnavailableNote(resolved.factory) };
  }
  const module = resolved.address;
  const readOpts = { rpcUrl: opts.rpcUrl };

  const penName = penNameToWrite(opts.penName);
  const hasCode = await deps.readHasCode({ address: module, ...readOpts });
  const create = resolved.recorded === null && !hasCode;
  const enabled = hasCode
    ? includesAddress(await deps.readEnabled({ safe: opts.safe, ...readOpts }), module)
    : false;
  const currentPenName =
    hasCode && enabled && penName !== undefined
      ? await deps.readRecord({ module, key: PEN_NAME_KEY, ...readOpts })
      : null;
  const penNameWrite = penName !== undefined && currentPenName !== penName;

  // A Safe this key does not solely own cannot take a self-call: hand the
  // owners only the calls still to do, in order, and send nothing.
  if (!opts.soleOwner) {
    const calls: RecordsCall[] = [];
    const described: string[] = [];
    if (create) {
      calls.push(createRecordsModuleCall(resolved.factory, opts.safe));
      described.push('createRecordsModule');
    }
    if (!enabled) {
      calls.push(enableRecordsCall(opts.safe, module));
      described.push('enableModule');
    }
    if (penNameWrite) {
      calls.push(setRecordCall(module, PEN_NAME_KEY, penName!));
      described.push('the pen_name write');
    }
    if (calls.length === 0) {
      return { records: module, factory: resolved.factory, create: false, needed: false };
    }
    return {
      records: module,
      factory: resolved.factory,
      create,
      calls,
      needed: true,
      // The caller appends this to its own "propose the Safe transactions"
      // sentence, so this names only what is still pending.
      note: `the records module is pending owner signatures: ${described.join(', ')}`,
    };
  }

  return {
    records: module,
    factory: resolved.factory,
    create,
    needed: create || !enabled || penNameWrite,
  };
}

/**
 * Install the records module on a Safe and write `pen_name`, in order: create
 * when the factory has recorded nothing and the module has no code, enable when
 * the Safe's own list does not carry it, prove with a re-read, then write the
 * pet name and read it back.
 *
 * Every failure is a `note` on the non-null `records` — never a throw, because
 * the caller has already installed the drafts and owner-history modules and must
 * not lose that state.
 */
export async function writeRecords(
  opts: {
    safe: Address;
    factory: Address;
    module: Address;
    rpcUrl: string;
    penName?: string;
    /** From the plan: nothing is recorded and no code exists at `module`. */
    create?: boolean;
  },
  deps: WriteRecordsDeps,
): Promise<{ sent: boolean; note?: string }> {
  const readOpts = { rpcUrl: opts.rpcUrl };
  const penName = penNameToWrite(opts.penName);
  let sent = false;

  // Proof of deployment is code at the module address, never the hash of a
  // userOp that may have reverted. `create` (from the plan) also rules out the
  // pointless second call: `createRecordsModule` is idempotent, but a factory
  // that already recorded the module has nothing to deploy.
  const create =
    opts.create ?? !(await deps.readHasCode({ address: opts.module, ...readOpts }));
  if (create) {
    deps.log(`creating the records module for ${opts.safe}…`);
    await deps.send(opts.factory, JSON.stringify(AuthorFactory), 'createRecordsModule', [
      opts.safe,
    ]);
    sent = true;
    if (!(await deps.readHasCode({ address: opts.module, ...readOpts }))) {
      return {
        sent,
        note: `the createRecordsModule transaction did not deploy ${opts.module} — it may have reverted; run again`,
      };
    }
  }

  let enabled = await deps.readEnabled({ safe: opts.safe, ...readOpts });
  if (!includesAddress(enabled, opts.module)) {
    deps.log(`enabling the records module ${opts.module} on ${opts.safe}…`);
    await deps.send(opts.safe, JSON.stringify(safeAbi), 'enableModule', [opts.module]);
    sent = true;
    enabled = await deps.readEnabled({ safe: opts.safe, ...readOpts });
    if (!includesAddress(enabled, opts.module)) {
      return {
        sent,
        note: `the enableModule transaction did not enable ${opts.module} on the Safe — it may have reverted; run again`,
      };
    }
  }

  if (penName !== undefined) {
    const current = await deps.readRecord({ module: opts.module, key: PEN_NAME_KEY, ...readOpts });
    if (current !== penName) {
      deps.log(`writing pen_name on the records module ${opts.module}…`);
      await deps.send(opts.module, JSON.stringify(S2SRecordsModuleV0_1), 'setRecord', [
        PEN_NAME_KEY,
        penName,
      ]);
      sent = true;
      const after = await deps.readRecord({
        module: opts.module,
        key: PEN_NAME_KEY,
        ...readOpts,
      });
      if (after !== penName) {
        return {
          sent,
          note: `the setRecord transaction did not write pen_name on ${opts.module} — it may have reverted; run again`,
        };
      }
    }
  }

  return { sent };
}
