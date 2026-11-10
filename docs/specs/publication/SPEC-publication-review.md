# SPEC-publication-review — what a publication can let a reviewer read before deciding

> **Parent:** [SPEC-publication](SPEC-publication.md) — the publication front door.
> **Siblings:** [SPEC-publication-agreements](SPEC-publication-agreements.md) (the state being decided),
> [SPEC-publication-admin-app](SPEC-publication-admin-app.md) (the surface that proposes the decision).
>
> **Type:** component spec, small on purpose. It owns one question: **between "offered" and "decided",
> who may read the work?** Today the answer is "whoever the author let hold the bytes", and this spec
> exists so that gap is written down rather than discovered. The gates themselves, and what makes each
> of them impossible to weaken, are in [SPEC-publication-must-not](SPEC-publication-must-not.md).
>
> **Audited against live code:** 2026-11-10, partially. Verified: `src/shared/src/gates/index.ts`,
> `src/press/actions/src/libs/gates.ts`, `src/press/actions/src/libs/decrypt.ts`, and the module's
> `canRead`/`canReview` at `S2SPublicationModuleV3.sol:297-312`. Not re-audited: the admin app's deals
> tab and the `shared/src/cid-view` consumers, which still carry the 2026-10-30 reading.

---

## Responsibility

Not the decision (agreements) and not the decryption machinery (the press, a sibling:
[SPEC-protocol-actions](../press/SPEC-protocol-actions.md)). This spec owns the **composition** of the read
gate as it applies to a pending offer, and the consequences of that composition for review.

## The gate

Two predicates answer a read, and they are not the same predicate.

**What the press runs.** `canRead(contentId, safeAddress, publicationModule, signerAddress, rpcs)` in
`src/press/actions/src/libs/gates.ts` binds `src/shared/src/gates/index.ts` to the action's `evmRead`.
Three ANDed reads, all on L2:

| term | call | means |
|---|---|---|
| 1 | `publicationModule.canPublish(safeAddress)` | the author Safe is one the publication would accept |
| 2 | `safe.isOwner(signerAddress)` | the caller holds that author Safe |
| 3 | `publicationModule.hasDeal(toBytes32Id(contentId))` | **the work is an agreement** |

**What the module answers.** V3 exposes the per-genesis gates: `canRead(bytes32 genesis, address
reader)` and `canReview(bytes32 genesis, address who)` (`S2SPublicationModuleV3.sol:297-312`). Both
admit an agreement **or** an offer. `canRead` admits the safe, the genesis author, and any address in
the publication's reviewer set; `canReview` is the narrower one — a reviewer, and offered or agreed.

Neither replaces the other. `canRead(genesis, reader)` trusts the address it is handed: the module
cannot ask whether that reader holds the Safe it names, so a caller MUST pair it with `isOwner`. The
press's composed gate does that in term 2, which is why the composition exists at all.

Two things follow, and both are load-bearing:

**Term 3 is the whole problem.** A pending offer has `hasDeal == false`, and term 1 refuses it as well:
a pending offer's author is not a whitelisted author. So a pending offer **cannot be decrypted through
the press by anyone** — not the holders, not the author, not a reviewer, not the person who wrote it.
The composed gate has no `hasOffer` branch, and nothing on this path calls `hasOffer`.

