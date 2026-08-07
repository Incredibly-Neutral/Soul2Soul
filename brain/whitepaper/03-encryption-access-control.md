---
component: encryption-access-control
protocol: soul2soul
number: 3
status: active-with-major-model-change
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude history; captures the Lit Naga→Chipotle model change
---

# Component 3 — Encryption & access control (the gate)

> Reconstructed for machine memory. **A major cryptographic-model change happened here**
> (Lit "Naga" → "Chipotle"); both are recorded, current one first. This component is the
> **gate**: it decides *whether an encrypted item's content is revealed*, and it ties
> directly into the **publication contract** (Component 4) and the **renderer** (Component 5).
> Decision entries preserved as discussed. Gaps marked `[GAP]`.

## Functional description

The ability to **encrypt content items to a protocol key** so content stays private until
agreed conditions are met, and to **decrypt them inside the neutral renderer** only when the
on-chain permission state allows. The "which content is encrypted vs plaintext" choice is
Component 2 (the ownership boundary); **this component is the mechanism of the gate itself.**

Concretely in S2S: encrypted content is decrypted **inside the Lit Action that renders the
HTML**, on the condition that the publication contract's gates pass (`hasDeal` / `canPublish`
/ license checks). Nobody can read gated content by copying the ciphertext; it is only ever
revealed transiently inside the trusted render, and only when permission holds.

## Minimum guarantee (protocol-level)

- **Decryption capability is not held by any single custodial party** — it is enforced by a
  distributed / TEE mechanism, conditioned on verifiable (on-chain) state.
- **No individual operator can unilaterally read** content they weren't granted.
- The gate is **conditioned on the publication's permission state**, not on possession of a
  key alone.

## Reference implementation (current: Lit "Chipotle")

