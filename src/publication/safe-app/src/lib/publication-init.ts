// safe-app/src/lib/publication-init.ts
//
// "New publication init" flow for safe-app (SPEC-author-hosts.md AD-3): make THIS
// existing Safe a publication by installing the two modules (records +
// publication) and recording the publication name.
//
// This module is PURE orchestration + encoding. It deliberately does not
// import safe-integration.ts, @safe-global/safe-apps-sdk, the browser global, or the
// rest of the shared package. All runtime dependencies are injected (duck-typed)
// so the module can run in any host (browser iframe, node test) without building
// a provider or SDK. Encoding is done directly with ethers v6 (the same module
// main.ts exposes as the page global).
//
// ONE FACTORY. `S2SPublicationModulesFactoryV0_1` deploys a module of a kind for a
// Safe at an address that is a function of (factory, safe, kind) and nothing
// else:
//
//   createModule(safe, kind, params)   deploys, or returns the module already
//                                      recorded for that pair (idempotent)
//   moduleAddress(safe, kind)          the module, or where a create lands
//   recordOf(module)                   which Safe, which kind — zero if foreign
//
// So there is a single address formula to read, it is stable across
// `setImplementation`, and a create that was already made cannot be made twice.
// `params` is the module's own initializer encoding:
//
//   publication kind   abi.encode(address[] authors, address[] devs)
//   records kind       abi.encode(string[] keys, string[] values)
//
// FLOW (two Safe proposals, NOT one — a human executes each):
//   batch1 = createModule(safe, records, params) + createModule(safe, publication, params)
//   read   = moduleAddress(safe, kind) for both kinds, polled until each has code
//   batch2 = enableModule(both) + records.setRecord("name", name)
//            + records.setRecord("manifest_version", "0.1.0")        (MultiSend)
//
// Every publication is pinned to a manifest document at creation. The version is
// three digits, `0.1.0`, and it names the document the protocol published when
// this publication was made; the records module holds it under
// `manifest_version` like every other configuration value the publication has.
// A publication that cannot name its document cannot be read, so the pin is part
// of the flow rather than something added later.
//
// The inverse (buildDeletePublicationBatch) is a teardown for starting over:
// disable both modules on the Safe + records.deleteRecord("name"). It never
// creates or destroys contracts, so the modules stay deployed and disabled.

import { AbiCoder, Interface, getAddress } from 'ethers';
import type { InterfaceAbi } from 'ethers';
import { Abi_S2SPublicationModulesFactoryV0_1 } from '@s2s/publication-contracts/abis/S2SPublicationModulesFactoryV0_1';
import {
  S2S_MODULE_KIND_PUBLICATION,
  S2S_MODULE_KIND_RECORDS,
} from '@s2s/soul2soul-shared/safe-app';

/**
 * The manifest document this build creates publications against: `x.y.z`, three
 * digits. Contracts carry a major and minor (`0.1` in `VERSION()`); a document
 * is the full version, because the third digit moves whenever a CID or an
 * address inside it moves.
 */
export const MANIFEST_VERSION = '0.1.0';

/** The record key a publication's records module holds its manifest version under. */
export const MANIFEST_VERSION_KEY = 'manifest_version';

// ---------------------------------------------------------------------------
// Types (exported contract — later workers code against these NAMES).
// ---------------------------------------------------------------------------

/** One Safe transaction in the shape the SafeAppsSDK `txs.send` accepts. */
export type MetaTransactionData = {
  to: string;
  value: string;
  data: string;
};

/** The one factory every module of every kind is created through. */
export type ProtocolInfo = {
  moduleFactory: string;
};

/** One `(key, value)` pair for a new records module's initializer. */
export type RecordsEntry = {
  key: string;
  value: string;
};

/**
 * A view read on a contract, in whatever shape the host has for one. The ABI is
 * passed in rather than closed over, so this module owns the selectors and the
 * host only owns the transport.
 */
export type FactoryRead = (
  factory: string,
  abi: InterfaceAbi,
  method: string,
  args: unknown[],
) => Promise<unknown>;

