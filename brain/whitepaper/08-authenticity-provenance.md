---
component: authenticity-provenance
protocol: soul2soul
number: 8
status: active-with-open-gaps
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude history; the self-verifying-HTML / JSON-LD Data Integrity Proof line, and the DID tie-in
---

# Component 8 — Content authenticity & provenance (the proof)

> Reconstructed for machine memory. This component is the **metadata + proof** story: what
> gets signed into a rendered page, in what format, and how a reader verifies it — including
> the recent **DID** tie-in. Distinct from Component 2 (the *item* schema/`objectId` proof at
> author time); this is the *page-level* proof the neutral renderer embeds at publish time.
> Decision entries preserved as discussed. Lens-era identifiers marked superseded. Gaps `[GAP]`.

## Functional description

Every published page carries **embedded, self-contained proof** of (a) who authored it, (b) who
published it, (c) that it hasn't been tampered with, and (d) that the neutral Lit Action produced
it under the rules. The proof travels *inside the HTML* so verification needs no external file —
"what you see is what was verified."

## Minimum guarantee (protocol-level)

- Pages are **cryptographically signed**; the signature proves **authorship and the terms of
  publication**.
- Verification is **client-side** and **self-contained** (the document proves itself; works offline).
- Tampering is **evident** — changing one character breaks the signature.

## The three aims (the spec's own framing)

1. **Self-authentication** — the document proves it wasn't tampered with (a SHA-256 of the
   `<html>…</html>` content is covered by the PKP signature).
2. **Proof of provenance** — proves *who* authored/published it.
3. **Proof of license on domain** — proves the content is authorized to appear on a given URL
   (license checked via the publication contract, Component 4).

## Reference implementation

At the **RENDER** stage (Component 5), the Lit Action builds a **schema.org `Article` as JSON-LD**
carrying a **W3C Data Integrity Proof**, signs it with the **PKP**, and injects it as a
`<script type="application/ld+json">` into the page (after `<!DOCTYPE html>`, before `<html>`).

Proof shape (from the record):
```jsonc
{
  "@context": ["https://schema.org", "https://w3id.org/security/data-integrity/v2"],
  "@type": "Article",
  "author":    { "@type": "Person",       "identifier": { "propertyID": "did", "value": "did:ethr:0x…" } },
  "publisher": { "@type": "Organization", "identifier": [ { "propertyID": "ens", "value": "pub.soul2soul.eth" },
                                                          { "propertyID": "safe", "value": "0x…" } ] },
  "encoding":  { "@type": "MediaObject", "contentUrl": "ipfs://<cid>", "sha256": "<hash of <html>…</html>>" },
  "sdPublisher": { "@type": "Organization", "name": "Soul2Soul Protocol",
                   "identifier": { "propertyID": "litAction", "value": "<lit_action CID>" } },
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "ecdsa-secp256k1-2019",
    "created": "<timestamp>",
    "verificationMethod": "did:pkh:eip155:<chain>:<pkpAddress>",
    "proofPurpose": "assertionMethod",
    "proofValue": "<signature>"
  }
}
```

**Verification (reader/plugin):** fetch **raw** HTML (not the DOM — the browser normalizes and
would break the hash), extract the JSON-LD, recompute SHA-256 over `<html>…</html>`, resolve the
`verificationMethod` DID → public key, verify `proofValue`. Show a badge if valid.

---

## Decision record

