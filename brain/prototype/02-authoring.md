# Authoring in the s2s prototype

A companion to the Authoring section of the protocol paper: one implementation, what each guarantee
rests on here, and where this prototype stops. Not a specification, and not a bug list — the audit is
a separate document.

Five terms, once: the **author** is an account on Base and the key beneath it; a **publication** is
another account that owns a name and hosts one contract holding its agreements; an
**agreement** is a *deal*, an entry in that contract's set; the **renderer** is a Lit action that
turns records into pages; the **ledger** is Base mainnet, with names on Ethereum's first layer.

## 1. One author, start to finish

**The account comes first.** The plugin generates or accepts a key, derives a smart account address
from it, and connects. The account is a Safe — a contract that executes calls for a set of owners,
here one owner at a threshold of one. Its address comes from a salt containing the owner's address and
nothing else, so the same key yields the same account on every chain: on Base now, on Ethereum later,
under one name. Nothing registers the author.

**The publication is older than the author.** Another Safe, owning a subdomain on Ethereum and
hosting a module on Base — one contract per publication, holding the authors it admitted and what
they published there. Admission is the boundary for opening a work; it is why "publish anywhere" means "anywhere
that has admitted you".

**Drafting is offline.** The body is canonicalised so hashing does not depend on key order, then
hashed; the hash enters the public metadata, which is signed as EIP-712 typed data — over named
fields, not a blob. The digest of that structure is the work's identity, its genesis.

So the signature commits to the plaintext without publishing it, and the identity exists before the
bytes have an address: the CID — the content address storage will give them — does not exist at
signing time and is not needed.

Encryption is designed in and not switched on: the note carries an `encryption` flag, the plugin
parses it, the publish path ignores it, and bodies go to IPFS in the clear.

**The bytes go to storage the author controls.** The signed item goes to the author's own Kubo node —
an IPFS node they run — which returns a CID; a CAR built from the same bytes then goes to a Filecoin
provider, so the content outlives the node. The indentation is deliberate: both hash the same bytes,
so the two CIDs agree. The ledger references the CID and holds no copy.

**One transaction opens the agreement.** `makeOffer` both appends a version, CID and timestamp, and
sets membership: a deal for an admitted author, a pending offer for anyone else. It is not sent by
the key but packaged as an ERC-4337 user operation — signed by the key, relayed by a bundler, paid
by a paymaster — so the chain sees the account as the actor, the author needs no gas, and their
address is not on the transaction. The first append fixes the genesis author; later ones are limited
to it or to the publication.

**The renderer works from that log.** The append is the authorisation: no separate call registers
intent. The client asks for a render with the genesis ids and a signature over a fixed string, and a
Lit action — published, content-addressed code running inside an enclave — does the work with a PKP,
a key pair whose private half exists only in that enclave and is used through the action, never
exported. It reads the log, fetches the item, builds the page, writes JSON-LD (author address, page
hash, genesis), signs it with the PKP, uploads it. That provenance signature is the renderer's; a
reader who wants the author's own checks the signed item.

**A revision reuses the genesis**, kept in the note's frontmatter: sign, upload, `makeOffer` against
the same id. The log gains a version, the site follows the latest, and the signature travels inside
the item at that CID.

**Withdrawal is one-sided on purpose.** `retract` from the author's account removes the work from the
deal and offer sets; from the publication's account it can only demote a deal to an offer. A
publication cannot delete a withdrawal, and an author cannot be forced back in. No rebuild follows —
the renderer checks membership when it renders, so the work vanishes the next time a page carrying it
is rendered.

**Rotation moves the key, not the account.** `swapOwner` replaces one entry in the owner set, the
address stays, and every past version and agreement still names the same account. The client stores
the address instead of re-deriving it, so a new key reconnects. There is no rotation command in the
application yet; on-chain, it is a Safe wallet operation.

## 2. The choices behind it

**The account is the identity, and there is no DID document.** A decentralized identifier is a
document naming a controller, so rotation means updating a registry someone may write to. The ledger
already answers who controls an account; a registry would be a second answer in a second place. The
cost: with no portable key history, "who owned this account when this version was written" must be
rebuilt from the Safe's own events.

**Set membership replaced licence objects.** The first module modelled an agreement as an object with
a lifecycle — grant, accept, revoke — and every state nobody wanted became a rule. Two sets, deals and
offers, answer the only questions that matter, in or out and who put it there, with author and
publication told apart by the caller.

**The version log is append-only.** A pointer — one row per work, updated — is simpler, and gives
whoever writes it power over history; it also discards order, and an authorship claim is partly a
claim about order. The log costs storage and makes "the latest" a derived fact.

**Access is a chain read at decryption time.** An access list per work must live somewhere, be
maintained, and become a second source of truth for something the ledger holds. So the decrypting
action asks three questions at that moment: is this author admitted, is the asking party an owner of
the author's account, is there a deal for this genesis. Ending an agreement ends access with nothing
revoked; the cost is three reads and a caller able to prove a recognised key.