/** Does `address` have code on the Safe's chain? Proof that a create executed. */
export type HasCode = (address: string) => Promise<boolean>;

export type InitializePublicationDeps = {
  chainId: number;
  safeAddress: string;
  protocolInfo: ProtocolInfo;
  propose: (txs: MetaTransactionData[]) => Promise<string>;
  /** `moduleAddress` / `recordOf` reads on the factory, through the host. */
  read: FactoryRead;
  hasCode: HasCode;
  isModuleEnabled: (module: string) => Promise<boolean>;
  now?: () => number;
};

export type InitializePublicationOpts = {
  authors?: string[];
  devs?: string[];
  name?: string;
  /** Git repo URL recorded alongside the name (used by the config build). */
  repo?: string;
  /** Git branch recorded alongside the name (defaults to 'main' at build time). */
  branch?: string;
  safeUrl?: (chainId: number, safeAddress: string) => string;
  /** How long to wait for the human to execute the enable batch (default 10 min). */
  enableTimeoutMs?: number;
  /** Poll interval while waiting for the enable batch to be executed (default 2s). */
  enablePollIntervalMs?: number;
};

export interface ModuleAddressDeps {
  read: FactoryRead;
}

export interface WaitForModuleAddressDeps extends ModuleAddressDeps {
  hasCode: HasCode;
  now?: () => number;
}

export interface WaitForModuleAddressOpts {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface WaitForModulesEnabledDeps extends WaitForModuleAddressDeps {
  factory: string;
  safeAddress: string;
  isModuleEnabled: (module: string) => Promise<boolean>;
}

export interface WaitForModulesEnabledOpts {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type InitResult = {
  recordsModule: string;
  publicationModule: string;
  nameRecorded: boolean;
  /** The manifest version the records module now answers, or should once the batch executes. */
  manifestVersion: string;
  proposals: string[];
};

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ENABLE_TIMEOUT_MS = 600_000; // 10 min — a human must execute the batch in the Safe app
const DEFAULT_ENABLE_POLL_INTERVAL_MS = 2_000;

/** Safe sentinel module address — prevModule of the first module in the linked list. */
const SENTINEL_MODULES = '0x0000000000000000000000000000000000000001';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const factoryInterface = new Interface(Abi_S2SPublicationModulesFactoryV0_1);
const safeInterface = new Interface([
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
]);
const recordsModuleInterface = new Interface([
  'function setRecord(string key, string value)',
  'function deleteRecord(string key)',
]);

const coder = AbiCoder.defaultAbiCoder();

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A plausible, non-zero address (the factory answers address(0) for nothing). */
function isModuleAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(value) &&
    value.toLowerCase() !== ZERO_ADDRESS
  );
}

// ---------------------------------------------------------------------------
// Encoders (exported for unit testing; selectors are derived from the ABIs,
// never hardcoded).
// ---------------------------------------------------------------------------

/** Safe enableModule(address module) → data for a Safe self-call. */
export function encodeEnableModule(module: string): string {
  return safeInterface.encodeFunctionData('enableModule', [module]);
}

/** Safe disableModule(address prevModule, address module) → data (Safe self-call). */
export function encodeDisableModule(prevModule: string, module: string): string {
  return safeInterface.encodeFunctionData('disableModule', [prevModule, module]);
}

/** recordsModule.setRecord(string key, string value) → data. */
export function encodeSetRecord(key: string, value: string): string {
  return recordsModuleInterface.encodeFunctionData('setRecord', [key, value]);
}

/** recordsModule.deleteRecord(string key) → data. */
export function encodeDeleteRecord(key: string): string {
  return recordsModuleInterface.encodeFunctionData('deleteRecord', [key]);
}

/**
 * `createModule(safe, recordsKind, params)` where params is the records
 * initializer's own encoding, `abi.encode(string[] keys, string[] values)`.
 * Empty params (no entries) says "no records yet", which is what a publication
 * created from this form wants: the name arrives with the finalize batch.
 */
