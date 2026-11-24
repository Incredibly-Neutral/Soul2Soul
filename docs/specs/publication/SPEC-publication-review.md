# SPEC-publication-review — what a publication can let a reviewer read before deciding

> **Parent:** [SPEC-publication](SPEC-publication.md) — the publication front door.
> **Siblings:** [SPEC-publication-agreements](SPEC-publication-agreements.md) (the state being decided),
> [SPEC-publication-admin-app](SPEC-publication-admin-app.md) (the surface that proposes the decision).
>
> **Type:** component spec, small on purpose. It owns one question: **between "offered" and "decided",
> who may read the work?** Today the answer is the press's preview gate: a listed reviewer, or an
> owner of the publication Safe, may open an offered manuscript. The gates themselves, and what
> makes each of them impossible to weaken, are in
> [SPEC-publication-must-not](SPEC-publication-must-not.md).
>
> **Audited against live code:** 2026-11-10, partially, and re-read 2026-11-24 for the preview gate.
> Verified: `src/shared/src/gates/index.ts`, `src/press/actions/src/libs/gates.ts`,
> `src/press/actions/src/libs/decrypt.ts`, and the module's `canRead`/`canReview` at
> `S2SPublicationModuleV3.sol:297-312`. Not re-audited: the `shared/src/cid-view` consumers, which
> still carry the 2026-10-30 reading. The admin app's surface is
> [SPEC-publication-admin-app](SPEC-publication-admin-app.md#key-flows).

---

## Responsibility

Not the decision (agreements) and not the decryption machinery (the press, a sibling:
[SPEC-protocol-actions](../press/SPEC-protocol-actions.md)). This spec owns the **composition** of the read
gate as it applies to a pending offer, and the consequences of that composition for review.

## The gate

Two predicates answer a read — `canRead` for a publish, `canPreview` for a preview — and they are not
the same predicate.

**What the press runs.** `canRead(contentId, safeAddress, publicationModule, signerAddress, rpcs)` in
`src/press/actions/src/libs/gates.ts` binds `src/shared/src/gates/index.ts` to the action's `evmRead`.
Three ANDed reads, all on L2:

| term | call | means |
|---|---|---|
| 1 | `publicationModule.canPublish(safeAddress)` | the author Safe is one the publication would accept |
| 2 | `safe.isOwner(signerAddress)` | the caller holds that author Safe |
| 3 | `publicationModule.canRead(toBytes32Id(contentId), safeAddress)` | **the module admits this reader**, agreement or offer |

**What the module answers.** V3 exposes the per-genesis gates: `canRead(bytes32 genesis, address
reader)` and `canReview(bytes32 genesis, address who)` (`S2SPublicationModuleV3.sol:297-312`). Both
admit an agreement **or** an offer. `canRead` admits the safe, the genesis author, and any address in
the publication's reviewer set; `canReview` is the narrower one — a reviewer, and offered or agreed.

Neither replaces the other. `canRead(genesis, reader)` trusts the address it is handed: the module
cannot ask whether that reader holds the Safe it names, so a caller MUST pair it with `isOwner`. The
press's composed gate does that in term 2, which is why the composition exists at all.

**What the press runs for a preview.** `canPreview(contentId, pubModule, signer, rpcs)` in
`src/press/actions/src/libs/gates.ts` binds the shared `canPreview`, and `decrypt` asks it whenever
the run is a preview. Two paths:

| term | call | means |
|---|---|---|
| 1 | `publicationModule.canReview(genesis, signer)` | the signer is in the reviewer set, and the genesis is offered or agreed |
| 2 | `safe.isOwner(signer)`, against `publicationModule.safe()` (that getter is read in parallel with term 1) | read only when term 1 refuses: the signer owns the publication Safe |
| 3 | `publicationModule.hasAgreement(genesis)` or `hasOffer(genesis)` | read only when term 2 passed: the genesis is under an agreement or an offer |

Neither `canPublish` nor `canAuthor` is asked, so a pending offer and a signer who owns no author Safe
the publication knows both reach a preview. Every read is fail-closed: a throw or a non-`true` answer
refuses, and a `safe()` that is not a usable address refuses the owner path. Term 1 and the `safe()`
getter share one `try`, so a failure of either refuses before a reviewer's `true` is used.

Two things follow, and both are load-bearing:

**Term 3 closes the publish path to an offer.** A pending offer has `hasAgreement == false`, and term 1
refuses it as well: a pending offer's author is not a whitelisted author. So a publish **cannot
decrypt an offer** — not the holders, not the author, not a reviewer. That is the composition a
publish is meant to have: it builds only from agreements.

**The reviewer path is the preview gate.** `canPreview` asks the module's `canReview(genesis, signer)`
first, which answers yes for a listed reviewer while the genesis is offered or agreed, and never asks
`canAuthor`. Its second path is ownership of the publication Safe the module's own `safe()` getter
names, read live, on the same offer-or-agreement condition. A failed read refuses. The reviewer set
is real — `setReviewer`, capped at 20, `onlySafe` — and the admin app's Preview is its surface.

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
| the publication reads it | from the deals row's Preview: one Lit render through `canPreview`, which decrypts an encrypted body. A row is also listed from the cache without a key, so a plaintext item is readable without the press |
| a reviewer reads it | the same Preview. The gate is the module's `canReview` inside `canPreview`, so a listed reviewer reads while the genesis is offered or agreed. No scoped read, no expiry |
| the decision | `admit` or `reject` on a V3 module (`acceptOffer` / `retract` on V2), both Safe transactions |

An offer may still be uploaded in the clear, and the app lists it without a key; that is a choice on
the authoring side, not a limit of the press. An encrypted offer is no longer an object nobody can
open: it opens to the reviewers the publication lists and to the publication's owners.

**Review is now a right the module grants.** The access control on a pending offer is the module's
answer: a listed reviewer and the publication's owners read while the offer or agreement holds, and
nobody else does. What is missing is the middle setting — the read is unscoped and leaves no trace.

## What a reviewer can see of an encrypted item

When the gate refuses, an encrypted item is still not opaque. The signed **public envelope** is in
the clear: `title` is body content (secret) but `attributes`, `tags`, `postType`, `locale`, `position`,
and `plaintextHash` are in the signed public part, and `proof` names the signer. A review surface
could therefore show *who* offered *what kind of* thing *when*, and verify the signature, without
the gate opening the body. The app shows that envelope on the row and leaves it there.

## Unknowns this spec does not settle

Recorded here, decided elsewhere (an RFC, not a spec — per `docs/conventions.md`):

1. Whether a reviewer read should be **scoped** (this genesis, until this time) or unconditional for
   the publication's holders. The preview gate is the latter: it asks the module each time, and the
   module answers while an agreement or an offer holds.
2. Whether a declined work becomes a **record** (`declined, by, at`) or stays an absence. Today decline
   removes the offer, leaves the log, leaves the bytes, and tells nobody.
3. Whether the author is **notified** of a decision, and through what — there is no event subscription,
   no webhook, no inbox anywhere in the system.

## Invariants this component preserves

- **A read never changes state.** The press's authorisation is an off-chain message
  (`extractSignerAddress` over `'lit actions auth'`); it costs nothing and writes nothing.
- **`canRead` and `canPreview` are fail-closed.** Any read returning false denies; an RPC failure throws
  in `canRead` and answers false in `canPreview`, so neither defaults to allow.
- **A preview asks the module's reviewer answer, not the author's.** `canPreview` asks `canReview`
  first and asks the ownership of the publication Safe only when that refuses; neither path asks
  `canAuthor`, so a reviewer reads an offer and the author's own right is not what opens it.

## Safe-to-change vs do-not-touch

- 🟢 show the public envelope of an unreadable offer in the app (additive, no gate change).
- 🟢 add a `declined` record as a new genesis-keyed structure.
- 🔴 weaken term 3 without replacing it (decryption of offers is a gated act by construction);
  🔴 let a publication Safe decrypt an item it has never dealt with — that would make the offer set a
  read capability and turns every offer into a publication-visible draft.

## Test seams

- Gate truth table over {deal, offer, unknown} × {listed reviewer, publication owner, neither} ×
  {hasAgreement, hasOffer}: an offer answers true for the reviewer and the owner, and false for a
  signer the module lists nowhere. The unknown-genesis row is false on both paths.
- An encrypted offer rendered through the press: a publish fails at the gate — term 1 or term 3 — and a
  preview renders it. The pair distinguishes "not allowed" from "broken".
- `canReview` against an offer: the module answers true for a listed reviewer, `canPreview` carries
  that answer, and no further read follows it.
- A failed `canReview`, `hasAgreement` or `hasOffer` read in a preview: refused, never admitted.
- An unencrypted offer: assert the app shows a title and no proof verification occurs on that path.
