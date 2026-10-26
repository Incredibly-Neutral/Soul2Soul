// safe-app/src/lib/ens-step.ts
//
// The ENS subdomain registration as a STANDALONE step for a live publication.
//
// A publication's modules + name record live on Base, but the ENS registry is
// deployed on Ethereum L1 only. The creation flow's step 1 can only register
// the name while the flow is running; a publication that is already live never
// runs it. This module supplies the two pure decisions that surface enables:
//
//   - findPublicationName() reads the publication name from the Safe's modules
//     on Base, independently of the chain this page's Safe is connected to.
//     That is what makes the step reachable on the L1 Safe too (whose module
//     list is empty — the modules live on Base).
//   - ensStepView() turns the L1 registration read into a small card state:
//     hidden / needs-registration / waiting / done / error, plus whether THIS
//     page can propose the call (only on chain 1).
//
// The Safe Apps SDK 9.1.0 cannot switch the host Safe's network (there is no
// setChain / wallet_switchEthereumChain), so a page on Base can never propose
// an L1 transaction itself. It links to the same Safe + app on mainnet instead
// (safeAppUrl) and always shows the exact call for a manual copy.
//
// Pure + injected reads (the same pattern as ens-registration.ts): every chain
// read goes through `evmRead`, so unit tests inject a fake and nothing here
// touches a real RPC, `window`, or lit.

import { buildRegisterSubdomainCall, type EnsRegistrationState } from './ens-registration';
import { ENS_L1_CHAIN_ID, ZERO_ADDRESS, type EvmReadFn } from './domain-validation';

/** The chain the publication's modules (and its name record) live on. */
export const BASE_CHAIN_ID = 8453;

/** NAME() of the records module whose `getRecord('name')` holds the publication. */
export const RECORDS_MODULE_NAME = 'S2S Records Module';

/** Safe's module linked-list sentinel: the `start` value for the first page and
 *  the `next` value after the last one. */
const MODULE_SENTINEL = '0x0000000000000000000000000000000000000001';

const SAFE_MODULES_ABI = [
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
];
const NAME_ABI = ['function NAME() view returns (string)'];
const GET_RECORD_ABI = ['function getRecord(string key) view returns (string)'];

export interface FindPublicationNameOptions {
  /** Chain the publication lives on; defaults to Base (8453). */
  chainId?: number;
  /** Safe.getModulesPaginated page size; defaults to 20. */
  pageSize?: number;
  /** Hard cap on pages walked, so a malformed list can never loop forever. */
  maxPages?: number;
  /** The name the app itself reads from its adopted records module. When set,
   *  a module holding a DIFFERENT name is not accepted: a Safe with two
   *  enabled records modules must not register the wrong (write-once) label. */
  expectedName?: string;
  /** Propagate transport/module-list failures instead of returning ''. The
   *  host uses this to avoid caching a failed read as "no publication". */
  throwOnError?: boolean;
}

/** Split Safe.getModulesPaginated's `(address[] array, address next)` result,
 *  tolerating both an ethers Result (an Array) and a plain named object. */
function splitModulesPage(result: unknown): { modules: string[]; next: string } {
  if (Array.isArray(result)) {
    const modules = Array.isArray(result[0]) ? (result[0] as unknown[]).map(String) : [];
    return { modules, next: result[1] ? String(result[1]) : '' };
  }
  const named = result as { array?: unknown; next?: unknown } | null | undefined;
  const modules = Array.isArray(named?.array) ? (named!.array as unknown[]).map(String) : [];
  return { modules, next: named?.next ? String(named.next) : '' };
}

/** A revert / undecodable reply means "this module has no NAME()", not a
 *  transport failure. Any other error is passed through when the caller asked
 *  for failures, so a 429 on a NAME probe cannot look like "no publication". */
function isContractReplyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 'CALL_EXCEPTION' || code === 'BAD_DATA';
}

/** Does `module` identify itself as the S2S records module? A probe that throws
 *  (no NAME, not a module) is simply a "no", never an error for the caller. */
async function isRecordsModule(
  evmRead: EvmReadFn,
  chainId: number,
  module: string,
  throwOnError = false,
): Promise<boolean> {
  try {
    const name = await evmRead(chainId, module, NAME_ABI, 'NAME', []);
    return String(name) === RECORDS_MODULE_NAME;
  } catch (err) {
    if (throwOnError && !isContractReplyError(err)) throw err;
    return false;
  }
}

/**
 * Read the publication's `name` record from the Safe's modules on Base.
 *
 * Deliberately NOT tied to the page's Safe chain: opening this app on the L1
 * twin Safe (to propose the registration) presents an empty module list on that
 * chain, but the publication still lives on Base at the same Safe address.
 *
 * Returns '' when no records module answers (no publication, a failed read, or
 * a module that does not identify itself) — callers stay silent rather than
 * guessing a name. With `expectedName`, only an exact match is returned, so a
 * second records module cannot make the card register the wrong label. Never
 * loops on a bad module. `throwOnError` opts a caller (the host) into seeing
 * transport failures so it can retry instead of suppressing the step.
 */
