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
// signature came from an owner of that author Safe. canPublish asks `isOwnerAt`
// for that and canRead asks `canAuthor`, so the two together are what the
// protocol requires of anyone admitting a write.
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
// `canAuthor` is the author-side gate: it asks the whole GATES-1 question about
// one genesis — the Safe's modules, the drafts log's `authorOf`, and ownership
// at the append block — and its verdict form reports what it read. A caller that
// needs the module answers and the judged block as well as yes or no asks
// `canAuthorVerdict`: the decrypt action reads the draft entry from the module
// the verdict names, at the block it names when it names one.
//
// `canRead` asks the publication's own `canRead` — the contract decides which
// agreements, offers and reviewer sets count — and then asks `canAuthor`, its
// ownership half. A caller that wants the reviewer path alone asks `canReview`.
//
// `canPreview` is the gate for opening a manuscript before the offer is
// accepted. All three admitted paths require the genesis to sit under an
// agreement or an offer, so a preview never outlives the deal: a genesis the
// publication never recorded, or whose offer is over, is refused even to its
// author. The identities are the reader who may review (the contract's
// `canReview`, which already requires agreement or offer), the manuscript's
// author (the publication's recorded `authorOf` names the author Safe, the
// drafts log must then name the same Safe, and `canAuthor` judges its owner at
// the append block), and the owner of the publication Safe (live `isOwner` of
// the module's `safe()`).
//
// Runtime note: the Lit Action runtime supplies ethers (an action's `require`
// resolves it, and a bare global is also present), which is what the default
// genesis normaliser uses. A host without ethers — a browser plugin, the
// safe-app, a CLI — must pass its own normaliser to canRead, or hand it an
// already-bytes32 id.
// ============================================================================

import { toBytes32Id } from '../manuscript/identity/contract-id';
import { isTrueAnswer, resolveAuthorModules, type AuthorModulesError } from './modules';
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
/**
 * DraftsModuleV1 and S2SPublicationModuleV0_1 — the recorded author of a
 * genesis. Both expose the same getter; a preview asks the publication, where
 * the first `makeOffer` writes it, and `canAuthor` asks the author Safe's
 * drafts log.
 */
const AUTHOR_OF_ABI = ['function authorOf(bytes32 genesis) view returns (address)'];
/** DraftsModuleV1 — the block behind each version, index for index with history(). */
const BLOCKS_OF_ABI = ['function blocksOf(bytes32 genesis) view returns (uint64[] blocks)'];
/** S2SPublicationModuleV0_1 — whether an agreement on this genesis is in force. */
const HAS_AGREEMENT_ABI = ['function hasAgreement(bytes32 genesis) view returns (bool)'];
/** S2SPublicationModuleV0_1 — whether an offer on this genesis is still open. */
const HAS_OFFER_ABI = ['function hasOffer(bytes32 genesis) view returns (bool)'];
/** S2SPublicationModuleV0_1 — the publication Safe this module serves. */
const SAFE_ABI = ['function safe() view returns (address)'];

const ZERO_ADDRESS = /^0x0{40}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

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
 * Options for {@link canAuthor}. Both are optional; the gate answers without
 * either.
 */