**There is no name field.** An optional display name gets filled, and a field that is filled gets
required. What remains is an address and a label in the author's own settings.

**Exclusivity is not enforced.** A publication wanting an author to itself can write that into a
contract the protocol cannot see; enforcing it in the module would mean reading state the module does
not own. Non-exclusivity is a property, not a feature: nothing to switch off, nothing to point at.

**The author's list goes on a records module the author owns.** A hosted profile reintroduces the
party the rest avoids. The protocol already has the primitive — an immutable store only its owner
account writes and anyone reads, which the publication uses for its configuration. Plan, not build.

## 3. The nine guarantees at a glance

| Guarantee | How the prototype does it | Status | Where it stops today |
|---|---|---|---|
| Write and revise offline; publish separately | Signing, hashing and identity are local; upload puts bytes on IPFS and Filecoin | met | — |
| Encrypted to the author's account; readable only under an agreement | A Lit ciphertext under the PKP, gated by three chain reads at decrypt time | partly | The `encryption` flag is parsed and then ignored; bodies go up in the clear |
| End any agreement alone; site rebuilt without the work | `retract` removes the genesis from the deal and offer sets | partly | Nothing watches the withdrawal and nothing rebuilds |
| Revise and reissue; every version signed and recorded | Append-only log of CID and timestamp per genesis; the signature is inside the item | partly | Nothing verifies the signature at read time, and the verifier would reject account-authored items |
| Rotate keys without losing account, history, reputation | Identity is the account address; rotation is `swapOwner` | partly | No in-app rotation, no ownership history, threshold of one, and the binary's rows name the key |
| Pseudonymous; no legal name in the record | No name field; a local label; transactions relayed | met | — |
| Receive their share at a linked wallet | Nothing exists | not yet | No payment, split or payout field anywhere; the paper defers this too |
| No exclusivity; the same work can be offered elsewhere | Every publication's lists are its own; nothing reads across them | partly | A first append needs admission, so a new work cannot arrive as a pending offer |
| Public, author-curated list of works and agreements | Per-publication enumeration only | not yet | No author-side index; the records-module plan is unbuilt |

Meets 2 of 9 outright, 6 partly, 1 not yet.

## 4. What comes next

Encryption first: the largest gap, and a small change with one large question attached — whether the
renderer decrypts on its own authority or only while the author is present to authorise a render.
Then one rule for who the author is, the account always, with the binary's existing rows migrated.
Then rebuild on withdrawal, so retraction becomes visible rather than merely recorded. Then the
author-side list, giving readers a way to find a body of work without trusting one publication's
enumeration. Then rotation in the application and a reader for ownership over time. Last, the TEE —
trusted execution environment — renderer on Phala/dstack and a second operator, so the key stops
being one enclave run by one company.

## 5. References

