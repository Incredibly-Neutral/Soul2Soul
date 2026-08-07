---
component: neutral-renderer
protocol: soul2soul
number: 5
status: active
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude history; the renderwithLitActions pipeline, PKP neutrality, trust domains
---

# Component 5 — Site generation (the neutral renderer)

> Reconstructed for machine memory. **This is the heart of the protocol's neutrality.** The
> "publisher" is not an operator — it is a group of Lit Actions holding a single PKP, which
> renders + signs + anchors only when on-chain gates pass. Decision entries preserved as
> discussed. Gaps marked `[GAP]`; open Lens-era references marked superseded where relevant.

## Functional description

On a publish/rebuild trigger, the neutral execution environment **fetches content, decrypts the
items it is permitted to decrypt, renders HTML, produces a new content-tree root for the site,
and updates the naming record to point at that new root.** No operator does this — sandboxed JS
(Lit Actions) controlled by a PKP does, and only after gates pass.

## Minimum guarantee (protocol-level)

- The generator runs **only transparent, auditable code** bound to a **key it does not expose**,
  executed by **multiple independent nodes reaching consensus** (secure hardware / TEE), so the
  signed output is **mathematically guaranteed to be the product of the published code and
  nothing else.**
- **No party — including the protocol's own authors — can substitute different logic or extract
  the signing key.**
- The generator writes the site root **only** after the on-chain conditions (licensing +
  authorship + ownership) pass.

## Reference implementation

**Lit Actions + a single PKP.** The PKP is the trust anchor: it renders a body into HTML, signs a
provenance proof into that HTML, and writes the site's IPFS root on-chain — but only after the
gates pass. Neither author nor publication controls the key directly; that is what makes the
publisher "neutral" (rules enforced by code + contract state, not by an operator).

Orchestrated client-side by `shared/src/rendering/index.ts :: renderwithLitActions`.

---

## The four trust domains (topology — agents confuse these)

| Domain | Lives where | Controlled by | Holds |
|---|---|---|---|
| **Neutral publisher** *(this component)* | Lit network (+ Bun preview runner) | **PKP** + permitted action CIDs | rendering, decryption, signing, on-chain root write |
| **Publication** (Component 4) | Safe on Base (L2) + ENS subdomain (L1) | publication multisig | licensing, whitelist, config, site-root pointer |
| **Author** (Component 1) | authoring surface + author Safe | author's key/Safe | content, encryption, render triggers |
| **Protocol root** | `soul2soul.eth` → controller Safe + global records | protocol operators | PKP info, action CIDs, gateways, ENS records contract |

## Two record stores (critical distinction)
- **`S2SRecordsModule`** (configModule) — KV config (Component 4). `getRecords`/`setRecord`.
- **ENS records contract** (`protocolInfo.ensRecords`) — stores **`contenthash_wrapped`** (the
  **site root**), read/written via `getText`/`setText`. **This is NOT the config module** and is
  the only thing the PKP writes as the "publish" (Component 7).

## The publish pipeline

```
client (authoring surface) ── signature over "lit actions auth"
        │
        ▼
[PREP]     runtime: Bun runner (NO signing)   → jobs[]
        │   reads: ENS→modules, config, content bodies; expands "ripples" (related content)
        ▼
[RENDER]   runtime: Lit (PKP)                 → job.html (CID)
        │   gate: canRead/canPublish (on-chain, Base) AND signer ∈ owners of author Safe
        │   PKP: Lit.Actions.Decrypt (gated collections)
        │   render: Handlebars → HTML
        │   sign: provenance metadata embedded (→ Component 8)
        │   upload: HTML → IPFS
        ▼
[UPDATE]   runtime: Lit (PKP)                 → new root CID
            builds IPFS MFS tree, pins, writes contenthash_wrapped
            (ONLY the PKP can perform this write)
```

- **PREP** — cheap, **no signing**, runs on the Bun serverless runner. Resolves the publication
  (ENS→modules), reads config, fetches content bodies, expands **ripples** (related content),
  emits a deduped `jobs[]`.
