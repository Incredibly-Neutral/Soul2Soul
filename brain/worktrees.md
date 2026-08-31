# s2s worktree registry

Tracks active/orchestrated worktrees and their sub-agent sessions. Hybrid runs: orchestrator
dispatching to a builder sub-agent in its own worktree; human merges each PR.

## 2026-08-25 — fix/table-filter-options (PR #63 APPROVED, ready to merge)

**Task:** safe-app table-filter dropdowns render but options only show "All" — unique per-column
values (author, post_type for Offers/Deals; kind for Pieces; state for Data Sets) never populate.

**Worktree:** `~/code/s2s-table-filter-options-fix` (branch `fix/table-filter-options` from origin/main `19d1010`)

**Root cause (confirmed by explore, session 09bacc32186144b79805d844e080f990):** structural, not a
timing race. `.table-filters` is rendered as a SIBLING of `.table-<name>`, but every
`attachEventListeners()` selector requires it as a DESCENDANT
(`.table-deals .table-filters table-filter`, etc. at deals-tab.ts:598/614, storage-tab.ts:553/569).
`querySelectorAll` matches nothing, so `options` is never assigned and every `<table-filter>` keeps
its default single "All". Deterministic across all 4 tables. Sorting works because the sortable-header
selectors (`.table-deals .table-header.sortable`) genuinely match the nested `.table-header`.

**Fix (8-line change, no deps, no store/subscription changes):** tag each filter wrapper with a
per-table class and target that class:
- deals-tab.ts:440 `.table-filters` → `.table-filters offers-filters`; :598 selector → `.offers-filters table-filter`
- deals-tab.ts:500 `.table-filters` → `.table-filters deals-filters`; :614 selector → `.deals-filters table-filter`
- storage-tab.ts:478 `.table-filters` → `.table-filters pieces-filters`; :553 selector → `.pieces-filters table-filter`
- storage-tab.ts:504 `.table-filters` → `.table-filters datasets-filters`; :569 selector → `.datasets-filters table-filter`

(`uniqueValuesForColumn`, the options setter, and the option computation in `attachEventListeners` are
already correct — no changes.)

**Gates:** `pnpm type-check` + `pnpm build` from `safe-app/`. Verification step: rebuild then grep
the bundle for `.offers-filters table-filter` etc. (the new selectors) present.

**Deliverable:** PR `fix/table-filter-options` → `main`.

**Status:** implementer committed a9831ce (8+/8- across the 2 files), pushed, opened PR #63
(https://github.com/Joera/S2S-monorepo/pull/63). Gates verified by orchestrator: type-check exit 0,
build exit 0, all four new selectors present in built bundle. Independent review APPROVED
(session bfb1abdf3a8143eeb3e902421caeb1b0) — no blocking issues; one non-blocking note that scoping
now relies on the new wrapper-class names (future typo/duplicate could cross-match; maintainability
only, not in scope).

**Secondary (out of scope, do NOT fix):** offers subscription gap — deals tab subscribes only to
`store.subscribeToDeals`, flows mutating offers alone can leave the offers table stale. Orthogonal to
the visible bug; excluded per no-scope-expansion.

## 2026-08-31 — bulkRender evm-update saga (PR #47, #65 merged; PR #66 APPROVED, ready to merge)

Debugging `bulkRender` from the safe-app through a chain of failures. Three PRs, in order:

**PR #47 (MERGED)** `fix(safe-app): wire endpoints.rpcs into bulkRender renderwithLitActions` —
safe-app `s2s-deals-tab.ts` bulkRender was omitting the now-required `endpoints.rpcs` action input
(`endpoints.rpcs not wired` guard). Fixed by building `rpcs {L1,L2}` from `VITE_DRPC_API_KEY` and
passing it as the 11th positional arg.

**PR #65 (MERGED)** `fix(actions): surface cp-root abort as a clear timeout — raise MFS cp timeout` —
`evm-update` was aborting at the `cp root` MFS op with bare `AbortError`. Raised `cpRoot`/`cpFile`/
`pinAdd` 10s→60s in `protocol/actions/src/update/main.ts` and relabeled the abort as `timed out after
<ms>ms calling <url>` in `fetchWithTimeout` (`libs/helpers.ts`). NOTE: the running action executes the
on-chain `lit_action_update` bundle, NOT repo main — the fix only took effect after re-pinning the
bundle (on-chain is now `QmNizaG…`, the fixed bundle).

**PR #66 (APPROVED-WITH-NOTES, ready to merge)** `fix(actions): retry-with-backoff on contenthash write
receipt wait` — with the timeout fixed, the remaining failure moved to the write path: `contenthash_wrapped
write failed: missing response (… code=SERVER_ERROR, version=web/5.7.1)` while the tx was still indexing.
Root cause: `evm.ts` used ethers v5 `txResponse.wait(1)` -> `waitForTransaction` -> `poll()`, which retries
on a NULL receipt but rejects IMMEDIATELY on a transient RPC transport error (`SERVER_ERROR`/'missing
response'); DRPC `lb.drpc.live` throws exactly that during indexing.

- **Worktree:** `~/code/s2s-contenthash-receipt-fix` (branch `feat/fix-contenthash-receipt-wait`, base main `a98c3dd`)
- **Fix (`protocol/actions/src/libs/evm.ts`, +tests in `evm.test.ts`):** new `waitForReceipt` bounded
  retry-with-backoff loop (250ms floor → 10s ceiling, 90s total budget) replaces `wait(1)`. Null/
  still-indexing receipt AND transient transport error both treated as "not ready" → log + retry;
  hard-fail only on budget exhausted or `status===0` (reverted). Scoped to write-confirmation only
  (`confirm:true` single caller `update/main.ts:316`); read-side `evmRead` fail-fast and `confirm:false`
  path untouched.
- **Gates (implementer-report, tri-signal verified):** protocol tests 157/157, shared build pass.
- **Commits:** `ea73ccc`.
- **PR:** https://github.com/Joera/S2S-monorepo/pull/66 (OPEN, MERGEABLE). Independent review
  APPROVE-WITH-NOTES, 0 blocking (N1 fake-timer backoff test, N2 catch breadth, N3 log lexicon; all
  cosmetic). **Pending deploy caveat (recorded, out of scope):** must rebuild + re-pin/re-register the
  `lit_action_update` bundle on-chain for this to take effect in the running app.
