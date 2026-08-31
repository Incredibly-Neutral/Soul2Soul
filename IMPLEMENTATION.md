# Retry-with-backoff on contenthash write receipt wait

## Problem
With `preview=false`, `bulkRender` runs the `evm-update` action, which submits a
`setText(contenthash_wrapped, ...)` tx and awaits its receipt. It failed with:

```
contenthash_wrapped write failed: missing response (requestBody="{...eth_getTransactionReceipt...}", url="https://lb.drpc.live/base/<key>", code=SERVER_ERROR, version=web/5.7.1)
```

while the tx was legitimately still indexing. Root cause:
`protocol/actions/src/libs/evm.ts` used ethers v5 `txResponse.wait(1)` →
`waitForTransaction` → `poll()`, which retries with backoff while the receipt is
`null` (pending/indexing) but rejects *immediately* on a transient RPC transport
error (`SERVER_ERROR` / 'missing response' — `@ethersproject/web` index.js
395-399). The write path uses a single RPC URL with no retry, so one DRPC
load-balancer hiccup during the receipt wait failed the whole write.

## Fix
Replaced the single-shot `await txResponse.wait(1)` with a bounded
retry-with-backoff receipt polling loop (`waitForReceipt`) inside the existing
`if (confirm) { ... }` block:

- `receipt === null` / `blockNumber === null` (still indexing/pending) → not
  ready: sleep + exponential backoff (250ms floor → ~10s ceiling, matching
  ethers' scaling) up to a ~90s total budget before giving up.
- transient ERROR (`SERVER_ERROR` / 'missing response' / network) → *not* a
  failure: log + retry with backoff for the same bounded budget.
- only fails hard once the time budget is exhausted, or later when the mined
  receipt confirms `status === 0` (reverted).

Behavior preserved:
- `receipt.status === 0` reverted check and the `{ success, hash, receipt }`
  return shape are unchanged.
- `confirm:false` still does **not** wait (fire-and-forget) — unchanged.
- Read-side `evmRead` fail-fast is untouched (it intentionally fail-fasts inside
  the Lit session budget).
- `protocol/actions/src/update/main.ts:336` unchanged — it still fails loudly
  when the wait ultimately fails after retries.

## Files changed
- `protocol/actions/src/libs/evm.ts`
  - Added retry-policy constants + `waitForReceipt` helper (lines ~52-98).
  - Replaced `const receipt = await txResponse.wait(1);` with
    `const receipt = await waitForReceipt(provider, txResponse.hash);` (lines ~168-171).
- `protocol/actions/src/libs/evm.test.ts`
  - Added `describe('evmWrite receipt-wait retry (confirm:true)')` with 4 tests
    (lines ~66-257):
    1. transient `SERVER_ERROR` once → retry → succeeds (asserts 2 receipt polls).
    2. null receipt (still indexing) → retry → succeeds (asserts 2 polls).
    3. mined-but-reverted (`status===0`) still reports failure.
    4. `confirm:false` does not call `getTransactionReceipt` at all.

## Gate commands run
- Protocol tests: `pnpm --filter @s2s/protocol test` → **157 passed / 157**
  (13 test files), including the 4 new evm receipt-wait tests.
- Shared build (dep prerequisite): `pnpm -C shared run build` (tsc) → success.
- Shared tests: not run/touched — no shared code changed.
- `tsc --noEmit` (protocol): N/A — the protocol tsconfig only includes
  `contracts/deploy|gencontracts|rocketh`; the lit-action source tree is not part
  of a TS project (it is bundled at build time). Pre-existing, unrelated.
- ESLint (`pnpm exec eslint protocol/actions/src/libs/evm.{ts,test.ts}`): the
  lint config uses `projectService` which cannot resolve the actions tree
  ("file was not found by the project service"). **Pre-existing**: the identical
  error occurs on unmodified `protocol/actions/src/update/main.ts`. The actions
  tree is outside every tsconfig project, so action source is not lint-covered.
- Prettier (`prettier --check` on evm.ts): fails, but **pre-existing** — the
  original `git show HEAD:...evm.ts` also fails (the file uses the repo's
  lit-action 4-space/quoted style). No CI workflows exist in this repo; the
  effective gate is the test suite.

## Pre-existing caveats
- `evm.ts` was already non-prettier-compliant on `main` (entire file uses the
  established lit-action style); this PR does not regress it and adds code in the
  same style rather than churning a full re-format.
- The eslint "projectService can't find actions files" condition is pre-existing
  and affects every file under `protocol/actions/src/`, including unmodified ones.

## Deploy note (out of scope)
The deployed action runs from the on-chain `lit_action_update` bundle, not from
repo `main`. Deploying this fix requires rebuilding + re-pinning/re-registering
the action bundle — that is out of scope for this PR; a human must redeploy after
merge.
