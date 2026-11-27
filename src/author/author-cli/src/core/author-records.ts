// ============================================================================
// The protocol's generic records module, per author Safe.
//
// One module kind, `S2S_MODULE_KIND_RECORDS`, and one module per (Safe, kind):
// a proxy the module factory deploys from an approved implementation. Its
// contents are plain string-to-string records — no CID, no JSON document, no
// IPFS. The author writes two of them:
//
//   pen_name   the author's pet name, so a reader can name the author without
//              the store (`s2s author new` / `s2s author init` write it)
//   bio        a short public biography (`s2s author bio` reads, sets, clears)
//
// Where the addresses come from, and in what order:
//
//   1. the protocol manifest (`getManifest`), whose `moduleFactory` is the
//      factory this kind is deployed from. This is the bootstrap read: it needs
//      no publication, no ENS name and no records module of its own.
//   2. `latestImplementation(kind)` — the implementation the factory has been
//      told to use. Zero means the kind is not deployable at all: only the
//      protocol Safe's `setImplementation` for that kind can change that, and
//      `createModule` would revert `NoImplementation(kind)`.
//   3. `moduleAddress(safe, kind)` — a CREATE2 prediction. It answers whether or
//      not the proxy exists, so it is what a `createModule` is aimed at and what
//      an `enableModule`/`setRecord` would name. It is NOT proof: the proof that
//      a module is installed is code at the address, and the proof that a Safe
//      carries it is the Safe's own enabled-module list.
//
// `createModule(safe, kind, params)` is callable only by the Safe itself or by
// the protocol Safe, so it goes out as a Safe self-call: the runner is bound to
// the Safe, which makes the Safe `msg.sender`. It is idempotent — a second call
// answers the module that already exists — so the read before it only avoids a
// pointless userOp; the read after it is the proof that it landed.
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
import {
  S2SPublicationModulesFactoryV0_1,
  S2SRecordsModuleV0_1,
} from '@s2s/publication-contracts';
import {
  getManifest,
  S2S_MODULE_KIND_RECORDS,
  type ViemProvider,
} from '@s2s/soul2soul-shared/protocol';
import { safeAbi } from '@s2s/soul2soul-shared';

import { describeError } from '../lib/errors';

/** The kind every records module is deployed as (`keccak256("s2s.module.records")`). */
export const RECORDS_KIND: Hex = S2S_MODULE_KIND_RECORDS as Hex;

/** The record holding the author's pet name. */
export const PEN_NAME_KEY = 'pen_name';

/** The record holding the author's public biography. */
export const BIO_KEY = 'bio';

/** A bio longer than this is refused before anything is encoded or sent. */
export const BIO_MAX_LENGTH = 1024;

/** The zero address: "no implementation for this kind", "no prediction". */
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** A Safe self-call the owners of a multisig must propose. */
export interface RecordsCall {
  to: Address;
  data: Hex;
}

/** What the factory says about this kind, for one Safe. */
export interface RecordsResolution {
  /** The protocol module factory the manifest names. */
  factory: Address;
  kind: Hex;
  /** `latestImplementation(kind)`; null for the zero address (kind not deployable). */
  implementation: Address | null;
  /** `moduleAddress(safe, kind)`; null for zero (this factory predicts none). */
  address: Address | null;
}

/**
 * The reads and writes to the outside world. The install and the bio command
 * take the seam they are given (`AuthorContractsSeam` extends this), so neither
 * has a second runner or a second client.
 */
export interface RecordsSeam {
  /** The protocol manifest's `moduleFactory` — the bootstrap read. */
  modulesFactory(opts: { rpcUrl: string }): Promise<Address>;
  /** `latestImplementation(kind)`, null for the zero address. */
  latestImplementation(opts: {
    factory: Address;
    kind: Hex;
    rpcUrl: string;
  }): Promise<Address | null>;
  /** `moduleAddress(safe, kind)`, null for the zero address. */
  moduleAddress(opts: {
    factory: Address;
    safe: Address;
    kind: Hex;
    rpcUrl: string;
  }): Promise<Address | null>;
  /** `getRecord(key)`, null when absent (`KeyNotFound`) or empty. */
  record(opts: { module: Address; key: string; rpcUrl: string }): Promise<string | null>;
}

