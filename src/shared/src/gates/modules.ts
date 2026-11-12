// ============================================================================
// Module resolver — which two modules does this author Safe actually run?
//
// An author Safe carries the drafts log (`DraftsModuleV1`) and the owner history
// (`OwnerHistoryModuleV1`), each a proxy minted for that Safe. Nothing on chain
// says "this is the drafts module of Safe X": the role is not stored in a
// registry and the factory's index is written by a permissionless `create`, so
// an index entry proves only that someone deployed a proxy and named a Safe.
//
// Two chain facts do the proving, and this module asks for both:
//   - the Safe's own enabled-module list (`getModulesPaginated`), which only the
//     Safe writes, is the set a module can be resolved out of;
//   - `supportsInterface` on each enabled module answers the role, against the
//     ERC-165 id that is a compile-time constant of the deployed bytecode.
//
// A factory prediction (`draftsModuleAddress`, `ownerHistoryModuleAddress`) is a
// hint and only a hint: it orders the probes and names the address the factory
// would deploy next. A predicted address that is enabled still has to answer
// `supportsInterface` for its role, and an enabled module that answers the role
// but is not the predicted one is the one used. Two enabled modules answering
// the same role is a refusal, never a choice: a Safe that runs two drafts logs
// has no single answer to "whose is this genesis", and picking one would make
// the gate depend on probe order.
//
// Cost per lookup, because a Lit Action session has a request cap: one eth_call
// per page of enabled modules (page size 100), two per enabled module (one per
// role), and two more when a factory address is supplied for the predictions.
// A Safe with three enabled modules costs 7 calls, or 9 with the factory. Every
// call is on the L2 the caller's read talks to, and nothing is cached between
// calls: a stale module answer is the failure this exists to avoid.
// ============================================================================

import type { GateRead, GateValueRead } from './index';

/**
 * ERC-165 ids of the two author-side roles, as constants of the deployed
 * implementations (`IDraftsModule` / `IOwnerHistoryModule` in
 * `src/author/contracts/src`). Computed from the generated ABIs' selectors; the
 * values are checked in `modules.test.ts` rather than trusted here.
 */
export const DRAFTS_MODULE_INTERFACE_ID = '0xefb74036';
export const OWNER_HISTORY_MODULE_INTERFACE_ID = '0xee855023';

/** The ERC-165 query itself; a module may also answer this, which proves nothing. */
export const ERC165_INTERFACE_ID = '0x01ffc9a7';

/** `getModulesPaginated`'s start sentinel: the Safe's own list head. */
const SENTINEL = '0x0000000000000000000000000000000000000001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Large enough that a normal author Safe is one page, and a walk is bounded. */
const PAGE_SIZE = 100;
/** A Safe with more than this many pages is not an author Safe; stop reading. */
const MAX_PAGES = 32;

const GET_MODULES_ABI = [
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
];
const SUPPORTS_INTERFACE_ABI = [
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
];
const PREDICTION_ABI = [
  'function draftsModuleAddress(address safe) view returns (address)',
  'function ownerHistoryModuleAddress(address safe) view returns (address)',
];

/** Why a lookup answered nothing. Each is a refusal, never a fallback. */
export type AuthorModulesError =
  | 'unreadable-module-list'
  | 'no-enabled-modules'
  | 'no-drafts-module'
  | 'ambiguous-drafts-module'
  | 'no-owner-history-module'
  | 'ambiguous-owner-history-module';

export type AuthorModules =
  | {
      ok: true;
      /** The one enabled module answering the drafts role id. */
      drafts: string;
      /** The one enabled module answering the owner-history role id. */
      ownerHistory: string;
      /** eth_calls this lookup made, so a caller can budget a session. */
      reads: number;
    }
  | { ok: false; error: AuthorModulesError; reads: number };

export interface ResolveAuthorModulesOptions {
  /**
   * `AuthorContractsFactory`. When given, its two predictions are read first and
   * only order the probes; when omitted the lookup costs two calls less and
   * starts from the Safe's list order.
   */
  factory?: string;
  /** Modules per page. Lowering it only adds pages, i.e. calls. */
  pageSize?: number;
}

const isAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const isZeroish = (value: unknown): boolean =>
  !isAddress(value) || sameAddress(value, ZERO_ADDRESS) || sameAddress(value, SENTINEL);

/** `getModulesPaginated` decodes as `[array, next]`, or as named members. */
const readPage = (page: unknown): { list: string[]; next: unknown } | undefined => {
  if (!Array.isArray(page) || page.length < 2) return undefined;
  const list = Array.isArray(page[0])
    ? (page[0] as unknown[]).filter(isAddress)
    : undefined;
  if (!list) return undefined;
  return { list, next: page[1] };
};

