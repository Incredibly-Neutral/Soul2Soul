# Second Opinion — Whitepaper (v1) Section Plan

**Filter applied:** A protocol-level guarantee earns a section only if a reader (author or
publication) must understand it to trust or use the system. Everything else is implementation and
belongs in the component specs, not the paper.

**Date:** 2026-09-09
**Status:** Working draft (starting artifact)

---

## Verdict (one line)

Add exactly **two** sections — *The Gate* (privacy & access control) and *Authenticity & Provenance*
(the guarantee, not the HTML mechanism); drop hosting, domain resolution, and content-item schema as
sections; all three survive only as one-paragraph assertions inside §5.

---

## 1. Which candidates deserve their own section (protocol vs implementation)

| Candidate | Verdict | Reasoning |
|---|---|---|
| 02 Content-item schema | **Out** (implementation) | Already agreed. The schema is wire format, not a trust property. Reference the signed-content-item concept where needed; the schema itself lives in the spec. |
| 03 Encryption & access control ("the gate") | **In — own section** | The system's entire privacy claim ("no single operator can read") rests on it. That is a guarantee a reader must understand to trust the paper. *Standalone, guarantee-first* (see §3). |
| 06 Website hosting | **Out** (implementation) | IPFS/Filecoin retrievability is a deployment property. The paper asserts "sites are content-addressed and retrievable via IPFS/Filecoin" in one sentence inside §5; retrieval parameters go to the spec. |
| 07 Domain resolution | **Out** (implementation) | ENS/CCIP-Read name → contenthash is plumbing for the publication claim. One paragraph in §5: "a site is addressable as name → contenthash via ENS/CCIP-Read." No section. |
| 08 Authenticity & provenance ("auth in HTML") | **In — own section** (reframed) | The *guarantee* (self-contained, offline-verifiable, tamper-evident provenance) is protocol-level and not covered by §3–5. The *mechanism* (HTML embedding) is implementation. Section named after the guarantee; mechanism described inside. See §2. |

---

## 2. Is authentication-in-HTML a protocol-level guarantee worth its own section?

**Yes — but only when restructured guarantee-first.** The human hypothesis is right, with one
correction: the section's title and thesis must be the guarantee, not the mechanism.

- **What earns the section:** the property that a page's authorship/publishing claims are
  cryptographically verifiable *offline*, *self-contained*, and *tamper-evident*, with no trusted
  third party (no operator, no host, no live oracle). This is a distinct trust property from
  §3–5: §5 executes agreements and anchors state on-chain, but the *verifiability of who said what,
  without a network round-trip or a trusted server*, is a separate promise a reader must absorb to
  trust the publication model.
- **What does not earn the section:** the embedding mechanism (data-URL, embedded signature block,
  <meta>/<script> proof payloads, exact serialization). That is implementation and belongs in the
  spec ("authentication in HTML" as written is a spec spec).
- **Is it covered already?** No. §3–5 never establish offline verifiability of provenance claims;
  they establish authorization and execution. So it is a genuine gap, and it is protocol-level.
- **Guarded verdict:** if the team chooses to *not* commit to offline verifiability in v1 (i.e.,
  provenance is only checkable against the live site), then this collapses to implementation and
  should be dropped. The section earns its slot only because v1's publication model actually makes
  the offline, self-contained claim.

**Recommended section title:** *§7 Authenticity & Provenance* (guarantee-first; the HTML embedding
is one subsection of it, labeled as mechanism; numbered §7 because §6 is reserved for The Gate).

---

## 3. Is "the gate" a standalone section, or material to fold into §5 Protocol?

**Standalone — and it is the most important addition.** But with a strict scope discipline.

- **Why standalone:** The gate is the load-bearing promise of the whole paper — "content is
  encrypted to protocol keys, decryption happens only inside the renderer (TEE), only when on-chain
  permission passes, and no single operator can read." This is a *threat-model commitment*, the
  thing a reader must understand to trust the privacy claim. §5 (agreements/execution) describes
  *what the protocol does*; the gate describes *why the content is unreadable*. Those are different
  questions and both are protocol-level. Folding the gate into §5 buries the paper's most important
  trust property.
- **Scope discipline:** the section states the guarantee and the trust model (adversaries: operators,
  hosts, storage providers; what they cannot do). TEE specifics — attestation scheme, SGX vs SEV,
  key management, rotation, renderer internals — stay in the component spec. If the section reads
  like an architecture diagram, it has slipped back into implementation.
- **Fallback if the paper must stay lean:** at minimum, a first-class subsection at the top of §5
  titled *Privacy & Access Control (The Gate)*. But my recommendation is a standalone §6 slot, ahead
  of Authenticity & Provenance, because it is the privacy claim that distinguishes Soul2Soul.

---

## 4. What belongs out of the whitepaper entirely

- **Content-item schema (02)** — wire format. Referenced, never specified.
- **Website hosting (06)** — one-sentence assertion in §5 ("content-addressed, retrievable via
  IPFS/Filecoin"); no section, no parameters.
- **Domain resolution (07)** — one-paragraph assertion in §5 (name → contenthash via ENS/CCIP-Read);
  no section.
- **TEE internals** — attestation details, hardware choice, enclave lifecycle, key rotation, renderer
  architecture → component spec.
- **Storage economics** — replication factors, pricing, provider selection → spec.
- **Performance/benchmarks** — not a trust property for v1.
- **Roadmap / "we will" normative content** — the paper states guarantees; the spec carries the plan.

---

## Recommended v1 table of contents (delta view)

1. §2 Authoring *(unchanged)*
2. §3 Publication *(unchanged)*
3. §4 Agreements *(unchanged)*
4. §5 Protocol *(unchanged, plus the one-sentence hosting + one-paragraph resolution assertions)*
5. **§6 Privacy & Access Control (The Gate)** — *new, standalone, guarantee-first*
6. **§7 Authenticity & Provenance** — *new, standalone, guarantee-first (HTML embedding as a
   mechanism subsection)*

Nothing else from the candidate list earns a section under the strict filter.
