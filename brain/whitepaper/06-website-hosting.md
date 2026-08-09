---
component: website-hosting
protocol: soul2soul
number: 6
status: active-decision
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude conversation history; not filled beyond what was discussed
---

# Component 6 — Website hosting (storage & retrievability of the rendered site)

> Reconstructed for machine memory. Decision entries are preserved as discussed,
> not synthesised. Where the record is thin, it is left thin. Gaps are marked
> `[GAP]` rather than filled.

## Functional description

Storage and delivery of the **rendered, content-addressed site** — the HTML tree
the neutral execution environment produces — such that a published page can be
retrieved by anyone, verifiably, without depending on a single host staying online.

This is distinct from **Component 2 (content storage)**, which concerns the raw
authored *items* (posts, encrypted content, queryable metadata). Component 6 is
about the *output* side: the generated website, and the guarantee that it remains
retrievable.

## Minimum guarantee (protocol-level)

- Addressing is **content-derived** (URL = content hash); altering the content
  changes the address.
- Delivery is **decentralised** — no single server whose removal takes the site down.
- The **complete site structure** is preserved (not just individual pages).
- Retrievability is a **first-class guarantee**, not best-effort pinning.

## Reference implementation

**Current:** IPFS (content-addressed HTML tree).
**In migration (as of 2026):** Filecoin — specifically the PDP / warm-storage stack
(Filecoin Pin / Synapse SDK), replacing reliance on IPFS pinning services (Pinata).

---

## Decision record

### DR-6.1 — Content addressing as the hosting primitive
**When:** early (2025), recurring
**Decision:** The site is hosted as a content-addressed HTML tree; the URL is derived
from the content hash, so any modification changes the address.
**Rationale (as discussed):** "Content-addressed storage means the URL is derived from
the content itself. Change the content, the address changes. No central server can take
it down or modify it." This is the property that makes the hosting layer censorship- and
tamper-evident.
**Status:** stable — this is a fixed protocol property, not an implementation detail.

### DR-6.2 — The retrievability problem was, for years, unsolved
**When:** context predating the Filecoin move
**Observation (as discussed):** Relying on "IPFS pinning services or hoping nodes stay
up" was the weak point. IPFS gives content addressing but not *incentivised persistence*
— nodes can drop content. This is the gap Component 6's minimum guarantee exists to close.

### DR-6.3 — Filecoin PDP identified as the retrievability layer
**When:** 2026-02-17
**Decision direction:** Adopt Filecoin's PDP (Proof of Data Possession) / Onchain Cloud
stack as the path to *verifiable, incentivised* persistence with the same CID-based
addressing already in use.
**Key facts established (from research at the time):**
- **PDP** launched mainnet May 2025; verifies individual pieces onchain rather than
  sealed sectors. Introduced "ProofSets" / Data Sets — open contracts where individual
  pieces can be added and proven over time.
- Stack: **Filecoin Warm Storage Service (FWSS)** (fast unsealed storage w/ service
  contracts), **Filecoin Pin** (persist IPFS content w/ PDP-backed guarantees),
  **Filecoin Pay** (onchain billing), **Filecoin Beam** (incentivised retrieval/CDN).
- **Beam** is the piece that finally makes retrieval a first-class, measurable,
  incentivised service rather than an afterthought.
**Why it fits S2S:** same CID addressing, plus verifiable persistence — directly closes
the DR-6.2 gap.

### DR-6.4 — Storacha → Filecoin Pin migration confirmed the timing
**When:** 2026-05-06
**Trigger:** Storacha emailed clients directing migration to Filecoin Pin within the month.
**Interpretation (as discussed, and confirmed):** Filecoin is finally able to accept small
badges of data in storage contracts and serve them globally — real retrievability at last,
"delivering on its original 2017 promise of incentivised IPFS persistence *with* real
retrievability." Storacha clients are early users because Storacha is a launch partner;
docs lagged the mainnet rollout.
**Model established:**
- Filecoin Pin stores data with **2 independent replicas** across separate providers;
  **PDP proofs verify onchain every 24h**; **payments halt automatically if proofs stop**.