/** A boolean answer from a read that may hand back a string or a number. */
export const isTrueAnswer = (value: unknown): boolean =>
  value === true || value === 'true' || value === 1 || value === '1';

/**
 * One `supportsInterface` question. A module that reverts (no ERC-165, a proxy
 * mid-upgrade, a contract that is not a module at all) answers "no": the call is
 * spent either way, and a broken module must not break the lookup for the others.
 */
const answersRole = async (
  read: GateRead,
  module: string,
  interfaceId: string,
): Promise<boolean> => {
  try {
    return isTrueAnswer(
      await read(module, SUPPORTS_INTERFACE_ABI, 'supportsInterface', [interfaceId]),
    );
  } catch {
    return false;
  }
};

/**
 * Find the drafts module and the owner-history module of `authorSafe`.
 *
 * The Safe's enabled-module answer is the proof; the factory prediction is only
 * a probe order. Cache nothing: the same Safe can be re-read after an owner
 * enables or disables a module, and the answer must follow the chain.
 */
export const resolveAuthorModules = async (
  read: GateRead,
  readValue: GateValueRead,
  authorSafe: string,
  options: ResolveAuthorModulesOptions = {},
): Promise<AuthorModules> => {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  let reads = 0;

  // The predictions: two calls, never proof. Their only effect is probe order.
  let predictedDrafts: string | undefined;
  let predictedOwnerHistory: string | undefined;
  if (options.factory) {
    try {
      const [drafts, ownerHistory] = await Promise.all([
        readValue(options.factory, PREDICTION_ABI, 'draftsModuleAddress', [authorSafe]),
        readValue(options.factory, PREDICTION_ABI, 'ownerHistoryModuleAddress', [authorSafe]),
      ]);
      reads += 2;
      if (isAddress(drafts)) predictedDrafts = drafts;
      if (isAddress(ownerHistory)) predictedOwnerHistory = ownerHistory;
    } catch {
      // A factory that does not answer is not a reason to refuse: the Safe's own
      // list still resolves the modules.
      reads += 2;
    }
  }

  // The Safe's own list: the set a module is resolved out of.
  const enabled: string[] = [];
  let cursor: unknown = SENTINEL;
  for (let page = 0; page < MAX_PAGES; page++) {
    let raw: unknown;
    try {
      raw = await readValue(authorSafe, GET_MODULES_ABI, 'getModulesPaginated', [cursor, pageSize]);
    } catch {
      reads += 1;
      return { ok: false, error: 'unreadable-module-list', reads };
    }
    reads += 1;

    const decoded = readPage(raw);
    if (!decoded) return { ok: false, error: 'unreadable-module-list', reads };

    for (const module of decoded.list) {
      if (!enabled.some((seen) => sameAddress(seen, module))) enabled.push(module);
    }

    if (isZeroish(decoded.next)) break;
    if (decoded.list.length === 0) break;
    cursor = decoded.next;
  }

  if (enabled.length === 0) return { ok: false, error: 'no-enabled-modules', reads };

  // Probes: the predicted addresses that are actually enabled go first (they are
  // what the factory would deploy, so they are usually the hit), then the rest of
  // the Safe's list. A prediction that is not enabled is never probed: the list
  // is what makes a module the Safe's. Every enabled module is asked both roles,
  // because a second claimant is exactly what must be refused and only the full
  // set can show one.
  const ordered = (() => {
    const head = [predictedDrafts, predictedOwnerHistory].filter(
      (predicted): predicted is string =>
        isAddress(predicted) && enabled.some((module) => sameAddress(module, predicted)),
    );
    const tail = enabled.filter((module) => !head.some((seen) => sameAddress(seen, module)));
    return [...head, ...tail];
  })();

  const draftsClaimants: string[] = [];
  const ownerHistoryClaimants: string[] = [];
  for (const module of ordered) {
    const [isDrafts, isOwnerHistory] = await Promise.all([
      answersRole(read, module, DRAFTS_MODULE_INTERFACE_ID),
      answersRole(read, module, OWNER_HISTORY_MODULE_INTERFACE_ID),
    ]);
    reads += 2;
    if (isDrafts) draftsClaimants.push(module);
    if (isOwnerHistory) ownerHistoryClaimants.push(module);
  }

  if (draftsClaimants.length === 0) return { ok: false, error: 'no-drafts-module', reads };
  if (draftsClaimants.length > 1) return { ok: false, error: 'ambiguous-drafts-module', reads };
  if (ownerHistoryClaimants.length === 0) {
    return { ok: false, error: 'no-owner-history-module', reads };
  }
  if (ownerHistoryClaimants.length > 1) {
    return { ok: false, error: 'ambiguous-owner-history-module', reads };
  }

  return {
    ok: true,
    drafts: draftsClaimants[0],
    ownerHistory: ownerHistoryClaimants[0],
    reads,
  };
};
