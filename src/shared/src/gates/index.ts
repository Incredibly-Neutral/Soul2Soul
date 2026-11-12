// ============================================================================
// Gates — the protocol's answer to "may this happen?".
//
// These predicates are the rules, not the plumbing: each one asks the chain a
// fixed set of questions and combines the answers. The chain reads are
// injected as a `GateRead`, because the EVM interface belongs to the caller —
// a Lit Action reads through its own action-scoped provider, a browser reads
// through a wallet's RPC, a CLI through whatever it was configured with. This
// module never imports a provider, never holds a key, and never writes.
//
// GATES-4 is an OBLIGATION, not a prohibition: canPublish answers "would the
// publication accept this author?", and callers must also verify that the
// signature came from an owner of that author Safe. canRead and canPublish do
// that second check inline (the isOwner read), so the two together are what
// the protocol requires of anyone admitting a write.
//
// V3 splits the takedown in two. `retract` is the genesis author's verb and
// terminal: it ends the genesis, so `makeOffer` and `admit` revert `Ended()`
// afterwards. `reject` is the publication's verb and reversible: an agreement
// returns to the pending offer set and the safe may admit it again. Nothing in
// this module writes; `canReset` is the publication owner's authority to reject.
//
// Known gap (GATES-4, implementation shortfall): `retract` tests `genesisAuthor`
// only, so an author who has been removed from the whitelist can always end
// their own earlier work — "or has carried" is not yet enforced on-chain.
//
// `canRead` below asks the publication's own `canRead` — the contract decides
// which agreements, offers and reviewer sets count — and adds the author Safe's
// `isOwner`. A caller that wants the reviewer path alone asks `canReview`.
//
// Runtime note: the Lit Action runtime supplies ethers (an action's `require`
// resolves it, and a bare global is also present), which is what the default
// genesis normaliser uses. A host without ethers — a browser plugin, the
// safe-app, a CLI — must pass its own normaliser to canRead, or hand it an
// already-bytes32 id.
// ============================================================================

import { toBytes32Id } from '../manuscript/identity/contract-id';
import { isTrueAnswer, resolveAuthorModules } from './modules';
/**
 * Normalises a content reference into the bytes32 genesis the contract keys
 * deals by. The default hashes through ethers, which the Lit Action runtime
 * provides; other hosts pass their own.
 */
export type IdNormaliser = (ref: string) => string;

/**
 * A read against the EVM, as the caller implements it.
 * Returns the decoded boolean result of a view function.
 */
export type GateRead = (
  target: string,
  abi: string[],
  fn: string,
  args: unknown[],
) => Promise<boolean>;

/**
 * A read whose answer is not a boolean: an address, a block number, a list. The
 * caller decodes it; the gates narrow it. Module resolution and the historical
 * ownership read use this, a boolean read uses {@link GateRead}.
 */
export type GateValueRead = (
  target: string,
  abi: string[],
  fn: string,
  args: unknown[],
) => Promise<unknown>;

const CAN_PUBLISH_ABI = ['function canPublish(address _author) view returns (bool)'];
const IS_OWNER_ABI = ['function isOwner(address owner) view returns (bool)'];
/** OwnerHistoryModuleV1 — the author Safe's owner set, per block. */
const IS_OWNER_AT_ABI = ['function isOwnerAt(address who, uint256 blockNumber) view returns (bool)'];
const CAN_READ_ABI = ['function canRead(bytes32 genesis, address reader) view returns (bool)'];
const CAN_REVIEW_ABI = ['function canReview(bytes32 genesis, address who) view returns (bool)'];
/** DraftsModuleV1 — the author's own version log, installed on the author Safe. */
const AUTHOR_OF_ABI = ['function authorOf(bytes32 genesis) view returns (address)'];
/** DraftsModuleV1 — the block behind each version, index for index with history(). */
const BLOCKS_OF_ABI = ['function blocksOf(bytes32 genesis) view returns (uint64[] blocks)'];

const ZERO_ADDRESS = /^0x0{40}$/i;

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The block number of the last version of a genesis, or `undefined` when the
 * answer is not a block list at all. `uint64` answers arrive as numbers, decimal
 * strings or BigNumbers depending on the caller's decoder.
 */
