---
component: introduction
protocol: soul2soul
number: 0
status: living
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude history; project vision + component map. Read this first.
---

# Soul2Soul (S2S) — Introduction & component map

> **Read this first.** This is the orientation doc for a machine (or person) picking up the S2S
> project cold. It states what S2S is, the core design principle, and how the eight component
> docs fit together. Each component doc leads with function + minimum guarantee, then a dated
> decision record. Vision phrasing here is from the project's own words; details live in the
> numbered docs. `[GAP]`/`[unresolved]`/`⚠` markers there flag what is *not* settled — respect them.

## What S2S is

A **publishing protocol** where **authors and publications hold independent, equal power**. Authors
write in their own tools, keep **cryptographic ownership** of their work, and can withdraw it;
publications coordinate editorial/brand/promotion **without owning the underlying content**. Every
published page carries **embedded proof** of who wrote it, who published it, and that it wasn't
altered. A publication is not an account on a platform — it is its **own static website**, fully
customizable, content-addressed, with no platform in the middle.

Shorthand the project uses: **"decentralized WordPress, not a web3 Substack."** Magazines are
static sites you build with templates; content has cryptographic provenance; neither party trusts
a central intermediary to keep the relationship honest.

## The problem it exists to solve

The **impossible choice** facing author collectives: either **trust a platform** (policy shifts,
deplatforming, shutdown) **or run your own server** (WordPress-style), which puts the whole
site — and everyone's content — **in one person's hands**. Associations are often temporary —
investigative teams, seasonal titles, issue-based coalitions — and current tooling forces
dependency and "manufactured consent" rather than letting people **cooperate temporarily while
keeping individual sovereignty**.

## The core principle (the "secret sauce")

**Remove the means of production from anyone's control.** In publishing, someone always controls
the printing press or the app. S2S makes the **generator autonomous, transparent, and owned by
no one**: an open-source **Lit Action bound to a key it cannot expose (a PKP)**, run by independent
nodes reaching consensus in secure hardware. It decrypts content, renders HTML, **signs** the page,
uploads it to IPFS, and **anchors the site root on-chain** — and it will do so **only** when the
on-chain rules pass. Neither author nor publication holds that key.

A recurring architectural through-line follows from this: **capability is open, authority is
collective.** Reusable logic (authoring, config/asset building, rendering) lives in **shared /
protocol-level code** so *anyone can build another frontend or tool over it*; but the *effects*
that matter — who may publish, whose content decrypts, what the site's code is, what the root
points at — are gated by a **Safe multisig** and enforced by the neutral generator. Frontends are
swappable; the guarantees are not.

## Identity, in one paragraph (it recurs everywhere)

The author is a **`did:ethr` whose address is a Safe (multisig), not an EOA** — because the
publication contract records the author by Safe address, and with ERC-4337 + a paymaster the
on-chain `msg.sender` *is* the Safe. Key rotation = **swap the Safe's signers**, not the DID. The
DID wrapper is a deliberate (partly aspirational) signal that S2S isn't *only* on-chain. There is
**no `did:safe` method** — that phrase is shorthand for did:ethr-over-Safe. Full rationale in
Component 1.

## The eight components

S2S is defined as a **minimum guarantee per component**; the named tech (Lit, Safe, ENS,
Filecoin/IPFS, Obsidian, Handlebars) is a **reference implementation**, not the protocol. Each can
be swapped if a replacement meets the guarantee.

1. **Content authoring** — the authoring surface; author authenticates (did:ethr-over-Safe) and
   emits two distinct interactions: the deal lifecycle (→ contract) and the publish action (→
   generator). Ref: an Obsidian plugin (`0xobsidian`/`neutralpress`). *One of many possible.*
2. **Content-item schema (+ content-addressed storage)** — the signed item
   `{body, encryption, objectId, proof, public}`; `objectId` = EIP-712 digest of `public`;
   proof signs `public`+`plaintextHash`, **not** the body. Encryption = author-vs-publication
   **ownership** boundary (not a paywall). Stored on IPFS/Filecoin. *(Lens: removed.)*
3. **Encryption & access control** — the **gate**. Encrypt to a PKP; decrypt **inside** the render
   action only if on-chain permission holds. Major model change on record: **Lit Naga → Chipotle**
   (ACC-immutable → governable, ciphertext-only, no `dataToEncryptHash`).
4. **Publication governance & permissions** — the on-chain authority (a **Safe + modules**):
   governs *who may publish/decrypt*, *the config*, and *the website's codebase* (build = a
   governance act). Includes `safe-app` (publisher UI) and the V2 append-log. Convergence point.
5. **Site generation (neutral renderer)** — the **PKP + Lit Actions**. Pipeline **PREP → RENDER →
   UPDATE**: prep (Bun, no signing) → render (gated, decrypt, render, sign, upload per job) →
   update (write the site root; **only the PKP** can). Heart of the neutrality claim.
6. **Website hosting** — retrievability of the rendered site; content-addressed. **Active
   migration: IPFS pinning → Filecoin** (PDP/warm storage, incentivised persistence).
7. **Domain resolution** — publications are **subdomains of `soul2soul.eth`**; root stored on
   **L2 (Base)**, resolved from **L1** via **CCIP-Read** + custom resolver/registry/records
   contracts and a gateway. `.limo`/`.link` for browsers.
8. **Authenticity & provenance** — the **embedded page proof**: schema.org JSON-LD + **W3C Data
   Integrity Proof**, PKP-signed, self-verifying HTML. Three aims: self-authentication, provenance,
   license-on-domain. ⚠ two open gaps gate the security claim (see that doc).

## How a publish flows (one pass through the whole system)

```
author writes (1) → signs content item (1,2) → encrypts if owned (3) →
uploads item to IPFS/Filecoin (2) → offers/appends to publication contract (4) →
triggers render → neutral generator: gate-check (3,4) → decrypt → render →
sign provenance into HTML (8) → upload site tree (6) → PKP writes new root to
the ENS-L2 records contract (5,7) → name resolves via CCIP-Read to the new CID (7) →
reader fetches over .limo, browser verifies the embedded proof (8)
```

## Status flags to respect
- **Removed:** Lens Protocol (was storage/identity venue — see Component 2's superseded section).
- **Active migration:** IPFS pinning → Filecoin (Component 6).
- **Recent model change:** Lit Naga → Chipotle (Component 3).
- **⚠ Security-gating gaps:** hardcoded provenance metadata + ambiguous signing primitive
  (Component 8, GAP-1/GAP-2); hardcoded API keys in a renderer lib (Component 5, GAP-9).
- **Naming drift caught during reconstruction:** `did:safe` (→ did:ethr-over-Safe);
  Deals↔Licenses (same concept); old render-stage names (→ PREP/RENDER/UPDATE).

## How to use these docs
- Start here (0), then read the component you need. Cross-references link the interlocking parts.
- Treat **decision records** as *why it is this way* — including **rejected** options (kept
  deliberately so they aren't re-proposed) and **superseded** ones (kept so history is legible).
- **Do not fill gaps.** Where a doc says `[GAP]`/`[unresolved]`, that is the real state of the
  design, not a documentation hole. Ask joera rather than inventing.
- These were **reconstructed from conversation history**, curated (not exhaustive). The running
  code and specs are the final authority where they disagree.
