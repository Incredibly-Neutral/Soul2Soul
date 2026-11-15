// safe-app/src/lib/publication-init.ts
//
// "New publication init" flow for safe-app (SPEC-author-hosts.md AD-3): make THIS
// existing Safe a publication by installing the two modules (records +
// publication) and recording the publication name.
//
// This module is PURE orchestration + encoding. It deliberately does not
// import safe-integration.ts, @safe-global/safe-apps-sdk, the browser global, or the
// shared package. All runtime dependencies are injected (duck-typed) so the
// module can run in any host (browser iframe, node test) without building a
// provider or SDK. Encoding is done directly with ethers v6 (the same module
// main.ts exposes as the page global).
//
// FLOW (two Safe proposals, NOT one):
//   A CREATE2 publication factory answers `moduleAddress(safe)` — the exact
//   address its next `createModule(safe, …)` deploys under the latest
//   implementation. Where it does, the address is known BEFORE the create
//   batch is proposed and the enable step needs no log read; where it does not
//   (a plain-CREATE factory, which is every V2-era deployment), the address is
//   unknowable in advance and is read back from the ModuleCreated log. Safe
//   enableModule is onlySelf (the Safe must self-call) and does NOT check that
//   the target has code, so a predicted address that is not confirmed by code
//   is never enabled. Therefore:
//     batch1 = create both modules (records + publication)
//     detect  = predicted address if it has code, else the ModuleCreated logs
//     batch2 = enable both modules
//     batch3 = (optional) records.setRecord("name", name)
//
// The inverse (buildDeletePublicationBatch) is a teardown for starting over:
// disable both modules on the Safe + records.deleteRecord("name"). It never
// creates or destroys contracts, so the modules stay deployed and disabled.
// The NEXT init run therefore does not start from nothing: a CREATE2
// publication factory answers `moduleAddress(safe)` with the very module it
// already made for this Safe, re-enables it and cannot change its authors or
// devs, while the records factory is still non-idempotent and deploys a second
// records module. A publication that wants different authors needs a Safe of
// its own.

import { Interface, getAddress } from 'ethers';
import type { InterfaceAbi } from 'ethers';
import { Abi_S2SRecordsModuleFactory } from '@s2s/publication-contracts/abis/S2SRecordsModuleFactory';
import { Abi_S2SPublicationModuleV2Factory } from '@s2s/publication-contracts/abis/S2SPublicationModuleV2Factory';

// ---------------------------------------------------------------------------
// Types (exported contract — later workers code against these NAMES).
// ---------------------------------------------------------------------------

/** One Safe transaction in the shape the SafeAppsSDK `txs.send` accepts. */
export type MetaTransactionData = {
  to: string;
  value: string;
  data: string;
};

export type ProtocolInfo = {
  recordsFactory: string;
  publicationFactory: string;
};

export type FetchModuleCreatedLogs = (
  factoryAddress: string,
  safeAddress: string,
  topic0: string,
  fromBlock: number,
) => Promise<Array<{ topics: string[] }>>;

export type DetectModuleAddressesDeps = {
  fetchModuleCreatedLogs: FetchModuleCreatedLogs;
  safeAddress: string;
  recordsFactory: string;
  publicationFactory: string;
  /**
   * Retired publication factories whose `ModuleCreated` logs still describe
   * live publications (shared: LEGACY_PUBLICATION_FACTORIES).
   *
   * Only the existence check (`scanExistingModules`) counts them, because it
   * answers "does this Safe already have a pair?" and a publication created
   * before the protocol record moved to a new factory has its log on the old
   * one only. Detection after a create batch leaves them out on purpose: the
   * batch was sent to `publicationFactory`, so only that factory's logs can
   * describe what it just deployed.
   */
  legacyPublicationFactories?: readonly string[];
  getBlockNumber: () => Promise<number>;
  now?: () => number;
  /**
   * The address the create batch is expected to deploy, from
   * `moduleAddress(safe)` (see predictNextModuleAddress) captured BEFORE the
   * batch executed. Detection accepts it once it has code — that is what
   * confirms the create landed there — and then skips this factory's log read.
   * Without it, or while it is still empty, detection polls the logs.
   */
  predictedPublicationModule?: string;
  /** Does `address` have code on the Safe's chain? Confirms the prediction. */
  hasCode?: (address: string) => Promise<boolean>;
};