const lastVersionBlock = (blocks: unknown): number | undefined => {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  const last = blocks[blocks.length - 1] as unknown;
  if (typeof last === 'number') return last;
  if (typeof last === 'string') {
    const parsed = Number(last);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (last && typeof (last as { toNumber?: unknown }).toNumber === 'function') {
    try {
      return (last as { toNumber: () => number }).toNumber();
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * Can this author Safe write to this publication, on behalf of this signer?
 *
 * Two questions, both required:
 *   - the publication admits the author Safe (`canPublish`)
 *   - the signer is an owner of that author Safe (`isOwner`)
 */
export const canPublish = async (
  read: GateRead,
  authorSafeAddress: string,
  publicationModule: string,
  signerAddress: string,
): Promise<boolean> => {
  const [canPublishResult, isOwner] = await Promise.all([
    read(publicationModule, CAN_PUBLISH_ABI, 'canPublish', [authorSafeAddress]),
    read(authorSafeAddress, IS_OWNER_ABI, 'isOwner', [signerAddress]),
  ]);

  return canPublishResult && isOwner;
};

/**
 * May this signer read this content item?
 *
 * Two questions, both required: the publication's own `canRead(genesis, safe)`
 * — it is the contract that decides which agreements, offers and reviewer sets
 * admit a reader — and the author Safe's `isOwner(signer)`. `contentId` is
 * normalised to bytes32 the same way the writes normalise it: an already-hashed
 * 0x+64hex id passes through, anything else (a raw CID, an objectId) is
 * keccak256-hashed. Pass `toId` when your host has no ethers.
 */
export const canRead = async (
  read: GateRead,
  contentId: string,
  safeAddress: string,
  publicationModule: string,
  signerAddress: string,
  toId: IdNormaliser = toBytes32Id,
): Promise<boolean> => {
  const genesis = toId(contentId);

  const [admitted, isOwner] = await Promise.all([
    read(publicationModule, CAN_READ_ABI, 'canRead', [genesis, safeAddress]),
    read(safeAddress, IS_OWNER_ABI, 'isOwner', [signerAddress]),
  ]);

  return admitted && isOwner;
};

/**
 * May this signer read this content item as a reviewer?
 *
 * The contract answers this itself: `who` is in the publication's reviewer set
 * and the genesis sits under an agreement or an offer. No `isOwner` read — a
 * reviewer is an address on the publication, not an owner of the author Safe.
 */
export const canReview = async (
  read: GateRead,
  contentId: string,
  publicationModule: string,
  signerAddress: string,
  toId: IdNormaliser = toBytes32Id,
): Promise<boolean> => {
  const genesis = toId(contentId);
  return read(publicationModule, CAN_REVIEW_ABI, 'canReview', [genesis, signerAddress]);
};

/**
 * Options for {@link owns}. Both are optional; the gate answers without either.
 */
export interface OwnsOptions {
  /**
   * `AuthorContractsFactory`. Supplied only to order the module probes; the
   * Safe's own enabled-module list remains the proof. See ./modules.ts.
   */
  factory?: string;
  /** Normaliser for a raw content reference. Defaults to the ethers one. */
  toId?: IdNormaliser;
}

/**
 * May this signer open this manuscript because it is theirs?
 *
 * The author branch of GATES-1, and it takes the author Safe, not a module,
 * because the Safe is the thing ownership is about. Three reads:
 *
 *   1. Resolve the Safe's two modules: the drafts log and the owner history,
 *      both proven by the Safe's own `getModulesPaginated` and by each module's
 *      `supportsInterface`. Two modules answering one role is a refusal.
 *   2. `authorOf(genesis)` on the drafts module must name the Safe it was given.
 *      A genesis another Safe kept is refused, and so is an unknown one (the
 *      module answers the zero address rather than reverting).
 *   3. Answer ownership from the history module at the block the genesis's last
 *      version was appended in: `isOwnerAt(signer, blocksOf(genesis).at(-1))`.
 *      A signer who was an owner then is admitted even if the Safe has since
 *      rotated them out, and a signer who became an owner afterwards is not.
 *
 * Known limit: a version written before `blockNumber` was recorded reads back
 * as block 0 (see DraftsModuleV1.Version), and an imported log has no block at
 * all. For those the gate falls back to the Safe's live `isOwner` — the present
 * tense — so a genesis appended before the upgrade cannot be judged against the
 * owner set it was written under. It is a fallback, not a second answer: block 0
 * is never a real append block.
 *
 * No publication is involved, so a draft that was never offered to anyone still
 * opens, and the fact survives the publication de-listing its author.
 *
 * A caller MUST also check the item it decrypted: `append` is `onlySafe`, but a
 * Safe can log any genesis with any ciphertext CID, so a genesis in the log only
 * says "this Safe kept this document here" — see
 * docs/specs/author/SPEC-author-drafts.md. Bind the blob by requiring
 * `public.author` to equal `authorSafe` before treating the ciphertext as that
 * author's.
 */
export const owns = async (
  read: GateRead,
  readValue: GateValueRead,
  genesis: string,
  authorSafe: string,
  signerAddress: string,
  options: OwnsOptions = {},
): Promise<boolean> => {
  const genesisId = (options.toId ?? toBytes32Id)(genesis);

  const modules = await resolveAuthorModules(read, readValue, authorSafe, {
    factory: options.factory,
  });
  if (!modules.ok) return false;

  const author = await readValue(modules.drafts, AUTHOR_OF_ABI, 'authorOf', [genesisId]);

  // Unknown genesis: DraftsModuleV1 returns a zeroed Entry rather than
  // reverting, so this is the "no such draft" case, not a broken read.
  if (typeof author !== 'string' || author === '' || ZERO_ADDRESS.test(author)) return false;

  // The module must name the Safe this gate was asked about. A genesis kept in
  // another Safe's log is not this Safe's, however the caller labelled it.
  if (!sameAddress(author, authorSafe)) return false;

  const blockNumber = lastVersionBlock(
    await readValue(modules.drafts, BLOCKS_OF_ABI, 'blocksOf', [genesisId]),
  );
  // A log that answers no block list is not the pre-upgrade case (which answers
  // a list of zeros); it is a read this gate cannot decide on.
  if (blockNumber === undefined) return false;

  if (blockNumber === 0) {
    // Pre-upgrade or imported version: no block to judge the owner set at.
    return read(authorSafe, IS_OWNER_ABI, 'isOwner', [signerAddress]);
  }

  return isTrueAnswer(
    await readValue(modules.ownerHistory, IS_OWNER_AT_ABI, 'isOwnerAt', [signerAddress, blockNumber]),
  );
};

export * from './modules';

/**
 * May this signer reset the publication's tree?
 *
 * A reset is STRICTER than a publish: only an owner of the PUBLICATION Safe
 * may nuke the tree — not merely an owner of a whitelisted author Safe. Note
 * this is an ADDITION (see docs/protocol/gates.md): the protocol text requires
 * the publication's owner to be able to reject an author's work — the
 * reversible takedown, since `retract` belongs to the author — and does not say
 * who may rebuild the whole tree.
 */
export const canReset = async (
  read: GateRead,
  multisig: string,
  signerAddress: string,
): Promise<boolean> => {
  return read(multisig, IS_OWNER_ABI, 'isOwner', [signerAddress]);
};