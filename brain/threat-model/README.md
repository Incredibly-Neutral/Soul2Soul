---
section: threat-model
protocol: soul2soul
status: drafting
last_reconstructed: 2026-09-09
source: threat-model working notes (joera + panel synthesis); grounded in whitepaper components 0–8. Read 00-introduction.md first.
---

# Threat model — index

These files document the **threat levels** the S2S protocol does and does not claim to
defend, per actor. They are honest scoping documents: they state what the protocol
**claims** (A), what it **partially addresses and must scope, not sell** (B), and what it
**explicitly defers** (C) — plus the residuals that no design removes.

The governing frame across all three files:

> **The protocol removes the rails between the actor and its risk; the actor owns the
> residual risk of being a real person/institution. It claims resilience and independence,
> not uncensorability, and it makes no claim to make anyone unbuyable, unseizable, or
> unidentifiable forever.**

A recurring structural fact: **the adversary is not one "state."** Two very different
adversaries demand different responses, and no file conflates them:

- the **hostile state** (surveillance, arrest, no court protects you) — the ceiling of any
  design is the residuals below; and
- the **rule-of-law state** (compelled disclosure *through courts*, which even a free press
  faces daily) — here the protocol can claim more.

The sections deliberately **do not claim uncensorability**. This version of the protocol is
built to be **fully stoppable** at the institutional/naming layer; a fork is the intended
path for anyone who wants to optimize for fully uncensorable publications.

## Files

| File | Actor | Core question |
|---|---|---|
| `author.md` | the individual writer | Can the pseudonym be linked to the person, and over what time horizon? |
| `publication.md` | the named institution + its owners | Can the institution be stopped, pressured, or its name made unresolvable? |
| `protocol.md` | the machinery itself | Can the protocol be shut down, captured, or a single point of failure exploited? |

## Cross-cutting residuals (all three share these)

- **Time is the adversary.** Any defense that defeats a *one-off* observer does not defeat a
  *persistent* one; the longer the listening, the weaker the pseudonym/institution.
- **Compellable relays.** Every third party that sees *something* (RPC, paymaster, bundler,
  gateway, DNS, repo host, UI host) is legally compellable.
- **The human and the machine are the custody.** Device seizure and personal compulsion are
  the rubber-hose end no protocol touches.
- **Money is a deanonymizer.** Whatever rail pays a person must settle somewhere real; this
  is why monetization is out of protocol scope (see `author.md` § money).

## Status
- `author.md` — drafted.
- `publication.md` — drafted.
- `protocol.md` — queued.

These are **working notes** for the threat section, not the whitepaper body itself. Fold
into the Introduction/component docs only after joera approves the prose.