export async function findPublicationName(
  evmRead: EvmReadFn,
  safeAddress: string,
  opts: FindPublicationNameOptions = {},
): Promise<string> {
  if (!safeAddress) return '';
  const chainId = opts.chainId ?? BASE_CHAIN_ID;
  const pageSize = opts.pageSize ?? 20;
  const maxPages = opts.maxPages ?? 10;
  const expectedName = (opts.expectedName ?? '').trim().toLowerCase();

  const modules: string[] = [];
  const seenModule = new Set<string>();
  try {
    let cursor = MODULE_SENTINEL;
    const seenCursor = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      const cursorKey = cursor.toLowerCase();
      if (seenCursor.has(cursorKey)) break;
      seenCursor.add(cursorKey);

      const result = await evmRead(chainId, safeAddress, SAFE_MODULES_ABI, 'getModulesPaginated', [
        cursor,
        pageSize,
      ]);
      const pageResult = splitModulesPage(result);
      for (const module of pageResult.modules) {
        if (!module || module === ZERO_ADDRESS) continue;
        const key = module.toLowerCase();
        if (seenModule.has(key)) continue;
        seenModule.add(key);
        modules.push(module);
      }

      const next = pageResult.next;
      if (!next || next.toLowerCase() === MODULE_SENTINEL || next.toLowerCase() === ZERO_ADDRESS) {
        break;
      }
      cursor = next;
    }
  } catch (err) {
    if (opts.throwOnError) throw err;
    return '';
  }

  let fallback = '';
  let readError: unknown;
  for (const module of modules) {
    if (!(await isRecordsModule(evmRead, chainId, module, opts.throwOnError))) continue;
    let name: string;
    try {
      const raw = await evmRead(chainId, module, GET_RECORD_ABI, 'getRecord', ['name']);
      name = typeof raw === 'string' ? raw : '';
    } catch (err) {
      readError ??= err;
      continue;
    }
    if (!expectedName) return name;
    if (name.trim().toLowerCase() === expectedName) return name;
    fallback ||= name;
  }

  // With an expected publication name, never fall back to a different module's
  // name: registering the wrong label is write-once and unrecoverable.
  if (expectedName) {
    if (opts.throwOnError && readError) throw readError;
    return '';
  }
  if (opts.throwOnError && readError && !fallback) throw readError;
  return fallback;
}

export interface EnsStepSafe {
  chainId: number;
  safeAddress: string;
}

export interface EnsStepOptions {
  /** A registration was already proposed from this Safe (persisted flag). */
  proposed?: boolean;
}

export type EnsStepKind = 'hidden' | 'needs-registration' | 'waiting' | 'done' | 'error';

export interface EnsStepView {
  kind: EnsStepKind;
  /** 'l1' when this page's Safe is on Ethereum mainnet, so it can propose. */
  chain: 'l1' | 'other';
  canPropose: boolean;
  /** The exact `registerSubdomain` call, for the Propose action and the copy
   *  fallback. Present whenever a registration could still be made. */
  call?: { to: string; data: string };
  /** Full publication name, when known. */
  name?: string;
  /** User-facing explanation of the current state. */
  reason?: string;
  /** The subnode's current owner (lowercase), when known. */
  owner?: string;
}

/**
 * Turn an L1 registration read into the standalone card's state.
 *
 * `canPropose` is true only when THIS page's Safe is on chain 1 AND the subnode
 * is still free: a Safe on any other chain cannot send an L1 transaction with
 * the Safe Apps SDK, and a name owned by the Safe is done while a name owned by
 * somebody else is not ours to register.
 *
 * A `null` state is "not read yet / read failed" and stays hidden: an
 * unrequested card must never hijack the page on a transient RPC error.
 */
export function ensStepView(
  state: EnsRegistrationState | null,
  safe: EnsStepSafe,
  opts: EnsStepOptions = {},
): EnsStepView {
  const chain: 'l1' | 'other' = safe.chainId === ENS_L1_CHAIN_ID ? 'l1' : 'other';
  if (!state) return { kind: 'hidden', chain, canPropose: false };

  const name = state.name;
  if (state.ownedBySafe) {
    return {
      kind: 'done',
      chain,
      canPropose: false,
      name,
      owner: state.owner,
      reason: `${name} is registered to this Safe.`,
    };
  }

  if (state.desynced) {
    return {
      kind: 'error',
      chain,
      canPropose: false,
      name,
      owner: state.owner,
      reason: `The ENS registry reports ${name} as taken but with no owner. This half-written state has to be fixed on chain 1 before the name can be registered.`,
    };
  }

  if (state.owner !== ZERO_ADDRESS) {
    return {
      kind: 'error',
      chain,
      canPropose: false,
      name,
      owner: state.owner,
      reason: `${name} is owned by ${state.owner}, not this Safe. This app cannot register a name somebody else controls.`,
    };
  }

  let call: { to: string; data: string } | undefined;
  try {
    const built = buildRegisterSubdomainCall(state.registry, state.label, safe.safeAddress);
    call = { to: built.to, data: built.data };
  } catch {
    // An invalid label cannot be proposed (and would revert for real gas), so
    // surface the state without an actionable call rather than a bad one.
  }

  if (opts.proposed) {
    return {
      kind: 'waiting',
      chain,
      canPropose: false,
      call,
      name,
      owner: state.owner,
      reason: `Registration of ${name} was proposed. Waiting for the Safe transaction to execute on Ethereum mainnet.`,
    };
  }

  return {
    kind: 'needs-registration',
    chain,
    canPropose: chain === 'l1' && !!call,
    call,
    name,
    owner: state.owner,
    reason:
      chain === 'l1'
        ? `${name} has no ENS registration yet. The registry lives on Ethereum mainnet, so it must be its own Safe transaction — never batched with the Base module steps.`
        : `${name} has no ENS registration yet. ENS lives on Ethereum mainnet only, and this Safe page is on another chain — open the same Safe on mainnet to propose it.`,
  };
}

