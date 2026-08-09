---
component: content-item-schema
protocol: soul2soul
number: 2
status: active
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude history + direct correction (2026-07-15); Lens-era material superseded
---

# Component 2 — The content-item schema (+ content-addressed storage)

> Reconstructed for machine memory. **This component is primarily about the SCHEMA** —
> the shape of a signed content item — and secondarily about the storage that the schema
> requires (content-addressing). An earlier reference implementation (Lens) is superseded;
> see the marked note. Decision entries preserved as discussed, not synthesised.
> Gaps marked `[GAP]`.

## Functional description

Defines the **content item**: the canonical object the whole protocol passes around. Every
authored piece becomes one of these. The schema is the load-bearing, interoperable part;
**content-addressed storage (IPFS/Filecoin) is the mechanism that makes it work**, because
the object must be addressable and verifiable by its hash. Framed plainly: *the protocol
only works when this object is content-addressed — but the **schema** is what makes it a
protocol.*

Two kinds of content item exist, and the choice is explicit per item:
- **Unencrypted** — `body` is plaintext. Cheaper. Used for **website copy written by or
  commissioned by the publication itself** — the publication's own material, where there is
  no author-vs-publication ownership tension to protect.
- **Encrypted** — `body` is ciphertext. Used when an **author contributes their own work to
  a publication but wishes to retain ownership vis-à-vis that publication.** Encryption is
  the mechanism that keeps the author in control of their contributed content rather than
  handing it over wholesale. The gating mechanism itself is Component 3; this component only
  records that the schema carries an `encryption` boolean and that `body`/`secret` is
  plaintext-or-ciphertext accordingly.

> **Not about monetization.** Encryption here is an **ownership boundary between author and
> publication**, not a paywall. Monetization is a **separate path**; if implemented it would
> live **inside the renderer (Component 5)**, not in this schema.

## Minimum guarantee (protocol-level)

- Every item is **content-addressed** (persistent, content-derived id) and retrievable
  **without any single host**.
- Every item is **author-signed** (EIP-712) and the binding is **verifiable by anyone**.
- Each item carries **public (unencrypted) metadata** usable to **filter before decryption**.
- The signed identity (`objectId`) is **stable and exists before the CID** (see DR-2.3).

## The schema (current)

Example item (unencrypted; real values from the record):

```jsonc
{
  "body": "{\"content\":\"<p>…public copy…</p>\",\"custom\":{},\"slug\":\"…\",\"title\":\"…\"}",
  "encryption": false,
  "objectId": "0xa200c2622d5e66ba9ee69e02b4f26b874ef54ea0439490c07d0cb4b07382c338",
  "proof": {
    "type": "eip712",
    "signer": "0x953393DBdB17Ec8f83fbF5BA41bc3a2B23A688C0",
    "signature": "0x739153be…"
  },
  "public": {
    "specVersion": "1",
    "author": "did:ethr:0x953393DBdB17Ec8f83fbF5BA41bc3a2B23A688C0",
    "postType": "home",
    "mediaType": "text/markdown",
    "parent": "0"
    // …more filterable fields…
  }
}
```

Fields:
- **`body`** — a JSON string: `content` (HTML/markdown), `custom` (arbitrary), `slug`, `title`.
  Plaintext when `encryption:false`; **ciphertext when `encryption:true`.** (In the signing
  code this value is `secret`.)
- **`encryption`** — boolean; explicit per item (public copy vs gated content).
- **`objectId`** — the item's **persistent id**: the **EIP-712 digest of `public`**. Hash-like
  (`0xa200…`) but it is *not* the CID and *not* a hash of `body`.
- **`proof`** — `{ type:"eip712", signer, signature }`. **What is signed:** the `public` part
  (see below), not the body.
- **`public`** — unencrypted metadata: `specVersion`, `author` (`did:ethr:…`), `postType`,
  `mediaType`, `parent`, … These are the **pre-decryption filter fields**.

### What is signed (the proof) — RESOLVED
Settled in code (2026-06-23, `shared/src/identity/sign-content.ts`):

- Compute `plaintextHash = keccak256(canonicalJSON(body))` **before** any encryption.
- Build `public = { …pub, author: toDidEthr(signer.address), plaintextHash }`.
- `objectId = eip712Digest(S2S_DOMAIN, S2S_TYPES, public)` — persistent version id, **pre-CID**.
- `signature = signer.signTypedData(S2S_DOMAIN, S2S_TYPES, public)` → `proof`.
- `secret = encryption ? lit.encrypt(body) : body` — same canonical bytes that were hashed;
  **`secret` is never part of the signed payload.**

So: **the signature covers `public` (which includes `author` + `plaintextHash`), not the
raw content.** Integrity of the content is bound in via `plaintextHash`; confidentiality is
separate. When encrypted, Lit's `dataToEncryptHash` and `plaintextHash` describe the *same*
plaintext (encrypt exactly the bytes you hashed).

## Content-addressed storage (the enabling mechanism)

**IPFS / Filecoin**, content-addressed. Shares the storage layer with **Component 6
(website hosting)** — Component 2 = raw authored items (input side); Component 6 = the
rendered site (output side). Filecoin PDP / retrievability decisions live in Component 6.

---

## Decision record

