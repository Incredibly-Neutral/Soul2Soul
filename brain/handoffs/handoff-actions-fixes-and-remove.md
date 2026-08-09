# Handoff: Lit action fixes, slug override, and tree removal (2026-08-06)

**Date:** 2026-08-06
**Scope:** Bug fixes and features discovered during production testing after the constants-extraction deploy. Covers Lit enclave fetch budget, slug overrides, and MFS tree path removal.
**Status:** Implemented and deployed. Client-side wiring for `remove` is deferred to the caller (neutralpress orchestrator).

---

## 1. Lit enclave fetch budget — repeated identical RPC calls fail

### Symptom
`getDeals` (returns dynamic array of structs) fails with `"missing response"` (empty HTTP body) from both DRPC and Alchemy simultaneously, but only when called 3+ times. Single `getDeals` call works fine. All scalar/single-tuple calls work fine regardless of count.

### Diagnosis
The `fetchCollections` loop in `data.ctrlr.ts` called `fetchByPublication` (→ `getDeals`) **once per collection**. With 5 collections on s3nl's home page, that's 5 identical `getDeals(0, 10)` calls. Lit nodes have an internal fetch budget that gets exhausted by repeated identical calls — not by response size. A single collection page works, 5 fails.

### Fix
`fetchCollections` now calls `fetchByPublication` **once** before the loop, caches the result in `allDeals`, and filters per collection in-memory.

**Changed:** `protocol/actions/src/render/data.ctrlr.ts`

### GAP-15 co-fix reverted
The original catch-all (`continue` on any error) was temporarily replaced with a check that threw on `CALL_EXCEPTION`. Ethers v5 wraps transport `SERVER_ERROR` as `CALL_EXCEPTION` with `data="0x"`, so the first RPC failure immediately threw — never trying the second URL. Reverted to pure catch-all + continue.

**Changed:** `protocol/actions/src/libs/evm.ts` — `evmRead` failover loop now collects all failures in `failures: string[]` and throws an aggregated Error with all URLs joined.

### `pageSize` reduction
`getDeals` default `pageSize` changed from 200 → 10 to keep individual responses minimal.

**Changed:** `protocol/actions/src/libs/module.factory.ts`

---

## 2. Slug override from Obsidian frontmatter

### Feature
Add `slug: mijn-eigen-pad` to a note's frontmatter to override the auto-slugified (from title) URL path.

### Fix
`neutralpress/src/factories/note.factory.ts` now reads `frontmatter?.slug` before falling back to `slug(title)`. The slug propagates through the existing pipeline — Lit actions use `body.slug` in `createPath`.

**Changed:** `neutralpress/src/factories/note.factory.ts`

---

## 3. MFS tree path removal (remove mechanism)

### Problem
When a slug changes (e.g. `/geen-risico-op-datalekken/` → `/veiligheid/`), or when a post is revoked, the old path stays in the IPFS tree forever. The update action only copies new/overwritten paths — it never removes stale ones.

### Mechanism
New `remove?: { path: string; replacedBy?: string }[]` field on `EvmUpdateInput`. The update action validates each entry before removal:

- **`replacedBy` present** → lookup that genesis string in the incoming jobs. If a job with matching `id` (genesis) exists, the removal is a **rename** — the same content moved to a new path. Allow.
- **No `replacedBy`** → **revocation**. Future: gate with `!hasDeal(genesis)`. Currently: also allowed (no trust issue since orchestrator already controls the tree).

The action does `files/rm` on each validated path after the copy loop, before stat+pin.

### Trust model
The orchestrator supplies the `remove` list. This is the same actor that supplies the `jobs` list (what to add). No new trust surface — the orchestrator already fully controls tree contents.

### Remaining
- Client-side (neutralpress) needs to populate `remove` based on slug change detection and revoked renders
- `hasDeal` gating for `!replacedBy` removal requires a `genesis` field on the remove entry — add when revocation UI exists

**Changed:** 
- `shared/src/lit/actions/types.ts` — `EvmUpdateInput.remove` type
- `shared/src/rendering/action-io.ts` — zod schema
- `protocol/actions/src/update/main.ts` — remove loop with `replacedBy` validation

---

## 4. `getProtocolInfo` duplicate ENS walk (identified, not fixed)

`getProtocolInfo` and `getDomainOwnerAndModules` both walk ENS L1 (`nameWrapper()` → `ownerOf()` → `getModulesPaginated()` → module `NAME()` loop). This is ~7 redundant calls. `getProtocolInfo` is used only for `pkp` and `gateway` (fallback) in the render action — neither needs the full ENS walk since `configModule` is already resolved by `getDomainOwnerAndModules`.

**Not changed** — both are client-side (`shared/src/`), not in Lit actions, so the duplicate doesn't affect the enclave fetch budget.

---

## Files changed

| File | Change |
|---|---|
| `shared/src/lit/actions/types.ts` | `EvmUpdateInput.remove` added |
| `shared/src/rendering/action-io.ts` | zod schema for remove |
| `protocol/actions/src/libs/evm.ts` | catch-all failover, aggregated error |
| `protocol/actions/src/libs/module.factory.ts` | `pageSize` 200→10 |
| `protocol/actions/src/render/data.ctrlr.ts` | `fetchByPublication` cached once |
| `protocol/actions/src/update/main.ts` | remove loop with replacedBy validation |
| `neutralpress/src/factories/note.factory.ts` | frontmatter `slug` override |

## Build verification
`pnpm actions:build` — 3/3 bundles (prep, render, update)
`pnpm -C shared run build` — tsc 0 errors
`pnpm -C neutralpress run build` — tsc + esbuild 0 errors
`pnpm -C 0xobsidian test` — 4/4 vitest pass