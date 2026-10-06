# Second Opinion — Additional Sections for Soul2Soul Whitepaper v1

**Scope:** strict protocol-vs-implementation filter on the candidate sections.
**Filter (restated):** a protocol-level *guarantee* earns a section only if a reader (author or publication) must understand it to trust or use the system; implementation detail belongs in component specs, not the paper.

**Key move applied throughout:** the filter is applied to *guarantees*, not *mechanisms*. Every candidate is split into "the property" (candidate for a section) vs "the mechanism" (specs). The paper states properties; the specs state mechanisms. Under this split, most candidates dissolve into mechanism and are out — the two that survive do so only in their guarantee form.

**Bottom line:** add exactly one certain new section — **the gate (Confidentiality & Access Control)** — and one conditional new section — **Read-Path Authenticity** (authentication-in-HTML, reframed as a guarantee and subject to a cut-test). Hosting (06) and resolution (07) stay out of the paper entirely; the schema (02) stays out; only the guarantee halves of 03 and 08 belong in the whitepaper, and every mechanism goes to its spec.

---

## Verdict table

| Candidate | Guarantee (the property) | Verdict | Where |
|---|---|---|---|
| 02 Content-item schema | Ownership boundary concept: encrypted = private, plaintext = public | Out as a section (schema is mechanism); ownership semantics worth one or two sentences max | spec 02 |
| 03 The gate | Confidentiality: only permission-holders can read; no single operator can read; revocation actually revokes | **STANDALONE SECTION** (guarantee + threat model only) | new §5 |
| 06 Website hosting | Content remains retrievable | Out (deployment/infra); one sentence in §3 | spec 06 |
| 07 Domain resolution | A name resolves to content | Out (addressability detail); one sentence in §3 | spec 07 |
| 08 Authentication-in-HTML | Read-path authenticity: what you see is verifiably the author's/publisher's content, tamper-evident, offline-verifiable | **Conditional yes — reframe as a guarantee** (see Q2) | new §6 (if it passes) |

---

## Q1 — Which of these deserve their own section?

One unambiguous yes and one conditional yes; two definite no's.

- **The gate (03) — YES, standalone.** It is the system's central trust-bearing claim (see Q3).
- **Authentication-in-HTML (08) — CONDITIONAL YES, reframed.** Deserves a section *only* as a guarantee ("read-path authenticity"), never as the mechanism ("embed a proof in HTML"). Subject to the cut-test in Q2.
- **Hosting (06) — NO.** Retrievability is an operational/deployment property, not a trust-bearing guarantee a reader must understand. Covered by §3's statement that content lives at a content-addressed reference.
- **Resolution (07) — NO.** Naming is a UX/addressability convenience; the protocol stands on content hashes alone.

On the orchestrator-vs-human tension: the orchestrator is right that 03 is the one unambiguously genuine gap. The human is right that 08 is the strongest *second* candidate — but 08 survives the strict filter only when reframed from mechanism to guarantee, and only if the existing §§2–3 (signing) don't already assert it. Net: the orchestrator's "only the gate" is the safe floor; 08 is the one justified add-on above that floor.

---

## Q2 — Is authentication-in-HTML protocol-level or implementation?

It is a protocol-level **guarantee** currently dressed as an implementation. Split it:

- **Guarantee (section-worthy):** end-to-end read-path authenticity — the rendered artifact verifiably corresponds to the canonical on-chain content, carries author *and* publisher attestation, is tamper-evident, and is verifiable without trusting the renderer or the network (offline). This is distinct from §2 (content-item signing at rest) and §3 (publication mechanics): it is the claim that a *reader's* trust is end-to-end rather than assumed from the serving path. A reader must understand this to trust the system → it passes the filter.
- **Mechanism (specs):** where the proof lives in the HTML, proof encoding/format, offline-verification bootstrap, hash-chaining details → all to spec 08.

**Cut-test (how to decide the conditional at the last minute):** after drafting, if the section reads as a restatement of §2's signing guarantees, cut it — the guarantee is already covered and what remains is mechanism. State the guarantee, then point at spec 08 for the delivery.

---

## Q3 — Is "the gate" standalone or folded into §5 Protocol?

**Standalone.** Three reasons:

1. **It is the headline claim.** It is the confidentiality promise that justifies the whole encryption architecture. Folded into §5 Protocol it becomes an appendix footnote instead of the paper's centerpiece.
2. **It is cross-cutting.** The gate spans §3 (publication encrypts to the protocol key), §4 (permission is defined in agreements; the gate consumes it), and the renderer (client-side enforcement). No existing section owns it; it does not live inside any single current section.
3. **Register mismatch.** §5 Protocol should be message-level/formalism; the gate is a security/trust model. Different register, different section.

**Scope discipline:** the section states the **threat model + guarantee statements** — who can read, who cannot, what no single operator can do (even with full backend access), and what revocation does. All TEE, key-management, cipher-suite, and renderer-enforcement detail → spec 03.

**Counter-argument acknowledged:** a strict minimizer could say the gate's guarantee fits as a sub-part of §5 with all mechanisms pushed to spec 03. That is defensible *if* §5 already carries a threat model. But the cross-cutting nature and the fact that this is the system's headline privacy claim argue decisively for its own visible section. If folded, the paper would state no confidentiality guarantee anywhere — the strongest argument for standalone status.

---

## Q4 — What belongs out of the whitepaper entirely?

- **02 schema** — out; mechanism. (The ownership-boundary *semantics* — encrypted vs plaintext as a property distinction — can surface as a sentence or two in §3 or in the gate section; the field-level schema does not.)
- **06 hosting (IPFS/Filecoin retrievability)** — out of the paper entirely; deployment/infra. One sentence in §3: content is content-addressed; retrievability is a network-layer concern. Filecoin deals/parameters → spec 06.
- **07 resolution (ENS/CCIP-Read)** — out of the paper (or one sentence in §3 on addressability). Protocol stands on content hashes; names are convenience. ENS specifics → spec 07.
- **03 mechanism and 08 mechanism halves** — out; specs only.
- **General rule:** the whitepaper names no infrastructure (no Filecoin, no ENS, no TEE vendors). Guarantees and invariants stay in the paper; components go to specs.

---

## Recommended v1 section order

1. §2 Authoring
2. §3 Publication (gains one sentence on ownership boundary + one on content-addressed storage + one on addressability)
3. §4 Agreements
4. **§5 Confidentiality & Access Control (the gate)** — standalone
5. **§6 Read-Path Authenticity** (authentication-in-HTML, reframed as a guarantee) — only if it passes the Q2 cut-test
6. §7 Protocol (renumbered)
7. Abstract + Introduction deferred, as already planned.

If 08 is cut by the cut-test: §5 gate, then §6 Protocol. Net result of this opinion: **one certain new section (the gate), one conditional new section (read-path authenticity), and two candidates removed outright (hosting, resolution).**
