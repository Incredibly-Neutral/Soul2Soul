// safe-app/src/lib/publication-init.ts
//
// "New publication init" flow for safe-app (SPEC-hosts.md AD-3): make THIS
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
//   Both factories deploy via plain CREATE (new ERC1967Proxy / new
//   S2SRecordsModule(safe)), so the module addresses are unknowable in
//   advance. Safe enableModule is onlySelf (the Safe must self-call) and does
//   NOT check that the target has code, so predicting CREATE addresses risks
//   silently enabling a wrong/empty address. Therefore:
//     batch1 = create both modules (records + publication)
//     detect  = read ModuleCreated logs to learn the deployed addresses
//     batch2 = enable both modules
//     batch3 = (optional) records.setRecord("name", name)

import { Interface, getAddress } from 'ethers';
import type { InterfaceAbi } from 'ethers';
import { Abi_S2SRecordsModuleFactory } from '../../../protocol/generated/abis/S2SRecordsModuleFactory';
import { Abi_S2SPublicationModuleV2Factory } from '../../../protocol/generated/abis/S2SPublicationModuleV2Factory';

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
  getBlockNumber: () => Promise<number>;
  now?: () => number;
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
};

export type InitializePublicationOpts = {
  authors?: string[];
  name?: string;
  safeUrl?: (chainId: number, safeAddress: string) => string;
};

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

const recordsFactoryInterface = new Interface(Abi_S2SRecordsModuleFactory);
const publicationFactoryInterface = new Interface(Abi_S2SPublicationModuleV2Factory);
const safeInterface = new Interface(['function enableModule(address module)']);
const recordsModuleInterface = new Interface(['function setRecord(string key, string value)']);

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
 * The deployed addresses are unknowable in advance (plain CREATE) — read them
 * from ModuleCreated logs before enabling.
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
 * Batch 3 (optional): record the publication name.
 * [records.setRecord("name", name)].
 */
export function buildNameRecordBatch(recordsModule: string, name: string): MetaTransactionData[] {
  return [{ to: recordsModule, value: '0', data: encodeSetRecord('name', name) }];
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
 */
function findModuleAddress(logs: Array<{ topics: string[] }>, paddedSafe: string): string | undefined {
  for (const log of logs) {
    const topics = log?.topics;
    if (!topics || topics.length < 3) continue;
    if (topics[1] === undefined || topics[1].toLowerCase() !== paddedSafe) continue;
    return topicToAddress(topics[2]);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Detection.
// ---------------------------------------------------------------------------

/**
 * Poll both factories' ModuleCreated logs until both module addresses are
 * found (or the timeout elapses). Each factory's topic0 is derived from its
 * own ABI (moduleCreatedTopic0), so the differing event signatures resolve to
 * distinct topic0. Throws a descriptive error naming the missing module(s).
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

  const paddedSafe = padAddress(deps.safeAddress);
  const recordsTopic0 = moduleCreatedTopic0(Abi_S2SRecordsModuleFactory);
  const publicationTopic0 = moduleCreatedTopic0(Abi_S2SPublicationModuleV2Factory);

  let recordsModule: string | undefined;
  let publicationModule: string | undefined;

  for (;;) {
    if (now() - start > timeoutMs) {
      const missing: string[] = [];
      if (!recordsModule) missing.push('records');
      if (!publicationModule) missing.push('publication');
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for module deployment logs; missing module: ${missing.join(', ')}`,
      );
    }

    const blockNumber = await deps.getBlockNumber();
    const fromBlock = Math.max(0, blockNumber - lookbackBlocks);

    const [recordsLogs, publicationLogs] = await Promise.all([
      deps.fetchModuleCreatedLogs(deps.recordsFactory, deps.safeAddress, recordsTopic0, fromBlock),
      deps.fetchModuleCreatedLogs(deps.publicationFactory, deps.safeAddress, publicationTopic0, fromBlock),
    ]);

    if (!recordsModule) recordsModule = findModuleAddress(recordsLogs, paddedSafe);
    if (!publicationModule) publicationModule = findModuleAddress(publicationLogs, paddedSafe);

    if (recordsModule && publicationModule) {
      return { recordsModule, publicationModule };
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
 *   1. propose create-batch (both modules),
 *   2. detect deployed module addresses from ModuleCreated logs,
 *   3. propose enable-batch (both modules),
 *   4. if `name` given, propose the name-record batch,
 *   5. verify both modules are enabled (throw if not).
 *
 * `proposals` is ordered and has length 2 (3 with `name`).
 */
export async function initializePublication(
  deps: InitializePublicationDeps,
  opts: InitializePublicationOpts = {},
): Promise<InitResult> {
  const authors = opts.authors ?? [];
  const name = opts.name;
  const proposals: string[] = [];

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
    },
    {},
  );

  // Batch 2: enable both modules (Safe self-calls).
  const enableBatch = buildEnableModuleBatch(deps.safeAddress, recordsModule, publicationModule);
  proposals.push(await deps.propose(enableBatch));

  // Batch 3 (optional): record the publication name.
  let nameRecorded = false;
  if (name !== undefined && name !== '') {
    proposals.push(await deps.propose(buildNameRecordBatch(recordsModule, name)));
    nameRecorded = true;
  }

  // Verify both modules are actually enabled on the Safe.
  const [recordsEnabled, publicationEnabled] = await Promise.all([
    deps.isModuleEnabled(recordsModule),
    deps.isModuleEnabled(publicationModule),
  ]);
  if (!recordsEnabled || !publicationEnabled) {
    const missing: string[] = [];
    if (!recordsEnabled) missing.push('records');
    if (!publicationEnabled) missing.push('publication');
    throw new Error(`Module enable verification failed; not enabled: ${missing.join(', ')}`);
  }

  return { recordsModule, publicationModule, nameRecorded, proposals };
}
