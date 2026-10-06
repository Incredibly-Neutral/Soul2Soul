# Soul2Soul — Prototype Specification

> **Status:** first pass (2026-09-11), restructured around the prototype's own logic — identity,
> actions, content — not the whitepaper's ordering. Companion to the **Polyphony** whitepaper
> (`../whitepaper/v1.md`). The whitepaper is the *protocol* (the target); this is the *prototype*,
> the working application that demonstrates it. **Not a reference implementation**: its intent is a
> working application, so it may fall short of the paper, lack features, or carry extras. Each
> divergence is marked **[shortfall]** / **[extra]** / **[forward]**. Component specs (SPEC-*,
> RFC-*) remain the authoritative detail of what is actually built; this is the readable spine.

---

## 0. Relationship to the Polyphony whitepaper

Polyphony (the paper) is **the protocol** — what the system commits to, independent of any named
technology. It never says "Obsidian", "Lit", "ENS", "Safe", because the protocol would survive
replacing all of them. It is the target.

Soul2Soul (this doc) is **the prototype** — a working application. It is **not** a reference
implementation: it makes no claim to faithfully instantiate every requirement. It shows a working
app, and diverges from the paper in either direction, deliberately. Where the paper says "the
author signs at publication", this doc says *which* key signs *which* bytes, with *which* library,
held *where* — in this build.

**The divergence is information.** Every shortfall or extra is a signal about the protocol — a gap
to close, a requirement that proved optional, a path the paper should consider. Markers:

- **[shortfall]** — the paper calls for X; the prototype does not yet deliver it.
- **[extra]** — the prototype does X; the paper neither requires nor describes it.
- **[forward]** — proposed, not yet built.

**Rule of thumb for the split:** a claim that survives replacing every named technology belongs in
the paper; a claim that names a package, contract, or component in this build belongs here.

---

## 1. Identity

### 1.1 What kind of key

A secp256k1 EOA keypair (`ethers.Wallet.createRandom`), generated in `OXOUser`. It is the signing
key.                          

- At rest: encrypted with Electron `safeStorage` (macOS Keychain / Windows DPAPI / Linux Secret
  Service) → only an opaque `key_blob` is on disk; plaintext exists in memory only while signing.
- Headless Linux (no secret store): `PlaintextKeystore` fallback **with an explicit logged warning
  — never silent**.
- The EOA signs `"lit actions auth"` — the signature the gates recover and check against the
  author Safe's owners (INV-1).
- The EOA also EIP-712-signs each published work (see §3.4).

### 1.2 What kind of DID

The author is a **`did:ethr`** — `did:ethr:0x<addr>`, naming the safe address directly.

- `did:ethr`'s registry supports rotation with time-aware resolution, so old signatures stay valid
  under the key that was current when signed.
- On-chain, the author is recorded as a **Safe** (ERC-4337 smart account, gasless via pimlico
  paymaster). Its address is deterministic across chains (same CREATE2 salt) so it can own the ENS subnode (L1) and be the gated identity (L2).
- **[forward]** Identity-first inversion (RFC Track B1): *today identity is the keypair.* The
  proposed change is DID-as-durable-identity with keys as rotatable material beneath it.

### 1.3 Rotate

- **Today:** rotation = swapping the Safe's signers (add/remove owner). The key changes; the Safe
  address and identity do not.
- **[forward]** Under DID-first: rotation is a `did:ethr` registry update changing the current key.
  Old signatures still verify (time-aware resolution).
- This is the concrete answer to the paper's "an identity that cannot survive a key rotation is an
  archive hostage to a single secret."

### 1.4 Recover

- **[shortfall]** The prototype has **no recovery** today. Because identity *is* the keypair, a lost
  key is a lost identity — nothing in the build recovers it.
- The paper's durability only lands via the Safe model (a lost owner doesn't lose the Safe while
  other signers remain) or via DID-first rotation. Both are **[forward]**.
- The human "confirm to sign" layer (explicit authorization to use the key — passkey/biometric) is
  a separate, later piece **[forward]**.

---

## 2. Actions

The two acts that move a work through the protocol. Both are **Safe proposals** (multisig) or
**signed renders** — never a direct privileged write.

### 2.1 Propose

How a work is admitted. Depends on whether the publication has whitelisted the author:

