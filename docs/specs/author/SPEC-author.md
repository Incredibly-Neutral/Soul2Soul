# AUTHOR — the author's guarantees

Read against: `~/code/polyphony/whitepaper/author.md` (2026-10-29).

Branches: [overview](SPEC-author-overview.md) (the model, host matrix, reading order) · [identity](SPEC-author-identity.md) · [publishing](SPEC-author-publishing.md) · [shared](SPEC-author-shared.md) · [hosts](SPEC-author-hosts.md) · [cli](SPEC-author-cli.md) · [nvim](SPEC-author-nvim.md) · [vscode](SPEC-author-vscode.md) · [nvim-s2s](SPEC-nvim-s2s.md) · [drafts](SPEC-author-drafts.md) (the draft log on the author Safe — uploaded and never offered) · [owner-history](SPEC-author-owner-history.md) (who was an owner of the author Safe, and when — the guard plus the module behind it).

An author is an account that signs manuscripts. Everything below is owed to that
account, not to a person: the protocol never learns a legal name.

**Account** — a public, permanent handle that manuscripts are signed by. The keys
that control it are replaceable, and control is recoverable if they are lost. It
MAY be pseudonymous, MAY carry a display name recorded on the ledger, and MAY
name a wallet that receives what it is owed.

**Manuscript** — a document, addressed by content, signed by an account and
encrypted to the press's key.

**Revision** — a new signed version of the same manuscript.

**Offer** — a manuscript made available to a publication. Not a transfer.

**Agreement** — a ledger record under which a publication may publish a
manuscript.

---

## AUTHOR-1 — writing is local

Writing and revising MUST NOT require the network. Publishing MUST be a separate,
deliberate, signed act.

Note: the protocol defines an interface, not an application, so no single program
stands between an author and their manuscripts. That is a requirement on
implementations, not an aspiration about tooling.

## AUTHOR-2 — sign and encrypt to the press

Every manuscript MUST be signed by the author's account and encrypted to the
press's key. After that it MUST be decryptable by exactly three parties: the
author, at any time; the reviewers of a publication it has been offered to, while
that publication considers it; and the renderer, while an agreement covers it.
Nothing else.

Note: a narrow set of fields — tags among them — MUST stay in the clear so a
publication can sort and organise an offer before decrypting anything. An offer is
therefore publicly observable: anyone can see that a manuscript was offered, and
to whom.

## AUTHOR-3 — ending an agreement, alone

The author MUST be able to end any agreement alone, at any time, with immediate
effect, as one ledger entry, without the publication's consent or cooperation.
From that moment the renderer MUST NOT be able to decrypt the manuscript for that
publication, and the author MUST be able to cause the site to be rebuilt without
waiting for the publication.

Note: ending the agreement removes the right; only a rebuild removes the work from
the site under the publication's name, and both MUST be available to the author
acting alone. Copies already read, saved or archived elsewhere cannot be recalled,
and the protocol does not pretend otherwise. What is stopped is the publication
presenting the work as part of what it publishes now.

## AUTHOR-4 — revisions are recorded, not overwritten

A revision MUST be a new signed version of the same manuscript, and every version
MUST be recorded. An agreement MUST name the version the publication approved; a
later revision MUST NOT silently extend that approval.

## AUTHOR-5 — the account outlives its keys

Keys MUST be replaceable, and control of the account MUST be recoverable after
total key loss, without losing the account, its history or its reputation. No
protocol record MAY bind an author's identity to a single key.

## AUTHOR-6 — pseudonymous by construction

The protocol MUST NOT hold a legal name for an author and MUST NOT require one to
publish.

Note: pseudonymous is not anonymous. Everything an account publishes stays linked
to that account, permanently. A display name on the ledger is an attribute the
author chooses, not an identity the protocol keeps.

## AUTHOR-7 — payment arrives directly

An account MUST be able to name a wallet, and any payment owed to the author MUST
arrive at that wallet, never through the publication's hands.

## AUTHOR-8 — no exclusivity

An author MUST be able to offer the same manuscript to any other publication. The
protocol MUST NOT impose exclusivity; any exclusive is a contract between the
parties, outside the protocol.

Note: with AUTHOR-3, this means one manuscript MAY carry agreements with several
publications at once, any of which the author can end alone.

## AUTHOR-9 — the authored work list

Every account MUST keep a public list of its works and its agreements, past and
current. The list MUST sit on the ledger, MUST hold references and proofs rather
than the manuscripts, and MUST be curatable only by the author. It MUST survive
leaving any publication.

Note: this is what makes a byline portable — how an author proves, long after
leaving, what they published and when, and how anyone checks that claim against
the ledger.

---

# This implementation

The prototype is a layer between these invariants and the code: it may do less
(gaps) or more (additions). Recorded against `../../prototype/author.md`.

## Decisions

- **ADR-001** — the author's account is a Safe on Base
  → [adr/ADR-001-author-account-is-a-safe.md](../../adr/ADR-001-author-account-is-a-safe.md)
  Carries AUTHOR-5 and AUTHOR-6; the protocol's obligation reduces to never
  binding identity to a signing key.
- **ADR-002** — revoking retracts on-chain first, then re-renders with a remove
  directive → [adr/ADR-002-revoke-retracts-then-re-renders.md](../../adr/ADR-002-revoke-retracts-then-re-renders.md)
  Satisfies AUTHOR-3 in one command, both halves, author alone.

## Proposals

- **RFC-001** — the portable byline (AUTHOR-9)
  → [rfc/RFC-001-portable-byline.md](../../rfc/RFC-001-portable-byline.md)
  An author-owned records module on the account, holding per-work claim records, plus a
  derived anyone-can-index view. Ships the list and the reader path together.
- **RFC-002** — a payee wallet on the account (AUTHOR-7)
  → [rfc/RFC-002-payee-wallet.md](../../rfc/RFC-002-payee-wallet.md)

## Gaps without a proposal

- **GAP — the subtractive rebuild has no gate of its own.** AUTHOR-3's second half is
  authorised by the same gate as publishing: `canPublish(author) && isOwner(signer)`, where
  `canPublish` answers "is this address trusted by the publication" — the publication Safe, its
  whitelisted devs, its whitelisted authors. Nothing in it asks whether the caller authored
  *this* manuscript. The publication can call `removeWhitelistedAuthor` at any time, and the
  author then still retracts on the ledger (that path is theirs alone) but cannot cause the page
  to be rebuilt away: the withdrawal stops at the ledger while the site keeps the work under the
  publication's name. So the publication retains a stall lever over precisely the act the
  protocol promises is unilateral, and retains it exactly when relations have broken — which is
  when AUTHOR-3 matters.
  The fact such a gate would need is already on-chain and survives revocation:
  `genesisAuthor[genesis]` is set when the manuscript is offered and is **not** cleared by
  `retract`, which only removes the deal and offer flags. Authorship is therefore readable
  without the publication's trust, and a subtractive gate could be
  `genesisAuthor(genesis) == authorSafe && isOwner(signer)`, restricted to remove-only
  directives. Recorded as a gap, not an RFC: no fix is agreed. Belongs in `gates.md` as the
  missing half of `canPublish` — the additive gate asks whether the publication trusts you, the
  subtractive one must ask whether the manuscript is yours.
- Open question, not a gap: AUTHOR-2's reviewer path is implemented but its
  boundary with the read gate is only described in code. Awaiting `gates.md` and
  `press.md` before it is written down here.
