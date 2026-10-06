---
section: threat-model
protocol: soul2soul
actor: protocol
status: drafted
last_reconstructed: 2026-09-09
source: reading-room reactions (round 1) + whitepaper section 5 draft + specs/SUMMARY-protocol.md
---

# Protocol — threat model

> The machinery itself. Core question: **can the protocol be shut down, captured, or a
> single point of failure exploited?**

Governing frame (shared with author.md / publication.md): the protocol claims resilience
and independence, not uncensorability. It is stoppable by design at the institutional/naming
layer; a fork is the intended route to something stronger.

## A. What the protocol claims (and the record backs)

- **Only approved code, using the approved key, produces a served page or a recorded
  root.** Actions are pinned by CID; the contract admits the root write only from the
  protocol key; and the whole path is externally verifiable by walking the chain
  (domain → Safe → records → valid actions). This is a requirement-of-code claim, and the
  record is its guarantee: anyone can check what the code is and what the key may do.
- **No operator holds the signing key.** The key is derived inside a TEE and never leaves
  the enclave (Lit V3 "Chipotle"); execution requires multiple independent nodes reaching
  consensus. No single holder — protocol owners included — can sign for a publication.
  *(Scope: this claim is exactly as strong as TEE integrity and genuine node
  independence; it is not stronger.)*
- **Actions are immutable and auditable.** CIDs cannot be altered without detection; the
  code is open source; the name-to-code path is short and public.
- **Governors have no part in rendering or in author/publication business.** Their lever is
  which actions are permitted and tied to the protocol key — nothing else.

## B. Partially addressed — scope, don't sell

- **Censorship by upgrade.** Governors can adopt code that cuts a publication or author
  off; the upgrade path makes it technically possible. It is visible — a public decision
  carrying reputational cost — so it cannot be done silently. **Transparency of the act is
  guaranteed; impossibility is not.** The child-pornography case is the honest
  acknowledgment: a community that wants the lever will pull it. Named limit, by design
  ("stoppable by design, fork for uncensorable").
- **The rendering/access layer is a chokepoint by design.** Decryption, signing, and the
  root write all concentrate in the PKP + Lit network (Doctorow's DRM charge, round 1).
  The counter (Max's framing, round 1): the test is not whether a gate exists but whether
  the author can decrypt and republish freely outside the name — and they can, because the
  author holds their own material and the gate governs only what the name serves. Real
  capture vectors remain: a compromised or broken TEE, a Lit network that stops being
  independent, an extracted PKP. The design does not remove these; it mitigates with
  openness — anyone can fork to another PKP or network — rather than with impossibility.
- **Naming/records path has single points.** The CCIP gateway
  (`ccip.transport-union.dev`) is a documented `[GAP]` single point. DNS/ENS seizure,
  poisoning, and hard-to-resolve apply to the protocol's name as to any name (shared
  residual with publication.md).
- **Compellable relays.** RPC, paymaster, bundler, repo host, UI host — every party that
  sees something is legally compellable (shared residual).

## C. Deferred

- **A fully uncensorable protocol** (no upgrade path) — explicitly not the aim; a fork is
  the intended route for anyone who wants it. We recommend waiting until ux has been battle tested.
- **Hostile-state immunity** — the protocol claims resilience and independence, not
  uncensorability; it does not claim to make anyone unbuyable, unseizable, or
  unidentifiable forever.

## Residuals (no design removes these)

- **Time is the adversary.** Persistent observation beats any one-off defense.
- **State power is the ceiling.** Compelled disclosure through courts, seizure of the human
  and the machine — the rubber-hose end no protocol touches.
- **The integrity claims stand on the TEE + consensus.** If those are wrong, the neutrality
  is wrong; the design's answer is openness and forkability, not a stronger promise.
