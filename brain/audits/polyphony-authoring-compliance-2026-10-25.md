# Polyphony §2 (Authoring): how the s2s prototype implements it

> **Type:** point-in-time reading of the prototype against the protocol text — not a SPEC. The
> authority is Polyphony §2; this document describes what the code does, which technical choices
> produce that behavior, and what each choice costs. The scorecard at the end is a derivative of the
> description, not a separate exercise.
>
> **Date:** 2026-10-25 · **Basis:** `brain/` (SPECs, research, handoffs, threat model, whitepaper) plus
> a source read of the paths cited inline. **Scope:** authoring only — not publication governance, the
> renderer, hosting, or verification.

## The shape of the answer

Five decisions carry authoring in the prototype. Everything else follows from them, including the
places where the prototype falls short of the paper.

1. **The interface is the signed object, not an application.** An authoring surface produces an
   `S2SContentItem`; any program that can produce one is a legitimate client.
2. **The account is a contract; the keys are signers.** Identity is an address that cannot move.
3. **The gate is a function of chain state, read at the moment of acting.** Not a permission granted
   to a party, and not a check performed by a server.
4. **An agreement is set membership over a per-work append log.** Publishing, revising, and ending
   are all writes to one small record.
5. **Everything the paper leaves to composition is left to composition** — payments, curation,
   discovery — which is a scope decision with a measurable cost.

The rest of this text takes those in order, says what the code does, and names the trade.

## 1. Local authoring, and the object that crosses the boundary

Writing never touches the network, and the code is arranged so that this is structural rather than
incidental. In the plugin, publishing begins from a markdown file in the vault: parse frontmatter,
canonicalize the body with JCS, hash it, build the EIP-712 signing view, sign. In the CLI the same
steps are exposed as separate commands, and `upload` — the step that puts bytes on IPFS and Filecoin
— resolves no ENS name, opens no publication, and returns no transaction hash
(`SPEC-author-cli.md`, "Flow notes"). Preview runs the renderer locally on Bun.

The load-bearing detail is that **the work's identity exists before it is published.** `objectId` is
the EIP-712 digest of the signed public part, computed from local bytes
(`shared/src/identity/sign-content.ts:46-105`); the CID does not exist yet at signing time and is not
needed. And the signature commits the plaintext: `plaintextHash` is keccak over the canonical body
and lives *inside* the signed public metadata, while the body itself is not signed. That is what
makes an offer possible at all — the record can commit to a document that is not yet readable by
anyone, and it can do so without the author surrendering the document.

The choice of interface is the consequence. There is no server API, no account, no session; the
contract between hosts and protocol is a well-known object plus a set of pure functions. Three hosts
use it — the Obsidian plugin, a browser app that runs inside the Safe UI, and a headless binary —
and they are genuinely different runtimes: the plugin has Electron and a vault, the safe-app has no
private key at all (every transaction is proposed to the Safe and approved by its owner,
`SPEC-hosts.md` AD-3), the binary has a funded key and a terminal. The shared package holds only
orchestration and primitives, parameterized by narrow injected dependencies, and each host writes
its own adapters (`SPEC-hosts.md` AD-2). No host imports another's internals.

The trade is that nothing enforces the object's semantics. Because the interface is data rather than
a call, a host can write a well-formed item with the wrong meaning and no shared code will object —
which is exactly what happened with the `author` field (below). The prototype bought host
independence and paid for it in the only currency available: invariant checking that has to be
written separately, and is not yet written.

## 2. The account: a contract, arrived at by reversal

The prototype's identity model is the least obvious thing in §2, and its history explains it. The
first implementation was ordinary: `ethers.Wallet.createRandom()`, an EOA, the private key encrypted
at rest, and a Lens account and Safe derived from it. Identity *was* the key. The first correction
was to invert that order — a durable DID with rotatable keys beneath it — and it settled on
`did:ethr` naming the owner EOA directly, precisely because `did:pkh` is welded to the address it
names and `did:key` cannot rotate (`RFC-0xobsidian-identity-key-custody-1.md` §B1). That proposal
was then reversed outright: **identity is the Safe; there is no DID**
(`handoff-owner-history-module.md` §2, "do not re-litigate"). No registry, no resolver, no Veramo.
The `did:ethr:<address>` string survives as a client-side label, and `eoaOf()` is now a misleading
name — it strips the prefix and returns whatever address was in the string.

