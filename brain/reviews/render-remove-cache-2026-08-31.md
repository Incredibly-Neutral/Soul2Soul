# Review — PR #73: refactor(render): remove inline cache write-back (maintain-cache owns it)

**Date:** 2026-08-31
**Reviewer:** DeepSeek V4 Flash 0731
**Base/Head:** main ← feat/render-remove-cache
**Commit:** `130a642` (pushed to `origin/feat/render-remove-cache`)
**PR:** https://github.com/Joera/S2S-monorepo/pull/73 (not merged — as instructed)
**Worktree:** /home/joera/s2s-render-remove-cache

---

## What was validated

The edit (left uncommitted by a prior run that stalled on a bogus eslint gate) was verified against the spec **without redoing it** — only the untouched on-disk diff was reviewed, plus one purely-mechanical prettier reformat (see §Non-gate). Then run through the real gates and shipped.

### Edit substance verified (git diff — deliverable)
- **Removed:** `writeBackArchiveCache()` async function + its call block; imports `S2SContentItem`, `catFile`, `evmWrite`, `toHexString`, `parseArchive`/`mergeArchive`/`serialize`/`reconcile`, `type CollectionsDrift`.
- **Kept:** `uploadFile` (html pin), `evmRead` (pointer read + hasDeal), `shouldWriteBackCache`.
- **Pointer READ preserved:** `archiveCid = await evmRead(... 'getText' 'content_cache_<publication>')` still reads the archive pointer.
- **Drift SIGNAL preserved:** `const shouldFire = shouldWriteBackCache(maintainCache, preview, drift); maintainCachePending = shouldFire;` and the `maintainCache: maintainCachePending` success-envelope field.
- **`RECORDS_CONTRACT_ABI` pruned to `getText` only** (no `setText`).

Line counts: `git show` diff = **1 file changed, 11 insertions(+), 148 deletions(-)**.

---

## Gates (all REAL gates run; all PASS)

### 1. Lit action bundle build — PASS (AUTHORITY)
Command: `pnpm actions:build` → `node protocol/scripts/lit/build-actions.cjs` (esbuild, `actions/src` → `dist`, iife/`globalName=__LitAction`).
**EXIT 0.** All five entries emitted:
- `Build complete: protocol/actions/dist/prep/main.js`
- `Build complete: protocol/actions/dist/render/main.js`
- `Build complete: protocol/actions/dist/maintain-cache/main.js`
- `Build complete: protocol/actions/dist/update/main.js`
- `Build complete: protocol/actions/dist/render-dev/main.js`

Bundle spot-checks on `dist/render/main.js`:
- `writeBackArchiveCache` occurrences = **0** (function gone from bundle).
- `maintainCachePending` occurrences = **3**, `getText` = **3** (read + signal present in bundle).
- The only `setText` string in the render bundle is an ABI fragment bundled from a shared/ethers dependency — `RECORDS_CONTRACT_ABI` in source is `getText`-only, and there is no render-owned `setText`/pointer-write call.

This is the authority that `render/main.ts` still compiles cleanly after the edit; maintain-cache + all other actions also still build.

### 2. Shared package build — PASS
Command: `pnpm shared` → `pnpm -C shared run build` → `tsc`. **EXIT 0.** (Actions import `@s2s/soul2soul-shared`; its `dist` compiles clean, so the shared-import surface the action relies on is valid.)

### 3. Tests — PASS
- **Render action suite** (`protocol`, `vitest run`, include `actions/src/**/*.test.ts`):
  **13 test files passed, 159 tests passed**, EXIT 0. Includes `data.ctrlr.test.ts` (exercises `shouldWriteBackCache`, still used) plus content-transforms, revoke-guard, revoke-e2e, byte-identity, etc.
- **Shared `action-io.test.ts`**: `pnpm --filter @s2s/soul2soul-shared exec vitest run src/rendering/action-io.test.ts` → **52 passed** (incl. `validateSingleOutput — maintainCache drift signal` cases: accepts `data.maintainCache:true` and omitted).
- **Shared `sequence.test.ts`**: **15 passed, 5 skipped, 1 todo** (21 collected), EXIT 0.

### 4. Prettier (touched file) — PASS after reformat
`npx prettier --check protocol/actions/src/render/main.ts` returned **EXIT 1** on the untouched edit, so formatting was fixed with `prettier --write` (a real gate). The only change was collapsing the single-element `RECORDS_CONTRACT_ABI` array to one line — verified **pure formatting, zero substance change** (diff against the pre-prettier edit = that one line only). Re-check → **All matched files use Prettier code style!** EXIT 0. Re-ran `pnpm actions:build` after the reformat → **EXIT 0**.

---

## Non-gate (known, NOT chased)
**eslint on `protocol/actions/src/*`** fails with `Parsing error: ... was not found by the project service` — a known repo-wide false failure because `actions/src/` is not included in ANY tsconfig. Not addressed (no temp tsconfig, no dead-end churn). Not introduced by this change.

---

## Signals/reads preserved (re-confirmed in final committed bytes)
- `archiveCid` pointer READ via `evmRead`/`getText` — intact.
- `shouldFire`/`maintainCachePending` drift signal + `maintainCache: maintainCachePending` envelope — intact.
- Bundled/`dist` artifacts for maintain-cache still emit with their own `setText` pointer-write (its job), render's is gone.

---

## Git / PR
- Branch: `feat/render-remove-cache` (tracking `origin/main` at start; now tracking `origin/feat/render-remove-cache`).
- Commit: `130a642` — `refactor(render): remove inline cache write-back (maintain-cache owns it)` (1 file, +11/−148).
- Pushed: `origin/feat/render-remove-cache` (new branch), EXIT 0.
- PR: **#73** — https://github.com/Joera/S2S-monorepo/pull/73 (title matches; body includes gates + non-gate note). **Not merged.**