### DR-2.1 — Author identity = did:ethr over a Safe (binding; defined in Component 1)
Stored items are bound to the author via **`did:ethr` over a Safe**. Full rationale (4337
`msg.sender`, "dress up", rotate-signers-not-DID) is the **canonical property of Component 1**
and not duplicated here, to avoid drift. This component only *consumes* it as the binding
target. *(Note: the example's `public.author` is a `did:ethr:` of the signer address.)*

### DR-2.2 — Two content kinds: encrypted vs unencrypted, chosen per item
**Decision:** `encryption` is a per-item boolean, and the axis it encodes is **author
ownership vis-à-vis the publication**:
- **Unencrypted** = **website copy written by or commissioned by the publication** — the
  publication's own material; cheaper; no ownership tension to protect.
- **Encrypted** = an **author contributing their own work but retaining ownership relative
  to the publication** — encryption keeps the author in control rather than ceding content
  to the publication.
**Explicitly not monetization.** This is an ownership boundary, not a paywall. **Monetization
is a separate path**; if implemented it belongs **inside the renderer (Component 5)**, not in
this schema.
**Boundary:** the *gate/how* of decryption is Component 3; the schema merely flags
`encryption` and stores plaintext-or-ciphertext in `body`/`secret`.
**Status:** active.

### DR-2.3 — objectId is the EIP-712 digest of `public`, NOT the CID *(load-bearing)*
**When:** 2026-06-23
**Decision:** The persistent id is the EIP-712 digest of the signed `public` part.
**Rationale (verbatim intent):** "The objectId exists at sign time; the CID does not, which
is exactly why the CID can't be the id." A stable id must exist **before** upload; the CID
only comes into being after upload.
**Load-bearing order:** `hash → digest(=objectId) → sign → encrypt → upload(→CID) → contract append.`
**Status:** settled in code.

### DR-2.4 — Proof signs `public` + plaintextHash, not the body *(RESOLVED)*
**When:** discussed earlier; resolved 2026-06-23
**Decision:** EIP-712 signature is over `public` (incl. `author`, `plaintextHash`).
`plaintextHash = keccak256(canonicalJSON(body))` computed **before** encryption; `secret`
(the possibly-encrypted body) is **never signed**.
**Note (post-Chipotle):** under the current Lit model (Component 3, DR-3.3) encryption returns
**ciphertext only** — there is no `dataToEncryptHash`. Integrity of the plaintext rests
entirely on `plaintextHash`, verified after decryption inside the renderer.
**Why:** lets anyone verify authorship + integrity from the public part alone, without
needing to decrypt; keeps confidentiality orthogonal to authenticity.
**Status:** resolved. (Deeper provenance/verification detail → Component 8.)

### DR-2.5 — "Indexable by anyone" reframed → contract-scoped + pre-decryption filter
**When:** reframed 2026-07-15
**Correction:** The Feb "indexable by anyone" language is **no longer the right frame**.
Discovery is **not** a global index. Instead:
- **From the publication contract you obtain the items offered to that publication.** The
  contract is the discovery/scoping mechanism (see Component 4).
- The **`public` fields exist to filter *before* decryption**, which is expensive.
So the guarantee is "**contract-scoped retrieval + filterable public metadata + content-
addressed + author-signed**," not "queryable global index."
**Status:** supersedes the earlier `[GAP: metadata index]` — that gap was chasing the wrong
abstraction.

### DR-2.X (SUPERSEDED) — Lens Protocol as storage/identity venue
**Status:** ❌ **REMOVED.** Lens is no longer used. Kept only so history is legible.
- Publications were Lens Feeds; posts scoped to an `APP_ADDRESS`; tags/attributes on metadata.
- Author had a Lens account **owned by the Safe, managed by an EOA** — the *ancestor* of
  today's did:ethr-over-Safe model.
- **Hard blocker:** Lens Chain is ZKsync-based; Safe same-address CREATE2 cloning fails on
  ZKsync, breaking `msg.sender == owner` — significant pressure toward the Lens-free model.
- Deal lifecycle → **Component 4**; publish-vs-render split → **Components 1 & 5**.

### DR-2.Y (HISTORICAL) — earlier layered "VCP" descriptor
**When:** 2026-01-27
**Status:** superseded by the current flat schema. For the record: an earlier, more ambitious
design modelled content/attribution/rights as **layered descriptors** (`did:pkh` authors,
license grants with grantee/permissions/conditions, `spdx`, attestation services like
eas/verax/ceramic). This simplified into today's flat `{body, encryption, objectId, proof,
public}`. The *rights/licensing* ambitions from it now belong to **Component 4** (permissions).

---

## Open questions / unresolved
- **[GAP]** Exact current field list of `public` beyond the observed
  (`specVersion, author, postType, mediaType, parent, plaintextHash`).
- **[future work]** Whether license/rights fields (from DR-2.Y) return, and whether they live
  in the item schema or purely in the permissions contract (Component 4).

## Cross-references
- **Component 1 (authoring)** — builds & signs the item (`shared/src/identity/sign-content.ts`);
  canonical home of the did:ethr-over-Safe identity.
- **Component 3 (encryption)** — the *gate/how* behind the `encryption` flag; Lit encrypt/decrypt;
  ties into the permission contract.
- **Component 4 (permissions/governance)** — publication contract scopes which items belong to a
  publication (replaces "index"); home of deal lifecycle + any rights/licensing.
- **Component 6 (website hosting)** — same IPFS/Filecoin layer, rendered-site stage.
- **Component 8 (authenticity/provenance)** — consumes proof + plaintextHash for page-level
  verification and the DID tie-in.
