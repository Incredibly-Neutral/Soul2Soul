# PUBLICATION — the name, the look, and the line

Read against: `whitepaper/publication.md` (2026-10-29).

A publication is three things at once: a name its pages are served from, a look it designs
itself, and an editorial line — whom it trusts and what it carries. The protocol fixes none of
those choices; it only requires that they be public and that the publication cannot quietly undo
what an author decided. The name is the load-bearing part: an agreement ending means nothing
unless the publication has given up the ability to keep the name pointing at the old site.

Two routes reach the site. A trusted author offers a manuscript and it is carried at once; any
other author's manuscript waits to be admitted or declined. Either stance can change at any time,
on the record (PUBLICATION-4).

## PUBLICATION-1 — its own name and its own look

A publication MUST have a name of its own, and MUST be free to design its site with its own
templates and styles. The protocol MUST NOT prescribe how a site looks, and MUST NOT serve its
pages from a name it does not hold.

## PUBLICATION-2 — its own governance, in public

A publication MUST be able to choose its own governance: one holder or several, any threshold for
acting. That shape MUST be recorded publicly, and MUST be changeable only by the publication's own
procedure (PUBLICATION-4).

## PUBLICATION-3 — pseudonymous holders and editors

Holders and editors MAY be pseudonymous. The protocol MUST NOT require, store, or reveal their
legal identity.

## PUBLICATION-4 — trust and admission, on the record

A publication MUST be able to decide which authors it trusts and which manuscripts it admits, and
MUST be able to change either at any time. Every such decision MUST be recorded on the ledger.
No decision MAY reach the next build of the site by any other route: a change of stance that is
not on the ledger MUST NOT affect what the renderer builds.

## PUBLICATION-5 — reviewers read what is offered

A publication MUST be able to read any manuscript offered to it, through the reviewers it has
authorised, from the moment the manuscript is offered until it declines it or the author withdraws
it. The right ends when the offer ends; nothing already read is recalled.

## PUBLICATION-6 — decline, and end from its side, at once

A publication MUST be able to decline any manuscript, and to end any agreement from its side, with
immediate effect. A decline MUST be recorded. Declining or ending MUST NOT alter the manuscript.

## PUBLICATION-7 — a build on request

A publication MUST be able to trigger a rebuild of its site at any time.

## PUBLICATION-8 — the name points only where the renderer built

The publication's name MUST point only at sites the renderer has built from the agreements in
force. For that to hold, the publication MUST give up its own ability to change what the name
points to: from the moment it joins, only the renderer changes it, and only to a site it has just
built.

## PUBLICATION-9 — taking the name back means leaving

A publication MUST be able to take back the right to change what its name points to, and it MUST
be able to do so without anyone's permission. That act MUST be leaving the protocol, and leaving
MUST be visible: anyone reading the name MUST be able to see that the protocol no longer controls
it.

## PUBLICATION-10 — every revision is seen, and reviewed first

A publication MUST see every revision of a manuscript it carries, and MUST be notified of it. It
MUST review the revision before it is carried unless it trusts the author, in which case the
revision is carried at once and cannot be stopped — its remaining recourse is PUBLICATION-6.

## PUBLICATION-11 — the record outlives the agreement

A publication MUST keep a record of everything it has published and every byline it has carried.
An ended agreement MUST be marked as ended and MUST NOT be removed.

## PUBLICATION-12 — carried as signed

A publication MUST carry every manuscript exactly as its author signed it. No one, the publication
included, MAY alter a manuscript.

## PUBLICATION-13 — paid where it says

A publication MUST be paid directly, at a wallet it names. The protocol MUST NOT hold the money or
route it through a third party.

---

# This implementation

Read against `src/publication/` (contracts), `src/press/actions` (the press),
`src/shared/src/publication`, `src/author/neutralpress`, `src/publication/safe-app`.

## Additions

- **Caps on the trust lists.** A publication may trust at most 100 authors and 20 delegated
  builders (`MAX_WHITELISTED_AUTHORS`, `MAX_WHITELISTED_DEVS`). The protocol sets no ceiling, and
  the cap is structural rather than policy: the 101st author cannot be trusted until one is
  removed. Presumably gas, not intent — but it is a limit the protocol does not impose, and it
  should not be presented as one.
- **A second trust list.** Besides trusted authors, a publication may authorise accounts that may
  cause builds without being authors. This is the implementation of PUBLICATION-7 combined with
  GATES-4's third caller, kept separate from the author list so that "may ask for a build" and "is
  trusted to publish" do not collapse into one thing.

## Gaps without a proposal

- **PUBLICATION-5 — an offered manuscript cannot be read.** The only decryption gate is
  `canRead`, which asks `canPublish(author)` and `hasDeal(genesis)`; `hasOffer` exists on the
  contract and no gate reads it. So a pending offer fails twice over: the author is by definition
  not trusted, and there is no deal. Reviewers can see that an offer exists and what its latest
  CID is, but cannot open it — which makes "wait for review" a queue nobody can review.
- **PUBLICATION-9 — there is no way to leave.** Nothing in the contracts implements a departure:
  no per-publication release of name control, no opt-out. And the name's record store is
  single-tenant by construction — one owner, one `protocolAddress`, per-node authorisation — so
  "this publication took its name back" is not expressible at all, only a protocol-wide act would
  be. The consequence is worse than a missing feature: PUBLICATION-8 holds *because* PUBLICATION-9
  cannot happen.
- **PUBLICATION-10 — no notification.** Revisions are appended to the log and a revision by a
  trusted author is carried immediately, so the seeing half holds. Nothing notifies: no event
  subscription, no outbound channel, nothing in the CMS that raises a revision.
- **PUBLICATION-11 — "ended" exists only as an event.** The version log is append-only and
  survives everything, so what was carried is retrievable in principle. But retracting removes the
  entry from the deal and offer sets, and nothing reads `Retracted`: a publication's own state
  cannot list ended agreements, and no byline record is kept beyond the log's author field.
- **PUBLICATION-13 — no payee exists.** There is no payment address, split, or royalty field
  anywhere in the contracts, the actions, or the CMS. This is the mirror of the author's gap, and
  the author at least has a proposal (`rfc/RFC-002-payee-wallet.md`); the publication side has
  nothing.

## Decisions not yet written up

- The asymmetry of `retract`: the author withdraws entirely and the entry disappears; the
  publication ending an agreement demotes the deal back to an offer, so the manuscript stays in its
  queue and can be re-admitted without the author signing again. It satisfies PUBLICATION-6 as
  written, but it is a choice, and it is the first ADR this domain should have.

## Not yet established

- **Who owns the name's record store.** The records contract has one owner and one
  `protocolAddress`; only the owner can move `protocolAddress`, and the owner or the protocol can
  authorise writers. Which of the two the publication's own name is, decides everything about
  PUBLICATION-8 and PUBLICATION-9: if the owner is the protocol, PUBLICATION-8 holds and
  PUBLICATION-9 is unreachable; if the owner is the publication, PUBLICATION-9 is one call away and
  PUBLICATION-8 does not hold at all. The deployment is not in this repo, so this has to be
  answered from the chain, not from code.
- **Where the decryption conditions live.** `canRead` is the action-level gate, but the ciphertext
  was sealed at encryption with a condition set that is not in this repo — it belongs to the PKP
  authorisation registered with the network, not to code that ships with the press. That splits
  responsibility across a boundary no file records, and it decides whether the same manuscript can
  be opened under different rules than the ones `decrypt.ts` enforces. Related: GATES-5's open
  question in `gates.md`.