**The reviewer path exists and is unused.** `canReview` is wired through the action adapter
(`src/press/actions/src/libs/gates.ts:49`) and answers yes for an offer, but
`src/press/actions/src/libs/decrypt.ts:38` calls the composed `canRead`, so a reviewer's decryption of
an offer is still refused at the gate. The reviewer set is real — `setReviewer`, capped at 20,
`onlySafe` — and no app surface uses it. This is a gap, recorded in
[SPEC-publication-must-not](SPEC-publication-must-not.md#reading) and not fixed by this spec.

**Term 2 means the *holder* is the reader, not the author.** The press acts as the publication: the
signature that authorises a render is a Safe owner's. An author who is not also a holder cannot decrypt
their own admitted work through the press; they need a holder to run the render. In the common
deployment the author *is* a holder, so the two collapse and the distinction is invisible — until it
isn't.

## What review looks like today

| step | what actually happens |
|---|---|
| the work is offered | `makeOffer` appends the version; the item is a pending offer |
| the publication learns of it | the app's deals tab lists it from `getOffers` |
| the publication reads it | **only if the item was published in the clear.** `s2s-deals-tab` fetches each item by CID from a gateway and parses the body directly — no gate, no key, no press |
| a reviewer reads it | same row, same fetch. The module has a reviewer set and `canReview`; the press's decrypt path asks the composed `canRead`, so the reviewer's read is refused unless the work is an agreement. No scoped read, no expiry |
| the decision | `admit` or `reject` on a V3 module (`acceptOffer` / `retract` on V2), both Safe transactions |

So the prototype ships offers **in the clear**, and the reason is structural rather than lazy: an
encrypted offer is an object nobody can open, including the publication that is supposed to consider it.
Encryption exists on both sides and is switched off by default for exactly this reason.

**Review today is a decision to look, not a right to look.** The only access control on a pending offer
is whatever the author did before uploading: publish it plaintext (anyone with the CID reads it), or
encrypt it (nobody reads it). There is no middle setting.

## What a reviewer can see of an encrypted item

Even unreadable, an encrypted item is not opaque. The signed **public envelope** is in the clear:
`title` is body content (secret) but `attributes`, `tags`, `postType`, `locale`, `position`, and
`plaintextHash` are in the signed public part, and `proof` names the signer. A review surface could
therefore show *who* offered *what kind of* thing *when*, and verify the signature, without the
publication ever being able to read the words. That is a real capability the prototype has and does not
use.

## Unknowns this spec does not settle

Recorded here, decided elsewhere (an RFC, not a spec — per `docs/conventions.md`):

1. Whether the press's decrypt path should call `canReview` for a non-owner before `canRead`, or whether
   the composed gate grows an offer branch. The third list (reviewers) is built; which predicate reads
   it on the decrypt path is not decided.
2. Whether a reviewer read should be **scoped** (this genesis, until this time) or unconditional for the
   publication's holders.
3. Whether a declined work becomes a **record** (`declined, by, at`) or stays an absence. Today decline
   removes the offer, leaves the log, leaves the bytes, and tells nobody.
4. Whether the author is **notified** of a decision, and through what — there is no event subscription,
   no webhook, no inbox anywhere in the system.

## Invariants this component preserves

- **A read never changes state.** The press's authorisation is an off-chain message
  (`extractSignerAddress` over `'lit actions auth'`); it costs nothing and writes nothing.
- **`canRead` is fail-closed.** Any of the three reads returning false denies; an RPC failure throws
  rather than defaulting to allow.
- **An offer read through the press is refused, not refused per reviewer.** The composed gate is blind
  to the reviewer set. Until (1) is decided, the module's `canReview` is a configured answer with no
  caller, and the press path stays closed to every offer.

## Safe-to-change vs do-not-touch

- 🟢 show the public envelope of an unreadable offer in the app (additive, no gate change).
- 🟢 add a `declined` record as a new genesis-keyed structure.
- 🔴 weaken term 3 without replacing it (decryption of offers is a gated act by construction);
  🔴 let a publication Safe decrypt an item it has never dealt with — that would make the offer set a
  read capability and turns every offer into a publication-visible draft.

## Test seams

- Gate truth table over {deal, offer, unknown} × {holder, non-holder} × {canPublish true, false}: the
  offer/holder row must be **false** for an encrypted body, and is the regression that matters.
- An encrypted offer rendered through the press: assert it fails at the gate — term 1 or term 3 — and
  not at decryption. The difference distinguishes "not allowed" from "broken".
- `canReview` against an offer: the module answers true for a listed reviewer and the press adapter
  carries that answer unchanged. The row that matters is that nothing calls it yet.
- An unencrypted offer: assert the app shows a title and no proof verification occurs on that path.