/** A public client per read: a client is cheap, a cached one is stale chain state. */
function clientFor(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
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

/** `latestImplementation(kind)`; the zero address is reported as null. */
export async function readLatestImplementation(opts: {
  factory: Address;
  kind: Hex;
  rpcUrl: string;
}): Promise<Address | null> {
  const implementation = await clientFor(opts.rpcUrl).readContract({
    address: opts.factory,
    abi: S2SPublicationModulesFactoryV0_1,
    functionName: 'latestImplementation',
    args: [opts.kind],
  });
  return implementation === ZERO_ADDRESS ? null : getAddress(implementation.toLowerCase());
}

/** `moduleAddress(safe, kind)`; the zero address is reported as null. */
export async function readModuleAddress(opts: {
  factory: Address;
  safe: Address;
  kind: Hex;
  rpcUrl: string;
}): Promise<Address | null> {
  const module = await clientFor(opts.rpcUrl).readContract({
    address: opts.factory,
    abi: S2SPublicationModulesFactoryV0_1,
    functionName: 'moduleAddress',
    args: [opts.safe, opts.kind],
  });
  return module === ZERO_ADDRESS ? null : getAddress(module.toLowerCase());
}

/**
 * The manifest's module factory, read over the configured L2. A read, not a
 * write: `getManifest` is a view call on the manifest module, whose address is
 * a protocol constant, so no publication and no ENS name take part.
 */
export async function readModulesFactory(rpcUrl: string): Promise<Address> {
  const client = clientFor(rpcUrl);
  const manifest = await getManifest(client as unknown as ViemProvider, client as unknown as ViemProvider);
  return getAddress(manifest.moduleFactory.toLowerCase());
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
  modulesFactory: ({ rpcUrl }) => readModulesFactory(rpcUrl),
  latestImplementation: readLatestImplementation,
  moduleAddress: readModuleAddress,
  record: readRecord,
};

/**
 * Manifest → factory → implementation → predicted address. A read-only
 * resolution; a factory with no implementation for the kind answers a null
 * address and a null implementation, and the caller says why.
 */
export async function resolveRecords(
  opts: { safe: Address; rpcUrl: string },
  seam: RecordsSeam = defaultRecordsSeam,
): Promise<RecordsResolution> {
  const factory = await seam.modulesFactory({ rpcUrl: opts.rpcUrl });
  const implementation = await seam.latestImplementation({
    factory,
    kind: RECORDS_KIND,
    rpcUrl: opts.rpcUrl,
  });
  if (implementation === null) {
    return { factory, kind: RECORDS_KIND, implementation: null, address: null };
  }
  const address = await seam.moduleAddress({
    factory,
    safe: opts.safe,
    kind: RECORDS_KIND,
    rpcUrl: opts.rpcUrl,
  });
  return { factory, kind: RECORDS_KIND, implementation, address };
}

// ===========================================================================
// The Safe self-calls
// ===========================================================================

/** `createModule(safe, kind, params)` — the Safe is the caller, the factory the target. */
export function createModuleCall(factory: Address, safe: Address): RecordsCall {
  return {
    to: factory,
    data: encodeFunctionData({
      abi: S2SPublicationModulesFactoryV0_1,
      functionName: 'createModule',
      args: [safe, RECORDS_KIND, '0x'],
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
   * The records module the factory PREDICTS for this Safe, not proof that it
   * exists. Non-null for a multisig whose owners have not proposed the create
   * yet, and for a create that reverted; null means the factory answers no
   * prediction (no implementation, an unreadable manifest, or a resolve error),
   * in which case `note` says why.
   */
  records: Address | null;
  /** The factory the create/enable calls target, when the manifest answered. */
  factory?: Address;
  /** One human line: the skip reason or the proposal reason, when there is one. */
  note?: string;
  /** When the Safe is a multisig: the calls its owners must propose, in order. */
  calls?: RecordsCall[];
  /** Sole owner: true when at least one of create / enable / pen_name is to do. */
  needed?: boolean;
}

/**
 * The two ops steps that make the records kind deployable. Only the protocol
 * Safe can approve an implementation, so the CLI names both steps rather than
 * pretending it can repair this.
 */
export function recordsUnavailableNote(factory: Address): string {
  return `the module factory ${factory} has no approved implementation for the records kind (${RECORDS_KIND}) — run \`pnpm deploy:impl -- --kind records\`, then the protocol Safe's \`setImplementation\` for that kind; only the protocol Safe can approve it`;
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
 * A factory with no implementation for the kind is a note, not a failure.
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

  if (resolved.implementation === null || resolved.address === null) {
    return { records: null, factory: resolved.factory, note: recordsUnavailableNote(resolved.factory) };
  }
  const module = resolved.address;
  const readOpts = { rpcUrl: opts.rpcUrl };

  const penName = penNameToWrite(opts.penName);
  const hasCode = await deps.readHasCode({ address: module, ...readOpts });
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
    if (!hasCode) {
      calls.push(createModuleCall(resolved.factory, opts.safe));
      described.push('createModule');
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
      return { records: module, factory: resolved.factory, needed: false };
    }
    return {
      records: module,
      factory: resolved.factory,
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
    needed: !hasCode || !enabled || penNameWrite,
  };
}

/**
 * Install the records module on a Safe and write `pen_name`, in order: create
 * (aimed at the prediction), prove with code, enable when the Safe's own list
 * does not carry it, prove with a re-read, then write the pet name and read it
 * back.
 *
 * Every failure is a `note` on the non-null `records` — never a throw, because
 * the caller has already installed the drafts and owner-history modules and must
 * not lose that state.
 */
export async function writeRecords(
  opts: { safe: Address; factory: Address; module: Address; rpcUrl: string; penName?: string },
  deps: WriteRecordsDeps,
): Promise<{ sent: boolean; note?: string }> {
  const readOpts = { rpcUrl: opts.rpcUrl };
  const penName = penNameToWrite(opts.penName);
  let sent = false;

  // Proof of deployment is code at the predicted address, never the hash of a
  // userOp that may have reverted.
  if (!(await deps.readHasCode({ address: opts.module, ...readOpts }))) {
    deps.log(`creating the records module for ${opts.safe}…`);
    await deps.send(opts.factory, JSON.stringify(S2SPublicationModulesFactoryV0_1), 'createModule', [
      opts.safe,
      RECORDS_KIND,
      '0x',
    ]);
    sent = true;
    if (!(await deps.readHasCode({ address: opts.module, ...readOpts }))) {
      return {
        sent,
        note: `the createModule transaction did not deploy ${opts.module} — it may have reverted; run again`,
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