**The account**
- `0xobsidian/src/main.ctrlr.ts` — `initChain`, salt derivation, reconnect by stored address
- `0xobsidian/src/eth/permissionless.safe.service.ts` — `connectToFreshSafe`, `connectToExistingSafe`,
  `deploySafe`, `updateSigner`; SafeL2 v1.4.1, singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`,
  proxy factory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, EntryPoint 0.7
- `shared/src/contracts/safe_implementation.ts` — the Safe ABI, including `swapOwner`,
  `addOwnerWithThreshold`, `removeOwner`, `changeThreshold`
- `author-cli/src/core/author-safe.ts` — counterfactual prediction and `init`
- `shared/src/publication/new.ts:209` — the only in-repo `addOwnerWithThreshold` writer (publication
  Safes, not author rotation)

**Signing and identity**
- `shared/src/identity/sign-content.ts:46-105` — order of operations, `plaintextHash` at `:48-50`,
  `objectId` at `:76-80`, `proof` at `:95-99`, `encryption` flag at `:104`
- `shared/src/identity/verify-content.ts:33-80` — `verifyAuthorship`; `:65` compares against
  `eoaOf(author)`; `:124-141` stubs for `resolveLatest`/`getHistory`; `:17` comment claims a caller
  that does not exist
- `shared/src/protocol/types.ts:122-124` — `eoaOf` returns the address inside the `did:ethr` string
- `neutralpress/src/content/content.ctrlr.ts` — `parseNote` (`encryption` at `:116`, `knownKeys` at
  `:65`), `publishContent` (`:134`, `:148-151`, `:174`, `:177`, `:185`)
- `author-cli/src/core/author.ts:118-150` — upload/propose split; `:134` `noOpEncrypt`; `:135` EOA as
  author; `:265` `"lit actions auth"`

**Encryption and access**
- `shared/src/lit/lit.service.ts:300` — `encrypt`; `shared/src/lit/actions/encrypt.ts` —
  `Lit.Actions.Encrypt`
- `protocol/actions/src/libs/decrypt.ts:4-30` — decrypt after the gate
- `protocol/actions/src/libs/gates.ts:14-40` — `canRead`: `canPublish` ∧ `isOwner` ∧ `hasDeal`
- `protocol/actions/src/render/data.ctrlr.ts:112-131` — the decrypt branch, reachable and unexercised
- `protocol/actions/src/render/main.ts:104` — `signerAddress` from the `"lit actions auth"` signature
- `protocol/scripts/lit/config.json` — group `s2s`, group id 1, PKP
  `0x0522b95938c3a18988bf71da2f964f8a52ae4004`, permitted action CIDs
- `shared/src/protocol/index.ts` — protocol config resolved from the on-chain records module

**The agreement and the log**
- `protocol/contracts/contracts/S2SPublicationModuleV2.sol` — `makeOffer` `:145-168`, `acceptOffer`
  `:170-180`, `retract` `:182-196`, `getDeals`/`getOffers` `:217-225`, `getLatest` `:250`,
  `getVersion` `:261`, `authorOf` `:274`, `canPublish` `:280-284`, whitelists `:297-315`, `_append`
  `:347-371` (first-append admission `:351-353`, append-by-other `:354-355`)
- `protocol/contracts/contracts/S2SRecordsModule.sol` — immutable `onlySafe` store, permissionless reads
- `protocol/contracts/contracts/S2SPublicationModule.sol` — V1, deprecated, licence lifecycle

**Rendering and storage**
- `neutralpress/src/publication/publish.ts:59-67` (`JSON.stringify(item, null, 2)`), `:74`
  (`makeOffer`)
- `protocol/actions/src/prep/main.ts` — reads the log, fetches items, `remove[]` for slug changes
- `protocol/actions/src/render/metadata.ts:45-58` (`schema.author`), `:105-107` (`encoding.sha256`)
- `protocol/actions/src/render/main.ts:42, 212-250` — `isRevokedByDealState`, three conservative guards
- `protocol/actions/src/update/verify.ts:47-90` — `verifyProvenance`
- `shared/src/ipfs/index.ts` — `backupToProviders`, `runFilecoinLeg`

**Clients**
- `neutralpress`, `0xobsidian` — the editor plugin
- `author-cli` — the `s2s` binary
- `safe-app` — browser surface inside the Safe UI; publication administration today, author flows
  designed only (`brain/specs/SPEC-hosts.md` AD-3)
- `brain/specs/SPEC-nvim-s2s.md`, `brain/handoffs/handoff-nvim-plugin-wrapper.md` — the Neovim
  wrapper, designed 2026-10-22, nothing built

**Decision documents**
- `brain/handoffs/handoff-owner-history-module.md` §2, §4, §6 — account as identity, no DID document;
  the ownership-history fork
- `brain/specs/RFC-0xobsidian-identity-key-custody-1.md:62, 88` — the superseded DID-first proposal
- `brain/specs/SPEC-00-system-contract.md` — INV-append `:207`, INV-10 `:216`, Lit deployment `:83-84`
- `brain/specs/SPEC-contracts-publication.md` — V1 → V2 migration, invariants
- `brain/specs/SPEC-hosts.md` AD-1, AD-2, AD-3 — hosts, shared core, the Safe as actor
- `brain/specs/prototype-soul2soul.md:70-78` — the recovery shortfall
- `brain/threat-model/author.md` — pseudonymity, residuals, and the chain-driven render claim
- `brain/research/2026-09-10-deals-ledger-convergence.md` — per-publication whitelists; the admission
  gate makes open submission unreachable
- `brain/research/2026-09-10-author-owned-bylines-scoping.md:88-97, 129, 340-343` — the author-owned
  records store
- `brain/research/2026-09-10-portable-byline-convergence.md` — three independent proofs
- `brain/research/2026-09-10-external-indexer-trust-model.md` — `verifyProvenance` as the audit routine
- `brain/handoffs/handoff-prep-ripples-from-revoke.md` — the unbuilt rebuild-on-retract plan
- `brain/handoffs/handoff-safe-app-duplicate-deals.md` — the duplicate-genesis symptom, 2026-07-22
- `brain/whitepaper/v2.md:36` — the disclosure gate deferred by the paper as well

**Not verified**
- Chain state: no contract or account was read from Base or L1; behaviour above is read from source.
- Which Lit group is live: the deployment config records group id 1 and PKP `0x0522…4004`, while
  `SPEC-00` records group 14 and `0xddc4…b414`, and the record the renderer actually reads is the
  on-chain records module. (The spec's stated path `scripts/lit/config.json` no longer exists; the
  file is at `protocol/scripts/lit/config.json`.)
- Whether the deployed renderer supplies a fresh author signature per job; the code path requires one.
- Whether any encrypted item has ever been published. Nothing in the code suggests it; an on-chain
  scan for items with `encryption: true` would settle it.
- Whether the historical duplicate-genesis rows were repaired. The current write path fixes the cause.