- Encrypt content to a **PKP** (programmable key pair). Binding is **ciphertext ↔ pkpId**
  (the symmetric key is derived from that PKP's secret inside a **TEE**).
- Access control is **imperative JS inside a Lit Action**, not declarative conditions:
  the action runs gating logic, then calls `Lit.Actions.Decrypt({ pkpId, ciphertext })`.
- In S2S the gating logic reads the publication module: recover the caller's signer from a
  signature over `"lit actions auth"`, check `canRead`/`canPublish` (author Safe whitelisted
  or licensed **AND** signer is an owner of the author's Safe), then decrypt gated
  collections and render.
- Encryption produces **ciphertext only** — under Chipotle there is **no
  `dataToEncryptHash`** (that was a Naga artifact). Integrity of the plaintext is carried
  separately by the schema's `plaintextHash` (Component 2, DR-2.4), computed over the same
  canonical bytes before encryption.

---

## Decision record

### DR-3.1 — Encrypt to a Lit PKP rather than a plain keypair *(foundational)*
**When:** 2025-10
**Decision:** Use Lit PKPs, not a static keypair, for content encryption.
**Rationale (as discussed):** PKPs are **programmable keys that execute logic, not just
decrypt** — decentralized custody (no single point of key loss), conditional/programmable
decryption, no backend key management, auditable, upgradeable gating without re-encrypting.
Fits the no-backend philosophy. Trade-offs acknowledged: complexity, network fees, latency.
**Status:** foundational.

### DR-3.2 — The gate is on-chain permission, checked inside the render action *(load-bearing)*
**When:** 2025-10-20, reaffirmed 2026-07-02
**Decision:** Two distinct gates, both enforced inside the Lit Action at render time:
- **`hasDeal`** (or license) → **content may be decrypted** for rendering.
- **`canPublish`** → the caller may **trigger a re-render and update the rootCid** of the
  HTML on the smart contract / ENS record.
**So:** decryption and publish-authority are *separate* on-chain checks. Reading gated
content ≠ authority to publish the site.
**Detail (2026-07-02 pipeline):** the `single` Lit Action recovers the caller's signer from
a sig over `"lit actions auth"`, runs the on-chain gates (author Safe whitelisted/licensed on
the publication module **AND** signer is an owner of the author's Safe), PKP-decrypts, renders
Handlebars HTML, signs+embeds provenance, uploads to IPFS.
**Status:** load-bearing; this is the heart of how encryption ties to governance.

### DR-3.3 — MAJOR MODEL CHANGE: Lit Naga → Chipotle *(cryptographic model changed under us)*
**When:** 2026-04-12
**What changed:** The entire Lit cryptographic model shifted:
- **Old (Naga):** threshold decryption; **ACCs (Access Control Conditions)** as a first-class
  primitive, **hashed into the ciphertext** (binding = ciphertext ↔ conditions, immutable);
  BLS network key shares (k-of-n); SDK required (`@lit-protocol/access-control-conditions`).
- **New (Chipotle):** **single TEE** derives the key; **no ACCs** — you write **JS gating
  logic** instead; symmetric key from the PKP; binding = **ciphertext ↔ pkpId**; encryption
  returns **ciphertext only (no `dataToEncryptHash`)**; **no SDK required** (plain HTTP).
**Where access control now lives (three places, all separate from ciphertext):** (1) on-chain
**Groups** — which Action CIDs may use which PKPs; (2) API keys — which keys run which groups;
(3) **in-action JS logic** decides whether to call `Decrypt()`.
**Trust implication (recorded explicitly):**
- Naga: "only wallets meeting these conditions can decrypt, and nobody can change that without
  re-encrypting" — **immutable, cryptographically enforced**.
- Chipotle: "whoever controls which Actions can access this PKP controls who can decrypt" —
  **governable** (update the Group, no re-encryption needed). Trust anchor moved from **k-of-n
  threshold** to **TEE + Safe multisig**.
**Net for S2S:** access became **mutable/governable without re-encrypting** — practical for a
living publication (change who can decrypt without re-encrypting everything), at the cost of
losing cryptographic immutability of the condition. `prod` Lit env is referred to as **Chipotle**.
**Status:** current. This supersedes any ACC-based reasoning in older notes.

### DR-3.4 — Encryption as the anti-theft protection (security model)
**When:** 2026-01-27 (Lens-era framing; mechanism still holds post-Lens)
**Model:** gated content is protected **because it's encrypted**, not because storage is
private. Attack analysis recorded:
- Attacker grant/license of a victim's item → **can't decrypt** (doesn't control the gate).
- Attacker copies the ciphertext/CID → **useless, can't read it**.
- The **author signature + on-chain record** prove the real author; front-running registration
  doesn't help.
So the chain is: **authored + signed → encrypted (decryptable only via the approved action) →
permission in contract → Lit Action checks permission → decrypts → renders.**
*(Lens-era wording called the Lens post "the nullifier"; post-Lens, the signed content item +
publication-contract record plays that anchoring role — see Components 2 & 4.)*
**Status:** mechanism current; Lens specifics superseded.

### DR-3.5 — plaintextHash as post-decryption integrity check (+ possible cross-publication nullifier) `[unresolved]`
**When:** 2026-01-27
**Idea discussed:** hash the original *unencrypted* content (→ `plaintextHash`, now in the
schema) so the renderer can **verify integrity after decryption**. Raised as *possibly also* a
**nullifier** to stop the same content being re-published elsewhere in S2S under a different
name (the "someone copies decrypted text and re-publishes" attack).
**Tension left open:** a single content item is **intended** to be publishable to **multiple
publications** — so a naive global nullifier would break that. Not resolved.
**Status:** `plaintextHash` exists and serves integrity (Component 2, DR-2.4); its use as an
anti-replay nullifier is **unresolved** because of the multi-publication requirement.

---

## Open questions / unresolved
- **[unresolved]** Whether/how `plaintextHash` doubles as a cross-publication anti-replay
  nullifier without breaking intentional multi-publication (DR-3.5).
- **[GAP]** Exact current Group configuration (which Action CIDs ↔ which PKP) for S2S in
  Chipotle, and how it's administered (Safe?).
- **[GAP]** Whether the "encrypt to publication key vs author key vs protocol key" multiplicity
  from the early whitepaper is still modelled, or collapsed to a single protocol PKP.

## Cross-references
- **Component 2 (schema)** — the `encryption` flag and `plaintextHash`. `plaintextHash` is
  computed over the canonical plaintext **before** encryption and is what carries integrity;
  under Chipotle there is no `dataToEncryptHash` to reconcile against.
- **Component 4 (permissions/governance)** — provides the gates the action reads: `canPublish`,
  `hasDeal`/license, whitelists; and the Group/PKP admin (Safe).
- **Component 5 (site generation / neutral renderer)** — decryption happens **inside** the render
  Lit Action; this is where the gate is actually executed.
- **Component 8 (authenticity/provenance)** — after decrypt+render, the action signs and embeds
  provenance; integrity ties back to `plaintextHash`.
