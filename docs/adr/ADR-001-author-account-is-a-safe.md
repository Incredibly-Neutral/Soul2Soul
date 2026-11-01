# ADR-001 — the author's account is a Safe on Base

Status: accepted · Domain: AUTHOR · Satisfies: AUTHOR-5, AUTHOR-6

## Context

AUTHOR-5 wants an account that outlives its keys; AUTHOR-6 wants authorship
checked without the protocol holding a legal name. Both push against the obvious
design — the signing key *is* the identity — because a key is one secret: lose it
and the history goes with it, rotate it and everything must move.

Two further constraints. Authorship has to be checked by gates (GATES-1: the
author decrypts their own manuscript at any time) against something already on the
ledger, so no separate registry should be needed. And an implementation must be
able to start without holding any tokens, or the account is unreachable before the
author has any.

## Decision

The account behind a byline is a Safe on Base. Ownership of the Safe is the set of
keys that sign manuscripts; the author's address is the Safe's address. Gates check
authorship against the Safe, never against `msg.sender`. Gas is paid through an
ERC-4337 paymaster, so an author can publish before holding any token.

## Alternatives rejected

- **An EOA.** Simplest, and it fails AUTHOR-5 outright: no rotation, no recovery,
  history bound to one key.
- **A bespoke account contract.** Buys nothing for a prototype and adds an
  unaudited contract between an author and their own work. An author's account
  should not depend on code written for this implementation.
- **A separate authorship registry.** A second source of truth that gates would
  have to trust, replacing one the ledger already provides.

## Consequences

- AUTHOR-5 and AUTHOR-6 become **inherited**: the protocol owes only the
  discipline of never treating a signing key as an identity, and MUST NOT
  reimplement rotation or recovery. Rotation is an owner change, invisible to every
  record the protocol keeps.
- The account is a contract on one chain, and its owners are public. An author's
  privacy is pseudonymity, not anonymity.
- 4337 means the payer is a policy, not a fact of the account: an author can
  publish with no token, and whoever pays can be a sponsor or a publication
  (see `monetization-and-costs.md`).
