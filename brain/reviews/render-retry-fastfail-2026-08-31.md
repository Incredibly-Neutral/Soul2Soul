# PR-B — Fast-fail render retry on deterministic session-budget errors

**Date:** 2026-08-31
**Branch:** `fix/render-retry-fastfail` (off `origin/main` @ `7a6313e`)
**Worktree:** `/home/joera/s2s-render-retry-fastfail`

## Goal
Stop the orchestrator from retrying a render job that fails with Lit's
DETERMINISTIC session-budget error (`You may not send more than 50 HTTP requests
per session ...`). Each retry opens a fresh Lit session with a fresh 50-request
budget and re-runs the same budget-blowing work — pure cost. Transient failures
(RPC flakiness, timeouts) keep their existing retries.

## Change — all in `shared/src/rendering/sequence.ts`, inside `runRenderActionWithRetry`

### Added predicate (module scope)
- `isDeterministicBudgetError(msg: string): boolean` at
  `shared/src/rendering/sequence.ts:45` (defined as `export`), matching the
  stable substring `/HTTP requests per session/i`. Robust to the `50` count
  changing; deliberately NOT matching the generic `Decryption error for item`
  prefix (that class mixes transient + budget failures) — we match the budget
  substring wherever it is embedded (including as a `Decryption error`
  suffix).

### Fast-fail placement (both failure branches, after the success gate)
- **Non-ok branch** (`shared/src/rendering/sequence.ts:96-104`): after
  `lastFailure = actionResult;`, if `isDeterministicBudgetError(String(actionResult?.error ?? ''))`
  → log `... deterministic session-budget error; NOT retrying — <msg>` and
  `break;`.
- **Thrown branch** (`shared/src/rendering/sequence.ts:113-121`): after
  `lastFailure = err;`, if `isDeterministicBudgetError(err?.message ?? '')`
  → log and `break;`.

In both cases `break` exits the loop, so the existing exhaustion path
(`nearest :123-140`) still builds the real `Error` from `lastFailure` and throws
it with `err.failure` attached — identical preserved-failure behavior, just
zero wasted retries.

### Unchanged
- `RENDER_RETRY_ATTEMPTS = 3` and `RENDER_RETRY_BACKOFF_MS = 1500` — untouched.
- Success gate (`actionResult?.ok || actionResult?.success`) and exhaustion
  semantics — untouched.
- maintain-cache and EVM-update actions — untouched (EVM-update is already
  deliberately excluded from retry; maintain-cache fires out of the render fan-out
  and is not retried here).

### No other render retry loop (confirmed)
- `neutralpress/src/render/render.helper.ts:102` calls `renderwithLitActions`
  with **no** outer retry.
- The only retry loop for the render action is `runRenderActionWithRetry` in
  `shared/src/rendering/sequence.ts` (called at the Promise.all fan-out, `:211`).

## Tests added — `shared/src/rendering/sequence.test.ts`
Added to the existing `runRenderActionWithRetry — live-path retry` describe
block (mocking `runAction` per existing patterns):

1. **`non-ok result with a session-budget error does NOT retry (1 call) and the throw preserves it`**
   — `runAction` called exactly once; thrown `Error` preserves the budget message
   AND `.failure === <envelope>`.
2. **`transient non-ok still retries up to RENDER_RETRY_ATTEMPTS (no fast-fail)`**
   — error `'RPC call to https://lb.example failed'` → `runAction` called 3×
   (exhaustion).
3. **`thrown budget error (err.message match) also fast-fails with 1 call`**
   — `runAction` rejects with the budget message → called 1×, throw preserved.
4. **`budget message embedded as a Decryption-error suffix still fast-fails (substring match)`**
   — guards the substring-match requirement (not the `Decryption error` prefix).

**Counts (rendering suite):** `Test Files 2 passed (2)` — `71 passed | 5 skipped | 1 todo`.
Sequence file alone: `19 passed | 5 skipped | 1 todo`.

## Gates
- `pnpm -C shared run build` → **EXIT 0** (tsc).
- `pnpm --filter @s2s/soul2soul-shared exec vitest run src/rendering/` → **EXIT 0** (71 passed).
- `npx prettier --write shared/src/rendering/sequence.ts shared/src/rendering/sequence.test.ts`
  → **EXIT 0** (sequence.ts unchanged; test file reformatted two pre-existing
  long lines only).
- Broader shared suite `pnpm -C shared test` → `116 passed | 5 skipped | 1 todo`,
  1 **infra** error: vitest worker fork `Worker exited unexpectedly` — not a test
  failure, unrelated to this change.

## Commit / PR
- Commit hash: `848e77c`
- Branch: `fix/render-retry-fastfail`
- PR: **#75** — https://github.com/Joera/S2S-monorepo/pull/75 (against `main`, NOT merged)