- **Storacha** = managed hot storage w/ UCAN access control on top of the same infra;
  **Filecoin Pin** = thinner developer primitive directly on the Onchain Cloud contracts.
  (Analogy discussed: raw S3 vs Cloudflare R2.)

### DR-6.5 — Warm storage is a subscription, not a fixed-term deal — and its guarantee is weaker than cold storage
**When:** 2026-05-06
**Facts established, relevant to the protocol's "minimum guarantee":**
- Model is **rolling / pay-as-you-go**, min duration 1 month, **30-day prepayment buffer**;
  if balance drops below 30 days the provider may remove data. Risk is "your wallet running
  dry," not a contract expiring.
- **Enforcement is weaker than the old PoRep cold-storage layer.** PDP warm storage: payment
  rails halt when proofs stop, provider loses future income + reputation — **but no explicit
  slashing of collateral for your specific deal.** Cold storage (PoRep) has real slashing.
- Guarantee hierarchy (weak→strong): (1) Filecoin Pin/warm storage → (2) cold storage
  (PoRep, slashing, but sealed/slow) → (3) both layers together.
- Per-deal enforceable-collateral SLA market was "on the roadmap for 2026," not yet live.
**Implication for S2S `[unresolved]`:** whether author/publication content needs the
cold-storage backstop, or whether warm-storage + reputation is an acceptable guarantee for
the protocol's purposes. Not decided in the record reviewed.

### DR-6.6 — Implementation: replacing Pinata with Filecoin across the monorepo
**When:** 2026-07-11
**Status:** in-progress implementation work (Storage tab / Synapse SDK).
**Concrete findings from the code work:**
- Using **`@filoz/synapse-sdk`**. Uploads go into **Data Sets**; each upload yields a
  Root CID, a Piece CID, a tx hash, a download URL; multiple uploads to the same payment
  config group into one Data Set with unique Piece IDs.
- **`deletePiece` is not instantaneous** — it "initiates the deletion process," which is
  **scheduled, not immediate**, and **irreversible once initiated**. Pieces go into a
  scheduled-removals queue (`getScheduledRemovals()` on the context). UI must cross-reference
  that queue to show a "pending deletion" state rather than expecting the row to vanish.
- **`pdpEndEpoch: 0n`** observed persisting for days on healthy uploads. Working hypothesis
  (from the record): `pdpEndEpoch` is the *end* epoch (deal termination), so `0n` = "no end
  scheduled" = correct and permanent for a live, non-terminated dataset — i.e. the wrong
  field to render as a date, rather than a fault. `[verify: not fully confirmed in record]`
- `createContext({ dataSetId })` — `dataSetId` must come from `ds.pdpVerifierDataSetId`
  and be a `bigint`.
- Related MEMORY.md note (from the s2s profile): *"Filecoin deletePiece fix: session key
  needs `schedulePieceRemovals` permission."*

### DR-6.7 — Running our own storage provider (considered)
**When:** 2025-12-25
**Status:** explored, not adopted `[GAP: no decision recorded]`
**Context:** Looked at running a PDP provider on the Amsterdam home server (Piri codebase,
Storacha node-provider waitlist). Conclusion at the time: far more accessible than a full
Filecoin SP, but PDP provider onboarding was still permissioned/alpha; advice was to join
the waitlist and not invest heavily yet. No decision to run one was recorded.

---

## Open questions / unresolved

- **[unresolved]** Does S2S require the cold-storage (PoRep) backstop for published content,
  or is warm-storage + reputation sufficient for the protocol's guarantee? (from DR-6.5)
- **[verify]** Confirm the `pdpEndEpoch: 0n` interpretation against the Synapse SDK source.
- **[GAP]** No recorded decision on self-hosting a provider (DR-6.7).

## Cross-references
- **Component 2 (content storage)** — raw authored items vs. this component's rendered output.
- **Component 5 (site generation)** — produces the HTML tree this component hosts; writes the
  new content-tree root.
- **Component 7 (domain resolution)** — resolves a human-readable name to the content-tree
  root hosted here.
