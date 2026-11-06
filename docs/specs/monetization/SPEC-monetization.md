# MONETIZATION — three rails, and nothing in the middle

Read against: `~/code/polyphony/whitepaper/monetization-and-costs.md` (2026-10-29).

No branch: no rail is built. The one proposal is [RFC-002](../../rfc/RFC-002-payee-wallet.md).

The protocol lays three rails and no business model. A destination: every author account and every
publication can name a wallet. A division: the agreement records how revenue splits, and the ledger
performs the split. A condition: the reader gate can ask for anything the ledger can confirm, and
answers only yes or no.

What the protocol guarantees is what happens *on* the rails — that money arrives where it was said
to arrive, in the proportion agreed, and that nobody stands between payer and payee. Whether a
publication charges, what it charges for, and how it divides a subscription across many manuscripts
is its own affair, and the protocol is deliberately silent on all of it.

The three rails are one system: a payment without a division pays one party, a division without
destinations has nowhere to go, and either without the reader gate has nothing to release. An
implementation that has none of the three has no monetization at all, which is a legitimate state
for a prototype and not a partial one.

## MONETIZATION-1 — the three rails, offered to every publication

An implementation MUST offer every publication all three: a wallet it can name, a wallet each of its
authors can name, a division recorded in the agreement, and a reader gate.

## MONETIZATION-2 — straight to the named wallets

Payment made on the rails MUST go to the wallets the author and the publication have named. No party
in between MAY hold it, and the protocol itself MUST NOT.

## MONETIZATION-3 — divided on the ledger, as agreed

A payment MUST be divided on the ledger according to the division the agreement records. Neither
party MUST be paid out of the other's hand.

## MONETIZATION-4 — the division holds for the agreement's life

The division MUST NOT change while the agreement lasts, by either party alone. Changing it MUST mean
ending the agreement, which takes the manuscript off the site, and making a new one.

---

# This implementation

Read against `src/publication/contracts/src`, `src/shared/src/gates`, `src/author/author-cli`,
`src/press/actions/src/render`.

None of the three rails is built. There is no wallet field on an account, a name, or an agreement;
there is no division, no splitter, no escrow and no payment call anywhere in the contracts or the
press; and the reader gate exists as an invariant (GATES-7, GATES-8) with nothing behind it.

The room this leaves is not a gap in a feature — it is the whole domain. The four invariants above
are recorded so that the paper's claims about payment are visible as claims, and so that the two
adjacent domains' gaps stay linked to them: AUTHOR-7 and PUBLICATION-13 are the destination rails
seen from each party's side, and GATES-7 is the condition rail seen from the gate's side.

## Readings

- **Two of the four are blocked on the same missing thing.** MONETIZATION-3's split needs a field in
  the agreement, and AGREEMENT-2 already records its absence. MONETIZATION-4 is then vacuous, not
  violated: with no division there is nothing to hold constant.
- **The one payment path in the tree is a cost, not a rail.** The press pays a storage service to
  keep manuscripts and pages available, and the scripts for funding and topping up that account are
  part of the press. That is the paper's Costs paragraph, not its rails: no reader pays through it
  and no author is paid out of it.
- **`canRead` would be the reader gate's carrier.** It is the only gate that runs when text is
  released (GATES-7's mechanism), and it currently asks only about deals and authorship. A payment
  check would be one more injected read; the shape exists, the terms do not.

## Additions

- **The press bears the protocol's costs for its users.** Running the press, pinning manuscripts and
  pages, and writing to the ledger are all paid by the operator rather than by the author or the
  publication. The paper allows an implementation to pay for its users; the choice is invisible in
  the code but decisive for what using the protocol costs anyone.

## Gaps without a proposal

- **MONETIZATION-1 — no destination.** Neither an account nor a publication can name a wallet. The
  author's half has a proposal (`../../rfc/RFC-002-payee-wallet.md`); the publication's half has none, and
  until both exist the rail has two missing ends.
- **MONETIZATION-1, division — nothing records a split.** See AGREEMENT-2. This is the one gap here
  that no proposal addresses at all, and it is the one that decides whether "revenue divides" in the
  paper means anything.
- **MONETIZATION-1, condition — the reader gate cannot ask for a payment.** No ledger read in the
  gates answers "has this reader paid", and PRESS-7 is unbuilt besides, so even a positive answer
  would release nothing. GATES-7's mechanism is missing at both ends.
- **MONETIZATION-2 and 3 — no payment path exists**, so nothing can be said about where it goes or
  how it divides. Recorded rather than inferred: the absence is verifiable, the intended design is
  not in the tree.

## Not yet established

- **How a payment that opens many manuscripts is divided.** The paper names subscriptions as the
  case the protocol deliberately leaves open, and there is no design in the repository to test that
  claim against. It is the largest unanswered question in this domain and the one that most affects
  whether the rails are usable by a real publication.