Four properties made the reversal correct rather than merely convenient. The publication contract
records the author as an `address`, and `genesisAuthor[genesis]` is set by the first `canPublish`
caller (`S2SPublicationModuleV2.sol`, INV-append in `SPEC-00-system-contract.md:207`). The module's
privileged writes are `onlySafe`-shaped. With ERC-4337 and a paymaster, a transaction signed by the
owner EOA is executed by the Safe, so `msg.sender` **is** the Safe and the EOA never appears in the
record. And the Safe address is deterministic from the EOA — salt `s2s_${eoa}`, no chain identifier
in the salt — so the same address exists on L1 and L2
(`0xobsidian/src/eth/permissionless.safe.service.ts:170-204`; `main.ctrlr.ts` `initChain` comment).
That determinism is not a nicety: the same address has to own the publication's ENS subnode on L1
and act as the gated identity on L2.

Rotation is then an edit to a contract's owner set — `swapOwner`, `addOwnerWithThreshold`,
`changeThreshold` — on an address that does not change. Deals, geneses, whitelist entries, and the
`did:ethr` label all survive untouched. That is the technical content of "keys are replaceable": the
chain has one durable address and a mutable set of signers.

Two costs came with it, and both are open. The first: **the chain has no memory of who was an owner
when.** The gate asks `Safe.isOwner(signer)` — present tense. Rotate an owner and every prior
`"lit actions auth"` claim and every EIP-712 content signature becomes unverifiable against the
current set; the author's earlier work does not change, but the proof that its owner signed it
decays. The proposed repair is a projection over the Safe's own `AddedOwner`/`RemovedOwner` events,
attached as a guard so that history has no gaps, exposing `isOwnerAt(owner, t)` for the actions to
read (`handoff-owner-history-module.md` §4). It is designed, not built, and its one open fork —
on-chain projection vs. indexer-only — determines whether it is built at all. The second cost is
smaller and sharper: author Safes are created with `owners:[signer], threshold:1`, so rotation works
only while the key still exists. The recovery shortfall in `prototype-soul2soul.md` §1.4 is
unchanged, and the Safe model does not fix it on its own — nothing sets up a second owner.

And one defect sits on top of this section, currently being mended: the plugin writes the Safe
address into the signed item's `author` field
(`neutralpress/src/content/content.ctrlr.ts:177`), the CLI writes the EOA
(`author-cli/src/core/author.ts:135`), and the shared builder defaults to the signing key when the
argument is omitted (`sign-content.ts:64`). Nothing verifies the field against the chain. So the
sentence "the author named in the record is the account" is currently a convention per host. This
matters beyond tidiness: the same item also carries `proof.signer`, which is always the EOA, so the
object already has the two addresses it needs — it just has no rule about which one is the author.

## 3. The offer: encryption as a function, the gate as a read

The paper's formulation — the work stays the author's, what is shared is an offer, and the
encryption governs the offer rather than the work — maps in the prototype onto a boolean on the
stored object and three reads at act time.

`S2SContentItem.encryption` is derived rather than declared: `encryption: encryptFn !== noOpEncrypt`
(`sign-content.ts:104`). Encryption is a pluggable function passed into the builder, so the item's
shape does not change between a plaintext and a ciphertext publication, and the ciphertext goes into
the same `body` field. Decryption happens in exactly one place: inside the render action, using a
key derived in the enclave (`Lit.Actions.getPrivateKey`), never exported and never reconstructed from
shares — Lit V3 is TEE-based, so the trust root is attestation plus on-chain permission, not an
honest majority.

The gate that must pass is one expression: `canRead = canPublish(authorSafe) ∧ isOwner(signer) ∧
hasDeal(genesis)` (`protocol/actions/src/libs/gates.ts:10-37`). Note what each term does. `hasDeal`
is the agreement. `isOwner` is "this signer currently controls that account". `canPublish` is the
publication's admission decision, which is itself just an address check against the Safe, the
whitelists, or the publication Safe (`S2SPublicationModuleV2.sol:280-284`). The action is not
`msg.sender` on any of these reads — it hands the caller-supplied Safe address to `canPublish` and
the recovered signer to `isOwner` — which is why the gate works from inside a sandbox with no
identity of its own.

The cost here is the largest single gap in the prototype, and it is a wiring gap, not a design one.
Both live hosts pass `noOpEncrypt`
(`neutralpress/src/content/content.ctrlr.ts:154-178`, `author-cli/src/core/author.ts:118-135`). Every
published item therefore has `encryption:false` and a plaintext body on Kubo and Filecoin. The
encryption capability exists (`shared/src/lit/lit.service.ts:300`,
`shared/src/lit/actions/encrypt.ts:4`) and the gate that would police it is complete, but no author
can produce an encrypted item, so the ciphertext branch is unexercised end to end. Until it is
wired, the agreement gate still prevents the *renderer* from using a work without a deal; it does
not prevent anyone holding the CID from reading the source. The paper's guarantee is the former plus
the latter, and only the former is delivered.