export type DetectModuleAddressesOpts = {
  timeoutMs?: number;
  lookbackBlocks?: number;
  pollIntervalMs?: number;
};

export type InitializePublicationDeps = {
  chainId: number;
  safeAddress: string;
  protocolInfo: ProtocolInfo;
  propose: (txs: MetaTransactionData[]) => Promise<string>;
  fetchModuleCreatedLogs: FetchModuleCreatedLogs;
  getBlockNumber: () => Promise<number>;
  isModuleEnabled: (module: string) => Promise<boolean>;
  now?: () => number;
  /**
   * `moduleAddress(safe)` on the publication factory, for the create this call
   * is about to propose. Called BEFORE the create batch, because after it
   * executes the factory answers for the NEXT create; the prediction is only
   * accepted once the module has code (see detectModuleAddresses).
   */
  predictNextModuleAddress?: () => Promise<string | undefined>;
  hasCode?: (address: string) => Promise<boolean>;
};

export type InitializePublicationOpts = {
  authors?: string[];
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

export interface WaitForModulesEnabledDeps {
  recordsModule: string;
  publicationModule: string;
  isModuleEnabled: (module: string) => Promise<boolean>;
  now?: () => number;
}

export interface WaitForModulesEnabledOpts {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type InitResult = {
  recordsModule: string;
  publicationModule: string;
  nameRecorded: boolean;
  proposals: string[];
};

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_LOOKBACK_BLOCKS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ENABLE_TIMEOUT_MS = 600_000; // 10 min — a human must execute the batch in the Safe app
const DEFAULT_ENABLE_POLL_INTERVAL_MS = 2_000;

/** Safe sentinel module address — prevModule of the first module in the linked list. */
const SENTINEL_MODULES = '0x0000000000000000000000000000000000000001';

const recordsFactoryInterface = new Interface(Abi_S2SRecordsModuleFactory);
const publicationFactoryInterface = new Interface(Abi_S2SPublicationModuleV2Factory);
const safeInterface = new Interface([
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
]);
const recordsModuleInterface = new Interface([
  'function setRecord(string key, string value)',
  'function deleteRecord(string key)',
]);

// ---------------------------------------------------------------------------
// Encoders (exported for unit testing; selectors are derived from the ABIs,
// never hardcoded).
// ---------------------------------------------------------------------------

/** Safe enableModule(address module) → data for a Safe self-call. */
export function encodeEnableModule(module: string): string {
  return safeInterface.encodeFunctionData('enableModule', [module]);
}

/** recordsFactory.createModule(address safe) → data. */
export function encodeCreateRecordsModule(safe: string): string {
  return recordsFactoryInterface.encodeFunctionData('createModule', [safe]);
}

/** publicationFactory.createModule(address safe, address[] _authors, address[] _devs) → data (devs = []). */
export function encodeCreatePublicationModule(safe: string, authors: string[]): string {
  return publicationFactoryInterface.encodeFunctionData('createModule', [safe, authors, []]);
}

/** recordsModule.setRecord(string key, string value) → data. */
export function encodeSetRecord(key: string, value: string): string {
  return recordsModuleInterface.encodeFunctionData('setRecord', [key, value]);
}

/** Safe disableModule(address prevModule, address module) → data (Safe self-call). */
export function encodeDisableModule(prevModule: string, module: string): string {
  return safeInterface.encodeFunctionData('disableModule', [prevModule, module]);
}

/** recordsModule.deleteRecord(string key) → data. */
export function encodeDeleteRecord(key: string): string {
  return recordsModuleInterface.encodeFunctionData('deleteRecord', [key]);
}

/**
 * topic0 of the ModuleCreated event for a given factory ABI. The two factories
 * emit different signatures, so their topic0 differ:
 *   records:     ModuleCreated(address indexed safe, address indexed module)
 *   publication: ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation)
 * The module address is always the second indexed argument → log topic[2].
 */
export function moduleCreatedTopic0(factoryAbi: InterfaceAbi): string {
  const event = new Interface(factoryAbi).getEvent('ModuleCreated');
  if (!event) throw new Error('factory ABI has no ModuleCreated event');
  return event.topicHash;
}

// ---------------------------------------------------------------------------
// Batch builders.
// ---------------------------------------------------------------------------

/**
 * Batch 1: create both modules from their factories. Creates:
 *   [recordsFactory.createModule(safe), publicationFactory.createModule(safe, authors, [])]
 * A plain-CREATE factory leaves the deployed addresses unknowable until the
 * batch executes (read them from ModuleCreated logs then). A CREATE2 factory
 * answers `moduleAddress(safe)` first — capture it BEFORE this batch is
 * proposed, since afterwards it names the next create (predictNextModuleAddress).
 */
export function buildCreateModuleBatch(
  protocolInfo: ProtocolInfo,
  safeAddress: string,
  authors: string[],
): MetaTransactionData[] {
  return [
    {
      to: protocolInfo.recordsFactory,
      value: '0',
      data: encodeCreateRecordsModule(safeAddress),
    },
    {
      to: protocolInfo.publicationFactory,
      value: '0',
      data: encodeCreatePublicationModule(safeAddress, authors),
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
 * Safe executions total (create → finalize) and eliminates the window where
 * modules are enabled but the name record was never proposed (the
 * reload-into-already-enabled-setup dead end of the 3-proposal flow).
 *
 * Safe's enableModule is idempotent, so re-proposing this batch against
 * already-enabled modules during a recovery is harmless.
 */
export function buildFinalizeBatch(
  safeAddress: string,
  recordsModule: string,
  publicationModule: string,
  name: string,
  extra?: { repo?: string; branch?: string },
): MetaTransactionData[] {
  return [
    ...buildEnableModuleBatch(safeAddress, recordsModule, publicationModule),
    ...buildNameRecordBatch(recordsModule, name, extra),
  ];
}

/**
 * Teardown batch — the inverse of init, for starting a new publication:
 *   [disableModule(prev, laterModule), disableModule(prev, earlierModule), records.deleteRecord("name")]
 *
 * Only DISABLES — it never creates or destroys contracts. Each init run
 * deploys fresh modules (the factories are non-idempotent), so tearing down
 * only needs to (a) remove the modules from the Safe and (b) unregister the
 * name record; the orphaned deployments stay on-chain as harmless leftovers.
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
 * whole thing fails to estimate (Safe UI GS013). S2SRecordsModule.deleteRecord
 * reverts with KeyNotFound() when the key was never written, so callers must
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
// Log parsing.
// ---------------------------------------------------------------------------

/** Left-pad a 20-byte address to the 32-byte form used in an indexed topic. */
function padAddress(addr: string): string {
  return `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/** Last 20 bytes of a 32-byte indexed topic → checksummed address. */
function topicToAddress(topic: string): string {
  return getAddress(`0x${topic.slice(26)}`);
}

/**
 * Find the module address among logs for one factory, ignoring logs emitted
 * for a different safe (topic[1] = padded indexed safe must match).
 *
 * eth_getLogs returns logs oldest-first, and the factory emits a fresh
 * ModuleCreated for EVERY createModule call (non-idempotent). Returning the
 * LAST matching log makes detection prefer the most recent deployment —
 * essential for re-init runs after a reset/teardown, where the previous
 * run's logs are still within the lookback range.
 */
function findModuleAddress(
  logs: Array<{ topics: string[] }>,
  paddedSafe: string,
): string | undefined {
  let module: string | undefined;
  for (const log of logs) {
    const topics = log?.topics;
    if (!topics || topics.length < 3) continue;
    if (topics[1] === undefined || topics[1].toLowerCase() !== paddedSafe) continue;
    module = topicToAddress(topics[2]);
  }
  return module;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CREATE2 prediction.
// ---------------------------------------------------------------------------

/**
 * The three reads a CREATE2 module factory answers, as its source defines them
 * (`src/publication/contracts/src/S2SPublicationModuleV4Create2Factory.sol`).
 *
 * Kept inline rather than taken from `@s2s/publication-contracts/abis`: these
 * three are the whole surface either front end touches, and the callers want
 * different shapes for it (an ethers `InterfaceAbi` here, a viem `abi` in
 * neutralpress).
 *
 * What the callers rely on, and the source says:
 *  - `moduleAddress(safe)` is the module the factory already recorded for that
 *    Safe when it has one, and the address `createModule(safe, …)` would deploy
 *    at otherwise. It names a create that has not happened only for a Safe with
 *    no module, and only that answer moves when the protocol Safe calls
 *    `setImplementation`.
 *  - `moduleAddressForVersion(safe, version)` is 1-based over
 *    `implementationHistory` and reverts `InvalidVersion` outside
 *    `1..implementationCount()`.
 *  - The address does not depend on what the create is called with: the factory
 *    constructs the proxy with empty initializer data and calls
 *    `initialize(safe, authors, devs)` on it afterwards, so the authors array
 *    cannot move it.
 *
 * A factory that predates them answers none, so each caller catches the revert
 * (that revert IS the "not a create2 factory" answer) and falls back to the log
 * scan.
 */
export const CREATE2_FACTORY_ABI: InterfaceAbi = [
  'function moduleAddress(address safe) view returns (address)',
  'function moduleAddressForVersion(address safe, uint256 version) view returns (address)',
  'function implementationCount() view returns (uint256)',
];

/** A view read on a contract, in whatever shape the host has for one. */
export type Create2Read = (
  factory: string,
  abi: InterfaceAbi,
  method: string,
  args: unknown[],
) => Promise<unknown>;

/** Byte size of the code at an address on the Safe's chain (0 = no contract). */
export type Create2CodeSize = (address: string) => Promise<number>;

export interface PredictModuleAddressDeps {
  read: Create2Read;
  /** The publication factory from the protocol record. */
  factory: string;
  safeAddress: string;
}

/** A plausible, non-zero address (the factories answer address(0) for nothing). */
function isModuleAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(value) &&
    !/^0x0{40}$/.test(value)
  );
}

/**
 * The module address the factory reports for a Safe, or `undefined` when it
 * does not answer the create2 views.
 *
 * For a Safe with no module this is the address the next
 * `createModule(safe, …)` deploys under the latest implementation; for a Safe
 * that already has one it is that module, so the same call doubles as the
 * existence check the log scan can only do inside its lookback. It is never
 * trusted on its own: the init flow captures it BEFORE proposing the create
 * batch, `detectModuleAddresses` accepts it only once the address carries code,
 * and `scanExistingModules` still reads the logs when the factory has nothing
 * to report.
 */
export async function predictNextModuleAddress(
  deps: PredictModuleAddressDeps,
): Promise<string | undefined> {
  if (!deps.factory) return undefined;
  try {
    const predicted = await deps.read(deps.factory, CREATE2_FACTORY_ABI, 'moduleAddress', [
      deps.safeAddress,
    ]);
    return isModuleAddress(predicted) ? getAddress(predicted) : undefined;
  } catch {
    // No such selector: a pre-create2 factory. The caller scans logs instead.
    return undefined;
  }
}

export interface ResolveModuleAddressDeps extends PredictModuleAddressDeps {
  codeSize: Create2CodeSize;
  /** How far back through `implementationHistory` to look (default 8). */
  maxVersions?: number;
}

/**
 * The module an ALREADY CREATED publication lives at, for discovery.
 *
 * Unlike the prediction this has to prove the module exists: an address the
 * factory would deploy for the next create has no code, and `setImplementation`
 * moves `moduleAddress(safe)`, so an older publication is only named by
 * `moduleAddressForVersion(safe, version)`. Candidates are tried newest
 * implementation first and the first one carrying code wins.
 *
 * A revert on `moduleAddress` means the factory has no create2 views at all,
 * and that is answered immediately: no `implementationCount` read and no
 * reverted `moduleAddressForVersion` calls. `undefined` is "this factory cannot
 * answer for this Safe" and the caller keeps its own NAME() scan.
 */
export async function resolveModuleAddress(
  deps: ResolveModuleAddressDeps,
): Promise<string | undefined> {
  const hasCode = async (address: string): Promise<boolean> => {
    try {
      return (await deps.codeSize(address)) > 0;
    } catch {
      return false;
    }
  };

  let latest: unknown;
  try {
    latest = await deps.read(deps.factory, CREATE2_FACTORY_ABI, 'moduleAddress', [
      deps.safeAddress,
    ]);
  } catch {
    // Pre-create2 factory: the revert is the answer.
    return undefined;
  }
  if (isModuleAddress(latest)) {
    const address = getAddress(latest);
    if (await hasCode(address)) return address;
  }

  let count = 0;
  try {
    count = Number(await deps.read(deps.factory, CREATE2_FACTORY_ABI, 'implementationCount', []));
  } catch {
    return undefined;
  }
  if (!Number.isFinite(count) || count < 1) return undefined;

  // moduleAddressForVersion is 1-based over implementationHistory and reverts
  // outside 1..count, so the walk is bounded on both ends.
  const floor = Math.max(1, count - (deps.maxVersions ?? 8) + 1);
  for (let version = count; version >= floor; version--) {
    let candidate: unknown;
    try {
      candidate = await deps.read(deps.factory, CREATE2_FACTORY_ABI, 'moduleAddressForVersion', [
        deps.safeAddress,
        BigInt(version),
      ]);
    } catch {
      continue;
    }
    if (!isModuleAddress(candidate)) continue;
    const address = getAddress(candidate);
    if (await hasCode(address)) return address;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Detection.
// ---------------------------------------------------------------------------

export type ScanExistingModulesOpts = {
  lookbackBlocks?: number;
};

type ModuleScanResult = {
  blockNumber: number;
  recordsLogs: number;
  publicationLogs: number;
  recordsModule?: string;
  publicationModule?: string;
};

/**
 * Every publication factory a scan reads: the one from the protocol record
 * first, then the retired deployments, each address once (case-insensitive).
 * Order is the preference order — a module logged by the current factory wins
 * over one logged by a retired factory.
 */
function publicationFactoryCandidates(deps: DetectModuleAddressesDeps): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const factory of [deps.publicationFactory, ...(deps.legacyPublicationFactories ?? [])]) {
    if (!factory) continue;
    const key = factory.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(factory);
  }
  return candidates;
}

/**
 * One pass over the records factory's and every publication factory's
 * ModuleCreated logs: the shared primitive behind detectModuleAddresses (which
 * polls it) and scanExistingModules (which calls it exactly once). Each
 * factory's topic0 comes from its own ABI (moduleCreatedTopic0), so the
 * differing event signatures resolve to distinct topic0. Missing modules are
 * `undefined` — this never waits, never throws.
 */
async function scanModuleLogs(
  deps: DetectModuleAddressesDeps,
  lookbackBlocks: number,
): Promise<ModuleScanResult> {
  const paddedSafe = padAddress(deps.safeAddress);
  const recordsTopic0 = moduleCreatedTopic0(Abi_S2SRecordsModuleFactory);
  const publicationTopic0 = moduleCreatedTopic0(Abi_S2SPublicationModuleV2Factory);

  const blockNumber = await deps.getBlockNumber();
  const fromBlock = Math.max(0, blockNumber - lookbackBlocks);

  const publicationFactories = publicationFactoryCandidates(deps);

  const [recordsLogs, publicationLogsByFactory] = await Promise.all([
    deps.fetchModuleCreatedLogs(deps.recordsFactory, deps.safeAddress, recordsTopic0, fromBlock),
    Promise.all(
      publicationFactories.map((factory) =>
        deps.fetchModuleCreatedLogs(factory, deps.safeAddress, publicationTopic0, fromBlock),
      ),
    ),
  ]);

  // Dedupe by module address: one address is one module, whichever factory's
  // log named it. `findModuleAddress` already prefers the newest log within a
  // factory, and the candidate order above decides between factories.
  const seenModules = new Set<string>();
  const publicationModules: string[] = [];
  for (const logs of publicationLogsByFactory) {
    const module = findModuleAddress(logs, paddedSafe);
    if (!module) continue;
    const key = module.toLowerCase();
    if (seenModules.has(key)) continue;
    seenModules.add(key);
    publicationModules.push(module);
  }

  return {
    blockNumber,
    recordsLogs: recordsLogs.length,
    publicationLogs: publicationLogsByFactory.reduce((total, logs) => total + logs.length, 0),
    recordsModule: findModuleAddress(recordsLogs, paddedSafe),
    publicationModule: publicationModules[0],
  };
}

/**
 * ONE look at the ModuleCreated logs: "does this Safe already have an
 * S2S module pair on-chain?". Used before proposing the create batch — the
 * factories are plain CREATE (non-idempotent), so re-creating a pair that
 * already exists deploys a duplicate (and anything the user built on the old
 * modules is orphaned).
 *
 * The look covers the record's publication factory AND the retired ones
 * (`legacyPublicationFactories`): a publication created before the protocol
 * record moved to a new factory has its ModuleCreated log on the old factory
 * only, and would otherwise look uninitialised.
 *
 * Returns a PARTIAL result when only one factory has a log for this Safe; the
 * caller decides whether a lone module is usable (it is not: the flow needs
 * both). Never polls and never throws for "nothing found" — RPC errors reject
 * like any other await, so callers that must not be blocked wrap it in
 * try/catch.
 */
export async function scanExistingModules(
  deps: DetectModuleAddressesDeps,
  opts: ScanExistingModulesOpts = {},
): Promise<{ recordsModule?: string; publicationModule?: string }> {
  const lookbackBlocks = opts.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;
  const { recordsModule, publicationModule } = await scanModuleLogs(deps, lookbackBlocks);
  return { recordsModule, publicationModule };
}

/**
 * Poll both factories' ModuleCreated logs until both module addresses are
 * found (or the timeout elapses). Each factory's topic0 is derived from its
 * own ABI (moduleCreatedTopic0), so the differing event signatures resolve to
 * distinct topic0. Throws a descriptive error naming the missing module(s).
 * Reads `publicationFactory` only — this runs after a create batch sent to
 * that factory, so its logs are the only ones that can describe the new pair.
 *
 * A `predictedPublicationModule` short-circuits the publication half: once that
 * address has CODE the create landed exactly there (the prediction is only
 * ever captured before the batch executed, so "has code" is the confirmation),
 * and this factory's log read is skipped entirely. The records module is still
 * read from its log — its factory is plain CREATE, so there is nothing to
 * predict.
 */
export async function detectModuleAddresses(
  deps: DetectModuleAddressesDeps,
  opts: DetectModuleAddressesOpts = {},
): Promise<{ recordsModule: string; publicationModule: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lookbackBlocks = opts.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const start = now();

  let recordsModule: string | undefined;
  let publicationModule: string | undefined;
  let predictionConfirmed = false;

  for (;;) {
    if (now() - start > timeoutMs) {
      const missing: string[] = [];
      if (!recordsModule) missing.push('records');
      if (!publicationModule) missing.push('publication');
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for module deployment logs; missing module: ${missing.join(', ')}`,
      );
    }

    if (!publicationModule && !predictionConfirmed && deps.predictedPublicationModule) {
      predictionConfirmed = deps.hasCode
        ? await deps.hasCode(deps.predictedPublicationModule).catch(() => false)
        : false;
      if (predictionConfirmed) {
        publicationModule = deps.predictedPublicationModule;
        console.log(`[init] detect: predicted publication module confirmed ${publicationModule}`);
      }
    }

    // Detection answers a different question from the existence check: the
    // create batch was just sent to `publicationFactory`, so only that
    // factory's logs describe the pair being waited for. A retired factory's
    // log would name a module from an earlier run and short-circuit the wait.
    // A confirmed prediction replaces that log read for the publication half
    // (empty factory → no read), and nothing else.
    const poll = await scanModuleLogs(
      {
        ...deps,
        legacyPublicationFactories: undefined,
        publicationFactory: predictionConfirmed ? '' : deps.publicationFactory,
      },
      lookbackBlocks,
    );
    console.log(
      `[init] detect poll block=${poll.blockNumber} recordsLogs=${poll.recordsLogs} publicationLogs=${poll.publicationLogs}`,
    );

    if (!recordsModule) recordsModule = poll.recordsModule;
    if (!publicationModule) publicationModule = poll.publicationModule;

    if (recordsModule && publicationModule) {
      return { recordsModule, publicationModule };
    }

    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Enable-wait (human-in-the-loop bridge).
// ---------------------------------------------------------------------------

/**
 * Wait until BOTH modules are enabled on the Safe. This is the bridge between
 * proposing the enable batch and everything that follows: a human must open
 * the Safe app and EXECUTE the pending enable proposal before the modules are
 * live, so the name-record batch must not be proposed (and verification must
 * not run) until then. Mirrors detectModuleAddresses — polls isModuleEnabled
 * every pollIntervalMs until both return true or the timeout elapses.
 * Default timeout 10 min; a human in the Safe UI typically takes seconds.
 */
export async function waitForModulesEnabled(
  deps: WaitForModulesEnabledDeps,
  opts: WaitForModulesEnabledOpts = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ENABLE_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_ENABLE_POLL_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const start = now();

  for (;;) {
    const [recordsEnabled, publicationEnabled] = await Promise.all([
      deps.isModuleEnabled(deps.recordsModule),
      deps.isModuleEnabled(deps.publicationModule),
    ]);
    if (recordsEnabled && publicationEnabled) return;

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
 * proposals (never direct sends) — the direct sequence (PR #158):
 *   1. propose create-batch (both modules),
 *   2. detect deployed module addresses from ModuleCreated logs,
 *   3. propose the MERGED enable+name batch (buildFinalizeBatch) — one
 *      proposal enables both modules AND records the identity,
 *   4. wait for a human to EXECUTE the merged batch (waitForModulesEnabled).
 *
 * `proposals` is ordered and has length 2. When `name` is empty the merged
 * batch is just the two enableModule calls (identity steps skipped).
 */
export async function initializePublication(
  deps: InitializePublicationDeps,
  opts: InitializePublicationOpts = {},
): Promise<InitResult> {
  const authors = opts.authors ?? [];
  const name = opts.name;
  const proposals: string[] = [];

  // The address the create batch will deploy, if the factory can name it. Read
  // BEFORE the batch: afterwards the factory answers for the next create. The
  // value is unconfirmed (no code yet), so detection still proves it landed.
  let predictedPublicationModule: string | undefined;
  if (deps.predictNextModuleAddress) {
    predictedPublicationModule = await deps
      .predictNextModuleAddress()
      .catch(() => undefined);
  }

  // Batch 1: create both modules.
  const createBatch = buildCreateModuleBatch(deps.protocolInfo, deps.safeAddress, authors);
  proposals.push(await deps.propose(createBatch));

  // Detect the deployed addresses.
  const { recordsModule, publicationModule } = await detectModuleAddresses(
    {
      fetchModuleCreatedLogs: deps.fetchModuleCreatedLogs,
      safeAddress: deps.safeAddress,
      recordsFactory: deps.protocolInfo.recordsFactory,
      publicationFactory: deps.protocolInfo.publicationFactory,
      getBlockNumber: deps.getBlockNumber,
      now: deps.now,
      predictedPublicationModule,
      hasCode: deps.hasCode,
    },
    {},
  );

  // Batch 2 (merged): enable both modules AND record the identity — one
  // proposal, one Safe execution. setRecord is onlySafe (no enable needed),
  // so splitting enable and name was an unnecessary extra round-trip; that
  // split was also what left "modules enabled but name never proposed" as a
  // resumable-but-dead state across reloads.
  const hasName = name !== undefined && name !== '';
  const finalizeBatch = hasName
    ? buildFinalizeBatch(deps.safeAddress, recordsModule, publicationModule, name, {
        repo: opts.repo,
        branch: opts.branch,
      })
    : buildEnableModuleBatch(deps.safeAddress, recordsModule, publicationModule);
  proposals.push(await deps.propose(finalizeBatch));

  // Wait for the human to execute the merged batch in the Safe queue.
  await waitForModulesEnabled(
    {
      recordsModule,
      publicationModule,
      isModuleEnabled: deps.isModuleEnabled,
      now: deps.now,
    },
    { timeoutMs: opts.enableTimeoutMs, pollIntervalMs: opts.enablePollIntervalMs },
  );

  return { recordsModule, publicationModule, nameRecorded: hasName, proposals };
}