- **Whitelisted author** — proposes, and the work goes straight to the generator (`canPublish`).
- **Non-whitelisted author** — proposing creates a **pending offer**; the publisher reads it and
  either approves (`acceptLicense` → active license) or refuses, on the record.

What actually happens on propose: the author signs an `S2SContentItem` → the render action produces
the page under the gates → the update action rebuilds the Merkle tree → the protocol key signs the
new root into the records → the ENS name points at it.

### 2.2 Revoke

How a work leaves the published state. Ending an agreement is a single act with immediate effect —
the next render drops the page, and no signer's standing extends to it.

- **Author retracts** or **publisher revokes** the license (`revokeLicense` on-chain) →
  `license=false` → on the next render the content is `revoked` and its page removed → **implies a
  rebuild** to take effect.
- **[shortfall]** The paper promises a withdrawn/old version "is no longer part of that state." The
  update action accepts a `remove[]` list of stale paths (`replacedBy` for slug renames, or
  revocations), but neutralpress does not yet build that list — a changed slug can leave the old
  path orphaned in the published tree. Closing this gap is a prototype→paper reconciliation.

---

## 3. Content

### 3.1 How source material is stored

- In the author's vault as a markdown file: `.md` for plain bodies, `.base` for encrypted bodies.
- Published: content-addressed, uploaded via the **dual Kubo + Filecoin** path — `uploadToKubo`
  for instant gateway availability, `uploadJson` (CAR builder) to Filecoin SPs for durability.
- Stored **raw and clean** — never baked with directive output. Markdown directives (e.g. the
  `sections` transform) are applied **at render time on the decrypted plaintext**, so a transform
  change takes effect on re-render without re-publishing.
- Source material is never made public; it exists in readable form only when it passes the gates,
  to be used in the render process. The reader gets the rendered page, not the source.

### 3.2 How it is encrypted

- Lit V3 (Chipotle) encryption. On/off **access control on a public network** — explicitly **not**
  DRM, **not** a legal license.
- Encrypted content is decrypted **only inside the renderer**, under the on-chain gate (`canRead`),
  while under a current agreement.
- `encryption` is a boolean on the item: `false` → content effectively public; `true` → ciphertext.

### 3.3 Schema of source material

`S2SContentItem` — a **flat stored object, no union**:

| field | type | notes |
|---|---|---|
| `public` | `S2SPublicContent` | signed public metadata (EIP-712) |
| `objectId` | digest | EIP-712 digest of `public`, computable pre-upload |
| `proof` | `S2SProof` | EIP-712 author signature |
| `encryption` | boolean | on/off access control |
| `secret` | string | ciphertext when `encryption:true`; stringified JSON when false |

`S2SPublicContent` (all signed): `specVersion`, `author` (`DidEthr`), `postType`, `mediaType`,
`parent`, `position`, `publication`, `locale`, `createdAt`, `base?`, `tags[]`, `attributes?`,
`plaintextHash`.

`S2SSecretBody` (inside `secret`): `title`, `slug`, `content`, `custom?`.

### 3.4 How plaintext is hashed

- `plaintextHash` lives in the **signed** public part and commits the plaintext. The `secret`
  itself is **not signed** — the hash, not the secret, is what's committed.
- Computed via RFC 8785 canonical JSON (**JCS**) + keccak256 (`jcs` / `keccakOfJson` in
  `identity/jcs.ts`).
- `objectId` = EIP-712 digest of `public` — available before upload, so the id needs no CID.

---

## 4. Surfaces

The prototype's pieces. **The Obsidian plugin is one surface among several, not the thing itself.**

| surface | what it is | who for |
|---|---|---|
| `0xobsidian` (plugin `oxo-core`) | author identity & account (key, Safe, wallet) | the author |
| `neutralpress` (plugin) | authoring & publication lifecycle (parse, encrypt, store, render trigger) | the author |
| `safe-app` | publisher control panel (licenses, whitelists, config) — runs inside Safe web UI | the publisher |
| `website-starter` | local renderer (Bun runner) for dev/preview | developers |
| `protocol/actions` | the Lit enclave actions (render, update) — the immutable signed code | the machinery |

The common interface is `@s2s/soul2soul-shared`, compiled into each consumer — but the shared
library is secondary to the methods and stack choices above. What matters is what each surface does,
not the package it imports. No surface is canonical; the protocol attaches to the interface, so the
maintainer of any one surface never becomes the owner.