const CHAIN_SHORTNAMES: Record<number, string> = {
  1: 'eth',
  10: 'oeth',
  137: 'matic',
  8453: 'base',
  84532: 'base-sepolia',
  11155111: 'sep',
  42161: 'arb1',
};

export interface SafeAppUrlOptions {
  /** Target chain for the Safe app (the ENS step always uses chain 1). */
  chainId: number;
  safeAddress: string;
  /** URL of this Safe app, opened on that chain. */
  appUrl: string;
}

/**
 * Safe{Wallet} deep link that opens THIS app against the same Safe address on
 * another chain. Used for the L1 hop: the page on Base cannot switch the host
 * Safe's network, so it hands the user a link to the same Safe + app on mainnet.
 */
export function safeAppUrl({ chainId, safeAddress, appUrl }: SafeAppUrlOptions): string {
  const prefix = CHAIN_SHORTNAMES[chainId] ?? String(chainId);
  if (!appUrl) return '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(safeAddress)) return '';
  return `https://app.safe.global/apps/open?safe=${prefix}:${encodeURIComponent(
    safeAddress,
  )}&appUrl=${encodeURIComponent(appUrl)}`;
}

/** The narrow storage surface the persisted proposal marker needs. */
export type EnsStepStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** How long a persisted proposal marker suppresses a second proposal. A
 *  rejected/abandoned transaction must not block the name forever; the card
 *  also exposes an explicit "Propose again" after its poll deadline. */
export const ENS_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Storage key for "a registration was proposed from this Safe".
 *
 * Scoped by Safe, label AND registry: a different publication name after a
 * reset must not inherit the old marker, and a deployment with a different
 * registry must not suppress this one just because the Safe address matches.
 */
export function ensProposalStorageKey(safeAddress: string, label: string, registry = ''): string {
  return `s2s.ens-step.proposed.v2:${safeAddress.toLowerCase()}:${registry.toLowerCase()}:${label.toLowerCase()}`;
}

/** Has a registration already been proposed in this scope? The marker is an
 *  in-flight timestamp written BEFORE the send, so a second tab sees it while
 *  the first is still waiting for the SDK. Expired markers are ignored. */
export function hasEnsProposal(
  storage: EnsStepStorage,
  safeAddress: string,
  label: string,
  registry = '',
  now = Date.now(),
): boolean {
  if (!safeAddress || !label) return false;
  const key = ensProposalStorageKey(safeAddress, label, registry);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    if (now - at < ENS_PROPOSAL_TTL_MS) return true;
    storage.removeItem(key);
    return false;
  } catch {
    return false;
  }
}

/** Write the proposal marker. Called before the send (and cleared if the send
 *  or the pre-send re-read fails), so a double click or a second tab cannot
 *  queue the same registration twice. */
export function markEnsProposal(
  storage: EnsStepStorage,
  safeAddress: string,
  label: string,
  registry = '',
  now = Date.now(),
): void {
  if (!safeAddress || !label) return;
  try {
    storage.setItem(ensProposalStorageKey(safeAddress, label, registry), String(now));
  } catch {
    // The in-memory busy guard still stops a double click in this page.
  }
}

/** Drop the marker after a failed/rejected proposal so Retry works. */
export function clearEnsProposal(
  storage: EnsStepStorage,
  safeAddress: string,
  label: string,
  registry = '',
): void {
  if (!safeAddress || !label) return;
  try {
    storage.removeItem(ensProposalStorageKey(safeAddress, label, registry));
  } catch {
    // Nothing to surface.
  }
}

/** Exponential backoff for the waiting poll: a 429 storm must not hammer the
 *  RPC at the base interval. Capped at one minute. */
export function pollBackoffMs(intervalMs: number, failures: number): number {
  const factor = 2 ** Math.min(Math.max(failures, 0), 6);
  return Math.min(intervalMs * factor, 60_000);
}
