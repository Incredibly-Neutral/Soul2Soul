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
// Ownership is one question asked at a block: was `who` an owner of `safe` at
// `blockNumber`? `isOwnerAt` is the only place that question is answered, and
// every gate that needs it asks it there. No block is the present tense — the
// Safe's live `isOwner` — and that is the only reading of it the module has.
//
// GATES-4 is an OBLIGATION, not a prohibition: canPublish answers "would the
// publication accept this author?", and callers must also verify that the
// signature came from an owner of that author Safe. canPublish and canRead ask
// `isOwnerAt` for that, so the two together are what the protocol requires of
// anyone admitting a write.
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
// which agreements, offers and reviewer sets count — and asks the author Safe's
// ownership at the block its last version was appended in. A caller that wants
// the reviewer path alone asks `canReview`.
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
 * caller decodes it; the gates narrow it. Module resolution uses this; a
 * boolean read uses {@link GateRead}.
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
/** DraftsModuleV1 — the block behind each version, index for index with history(). */
const BLOCKS_OF_ABI = ['function blocksOf(bytes32 genesis) view returns (uint64[] blocks)'];
/** DealsModuleV1 — whether an agreement on this genesis is in force. */
const HAS_DEAL_ABI = ['function hasDeal(bytes32 genesis) view returns (bool)'];

/**
 * The block number of the last version of a genesis, or `undefined` when the
 * answer is not a block list at all. `uint64` answers arrive as numbers, decimal
 * strings or BigNumbers depending on the caller's decoder.
 */
