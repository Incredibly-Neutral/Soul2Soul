# Handoff: Tree-mutation integrity gate — verify PKP provenance sig before any tree change (2026-08-06, for tomorrow)

**Date:** 2026-08-06
**Scope:** Design spec (not yet implemented) for closing the tree-mutation trust gap exposed by the
`remove` feature review. Captures the full produce/consume design agreed in conversation.
**Status:** Spec'd in SPEC-protocol-actions A3 ("Remaining / trust TODO"). Implementation deferred to
tomorrow. This handoff is the actionable pointer; the spec is the reference.

## The gap (why)

Tree assembly moved out of the enclave when `cbor` (in-enclave root-builder) was merged into the
client-supplied-`jobs[]` `update` action (GAP-5 ✅). The merge kept tree-building but dropped the
implicit in-enclave custody over what enters the tree — never replaced with an explicit check.

Consequence: a licensed author can already **overwrite any co-author's page with junk** via `jobs`
(the gate is publication-scoped `canPublish`, no per-content check). `remove` lowers the cost and
broadens the blast radius (recursive, low attribution) but is the **same seam**. The fix below
closes both at once.

## The chain that already exists (contract → PKP sig → tree)

- Contract `_append` is genesis-author-gated (INV-append): only `genesisAuthor[G]` (or Safe) can put
  a cid at `getLatest(G)`. On-chain identity is an address, authenticated by tx-origin.
- Render fetches `getLatest(G)` and **the PKP signs the rendered output** (`render/metadata.ts`
  `addAndSignMetadata` — already shipping): `proof.proofValue` is a PKP sig over
  `canonicalize(schema)+canonicalize(proofOptions)`, where the schema commits to **both**
  `encoding.sha256` (sha256 of the HTML body) **and** the genesis (today implicit as
  `encoding.contentUrl = ipfs://${body.id}`; `body.cid` is never set).
- So a real render output is HTML carrying a PKP sig that commits to the bytes AND the genesis.
  **That sig is the render↔update tie that went missing — update just doesn't verify it yet.**
  Verifying it extends the contract's author-gate transitively to the tree.

## Produce side (render) — one small addition

Add the document's own genesis/objectId as an **explicit signed field** in the JSON-LD schema (e.g.
top-level `identifier` = bytes32). Today implicit via `contentUrl`'s `body.cid || body.id` fallback
— correct only because `body.cid` is never set. Promoting it removes the fallback dependency. The
PKP sig already covers the whole schema, so adding the field signs it automatically.

(GAP-1's `S2SContentInfo` type-rename tail is cosmetic and **not** a blocker — the sig is produced
and verifiable today.)

## Consume side (update) — one verify routine before any tree mutation

For a given HTML (at `job.html` for adds, at `entry.path` for removes), extract the embedded
JSON-LD, then:

1. **Sig** — recover address from `proof.proofValue` over
   `canonicalize(schema)+canonicalize(proofOptions)`; assert `== protocolInfo.pkp`.
2. **Bytes** — recompute `sha256(html body)`; assert `== schema.encoding.sha256`.
3. **Genesis** — read schema genesis; assert `== job.id` (add) / use as `genesisAt(path)` (remove).

Then per-loop predicates:
- **Add (copy loop):** 1+2+3 pass → `cp`; else reject the job. *(Closes the junk-overwrite.)*
- **Remove, revoke (`!replacedBy`):** path HTML passed 1+2 at add time → parse-trust genesis →
  `!hasDeal(genesisAt(path))` → allow.
- **Remove, rename (`replacedBy`):** `genesisAt(path) == replacedBy && jobGenesisSet.has(replacedBy)`
  → allow.

## Soundness subtleties (the parts that make the checks work)

- **Check 2 (sha256) is mandatory, not optional.** The PKP signs the schema, not the HTML; `sha256`
  is what binds schema→bytes. Skip it → graft attack: stolen signed schema wrapped around junk HTML
  passes. 1+2 together = "PKP signed *this* HTML claiming *this* genesis."
- **`canonicalize` must be identical on both sides (GAP-2).** Top-level key sort, current quirk.
  Co-evolve or share the function; a one-sided GAP-2 "fix" silently breaks every sig.

## Preview is unsigned by design (INV-7/GAP-6)

Bun shim's `getPrivateKey` throws → `proof` has no `proofValue`. So the verify gate must be
`if (!preview)`: enforce only on the Lit path. Bonus: preview HTML can never enter the prod tree
(OPEN-TASK-2's flip side).

## What this does NOT need

- No new on-chain path→genesis index (sig carries genesis; contract already gates author; path is a
  render artifact per slug-override, not a content property — binding it on-chain fights the model).
- No re-verifying the sig in the remove loop (add loop gated entry; removes parse-trust).
- No author signing of `jobs`/`remove` (PKP sig per-HTML is the stronger integrity proof and already
  exists; "sign the jobs" only binds who approved the list, not that the claims are true —
  superseded).

## Orthogonal hardening TODOs (same session, cheap)

- Reject any `..` segment in `cleanPath` (today `entry.path = "../foo"` →
  `rmPath = /temp-…/../foo` → resolves to `/foo` in the MFS root, outside the temp tree).
- Explicitly block reserved roots (`assets`, `index.html`, empty) rather than relying on the
  assets-copy running *after* the remove loop to heal `assets`.

## Still not done (client side)

neutralpress must populate `remove` from slug-change detection and revoked renders (SPEC-neutralpress
flagged this; orthogonal to the gate but needed for the feature to actually fire).

## Reference

- Full spec: `brain/specs/SPEC-protocol-actions.md` §A3 "Remaining / trust TODO".
- GAP-1 register entry (SPEC-00) updated to note the explicit-genesis-field plan (tail (c)).
- Two stale GAP-1 lines in SPEC-protocol-actions (A2 gotcha + Local gotchas) corrected: provenance
  is no longer a placeholder — built from real signed data; only the type-rename tail remains.
