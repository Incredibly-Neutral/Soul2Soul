# AGREEMENT — a manuscript, two parties, and terms neither can rewrite

Read against: `~/code/polyphony/whitepaper/agreement.md` (2026-10-29).

Branch: [publication/SPEC-publication-agreements](../publication/SPEC-publication-agreements.md) — the contract as built (`S2SPublicationModuleV2`), offer/deal/retract, the version log.

An agreement is the whole of what makes a manuscript published. It names one manuscript, it records
an author and a publication, it carries the publication's permission and the division of any revenue,
and it is the only thing the press consults before decrypting for a publication. There is no list of
what a publication carries: the set of agreements in force *is* the site's content.

Agreements are also the protocol's memory. What a publication carried and who wrote it has to
outlive the agreement, because an author's hold on a work cannot be undone by a site rebuilding
without it.

## AGREEMENT-1 — one manuscript, and the latest version the publication approved

An agreement MUST cover exactly one manuscript. It MUST point at the latest version of that
manuscript that the publication has approved, and MUST never point at a version it has not.

Note: approval is per version, not per manuscript. An agreement that lets a new version of a
manuscript be carried without the publication approving it is not this invariant with a shortcut;
it is a different rule.

## AGREEMENT-2 — author, permission, and division, on the record

An agreement MUST record which author it is with, the publication's permission to publish, and how
any revenue from it divides. All three MUST be readable by anyone.

## AGREEMENT-3 — both parties' consent

An agreement MUST require the consent of both parties: the author's, by offering the manuscript, and
the publication's, either for that manuscript or in advance by trusting the author. Withdrawing
trust MUST NOT affect agreements already made.

## AGREEMENT-4 — either party can end it, alone and at once

Either party MUST be able to end an agreement without the other's consent, and the ending MUST take
effect from the moment it is recorded on the ledger.

## AGREEMENT-5 — the only ground for decryption for a publication

The agreement MUST be the only thing that lets the press decrypt a manuscript for a publication.

## AGREEMENT-6 — on the ledger, and still there when it ends

An agreement MUST sit on the ledger, where neither party can rewrite it. When it ends it MUST stay
there, marked as ended.

Note: "marked as ended" is a state a reader can read, not an event a reader must reconstruct from a
log. An ended agreement that is indistinguishable from one that never existed fails this,
whatever history is still queryable.

## AGREEMENT-7 — an ending holds

An agreement that has ended MUST stay ended. No change to how agreements are entered or ended,
including one made through the protocol's governance, MAY make a manuscript usable again under it.

---

# This implementation

Read against `src/publication/contracts/src/S2SPublicationModuleV3.sol`,
`src/shared/src/gates`, `src/press/actions/src/render/main.ts`.

## Readings

- **An agreement is not an object.** The module keeps a boolean per manuscript: `_isDeal[genesis]`.
  The author is `genesisAuthor[genesis]`, set by the first version ever appended; the versions are an
  append-only log under the same genesis; the permission is the boolean. There is no struct to read,
  and nothing to enumerate beyond the two lists of deals and offers.
- **Offering and accepting are one call each.** `makeOffer(genesis, cid)` appends a version and then
  decides: the publication's own safe, or a trusted author, strikes the deal immediately; anyone else
  leaves the manuscript as an offer. `admit(genesis)` turns an offer into a deal; `acceptOffer` is kept
  as its deprecated alias, and it is the only name a V2 module implements, which is why a caller of an
  older publication still sends that one.
- **Ending is split in two, and only one half is reversible.** `reject(genesis)` is the publication's
  verb: `onlySafe`, and it demotes a deal to an offer or declines an offer, so the manuscript stays in the
  publication's queue and can be admitted again without the author signing again. `retract(genesis)` is the
  genesis author's verb: it ends the genesis, tombstones the latest version and drops the agreement, and
  nothing re-opens it — a later `makeOffer` or `admit` reverts `Ended()`. Ending was asymmetric in V2 as
  one function branching on `msg.sender`, and the first ADR in `publication.md` still records that shape;
  V3 made the asymmetry two functions with different guards.
- **AGREEMENT-5 is the live one.** `canRead` asks `hasDeal(genesis)` and nothing else about the
  publication's side, so the boolean is exactly the ground the invariant names.
- **Rule changes are upgrades.** The module sits behind a proxy that only the publication's safe may
  upgrade, so the entry and ending rules change through the protocol's procedure and never through
  the publication's own — which is what the paper requires of them.

## Additions

- **The publication may author.** When the safe itself calls `makeOffer`, it is the manuscript's
  genesis author, so a publication can publish under its own name without a separate author account.
  The protocol has no such role; it is a convenience of sharing one key.
- **A manuscript's identity is its first version.** `genesis` is fixed at the first append and every
  later version carries the same identity, which is what lets an agreement survive revisions at all.
  Stated here because the paper leaves the identity of a manuscript implicit.

## Gaps without a proposal

- **AGREEMENT-1 — approval is per manuscript, not per version.** An untrusted author who is admitted
  once can then append revisions that are carried without review: `makeOffer` appends the version
  first and only then checks trust, and an existing deal is deliberately left intact when a
  non-trusted author edits. A trusted author's revision going straight out is the paper's own rule
  (PUBLICATION-10); this is the other case, and it is not.
- **AGREEMENT-2 — no division exists.** There is no revenue field anywhere in the module, so an
  agreement records two of its three required facts. The proposal on the author side
  (`../../rfc/RFC-002-payee-wallet.md`) covers only where an author is paid; nothing addresses the split.
- **AGREEMENT-6 — ended is an event, not a state.** `Retracted` is emitted and the entry is removed
  from the deal and offer sets; nothing writes "ended" anywhere readable. The append-only version
  log survives, so the manuscript's history is queryable, but the agreement's ending is not — and a
  reader asking the module whether a manuscript is published gets the same answer for "ended" and
  "never published".
- **AGREEMENT-7 — the publication can undo its own ending.** Because the publication's `retract`
  demotes rather than clears, and the author's standing version is still a valid offer, the same
  agreement can be re-struck by the publication alone. As written AGREEMENT-7 constrains rule
  changes, not this, and AGREEMENT-3's consent reading survives it (the author's append stands as an
  offer). It is recorded here because it is a consequence of there being no ended state at all, and
  the two gaps should be fixed together or not at all.

## Not yet established

- **Whether the terms can grow without changing the rules.** AGREEMENT-2's missing division needs
  storage the module does not have, which means an upgrade — and an upgrade is the same channel the
  paper reserves for changing how agreements run. Whether adding a field is "the same rules with more
  recorded" or "a change of rules" is a governance question, not a code question.