### DR-8.1 — Self-verifying HTML: sign the page, embed the proof in it *(foundational)*
**When:** 2026-01-15
**Decision:** Sign the canonical `<html>…</html>` and **embed** the signature + metadata in the
page itself, so the document is self-contained and self-verifying ("WYSIWYV — what you see is what
was verified"). Tamper-evident, offline-verifiable, human+machine readable.
**Status:** foundational.

### DR-8.2 — Format: schema.org JSON-LD + W3C Data Integrity Proof (moved from HTML comment)
**When:** 2026-01-27
**Decision:** Metadata moved **from a human-readable HTML comment → machine-readable JSON-LD** in
a `<script type="application/ld+json">`. Use **schema.org `Article`** for structure and **W3C Data
Integrity Proof** (`DataIntegrityProof`, `ecdsa-secp256k1-2019`) for the signature.
`encoding.sha256` (on `MediaObject`) carries the content hash; `proof` carries the signature.
**Note:** `proof`/`contentHash` are **not native schema.org fields** — they live via the JSON-LD
`@context` extension (`w3id.org/security/data-integrity/v2`), cleaner than abusing
`additionalProperty`.
**Why:** W3C-standard, browser/extension-verifiable, SEO-legible, interoperable with the VC
ecosystem.
**Status:** current.

### DR-8.3 — `proofPurpose: assertionMethod` (deliberate choice)
**When:** 2026-01-27
**Decision:** The PKP proof uses **`assertionMethod`** — the PKP is *asserting claims are true*
(author is X, licensed for URL Y, hash is Z), not authenticating an identity or invoking a
capability. `authentication` / `capabilityInvocation` were considered and rejected as not the point.
**Status:** settled.

### DR-8.4 — The signer identity is a DID (`did:pkh` for the PKP; author is `did:ethr`)
**When:** 2026-01 → 2026-06
**Decision:** The **verificationMethod** (who signed the page) is the **PKP as a DID**:
`did:pkh:eip155:<chain>:<pkpAddress>`. The **author** identifier in the provenance is the author's
**`did:ethr` over Safe** (Component 1) — this is the DID tie-in: the page's provenance resolves
authorship to the same did:ethr identity the content item was signed under (Component 2).
**Note:** early drafts used `did:pkh` for authors too; the author identity standardized on
`did:ethr`-over-Safe. The PKP signer remains `did:pkh`.
**Status:** current.

### DR-8.5 — What the provenance records (fields)
**When:** 2026-07-02
**Facts:** the embedded JSON-LD records: **author** (DID), **publisher** (ENS + Safe), a **SHA-256
of the HTML** (self-authentication), the **content CID**, the **license/publication** reference,
an **`isBasedOn`** field for derivative-work tracking, and **`sdPublisher`** pointing at the exact
Lit Action CID that produced it. So a reader can verify *who authored it* **and** *that the neutral
action produced it under the rules*, against an auditable key.
**Status:** current (design); see gaps.

### DR-8.6 — did:pub exploration (a DID *method* for documents) *(explored, not adopted)*
**When:** 2026-01-15
**Status:** explored, not the current design. For the record: considered defining a **`did:pub`**
DID method for *documents/publications* (not just identities) — hybrid resolution (on-chain
contract → IPFS content), relative paths (`did:pub:…/section/2`), Veramo resolver plugin, VCs for
publications (peer-review/citation/authorship credentials). Ambitious; parked. The *current* design
uses existing methods (`did:ethr` author, `did:pkh` PKP signer) rather than a new method.
**Status:** parked / aspirational.

### DR-8.7 — License-as-encryption is part of the authenticity story
**When:** 2026-01-15
**Observation:** "proof of license on domain" (aim 3) is enforced not only by a metadata claim but
by the **encryption model** (Component 3): raw content is encrypted to a publication/protocol key,
so appearing on a domain at all *requires* the licensed decryption path. The provenance proof
*records* the license; the encryption *enforces* it. The two together are the license guarantee.
**Status:** current; cross-binds Components 3, 4, 8.

---

## Open questions / unresolved (these gate the security claims)
- **⚠ [GAP-1] Provenance metadata is currently HARDCODED.** In the RENDER action the
  `S2SContentInfo` was literal placeholders (`"joera.lens"`, `"mypub.eth"`, `0xAuthor…`); the type
  is defined in `shared` but **not yet wired from real body/author/config data.** *This is the
  single biggest gap between design and running code* — until fixed, the provenance is not real.
- **⚠ [GAP-2] Signing primitive is ambiguous.** `metadata.ts` uses `Lit.Actions.getPrivateKey` +
  a raw `SigningKey`, with `signAndCombineEcdsa` **commented out**. These are **different Lit
  mechanisms** (wrapped-key vs. true PKP threshold signing) with **different neutrality /
  key-extractability guarantees.** Which is canonical is undecided — and it directly affects the
  Component 5 neutrality claim (can the key be extracted?).
- **[superseded]** Provenance `author` used a **Lens** identifier in Lens-era code; now `did:ethr`.
  Confirm the running action emits the did:ethr author, not a stale `lens` propertyID.
- **[GAP]** Canonicalization method for the signed `<html>` must be pinned exactly (raw-source vs
  normalized) or verification breaks; recommendation on record is **raw fetch**, not DOM.

## Cross-references
- **Component 2 (schema)** — author-time `objectId`/`proof` over the item; this component is the
  *page-time* proof; both resolve authorship to the same `did:ethr`-over-Safe identity.
- **Component 3 (encryption)** — enforces aim 3 (license) via encryption; provenance records it.
- **Component 4 (governance)** — publisher identity (ENS + Safe) and the license/`isLicensed`
  reference embedded in the proof.
- **Component 5 (renderer)** — the RENDER stage builds + signs + embeds this metadata (its
  `metadata.ts`); the PKP is the signer.
- **Component 7 (domain resolution)** — aim 3 ("license on domain") ties the proof to the URL the
  page resolves at.