- **RENDER** — one Lit Action per job; **this is where trust is enforced.** Recovers the caller's
  signer from a sig over `"lit actions auth"`; runs the on-chain gates (author Safe
  whitelisted/licensed **AND** signer is an owner of the author's Safe); PKP-decrypts gated
  collections; renders Handlebars HTML; signs + embeds provenance; uploads HTML to IPFS. **RENDER
  produces the per-job HTML; it does not write the site root.**
- **UPDATE** — assembles the IPFS MFS tree from the rendered jobs, pins it, and **writes
  `contenthash_wrapped`** (the new site root) on-chain via the PKP. **This is the single
  privileged root write; only the PKP can perform it.**

---

## Decision record

### DR-5.1 — The publisher is neutral: a PKP + Lit Actions, not an operator *(foundational)*
**When:** 2025 (core idea), reaffirmed 2026-07-02
**Decision:** Remove the "means of production" from any party's control. The generator is a set
of Lit Actions bound to a PKP; it executes only transparent code, and only it can sign pages and
write the site root — after gates pass.
**Rationale (as discussed):** "publishing infrastructure that belongs to no one and everyone" —
neither author nor publication controls the key; the rules are enforced by code + contract state.
**Status:** foundational; this is the protocol's defining property.

### DR-5.2 — Three-stage pipeline: PREP (cheap) / RENDER (trust) / UPDATE (root write)
**When:** 2026-07-02
**Decision:** Split rendering into **PREP** (no signing, Bun) → **RENDER** (per-job, gated, PKP,
decrypt+render+sign+upload) → **UPDATE** (assemble tree, pin, write root). Orchestrated by
`renderwithLitActions`.
**Status:** current (live).

### DR-5.3 — Runtime split: Bun preview vs Lit production; ONE renderer (INV-7)
**When:** 2026-07-02
**Decision:** In `dev=true`, all stages run through the **Bun serverless runner**
(`run.transport-union.dev`), which replicates the Lit Actions **without signing** (the shim's
`getPrivateKey` has no signing capability). In production, **RENDER** and **UPDATE** run on
**Lit nodes**.
**Invariant INV-7:** action code must behave **identically** in both runtimes (no Node built-ins
beyond the shim). There is a **single renderer** (`protocol/actions/renderer/`) run two ways —
so a template cannot render differently across dev/preview/prod; no parity drift to police.
**Consequence:** the older local renderer (`website-starter/renderer/`) is **transitional, being
replaced by the Bun flow**; `website-starter` reduces to templates + assets + `mapping.json` +
scripts, rendering delegated outward.
**Status:** current; local-renderer removal is `[in-progress]`.

### DR-5.4 — Only the PKP writes the site root; two record stores must not be confused
**When:** 2026-07-02
**Decision:** The "publish" is a single privileged write: `setText(node, "contenthash_wrapped",
…)` on the **ENS records contract** (not the config module), performed **only by the PKP** in the
**UPDATE** stage. Everything else (config, licenses) is Safe-governed (Component 4).
**Why it matters:** conflating the config module with the ENS records contract is a known
agent-confusion; they are different contracts with different write paths.
**Status:** load-bearing.

### DR-5.5 — Rendering approach: Handlebars, content injected into templates
**When:** 2025-12-30 → 2026
**Decision:** Use **Handlebars** templates (from the publication's repo/config) with content
injected at render time, rather than running a full framework build (Next/Astro) inside the
constrained action runtime. Pre-built templates + content injection is the tractable path given
Lit Action execution limits.
**Status:** current. `[GAP: confirm whether any framework-build path survives; record shows
Handlebars won]`

### DR-5.6 — Incremental rendering for large publications
**When:** 2025-10-28 (Lens-era plan; mechanism still relevant)
**Idea:** For publications with many posts, don't re-render everything: load a cached post index,
fetch only new posts since last render, select the subset to render (e.g. homepage set), decrypt
only those, render, reassemble the tree. `prep`'s `jobs[]` + `ripples` expansion is the current
embodiment of "render only what changed / what's related."
**Status:** mechanism current; specific caching detail `[GAP]`.

### DR-5.7 — IPFS upload / root encoding (implementation notes)
**When:** 2025-06 → 2025-12
**Facts established across the record:**
- The site is uploaded as a **directory/MFS tree**; the root becomes `contenthash_wrapped`.
- Root is encoded as an ENS **contenthash** (`0xe3 01 …CID bytes`); **UnixFS (dag-pb)** preferred
  over dag-cbor for **ENS gateway compatibility**.
- Upload mechanism evolved (Storacha/Pinata/Kubo considered); the action pins the tree and writes
  the contenthash via `evmWrite` using the PKP.
**Status:** current mechanism; exact pinning provider `[GAP: reconcile with Filecoin move,
Component 6]`.

---

## Known dead/duplicate code (from the record, for accuracy)
- `cbor/main.ts` — old root-builder, **dead** (merged into `updateEvm`, GAP-5); still group-permitted.
- `__renderer/` — older renderer copy, **dead duplicate** (GAP-4).
- `libs/constants.ts` — contains **hardcoded API keys** ⚠ (GAP-9).
- `libs/lens.factory.ts` — Lens GraphQL fetch, **testnet / superseded** by the Lens removal (GAP-10);
  content-body fetch now comes from the Filecoin/IPFS + contract path (Components 2/4).

## Open questions / unresolved
- **[in-progress]** Remove the transitional local renderer once the Bun flow fully replaces it.
- **[GAP]** Reconcile the upload/pin provider with the Filecoin migration (Component 6).
- **[GAP]** `libs/lens.factory.ts` still present though Lens is removed — confirm the current
  content-fetch path inside the action.
- **⚠ [security]** Hardcoded API keys in `libs/constants.ts` (GAP-9).

## Cross-references
- **Component 1 (authoring)** — the `"lit actions auth"` signature and render trigger originate here.
- **Component 3 (encryption)** — decryption happens **inside** SINGLE via `Lit.Actions.Decrypt`,
  gated by the contract; this component is *where* the gate executes.
- **Component 4 (governance)** — provides `canPublish`/`isLicensed` gates and the approved
  config/assets; the PKP consumes them but is separate from the Safe.
- **Component 6 (website hosting)** — the rendered tree is stored/hosted (IPFS/Filecoin).
- **Component 7 (domain resolution)** — the PKP's root write targets the ENS records contract
  (`contenthash_wrapped`); that is the "publish."
- **Component 8 (authenticity/provenance)** — SINGLE signs + embeds provenance metadata into the HTML.
