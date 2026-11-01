# RFC-002 — a payee wallet on the account

Status: proposed · Domain: AUTHOR · Satisfies: AUTHOR-7

## Problem

AUTHOR-7 requires that an account be able to name a wallet, and that payment owed
to the author arrive there directly, never through the publication's hands. No
account, record or agreement struct carries a payee, so the invariant has nothing
to point at. It is the author's half of the first monetization rail.

## Options

**A. A record on the author's own store** (RFC-001), key `payee`, value an address.
Same permission model as the work list: only the author's account writes it,
anyone may read it.

**B. A field on the agreement.** Wrong scope: AUTHOR-7 says the *account* names the
wallet, so a per-agreement field would let a publication's agreement carry a
different destination, and the author would have to update it per publication.

**C. A text record on the author's name.** Name-space is the publication's, not the
author's; also mixes two ledgers of meaning.

**D. A Safe module.** More machinery than one address needs.

## Proposal

**A**, folded into RFC-001's store: one more key, no new contract. When the rail
that pays authors exists, it reads `payee` and sends there; when it does not, the
field is still the author's statement of where money should go, which is what the
invariant asks for.

## Notes

- Order matters only in one direction: the field may land before the rail. The
  reverse — a rail that pays authors with nowhere to send — would be a payable the
  publication controls, which is the thing the paper forbids.
- The address is public along with the rest of the account. That is consistent
  with AUTHOR-6: pseudonymous, not anonymous.
- If RFC-001 lands as a per-author records instance, this is a one-line addition to
  it. If RFC-001 is rejected, this RFC keeps option A but needs a store of its own.
