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
// Known gap (GATES-4, implementation shortfall): the on-chain retract path
// tests `genesisAuthor` only, so an author who has been removed from the
// whitelist can always retract their own earlier work — "or has carried" is
// not yet enforced on-chain.
//
// Note: `hasDeal` is read by canRead, but nothing reads `hasOffer`. Whether
// holding an offer (rather than a deal) is enough to read is GATES-5's open
// mechanism question, not decided here.
//
// Runtime note: the Lit Action runtime supplies ethers (an action's `require`
// resolves it, and a bare global is also present), which is what the default
// genesis normaliser uses. A host without ethers — a browser plugin, the
// safe-app, a CLI — must pass its own normaliser to canRead, or hand it an
// already-bytes32 id.
// ============================================================================

import { toBytes32Id } from '../manuscript/identity/contract-id';

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

const CAN_PUBLISH_ABI = ['function canPublish(address _author) view returns (bool)'];
const IS_OWNER_ABI = ['function isOwner(address owner) view returns (bool)'];
// const HAS_DEAL_ABI = ['function hasDeal(bytes32 genesis) view returns (bool)'];
const CAN_READ_ABI = ['function canRead(bytes32 genesis, address reader) view returns (bool)'];

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
 * The content is readable when the publication would still accept its author,
 * the signer owns the author Safe, and a deal exists for the item's genesis.
 * `contentId` is normalised to bytes32 the same way the writes normalise it —
 * an already-hashed 0x+64hex id passes through, anything else (a raw CID,
 * an objectId) is keccak256-hashed. Pass `toId` when your host has no ethers.
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

  const [isOwner, isDeal] = await Promise.all([
    read(publicationModule, CAN_READ_ABI, 'canRead', [genesis, safeAddress]),
    read(safeAddress, IS_OWNER_ABI, 'isOwner', [signerAddress])
  ]);

  return isOwner && isDeal;
};

/**
 * May this signer reset the publication's tree?
 *
 * A reset is STRICTER than a publish: only an owner of the PUBLICATION Safe
 * may nuke the tree — not merely an owner of a whitelisted author Safe. Note
 * this is an ADDITION (see docs/protocol/gates.md): the protocol text requires
 * the publication's owner to be able to retract an author's work, and does not
 * say who may rebuild the whole tree.
 */
export const canReset = async (
  read: GateRead,
  multisig: string,
  signerAddress: string,
): Promise<boolean> => {
  return read(multisig, IS_OWNER_ABI, 'isOwner', [signerAddress]);
};