The design choice that makes this recoverable is worth noting, because it is the reason the gap is
one call site rather than a refactor: encryption was factored as a parameter of signing, so the
boundary between "offer" and "transfer" is a function argument. Wiring it is a change of argument at
two call sites plus an end-to-end test; it is not a new subsystem.

## 4. Agreements: a set over a log

Revising, publishing, and ending are three writes to one small contract, and the prototype's choices
here are about making the gate cheap rather than making the history rich.

A work is identified by `genesis`, a `bytes32` derived from its first `objectId`. Each genesis owns
an append-only `versions[]` of `{cid, timestamp, tombstone}` (`S2SPublicationModuleV2.sol:40-55`), a
`genesisAuthor` written once, and a cached `latestIndex`. Deals and offers are not tables of
documents; they are enumerable sets of genesis pointers with swap-pop removal, and `getDeals` /
`getOffers` assemble an `Entry {genesis, author, cid, timestamp}` from the latest version plus
`genesisAuthor` at read time — there is no stored `entries[]`. The whole point is that `hasDeal` is
one boolean read, so the gate costs a call, not a query.

Ending an agreement is `retract`, and it is deliberately asymmetric. If the caller is the genesis
author, the work leaves the deal and offer sets unconditionally: no publisher consent, no
precondition beyond membership. If the caller is the publication Safe, a deal is demoted back to an
offer rather than deleted (`S2SPublicationModuleV2.sol:182-196`) — the work stops being published
but does not vanish from the record. That asymmetry is a faithful encoding of "ending is a fact
rather than a request": the author's exit is total, the publication's is a withdrawal of
sponsorship.

Revision is an append gated to `msg.sender == genesisAuthor || safe` (INV-append), and every version
is a full signed item, so the signature travels with the version rather than being a separate
artifact. What is missing is on the client side and in the read path. The client is supposed to
resolve the existing genesis before registering a revision; the observed failure mode is that it
blind-creates instead, so a genuine new version of the same author's same slug lands as a second
genesis (`handoff-safe-app-duplicate-deals.md` §3B). And the readers that would make history legible
— `resolveLatest` and `getHistory` — are still stubs that log "append-log contract pending"
(`shared/src/identity/verify-content.ts:124-141`), even though the contract is no longer pending. The
`tombstone` field is carried in the struct and written `false` at every append; retraction removes
set membership instead, so nothing ever sets it. And the version signature is stored but unverified:
`verifyAuthorship` has zero call sites.

Two smaller consequences follow, and they matter for portability rather than for §2's letter. The
contract stores no deal start or end timestamp — `Entry.timestamp` is the latest append's block
time — so an ended agreement is reconstructable from events, not from state. And `publication` is
inside the signed public metadata, so the same source offered to two publications yields two
different geneses; the link between them is `plaintextHash`, which commits the body. Sameness is
provable, but not by a shared identifier.

The rebuild half of "end an agreement and have the site rebuilt without the work" is where the
prototype is furthest from the paper, and it fails in three independent places. A revoked render
does produce a `revoked` job and a `remove` entry for its own path
(`protocol/actions/src/render/main.ts:212-250`), so the page goes. But pages that embed or list the
work are not re-rendered, because ripples-from-revoke is specified and explicitly not implemented
(`RFC-prep-ripples-from-revoke.md`); the plugin does not populate the `remove[]` list the update
action accepts (`prototype-soul2soul.md` §2.2); and no process watches `Retracted` to trigger a
render at all — rendering is initiated by a surface calling `renderwithLitActions`. The first half of
the guarantee is exact and already strong. The second depends on someone running a render that
cannot yet clean up dependent pages.

## 5. What is deliberately not here

Three of the nine guarantees are answered by *not* building something, and the distinction between
"left to composition" and "missing" is the honest way to read them.

Pseudonymity is a property of what the record can hold. `S2SPublicContent` has no name field, the
contracts store addresses, and the only `name` in the system is a local label in plugin settings
that is never uploaded. The threat model states the residuals rather than hiding them: the pseudonym
is public forever and findable in every page's provenance, and no fiat rail is required for fees, so
no payment trail is welded to the identity. This one is simply met.

No-exclusivity is the same kind of answer: there is no mechanism because there is nothing to
enforce. `makeOffer` is permissionless, whitelists are per publication, and nothing anywhere asks
whether a work is published elsewhere. The author holds the item; the publication holds a pointer
and a permission.

