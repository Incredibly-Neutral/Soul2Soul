// safe-app/src/lib/ens-step.ts
//
// The ENS subdomain registration as a STANDALONE step for a live publication.
//
// A publication's modules + name record live on Base, but the ENS registry is
// deployed on Ethereum L1 only. The creation flow's step 1 can only register
// the name while the flow is running; a publication that is already live never
// runs it. This module supplies the two pure decisions that surface enables:
//
//   - findPublicationName() reads the publication name from the Safe's records
//     module on Base, independently of the chain this page's Safe is connected
//     to. The module is the one the factory keeps for (safe, records kind), so
//     the read is a single `moduleAddress` answer instead of a walk over the
//     Safe's module list.
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
import { ModuleAddressRefusalError, moduleAddressFor } from './publication-init';
import { S2S_MODULE_KIND_RECORDS } from '@s2s/soul2soul-shared/safe-app';

/** The chain the publication's modules (and its name record) live on. */
export const BASE_CHAIN_ID = 8453;

const GET_RECORD_ABI = ['function getRecord(string key) view returns (string)'];

/**
 * The Safe has no records module on Base to read the name from. The factory is
 * the only authority on that address, and it answered zero: there is nothing to
 * read and nothing to write, so the card says so instead of naming a guess.
 */
export class NoRecordsModuleError extends Error {
  constructor(safeAddress: string, factory: string, cause?: unknown) {
    super(
      factory
        ? `The module factory ${factory} names no records module for ${safeAddress} on Base (${BASE_CHAIN_ID}), so this Safe has no module to read or record the publication name.`
        : `The protocol record names no module factory, so this Safe's records module on Base (${BASE_CHAIN_ID}) is unknown and the publication name cannot be read.`,
    );
    this.name = 'NoRecordsModuleError';
    this.cause = cause;
  }
}

export interface FindPublicationNameOptions {
  /** The one module factory (`publication_factory` in the protocol record).
   *  It answers where this Safe's records module is; without it there is no
   *  module to read, and the read refuses rather than searching the Safe. */
  moduleFactory: string;
  /** Chain the publication lives on; defaults to Base (8453). */
  chainId?: number;
  /** The name the app itself reads from its adopted records module. When set,
   *  a module holding a DIFFERENT name is not accepted: a Safe with two
   *  enabled records modules must not register the wrong (write-once) label. */
  expectedName?: string;
  /** Propagate transport/module-list failures instead of returning ''. The
   *  host uses this to avoid caching a failed read as "no publication". */
  throwOnError?: boolean;
}

/**
 * Read the publication's `name` record from the Safe's records module on Base.
 *
 * Deliberately NOT tied to the page's Safe chain: opening this app on the L1
 * twin Safe (to propose the registration) presents an empty module list on that
 * chain, but the publication still lives on Base at the same Safe address.
 *
 * The module comes from the factory, one `moduleAddress(safe, records kind)`
 * read. A factory answer of address zero is a refusal (`NoRecordsModuleError`),
 * not an empty search: no module exists for this Safe, so there is no name and
 * nothing to write. A module whose `getRecord('name')` reverts or returns
 * nothing is "no name yet" and returns ''. With `expectedName`, only an exact
 * match is returned, so a stale record cannot make the card register a label
 * the app is not looking at. `throwOnError` opts a caller (the host) into
 * seeing transport failures so it can retry instead of suppressing the step.
 */
export async function findPublicationName(
  evmRead: EvmReadFn,
  safeAddress: string,
  opts: FindPublicationNameOptions,
): Promise<string> {
  if (!safeAddress) return '';
  const chainId = opts.chainId ?? BASE_CHAIN_ID;
  const expectedName = (opts.expectedName ?? '').trim().toLowerCase();
  const moduleFactory = opts.moduleFactory;

  if (!moduleFactory) throw new NoRecordsModuleError(safeAddress, '');

  let module: string;
  try {
    module = await moduleAddressFor(
      { read: (factory, abi, method, args) => evmRead(chainId, factory, abi, method, args) },
      moduleFactory,
      safeAddress,
      S2S_MODULE_KIND_RECORDS,
    );
  } catch (err) {
    // Address zero (or a non-address) is the refusal this card must show. Any
    // other failure is a transport failure and stays a transport failure: it is
    // never cached as "this Safe has no publication".
    if (err instanceof ModuleAddressRefusalError) {
      throw new NoRecordsModuleError(safeAddress, moduleFactory, err);
    }
    if (opts.throwOnError) throw err;
    return '';
  }

  let raw: unknown;
  try {
    raw = await evmRead(chainId, module, GET_RECORD_ABI, 'getRecord', ['name']);
  } catch (err) {
    if (opts.throwOnError) throw err;
    return '';
  }
  const name = typeof raw === 'string' ? raw : '';

  // With an expected publication name, never accept a different one:
  // registering the wrong label is write-once and unrecoverable.
  if (expectedName && name.trim().toLowerCase() !== expectedName) return '';
  return name;
}

export interface EnsStepSafe {
  chainId: number;
  safeAddress: string;
}

export interface EnsStepOptions {
  /** A registration was already proposed from this Safe (persisted flag). */
  proposed?: boolean;
  /** The Safe has no records module to read or write on Base. The card reports
   *  that instead of a registration for a name that was never read. */
  moduleMissing?: string;
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

  // No module, no name: this outranks every registry answer, because nothing
  // here could be registered into a publication that has no records module.
  if (opts.moduleMissing) {
    return {
      kind: 'error',
      chain,
      canPropose: false,
      reason: opts.moduleMissing,
    };
  }

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