export const lastVersionBlock = (blocks: unknown): number | undefined => {
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
 * Was `who` an owner of `safe` at `blockNumber`?
 *
 * No block, or block 0, is the present tense: the Safe's live `isOwner`. Block 0
 * is what a version written before the drafts log recorded a block reads back
 * as, and what an imported log carries; it is never a real append block, so it
 * is not a height to judge at.
 *
 * A block above 0 needs the Safe's `OwnerHistoryModuleV1` to be judged against.
 * With none supplied the answer is false: the gate cannot decide, and false is
 * the refusal — not a fall back to the live owner set, which would answer a
 * different question than the one asked.
 */
export const isOwnerAt = async (
  read: GateRead,
  safe: string,
  who: string,
  blockNumber?: number,
  ownerHistory?: string,
): Promise<boolean> => {
  if (!blockNumber) return read(safe, IS_OWNER_ABI, 'isOwner', [who]);
  if (!ownerHistory) return false;
  return isTrueAnswer(
    await read(ownerHistory, IS_OWNER_AT_ABI, 'isOwnerAt', [who, blockNumber]),
  );
};

/**
 * Ownership of a Safe by a signer, at the block a genesis was last appended in.
 *
 * The block is the history module's to answer, so the Safe's modules are
 * resolved first. A Safe whose modules cannot be resolved names no block, and
 * `isOwnerAt` then answers the present tense.
 */
const ownershipAtAppendBlock = async (
  read: GateRead,
  readValue: GateValueRead,
  safe: string,
  genesis: string,
  who: string,
): Promise<boolean> => {
  const modules = await resolveAuthorModules(read, readValue, safe);
  if (!modules.ok) return isOwnerAt(read, safe, who);
  const block = lastVersionBlock(
    await readValue(modules.drafts, BLOCKS_OF_ABI, 'blocksOf', [genesis]),
  );
  return isOwnerAt(read, safe, who, block, modules.ownerHistory);
};

/**
 * Can this author Safe write to this publication, on behalf of this signer?
 *
 * Two questions, both required:
 *   - the publication admits the author Safe (`canPublish`)
 *   - the signer owns that author Safe now (`isOwnerAt`, no block)
 *
 * The ownership question is present-tense here because a write is being
 * admitted now: the signer is signing the append, not standing behind one made
 * earlier.
 */
export const canPublish = async (
  read: GateRead,
  authorSafeAddress: string,
  publicationModule: string,
  signerAddress: string,
): Promise<boolean> => {
  const [canPublishResult, isOwner] = await Promise.all([
    read(publicationModule, CAN_PUBLISH_ABI, 'canPublish', [authorSafeAddress]),
    isOwnerAt(read, authorSafeAddress, signerAddress),
  ]);

  return canPublishResult && isOwner;
};

/**
 * May this signer read this content item?
 *
 * Two questions, both required: the publication's own `canRead(genesis, safe)`
 * — it is the contract that decides which agreements, offers and reviewer sets
 * admit a reader — and ownership of this Safe by this signer, judged at the
 * block the genesis's last version was appended in.
 *
 * The ownership answer is historical because the content is: a key rotated out
 * of the Safe keeps what it wrote, and a key added afterwards does not inherit
 * it. The block comes from the Safe's own drafts log (`blocksOf(genesis)`, last
 * entry). When the Safe's modules cannot be resolved there is no block to judge
 * at, and the live `isOwner` answers instead.
 *
 * `contentId` is normalised to bytes32 the same way the writes normalise it: an
 * already-hashed 0x+64hex id passes through, anything else (a raw CID, an
 * objectId) is keccak256-hashed. Pass `toId` when your host has no ethers.
 */
export const canRead = async (
  read: GateRead,
  readValue: GateValueRead,
  contentId: string,
  safeAddress: string,
  publicationModule: string,
  signerAddress: string,
  toId: IdNormaliser = toBytes32Id,
): Promise<boolean> => {
  const genesis = toId(contentId);

  const [admitted, isOwner] = await Promise.all([
    read(publicationModule, CAN_READ_ABI, 'canRead', [genesis, safeAddress]),
    ownershipAtAppendBlock(read, readValue, safeAddress, genesis, signerAddress),
  ]);

  return admitted && isOwner;
};

/**
 * May this signer read this content item as a reviewer?
 *
 * The contract answers this itself: `who` is in the publication's reviewer set
 * and the genesis sits under an agreement or an offer. No ownership read — a
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

export * from './modules';

/**
 * May this signer reset the publication's tree?
 *
 * A reset is STRICTER than a publish: only an owner of the PUBLICATION Safe
 * may nuke the tree — not merely an owner of a whitelisted author Safe. The
 * ownership question is present-tense: a reset is asked for now, by the signer
 * asking.
 *
 * Note this is an ADDITION (see docs/specs/gates/SPEC-gates.md): the protocol
 * text requires the publication's owner to be able to reject an author's
 * work — the reversible takedown, since `retract` belongs to the author — and
 * does not say who may rebuild the whole tree.
 */
export const canReset = async (
  read: GateRead,
  multisig: string,
  signerAddress: string,
): Promise<boolean> => isOwnerAt(read, multisig, signerAddress);

/**
 * Is this genesis out of force on this publication?
 *
 * The subtractive side of the tree rules. The published tree is built from the
 * agreements in force, so a page whose genesis is out of force must not be on
 * it, and removing that page is a repair rather than an exercise of authority —
 * which is why it needs no permission. GATES-4 is what makes the repair
 * reachable: an author's page can be out of force while the press still carries
 * it (`has carried`), so the author is asked for a build of a site that no
 * longer holds their manuscript.
 *
 * `genesis` is already bytes32. The caller normalises a content reference with
 * `toBytes32Id`; this gate hashes nothing.
 *
 * True only on a definitive `false` from `hasDeal`. A read that throws answers
 * false: a transport error must never make a live page look removable.
 */
export const isOutOfForce = async (
  read: GateRead,
  genesis: string,
  publicationModule: string,
): Promise<boolean> => {
  try {
    return (await read(publicationModule, HAS_DEAL_ABI, 'hasDeal', [genesis])) === false;
  } catch {
    return false;
  }
};
