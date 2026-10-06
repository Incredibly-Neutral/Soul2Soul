# Second opinion — additional sections for the Soul2Soul whitepaper (v1)

**Scope.** Candidates: 02 content-item schema, 03 encryption & access control ("the gate"), 06 website hosting, 07 domain resolution, 08 authenticity & provenance ("authentication in HTML"). Current v1 body: §2 Authoring, §3 Publication, §4 Agreements, §5 Protocol (Abstract/Introduction deferred). Filter: a protocol-level guarantee earns a section only if a reader — author or publication — must understand it to trust or use the system; implementation detail belongs in component specs. Written from the provided context only; where the answer depends on how §5 currently words something, I say so and give the check to run.

## Verdict

Exactly two candidates earn a section: the gate (03) and authentication-in-HTML (08). The schema (02), hosting (06), and resolution (07) stay in the specs. The orchestrator lean ("only the gate is a real gap") and the human hypothesis ("08 is the strongest candidate") are each right about their own candidate and wrong about the other's. They are the same category of thing — the system's two load-bearing trust guarantees, confidentiality and authenticity, neither of which currently has a home in §§2–5 — and the two positions are not independent: untrusted infrastructure is only acceptable in a system whose content carries its own proof (see (2)).

## The filter, operationalized

Three tests, applied in order; the first governs:

1. **Audience test.** Would an author or publication evaluating Soul2Soul against the obvious incumbent — "put it behind a paywall on our CMS" — need to understand this to trust or adopt the system? If not, it is not paper material, however essential to the build.
2. **Mechanism-independence.** Can the claim be stated without committing to an implementation? If a different implementation could realize the same claim without changing what users trust, the claim is protocol and the realization is spec. This is the cleanest protocol/spec boundary available.
3. **Interoperability.** Must two independent implementations agree on it for their artifacts and services to interoperate? If yes, it is normative — but normative wire formats still belong in specs. The paper states the promise; the spec states the bytes.

The recurring shape of every judgment below: the promise and the trust assumption go in the paper; the machinery goes in the spec.

## (1) Candidate-by-candidate

**03 — the gate: IN, as its own section.** This is the system's answer to the first question a skeptical publication asks: who can read our content? Ciphertext everywhere except inside a renderer acting on an on-chain permission; no single operator can read. It passes all three tests and is the adoption differentiator versus the incumbent (there, the operator reads everything; here, no one without a grant can). It is currently absent from §§2–5, which describe who does what, but not the property that makes participation safe.

**08 — authentication-in-HTML: IN, as its own section.** The system's answer to the reader's question: why should anyone believe this page is what it claims to be? Currently homeless in §§2–5, and the guarantee that makes untrusted distribution acceptable (see (2)).

**02 — content-item schema: OUT, as previously agreed — with one migrating clause.** Fields, signature formats, and the ciphertext/plaintext encoding are wire-format details: normative, but spec material. One semantic clause is protocol-relevant and should migrate into the gate section as its invariant phrasing: access is the capability to decrypt; the on-chain permission, not possession of any file, is the ownership boundary; ciphertext is public by design. The schema stays in the spec.

**06 — website hosting: OUT.** Pinning, deal-making, gateway behavior — plumbing, at parity with every web host; fails the audience test. Residue if §3 does not already say it, one sentence: publication artifacts are content-addressed and retrievable through untrusted storage; the protocol guarantees integrity, not availability. Integrity is delivered by verification (08) — which is precisely why hosting can be demoted.

**07 — domain resolution: OUT.** ENS/CCIP-Read and name→contenthash are a convenience layer, not a trust layer. Residue, one sentence: names are pointers, not guarantees; whatever a resolver returns is checked by verification. If §§3–5 already say where the pointer lives, nothing more is needed.

## (2) Is authentication-in-HTML protocol-level, or implementation / already covered?

Protocol-level, and not covered unless §5 already states it as a normative guarantee. If §§3–5 merely mention that proofs exist, that is coverage of the mechanism, not of the promise. Four arguments:

1. **The distribution layer is deliberately untrusted.** The paper (correctly) demotes hosting to dumb storage and naming to a pointer. Once no trust rests on infrastructure, trust must ride in the content itself — and authentication-in-HTML is the name of that property. This is the dependency that resolves the orchestrator/human split: accept "06 and 07 are implementation" and you have already accepted "08 is protocol," because otherwise the reader's trust rests on infrastructure the paper itself calls untrusted.
2. **The interop test is unambiguous.** Two compliant implementations must produce mutually verifiable artifacts, or the system fragments into walled gardens of verifiability. Mutual verifiability across independent implementations is the definition of a protocol property.
3. **It is mechanism-independent.** The proof's encoding, placement, and ciphers can change without changing what a reader trusts. A guarantee that survives implementation substitution is protocol; the substitutions are spec.
4. **It closes the loop the existing sections open.** §2: authors sign. §3: publications publish. §4: agreements govern. The missing act is the reader's: verify. Without it, the whitepaper tells the supply-side story and stops one act short of the trust story — and the reader, not the author, is who a publication's customers ultimately are.

One precision requirement, since this claim will be quoted back: scope the word "offline." The strong, honest version: the proof is self-contained and verifies with no live service and no trusted third party; integrity and attribution hold against the keys as they were at publication time. What offline verification does not buy — revocation freshness, post-publication key compromise, current agreement state — deserves one plain sentence rather than leaving it for a critic to discover. (Exact scoping depends on how author/publisher identity is anchored; if the anchor requires chain access, say so — the guarantee remains strong, but only if precisely stated.)

## (3) The gate: standalone section, or folded into §5?

Standalone. Four reasons:

1. §5 already has a job (the protocol's rules and flow); the gate is a property spanning authoring, publication, agreements, and rendering. Burying it inside one section's machinery mixes invariant with mechanism.
2. The audience needs the one-line guarantee at headline level — no single operator can read your content without an on-chain grant — because it is the differentiator against every incumbent. It should not share a heading with message formats.
3. The gate carries the paper's one genuine trust assumption (the renderer's TEE), which deserves explicit statement and would bloat §5.
4. Citability: outsiders will link to "the section that explains why operators can't read your content."

Must state: the invariant — content exists as ciphertext at rest, in transit, and in caches; plaintext only inside a renderer, only after the on-chain permission check for that reader. The corollary — no host, gateway, or operator reads content absent an on-chain grant. The trust assumption, one plain sentence — the confidentiality guarantee reduces to the soundness of the renderer's trusted execution environment and the correctness of on-chain permission state. The boundary — what it does not cover (reader-device compromise after decryption, key custody, TEE compromise beyond attestation), one sentence pointing at the spec's threat model.

Must not state: key formats, attestation flows, key rotation, cipher choices, renderer architecture. All spec 03.

Decision rule, if the editors want to fold anyway: if §5 is currently a short list of normative invariants (call it under a page) with room for the gate as its dominant subsection without burying the guarantee, folding is defensible. Placement is editorial; presence is not.

**Placement:** minimal churn — append as §6 Confidentiality (the gate) and §7 Verification after §5. Better arc, more churn — the gate between §4 Agreements and the protocol section (agreements say who may read; the gate is how reading is enforced), verification last as the reader-facing close. Either way, prefer two short sections over one combined "trust model" section: each guarantee is strongest stated on its own.