Payment is different, and should not be read as a failure. The paper names three rails — a
destination, a division, and a disclosure gate — and says of the third that it is "described in this
paper and not yet built". The prototype has no payment code at all: no `payable`, no split, no
withdraw, and no signature that links a wallet to an account. The useful statement is that both
protocol and prototype defer it, so the prototype has no divergence to answer for; it has a rail to
build when the protocol decides what the rail is.

The author-side list of works and agreements is the one deliberate omission with a visible cost. The
facts are already public and permanent — agreements live on publication modules with permissionless
reads, `authorOf(genesis)` is immutable, and nothing is deleted when an author leaves — so a third
party can reconstruct any author's history today. What does not exist is the author's own curated
view: the author Safe is deployed with no modules, no ENS node, and no records store
(`research/2026-09-10-author-owned-bylines-scoping.md:129`), and the only per-author state is the
local settings blob. The research makes the repair unusually cheap, because `S2SRecordsModule` is an
immutable `onlySafe` KV store with permissionless reads: pointed at the author Safe,
`setRecord('bylines', …)` from the author's 4337 account passes the gate with no new contract code.
What is greenfield is the install batch, the record schema, the resolver, and the question of who
pays for the install. So the guarantee "survives leaving any publication" is half-present in the
ledger and absent in the tooling.

## 6. The score, derived

Read against the nine musts, the description above yields this. Scores are about end-to-end
enforceability, not about the existence of code: 3 = holds today through a real host, 2 = runs with
one unenforced hop, 1 = the piece exists but no author can rely on it, 0 = no mechanism.

| # | Polyphony must | Score | Why, in one line |
|---|---|---|---|
| A1 | Write and revise without the network; publish separately | **3** | The item and its identity are local; `upload` is off-chain and resolves nothing. |
| A2 | Work encrypted to own account, usable only under agreement | **1** | Gate and ciphertext branch are complete; both hosts pass `noOpEncrypt`, so nothing is encrypted. |
| A3 | End any agreement alone, site rebuilt without the work | **1** | Author-only `retract` is exact; revoke ripple, `remove[]`, and re-render trigger are all missing. |
| A4 | Revise and reissue; every version signed and recorded | **2** | Append log and per-version signatures exist; genesis resolution is wrong and history readers are stubs. |
| A5 | Rotate keys without losing account, history, reputation | **2** | Address-stable rotation works; no `isOwnerAt`, threshold 1, and hosts disagree on the author field. |
| A6 | Pseudonymous; protocol never holds a legal name | **3** | No name field exists; the only name is local settings. |
| A7 | Receive their share directly at a linked wallet | **0** | No payment, split, or link mechanism — deferred by the paper as well. |
| A8 | Publish anywhere; no exclusivity | **3** | Permissionless offers, per-publication whitelists, nothing to enforce. |
| A9 | Public, author-curated list of works and agreements | **1** | Ledger facts are public and permanent; the author's own store does not exist. |

**16 / 27 (59%).**

The distribution is more informative than the total. Three guarantees are fully met and are the ones
that follow from the five decisions: local-first authoring, an account that cannot move, and no
exclusivity. Three sit at 2 and fail on a single unenforced hop each: append correctness and history
reads, rotation survival, and — folded in — the author field. Three sit at 1 or 0 and share a cause:
the parts of authoring that need something *outside* the signed item — a ciphertext to publish, a
render to propagate a revoke, a store to hold a byline, a rail to pay through — are the parts not
yet wired, because the prototype built the object and the gate before it built the plumbing around
them.

That also orders the work. Wiring encryption is one argument at two call sites and buys the largest
gap on the board. Revoke propagation is two already-specified changes. The byline store is a
composition of shipped parts. Append correctness, the history readers, and `isOwnerAt` are smaller
but deeper, because they are where "the account remembers" is still a promise rather than a
mechanism. Payments are last, and are a protocol question before they are an implementation one.

## Limits

- **Judgment, not measurement.** A rubric that credits code existing would score A2 at 2 and A9
  higher; the prose states the reasoning per item so a reader can re-score without re-deriving.
- **Draft authority.** The nine musts are quoted from the supplied draft of §2. If the wording
  changes, the mapping survives; the phrasing in this document does not.
- **Single pass, no independent review.** One reading of `brain/` plus the cited source. Treat the
  scores as a starting position for argument.
- **Symbols over line numbers.** Line numbers drift; the stable anchors are names such as
  `S2SPublicationModuleV2.retract`, `buildSignedContentItem`, and `canRead`.
- **One defect crosses three rows.** The CLI/plugin divergence on the `author` field affects A4, A5,
  and A9. When it is mended, re-check those rows — two of them may move with no other work.
