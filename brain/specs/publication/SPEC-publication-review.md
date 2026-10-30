# SPEC-publication-review — what a publication can let a reviewer read before deciding

> **Parent:** [SPEC-publication](../SPEC-publication.md) — the publication front door.
> **Siblings:** [SPEC-publication-agreements](SPEC-publication-agreements.md) (the state being decided),
> [SPEC-publication-admin-app](SPEC-publication-admin-app.md) (the surface that proposes the decision).
>
> **Type:** component spec, small on purpose. It owns one question: **between "offered" and "decided",
> who may read the work?** Today the answer is "whoever the author let hold the bytes", and this spec
> exists so that gap is written down rather than discovered.
>
> **Audited against live code:** 2026-10-30 (`protocol/actions/src/libs/gates.ts`,
> `libs/decrypt.ts`, `shared/src/cid-view/`).

---

## Responsibility

Not the decision (agreements) and not the decryption machinery (the press, a sibling:
[SPEC-protocol-actions](../SPEC-protocol-actions.md)). This spec owns the **composition** of the read
gate as it applies to a pending offer, and the consequences of that composition for review.

## The gate

`canRead(contentId, safeAddress, publicationModule, signerAddress, rpcs)` — three ANDed reads, all on
L2, all `evmRead`:

| term | call | means |
|---|---|---|
| 1 | `publicationModule.canPublish(safeAddress)` | the publication Safe itself is entitled to publish |
| 2 | `safe.isOwner(signerAddress)` | the caller is a holder of the publication Safe |
| 3 | `publicationModule.hasDeal(toBytes32Id(contentId))` | **the work is a deal** |

Two things follow, and both are load-bearing:

**Term 3 is the whole problem.** A pending offer has `hasDeal == false`. So a pending offer **cannot be
decrypted through the press by anyone** — not the holders, not the author, not a reviewer, not the
person who wrote it. The gate has no `hasOffer` branch, and nothing in the action set calls `hasOffer`.

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
| a reviewer reads it | same row, same fetch. There is no reviewer identity, no scoped read, no expiry |
| the decision | `acceptOffer` or `retract`, both Safe transactions |

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

Recorded here, decided elsewhere (an RFC, not a spec — per `brain/docs-conventions.md`):

1. Whether review needs a **third list** (reviewers) or a `hasOffer` branch in `canRead` keyed by an
   address the Safe names — or both.
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
- **Offers are visible or unreadable, never selectively readable.** Until (1) is decided, any per-reviewer
  access would have to be invented, not configured.

## Safe-to-change vs do-not-touch

- 🟢 show the public envelope of an unreadable offer in the app (additive, no gate change).
- 🟢 add a `declined` record as a new genesis-keyed structure.
- 🔴 weaken term 3 without replacing it (decryption of offers is a gated act by construction);
  🔴 let a publication Safe decrypt an item it has never dealt with — that would make the offer set a
  read capability and turns every offer into a publication-visible draft.

## Test seams

- Gate truth table over {deal, offer, unknown} × {holder, non-holder} × {canPublish true, false}: the
  offer/holder row must be **false** for an encrypted body, and is the regression that matters.
- An encrypted offer rendered through the press: assert it fails at `hasDeal`, not at decryption — the
  difference distinguishes "not allowed" from "broken".
- An unencrypted offer: assert the app shows a title and no proof verification occurs on that path.