export function encodeCreateRecordsModule(
  safe: string,
  entries: readonly RecordsEntry[] = [],
): string {
  const keys = entries.map((entry) => entry.key);
  const values = entries.map((entry) => entry.value);
  if (keys.length !== values.length) {
    throw new Error('records entries must pair every key with a value');
  }
  const params = coder.encode(['string[]', 'string[]'], [keys, values]);
  return factoryInterface.encodeFunctionData('createModule', [
    safe,
    S2S_MODULE_KIND_RECORDS,
    params,
  ]);
}

/**
 * `createModule(safe, publicationKind, params)` where params is the publication
 * initializer's own encoding, `abi.encode(address[] authors, address[] devs)`.
 * The Safe is passed by the factory to `initialize`, never by the caller.
 */
export function encodeCreatePublicationModule(
  safe: string,
  authors: string[],
  devs: string[] = [],
): string {
  const params = coder.encode(['address[]', 'address[]'], [authors, devs]);
  return factoryInterface.encodeFunctionData('createModule', [
    safe,
    S2S_MODULE_KIND_PUBLICATION,
    params,
  ]);
}

// ---------------------------------------------------------------------------
// Factory reads.
// ---------------------------------------------------------------------------

/**
 * The factory has no module of that kind for this Safe: `moduleAddress` answered
 * address zero or something that is not an address. There is nothing to read and
 * nothing to create, so callers refuse instead of looking elsewhere.
 */
export class ModuleAddressRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleAddressRefusalError';
  }
}

/**
 * The module of `kind` this factory has for `safe`, or the address a create
 * would deploy at right now.
 *
 * One read, no fallback: `moduleAddress` is the factory's whole answer for
 * "which module is mine", and it is the same before and after a create (the
 * salt is `keccak256(abi.encode(kind, safe))` and the proxy's creation code is
 * constant). Address zero means the factory has no implementation set for the
 * kind, so no create could succeed; that is a refusal, not an empty answer.
 */
export async function moduleAddressFor(
  deps: ModuleAddressDeps,
  factory: string,
  safeAddress: string,
  kind: string,
): Promise<string> {
  const answer = await deps.read(factory, Abi_S2SPublicationModulesFactoryV0_1, 'moduleAddress', [
    safeAddress,
    kind,
  ]);
  if (!isModuleAddress(answer)) {
    throw new ModuleAddressRefusalError(
      `The module factory ${factory} names no ${kind} module for ${safeAddress} — it has no implementation set for that kind, so no create can succeed.`,
    );
  }
  return getAddress(answer);
}

/**
 * Poll `moduleAddress(safe, kind)` until the module at that address has code.
 *
 * The address is known before the create batch is proposed, so the address
 * alone proves nothing: the create is what puts code there. Polling the same
 * read before and after is the whole wait — there is no log to filter and no
 * lookback window to miss.
 */