export interface CanAuthorOptions {
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
 * The author branch of GATES-1, and the author-side half of {@link canRead}:
 * `canRead` asks the publication to admit the reader and then asks this
 * question; `canAuthor` asks only this one, because a draft was never offered
 * to anyone and no agreement is involved. It takes the author Safe, not a
 * module, because the Safe is the thing ownership is about.
 *
 * Three reads:
 *
 *   1. Resolve the Safe's two modules: the drafts log and the owner history,
 *      both proven by the Safe's own `getModulesPaginated` and by each module's
 *      `supportsInterface`. Two modules answering one role is a refusal, and so
 *      is a list that cannot be read: without the drafts log there is no
 *      `authorOf` to ask and no height to judge at, so an unresolvable Safe is
 *      refused rather than answered from its live owner set. The owner history
 *      is optional here, because only a positive block needs it; a Safe that
 *      runs none is refused at such a block and answered live at no height.
 *   2. `authorOf(genesis)` on the drafts log must name the Safe it was given.
 *      A genesis another Safe kept is refused, and so is an unknown one (the
 *      module answers the zero address rather than reverting).
 *   3. Answer ownership, and say which set answered. Where the log records the
 *      block the last version was appended in — a finite block greater than 0 —
 *      the owner-history module answers `isOwnerAt(signer, block)`: a signer who
 *      was an owner then is admitted even if the Safe has since rotated them
 *      out, and a signer who became an owner afterwards is not. Where the log
 *      records 0 (a version written before `blockNumber` existed, or one carried
 *      in by `absorb()`) or answers no usable block list, the Safe's live
 *      `isOwner(signer)` answers, read inside this function: a missing height
 *      must not deny access. That is the only path on which the present tense
 *      answers, and its answer changes when owners rotate. A positive block with
 *      no owner-history module is a refusal: nothing can say who owned the Safe
 *      then, and the live set answers a different question.
 *
 * One question, one answer: {@link CanAuthorVerdict} carries what the gate read,
 * so a caller that needs the modules, the entry author or the judged block takes
 * them from the answer instead of reading them again.
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
export const canAuthor = async (
  read: GateRead,
  readValue: GateValueRead,
  genesis: string,
  authorSafe: string,
  signerAddress: string,
  options: CanAuthorOptions = {},
): Promise<boolean> =>
  (await canAuthorVerdict(read, readValue, genesis, authorSafe, signerAddress, options)).ok;

/**
 * What {@link canAuthor} decided, and what it decided it from.
 *
 * `block` is the append block of the genesis's last version, reported wherever
 * the log answered one:
 *
 *   - `blocksOf` answers a block of N: `block: N`, owner answer `isOwnerAt`.
 *   - `blocksOf` answers a block of 0 (pre-upgrade or imported): `block: 0`,
 *     owner answer the Safe's live `isOwner`, which is read inside the gate.
 *   - `blocksOf` answers no usable list: no `block`, owner answer the Safe's
 *     live `isOwner`.
 *
 * It is reported on the refusal a positive block meets when the Safe runs no
 * owner-history module, because that block is what could not be judged. It is
 * NOT reported on the refusals that never reach `blocksOf`: a module list that
 * cannot be resolved or is ambiguous, a genesis the drafts log does not name
 * (zeroed `authorOf`), and a genesis the log names for another Safe.
 *
 * `ownerSet` names the owner set the answer came from. It is present on every
 * path that reached an answer, including the no-usable-list path, where `block`
 * is not reported:
 *
 *   - `'append-block'`: the owner-history module answered `isOwnerAt` at the
 *     block `block` reports. The tenure is the one at the append.
 *   - `'live'`: the log recorded no positive block, so the Safe's own
 *     `isOwner` answered, read at head. `block` is 0 when the log answered 0,
 *     and absent when it answered no usable list. This is the only path on
 *     which the present tense answers, and its answer moves with each rotation.
 *
 * It is a string rather than a second boolean so that a reader of a trace can
 * tell the two paths apart without holding the block-0 rule in their head.
 *
 * `modules` and `author` are what the gate had already read when it decided, so
 * a caller that needs the same two answers does not resolve them again — a
 * second lookup would spend chain calls and, if the Safe's module set rotated
 * in between, judge the entry against a different log. `modules` is absent
 * exactly when the lookup answered nothing, and `modulesError` then says why.
 * `modules.ownerHistory` is absent when the Safe runs no owner-history module:
 * that is no reason to refuse on its own, and `modulesError:
 * 'no-owner-history-module'` appears only where a positive block needed it.
 * `author` is absent when the drafts log names no author for the genesis, and
 * present (as the log's own answer) whenever it named one, including another
 * Safe's.
 */
export interface CanAuthorVerdict {
  ok: boolean;
  block?: number;
  /** Which owner set answered: the append block's, or the Safe's live one. */
  ownerSet?: 'append-block' | 'live';
  /** `ownerHistory` is absent when the Safe runs no owner-history module. */
  modules?: { drafts: string; ownerHistory?: string };
  modulesError?: AuthorModulesError;
  author?: string;
}

/**
 * The three reads of {@link canAuthor}, reporting the block they were judged at
 * and the module answers they were judged from.
 *
 * The block is reported so a caller can read the entry at the same block it was
 * judged at: the owner set the gate tested is the one at that block, and a
 * version appended since then would be read at the head instead. It is reported
 * on a refusal too, so a caller that was refused at block N can still say which
 * block it was refused at. See {@link CanAuthorVerdict} for the exact paths.
 */
export const canAuthorVerdict = async (
  read: GateRead,
  readValue: GateValueRead,
  genesis: string,
  authorSafe: string,
  signerAddress: string,
  options: CanAuthorOptions = {},
): Promise<CanAuthorVerdict> =>
  authorVerdict(
    read,
    readValue,
    (options.toId ?? toBytes32Id)(genesis),
    authorSafe,
    signerAddress,
    options.factory,
  );

/**
 * The reads themselves, over a genesis already normalised to bytes32. Callers
 * that normalise on their own — `canRead`, which answers its publication
 * question about the same id — come here directly, so no id is hashed twice.
 */
const authorVerdict = async (
  read: GateRead,
  readValue: GateValueRead,
  genesisId: string,
  authorSafe: string,
  signerAddress: string,
  factory?: string,
): Promise<CanAuthorVerdict> => {
  const modules = await resolveAuthorModules(read, readValue, authorSafe, {
    factory,
    // Only a positive block needs the owner history; a Safe that runs none must
    // still answer the present-tense path.
    ownerHistoryOptional: true,
  });
  if (!modules.ok) return { ok: false, modulesError: modules.error };

  const resolved = {
    drafts: modules.drafts,
    ...(modules.ownerHistory ? { ownerHistory: modules.ownerHistory } : {}),
  };
  const author = await readValue(modules.drafts, AUTHOR_OF_ABI, 'authorOf', [genesisId]);

  // Unknown genesis: DraftsModuleV1 returns a zeroed Entry rather than
  // reverting, so this is the "no such draft" case, not a broken read.
  if (typeof author !== 'string' || author === '' || ZERO_ADDRESS.test(author)) {
    return { ok: false, modules: resolved };
  }

  // The module must name the Safe this gate was asked about. A genesis kept in
  // another Safe's log is not this Safe's, however the caller labelled it.
  if (!sameAddress(author, authorSafe)) return { ok: false, modules: resolved, author };

  const block = lastVersionBlock(
    await readValue(modules.drafts, BLOCKS_OF_ABI, 'blocksOf', [genesisId]),
  );

  if (block === undefined || block === 0) {
    // No height to judge the owner set at: a version written before the block
    // was recorded, a version carried in by an import, or a log that answers no
    // usable list. A missing height is not a denial, so the Safe's live owner
    // set answers — the only path on which the present tense does. The verdict
    // says so, and reports the 0 when the log gave one.
    return {
      ok: await isOwnerAt(read, authorSafe, signerAddress),
      ...(block === 0 ? { block } : {}),
      ownerSet: 'live',
      modules: resolved,
      author,
    };
  }

  // A positive block with no owner-history module: nothing can say who owned the
  // Safe then, and the live set answers a different question.
  if (!modules.ownerHistory) {
    return {
      ok: false,
      block,
      modulesError: 'no-owner-history-module',
      modules: resolved,
      author,
    };
  }

  return {
    ok: await isOwnerAt(read, authorSafe, signerAddress, block, modules.ownerHistory),
    block,
    ownerSet: 'append-block',
    modules: resolved,
    author,
  };
};

/**
 * May this signer read this content item?
 *
 * The publication's own `canRead(genesis, reader)` decides which agreements,
 * offers and reviewer lists admit the reader, and only three identities are ever
 * admitted: the publication Safe, the genesis author, and a reviewer. The signer
 * must then prove they own one of them.
 *
 * The genesis author's Safe is judged by {@link canAuthor}, at the append block:
 * the author's right outlives a rotation, and does not open to a key added
 * afterwards. Every other admitted reader, the publication Safe and a reviewer
 * alike, is judged live: they are holders now or they are not, and neither runs
 * the drafts or history modules the author's read needs. Refusing the holder
 * would let `canRead` veto a build the protocol owes (GATES-4).
 *
 * The author half's block, its live answer where the log records no height, and
 * its refusals are `canAuthor`'s, stated there once and not repeated here.
 *
 * `contentId` is normalised to bytes32 the same way the writes normalise it: an
 * already-hashed 0x+64hex id passes through, anything else (a raw CID, an
 * objectId) is keccak256-hashed. Pass `toId` when your host has no ethers. The
 * one normalised id answers every question.
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

  const [admitted, isAuthor] = await Promise.all([
    read(publicationModule, CAN_READ_ABI, 'canRead', [genesis, safeAddress]),
    authorVerdict(read, readValue, genesis, safeAddress, signerAddress),
  ]);

  if (!admitted) return false;
  if (isAuthor.ok) return true;

  // The verdict named the genesis for the Safe we asked about: that Safe is the
  // author's, so the append-block answer is the whole answer. A newer owner does
  // not inherit the read.
  if (isAuthor.author && sameAddress(isAuthor.author, safeAddress)) return false;

  // Any other admitted reader is the publication Safe or a reviewer Safe, and
  // the proof is ownership of the Safe that was named, read live. `isOwnerAt`
  // with no block is exactly `isOwner`; the block never applies to these Safes.
  return isOwnerAt(read, safeAddress, signerAddress);
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

/** A boolean answer read defensively: a throw or any non-`true` refuses. */
const answeredTrue = async (question: () => Promise<boolean>): Promise<boolean> => {
  try {
    return ((await question()) as unknown) === true;
  } catch {
    return false;
  }
};

/**
 * May this signer open this manuscript as a preview, before the offer is
 * accepted?
 *
 * A preview is the step between an offer and an agreement: the reader wants to
 * see the manuscript, and the author has not accepted yet. Every path requires
 * the genesis to sit under an agreement or an offer, because a preview must not
 * outlive the deal. A genesis the publication never recorded, or whose offer is
 * over, is refused to everyone.
 *
 * Three identities are admitted, and they are asked in this order:
 *
 *   - A listed reviewer. The contract's `canReview(genesis, who)` answers this,
 *     and it already requires the genesis to sit under an agreement or an
 *     offer. No ownership read: a reviewer is an address on the publication.
 *     A true answer is the admission on its own; the agreement and offer reads
 *     run alongside it and cannot undo it.
 *   - The manuscript's author. The publication's `authorOf(genesis)` names its
 *     recorded author of the genesis, not the writer of any particular append.
 *     The drafts log must then name that same Safe, and {@link canAuthor}
 *     answers whether the signer owned it at the append block. An `authorOf`
 *     that answers nothing usable (a missing answer, a non-address, the zero
 *     address) refuses this path only, and so does a drafts log that names
 *     another Safe.
 *   - An owner of the publication Safe. The module names that Safe in its own
 *     `safe()` getter; ownership is asked live, because a preview is asked for
 *     now.
 *
 * The agreement and offer reads come first, together with the reviewer
 * question: when neither is true, the preview is refused before any author or
 * Safe read is spent. A failed agreement or offer read is a refusal, not a
 * fall-open. A reviewer yes is still admitted on its own, because the
 * contract's condition already implies agreement-or-offer and the extra two
 * reads must not undo it.
 *
 * The difference from {@link canRead}: `canRead` admits the author at the append
 * block and every other reader live.
 *
 * The reads are ordered: `canReview`, `hasAgreement` and `hasOffer` in
 * parallel; `authorOf` and `safe()` in parallel only when one of the two holds;
 * `canAuthor`'s reads only when `authorOf` named a usable Safe, and `isOwnerAt`
 * on the publication Safe only when the author path answered false. A read
 * failure is never a way in: a throw or a non-boolean answer refuses the path
 * it was asked on, and an `authorOf` or `safe()` that is not a usable address
 * (or is the zero address) refuses its path.
 *
 * `contentId` is normalised as {@link canRead} normalises it; pass `toId` when
 * your host has no ethers.
 */
export const canPreview = async (
  read: GateRead,
  readValue: GateValueRead,
  contentId: string,
  publicationModule: string,
  signerAddress: string,
  toId: IdNormaliser = toBytes32Id,
): Promise<boolean> => {
  const genesis = toId(contentId);

  // The deal question, asked with the reviewer's. Every path needs an
  // agreement or an offer, so neither answer true refuses before any other read
  // is spent. A failed read answers false here: a refusal, not a fall-open.
  const [reviewerAnswer, agreementAnswer, offerAnswer] = await Promise.allSettled([
    read(publicationModule, CAN_REVIEW_ABI, 'canReview', [genesis, signerAddress]),
    read(publicationModule, HAS_AGREEMENT_ABI, 'hasAgreement', [genesis]),
    read(publicationModule, HAS_OFFER_ABI, 'hasOffer', [genesis]),
  ]);

  // A reviewer yes is the admission on its own. The contract's condition
  // already requires an agreement or an offer, so the two reads alongside it
  // must not undo it.
  if (reviewerAnswer.status === 'fulfilled' && (reviewerAnswer.value as unknown) === true)
    return true;

  const held =
    (agreementAnswer.status === 'fulfilled' && (agreementAnswer.value as unknown) === true) ||
    (offerAnswer.status === 'fulfilled' && (offerAnswer.value as unknown) === true);
  if (!held) return false;

  // The author and owner paths, asked together: `authorOf` is the publication's
  // recorded author of the genesis, `safe()` is the publication Safe.
  const [authorAnswer, safeAnswer] = await Promise.allSettled([
    readValue(publicationModule, AUTHOR_OF_ABI, 'authorOf', [genesis]),
    readValue(publicationModule, SAFE_ABI, 'safe', []),
  ]);

  // The author path. `authorOf` names the publication's recorded author, not the
  // writer of an append; a missing, malformed or zeroed answer refuses this path
  // only, because the owner path below may still admit. `authorVerdict` is
  // `canAuthor` over the id already normalised, so the id is not hashed twice,
  // and it asks the drafts log to name the same Safe.
  const authorSafe = authorAnswer.status === 'fulfilled' ? authorAnswer.value : undefined;
  if (typeof authorSafe === 'string' && ADDRESS.test(authorSafe) && !ZERO_ADDRESS.test(authorSafe)) {
    const isAuthor = await answeredTrue(async () =>
      (await authorVerdict(read, readValue, genesis, authorSafe, signerAddress)).ok,
    );
    if (isAuthor) return true;
  }

  // The owner path, reached only when the author path did not admit. It needs a
  // real Safe to ask. A module that answers nothing or whose read failed, a
  // non-address, or the zero address cannot make its answer an owner's.
  const publicationSafe = safeAnswer.status === 'fulfilled' ? safeAnswer.value : undefined;
  if (typeof publicationSafe !== 'string' || !ADDRESS.test(publicationSafe)) return false;
  if (ZERO_ADDRESS.test(publicationSafe)) return false;

  return answeredTrue(() => isOwnerAt(read, publicationSafe, signerAddress));
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
 * True only on a definitive `false` from `hasAgreement`. A read that throws
 * answers false: a transport error must never make a live page look removable.
 *
 * The deployed publication exposes `hasAgreement`, not `hasDeal`, which reverts
 * and would read as in force. The name `isOutOfForce` stays because the press
 * re-exports it under that name.
 */
export const isOutOfForce = async (
  read: GateRead,
  genesis: string,
  publicationModule: string,
): Promise<boolean> => {
  try {
    return (await read(publicationModule, HAS_AGREEMENT_ABI, 'hasAgreement', [genesis])) === false;
  } catch {
    return false;
  }
};