export async function waitForModuleAddress(
  deps: WaitForModuleAddressDeps,
  factory: string,
  safeAddress: string,
  kind: string,
  opts: WaitForModuleAddressOpts = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const start = now();

  for (;;) {
    const address = await moduleAddressFor(deps, factory, safeAddress, kind);
    if (await deps.hasCode(address)) return address;
    if (now() - start > timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the ${kind} module at ${address}; the create proposal was not executed.`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Batch builders.
// ---------------------------------------------------------------------------

/**
 * Batch 1: create both modules through the one factory.
 *   [createModule(safe, records, params), createModule(safe, publication, params)]
 *
 * Idempotent per (safe, kind): a batch sent twice returns the module already
 * recorded instead of deploying a second one.
 */
export function buildCreateModuleBatch(
  protocolInfo: ProtocolInfo,
  safeAddress: string,
  authors: string[],
  devs: string[] = [],
): MetaTransactionData[] {
  return [
    {
      to: protocolInfo.moduleFactory,
      value: '0',
      data: encodeCreateRecordsModule(safeAddress),
    },
    {
      to: protocolInfo.moduleFactory,
      value: '0',
      data: encodeCreatePublicationModule(safeAddress, authors, devs),
    },
  ];
}

/**
 * Batch 2: enable both modules on the Safe (onlySelf — the Safe self-calls
 * enableModule). [enableModule(records), enableModule(publication)].
 */
export function buildEnableModuleBatch(
  safeAddress: string,
  recordsModule: string,
  publicationModule: string,
): MetaTransactionData[] {
  return [
    { to: safeAddress, value: '0', data: encodeEnableModule(recordsModule) },
    { to: safeAddress, value: '0', data: encodeEnableModule(publicationModule) },
  ];
}

/** `recordsModule.getRecord(string key)` → the read the pin is checked with. */
export const RECORDS_GET_RECORD_ABI: InterfaceAbi = [
  'function getRecord(string key) view returns (string value)',
];

/**
 * Batch: pin the publication to the manifest document it was created against.
 * `[records.setRecord("manifest_version", MANIFEST_VERSION)]`.
 */
export function buildManifestVersionBatch(recordsModule: string): MetaTransactionData[] {
  return [
    {
      to: recordsModule,
      value: '0',
      data: encodeSetRecord(MANIFEST_VERSION_KEY, MANIFEST_VERSION),
    },
  ];
}

/**
 * Batch 3 (optional): record the publication identity.
 * [records.setRecord("name", name), records.setRecord("repo", repo),
 *  records.setRecord("branch", branch)] — repo/branch are only included when
 * supplied, so the batch stays a single setRecord for existing callers.
 */
export function buildNameRecordBatch(
  recordsModule: string,
  name: string,
  extra?: { repo?: string; branch?: string },
): MetaTransactionData[] {
  const batch: MetaTransactionData[] = [
    { to: recordsModule, value: '0', data: encodeSetRecord('name', name) },
  ];
  if (extra?.repo) {
    batch.push({ to: recordsModule, value: '0', data: encodeSetRecord('repo', extra.repo) });
  }
  if (extra?.branch) {
    batch.push({ to: recordsModule, value: '0', data: encodeSetRecord('branch', extra.branch) });
  }
  return batch;
}

/**
 * Batch 2 (MERGED — the direct sequence, PR #158): enable BOTH modules AND
 * record the publication identity in ONE atomic MultiSend proposal:
 *   [enableModule(records), enableModule(publication),
 *    records.setRecord("name", name),
 *    records.setRecord("repo", repo)?, records.setRecord("branch", branch)?]
 *
 * setRecord is onlySafe on the records module and does not require the module
 * to be enabled on the Safe (that is exactly what this batch does), and every
 * operand targets the Safe's own chain — so there is no reason to split enable
 * and name into two round-trips. Merging them makes the direct happy path two
 * Safe executions total (create → finalize).
 */
export function buildFinalizeBatch(
  safeAddress: string,
  recordsModule: string,
  publicationModule: string,
  name: string | undefined,
  extra?: { repo?: string; branch?: string },
  opts?: { pin?: boolean },
): MetaTransactionData[] {
  const recordBatch: MetaTransactionData[] = [
    ...(name ? buildNameRecordBatch(recordsModule, name, extra) : []),
    ...((opts?.pin ?? true) ? buildManifestVersionBatch(recordsModule) : []),
  ];
  return [...buildEnableModuleBatch(safeAddress, recordsModule, publicationModule), ...recordBatch];
}

/**
 * Teardown batch — the inverse of init, for starting a new publication:
 *   [disableModule(prev, laterModule), disableModule(prev, earlierModule), records.deleteRecord("name")]
 *
 * Only DISABLES — it never creates or destroys contracts. A module of a kind is
 * one address for good, so re-initialising the same Safe re-enables the same
 * modules (and cannot change their authors): tearing down removes them from the
 * Safe and drops the name record; the deployments stay as harmless leftovers.
 *
 * Safe's disableModule(prevModule, module) needs the PREVIOUS module in the
 * Safe's linked list. `safeModules` is the Safe's current enabled-module list
 * (as returned by Safe.getModules(), in list order). Modules are disabled in
 * DESCENDING list order so each module's prev (taken from the original list)
 * is still present when its disable executes. `deleteRecord("name")` is only
 * included when a records module address is supplied AND `opts.deleteName` is
 * not false.
 *
 * The batch is a single atomic MultiSend tx — if ANY operation reverts the
 * whole thing fails to estimate (Safe UI GS013). The records module's
 * deleteRecord reverts with KeyNotFound() when the key was never written, so callers must
 * gate `deleteName` on the name record actually existing on-chain (defaults to
 * true to preserve the full-teardown intent for callers that cannot know).
 */
export function buildDeletePublicationBatch(
  safeAddress: string,
  modules: { recordsModule: string; publicationModule: string },
  safeModules: string[],
  opts: { deleteName?: boolean } = {},
): MetaTransactionData[] {
  const indexOf = new Map<string, number>();
  safeModules.forEach((m, i) => indexOf.set(m.toLowerCase(), i));

  const toDisable: { module: string; index: number }[] = [];
  for (const addr of [modules.recordsModule, modules.publicationModule]) {
    if (!addr) continue;
    const index = indexOf.get(addr.toLowerCase());
    if (index !== undefined) toDisable.push({ module: addr, index });
  }
  if (toDisable.length === 0) {
    throw new Error('No enabled S2S modules to reset');
  }

  // Disable the later list entries first so their prev (from the original
  // list) is still present when the earlier disable runs.
  toDisable.sort((a, b) => b.index - a.index);

  const txs: MetaTransactionData[] = toDisable.map(({ module, index }) => ({
    to: safeAddress,
    value: '0',
    data: encodeDisableModule(index > 0 ? safeModules[index - 1] : SENTINEL_MODULES, module),
  }));

  if (modules.recordsModule && (opts.deleteName ?? true)) {
    txs.push({ to: modules.recordsModule, value: '0', data: encodeDeleteRecord('name') });
  }

  return txs;
}

// ---------------------------------------------------------------------------
// Enable-wait (human-in-the-loop bridge).
// ---------------------------------------------------------------------------

/**
 * Wait until BOTH modules exist AND are enabled on the Safe. This is the bridge
 * between proposing the merged enable batch and everything that follows: a
 * human must open the Safe app and EXECUTE the pending proposal before the
 * modules are live, so verification must not run until then.
 *
 * The addresses come from `moduleAddress`, polled until each has code; the
 * enable state is read from the Safe itself. Default timeout 10 min; a human in
 * the Safe UI typically takes seconds.
 */
export async function waitForModulesEnabled(
  deps: WaitForModulesEnabledDeps,
  opts: WaitForModulesEnabledOpts = {},
): Promise<{ recordsModule: string; publicationModule: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ENABLE_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_ENABLE_POLL_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const start = now();

  const recordsModule = await waitForModuleAddress(
    deps,
    deps.factory,
    deps.safeAddress,
    S2S_MODULE_KIND_RECORDS,
    { timeoutMs, pollIntervalMs },
  );
  const publicationModule = await waitForModuleAddress(
    deps,
    deps.factory,
    deps.safeAddress,
    S2S_MODULE_KIND_PUBLICATION,
    { timeoutMs, pollIntervalMs },
  );

  for (;;) {
    const [recordsEnabled, publicationEnabled] = await Promise.all([
      deps.isModuleEnabled(recordsModule),
      deps.isModuleEnabled(publicationModule),
    ]);
    if (recordsEnabled && publicationEnabled) return { recordsModule, publicationModule };

    if (now() - start > timeoutMs) {
      const missing: string[] = [];
      if (!recordsEnabled) missing.push('records');
      if (!publicationEnabled) missing.push('publication');
      throw new Error(
        `Timed out waiting for the enable proposal to be executed; not enabled: ${missing.join(', ')}`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export function defaultSafeUrl(chainId: number, safeAddress: string): string {
  return `https://app.safe.global/transactions/queue?safe=${chainId}:${safeAddress}`;
}

/**
 * Orchestrate the full "new publication init" flow as a sequence of Safe
 * proposals (never direct sends):
 *   1. read `moduleAddress(safe, kind)` for both kinds,
 *   2. propose the create batch when either module is not deployed yet,
 *   3. poll `moduleAddress` until both modules have code,
 *   4. propose the merged enable+name batch (buildFinalizeBatch),
 *   5. wait for a human to EXECUTE the merged batch (waitForModulesEnabled).
 *
 * `proposals` is ordered and has length 2 for a fresh Safe, 1 when the modules
 * already exist, 0 when there is nothing left to propose. A fully live
 * publication returns without proposing anything.
 */
export async function initializePublication(
  deps: InitializePublicationDeps,
  opts: InitializePublicationOpts = {},
): Promise<InitResult> {
  const factory = deps.protocolInfo.moduleFactory;
  const authors = opts.authors ?? [];
  const devs = opts.devs ?? [];
  const name = opts.name;
  const proposals: string[] = [];

  // The addresses are known before anything is proposed: the factory derives
  // them from (factory, safe, kind). Code at each is what proves the create ran.
  const [recordsAddress, publicationAddress] = await Promise.all([
    moduleAddressFor(deps, factory, deps.safeAddress, S2S_MODULE_KIND_RECORDS),
    moduleAddressFor(deps, factory, deps.safeAddress, S2S_MODULE_KIND_PUBLICATION),
  ]);
  const [recordsExists, publicationExists] = await Promise.all([
    deps.hasCode(recordsAddress),
    deps.hasCode(publicationAddress),
  ]);

  if (!recordsExists || !publicationExists) {
    const createBatch = buildCreateModuleBatch(deps.protocolInfo, deps.safeAddress, authors, devs);
    proposals.push(await deps.propose(createBatch));
  }

  const recordsModule = await waitForModuleAddress(
    deps,
    factory,
    deps.safeAddress,
    S2S_MODULE_KIND_RECORDS,
  );
  const publicationModule = await waitForModuleAddress(
    deps,
    factory,
    deps.safeAddress,
    S2S_MODULE_KIND_PUBLICATION,
  );

  // One proposal: enable what is not enabled, and record the identity when a
  // name was given. Enable is not idempotent on the Safe (GS102), so an
  // already-enabled module is left out instead of re-sent.
  const hasName = name !== undefined && name !== '';
  const [recordsEnabled, publicationEnabled] = await Promise.all([
    deps.isModuleEnabled(recordsModule),
    deps.isModuleEnabled(publicationModule),
  ]);

  // The manifest version is written once, at creation, and re-reading it is what
  // makes a second run idempotent: a publication that already names a document
  // gets no pin transaction.
  const pinned = (await deps.read(
    recordsModule,
    RECORDS_GET_RECORD_ABI,
    'getRecord',
    [MANIFEST_VERSION_KEY],
  )) as string | undefined;
  // Written when absent and never overwritten: a publication already pinned to
  // another document keeps it, because moving a publication onto a newer
  // manifest is a decision its own Safe makes, not a side effect of a re-run.
  const needsPin = pinned === undefined || pinned === '';

  const recordBatch: MetaTransactionData[] = [
    ...(hasName ? buildNameRecordBatch(recordsModule, name!, { repo: opts.repo, branch: opts.branch }) : []),
    ...(needsPin ? buildManifestVersionBatch(recordsModule) : []),
  ];
  const finalizeBatch: MetaTransactionData[] =
    recordsEnabled && publicationEnabled
      ? recordBatch
      : [
          ...buildEnableModuleBatch(deps.safeAddress, recordsModule, publicationModule),
          ...recordBatch,
        ];
  if (finalizeBatch.length) proposals.push(await deps.propose(finalizeBatch));

  // Wait for the human to execute the batch in the Safe queue.
  await waitForModulesEnabled(
    {
      read: deps.read,
      hasCode: deps.hasCode,
      factory,
      safeAddress: deps.safeAddress,
      isModuleEnabled: deps.isModuleEnabled,
      now: deps.now,
    },
    { timeoutMs: opts.enableTimeoutMs, pollIntervalMs: opts.enablePollIntervalMs },
  );

  return {
    recordsModule,
    publicationModule,
    nameRecorded: hasName,
    manifestVersion: MANIFEST_VERSION,
    proposals,
  };
}
