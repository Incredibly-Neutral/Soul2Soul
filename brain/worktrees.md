## 2026-10-09 — T4a shared per-CID retrievability core (orchestrated) — MERGED #120 (main 02ceb8a)

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
| 2026-10-09 | MERGED #120 | /home/joera/code/worktrees/t4-retriev (removed) | agent/t4-retriev | impl-t4-retriev | deepseek-v4-flash-0731 | shared/src/cid-view/retrievability.ts — transport-agnostic per-CID copy/retrievability core: RETRIEVABILITY_SOURCES (kubo/pinata/filebase/filecoin), CidRetrievabilityStatus {checkedAt, copies, sources, error?}, RetrievabilityReadContext {hasCopy}, cidsFromView, filecoinBackedCidsFromView (deal+deal-version only), checkCidRetrievability (fail-open per source, capped concurrency, clone-merge into prev), orderByCopiesAscending + orderByStaleness (never-checked-first, stable); zod schemas + parseCidRetrievabilityMap in validation.ts; index.ts export. Reviewer rev-t4-retriev APPROVE (0 blocking; 3 non-blocking: now?() clock override is additive+matching BuildCidViewOptions.now; input dedupe additive+documented; no .strict() matches file style). Lead independently verified all 3 gates. Post-merge gate on 02ceb8a: shared build 0, cid-view subset 93/93 (16 new). wt/branch/remote deleted + panes closed 2026-10-09. Single-model review limitation (pi-only) flagged per AGENTS.md.

## 2026-10-09 — T2 incremental cid-view composition (orchestrated) — MERGED #115 #116 (main 74dd4e0)

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
| 2026-10-09 | MERGED #115 | /home/joera/code/worktrees/t2-layers | agent/t2-layers | impl-t2-layers | deepseek-v4-flash-0731 | extract+export readSiteRoot/readArchiveRoot (tree.ts) + readConfigRoot (config.ts) fail-open root-read helpers; collectors refactored to use them (behavior-preserving) |
| 2026-10-09 | MERGED #116 | /home/joera/code/worktrees/t2-coord | agent/t2-coord | impl-t2-coord | deepseek-v4-flash-0731 | CidViewMeta + schema-optional meta + incremental composition in coordinator (buildPublicationCidView ctx,pub,{prev}) |
| 2026-10-09 | lead (trivial dedupe) | main direct | main | pi | deepseek-v4-flash-0731 | coordinator adopts readSiteRoot/readArchiveRoot/readConfigRoot (inline root-read dedupe) — commit 74dd4e0 |

T2 commits: `d5427a5` (layers: root-read helper extraction, 13 new tests) → PR #115 `0abd965`; `613bf6c` (coord: meta + incremental) + `61bbc79` (round-2 fix: retain revoked-genesis history across arbitrary incremental hops) → PR #116 `e8f3976`. Reviewer `rev-t2-layers` APPROVE (3 non-blocking); `rev-t2-coord` REQUEST_CHANGES round-1 (2 findings: revoked-history 1-refresh-deep = BLOCKING, fixed via DealCidSnapshot.genesisKind + prev.versions-keyed revoked branch; archive-shadow corner NOT self-correcting, documented) → round-2 APPROVE (revert-and-run confirmed 3 new tests genuinely guard the fix). Lead verified all gates independently (shared build, cid-view vitest, eslint 6 files, prettier, tsc) + empirical 3-hop revocation scratch. Post-merge main gates: shared build 0, safe-app build 0 (unit suite stable 319; browser-component count varies with user's uncommitted records-tab test edit — NOT a cid-view regression). Worktrees/panes/branches cleaned. Single-model review limitation (pi-only) flagged per AGENTS.md.

## 2026-10-09 — T3 safe-app SWR cache wiring (orchestrated) — MERGED #117 (main 877abc5)

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
| 2026-10-09 | MERGED #117 | /home/joera/code/worktrees/t3-cache (removed) | agent/t3-cache | impl-t3-cache | deepseek-v4-flash-0731 | safe-app s2s-cid-view-section: auto-revalidate passes cached view as `prev` (incremental diff via T2 coordinator; coordinator self-degrades when prev.meta.complete!==true); Refresh button → rebuild(true) forces cold; (incremental)/(cold) log label; 5 new component tests (meta round-trip through SWR payload, prev passed on incremental, no prev on cold, Refresh forces cold, complete:false self-degrade). Reviewer rev-t3-cache APPROVE (2 non-blocking cosmetic: log label reflects request not coordinator path). Lead independently verified: src diff exact-per-spec, 17/17 component tests, zero NEW eslint (12 pre-existing on untouched lines, confirmed same rules at shifted line numbers), test-file lint-from-root excluded by infra, 2 records-tab failures on clean main = pre-existing committed-test debt masked by user's dirty checkout. |

T3 commit: `ea98e0a` → PR #117 `457bb0e`. Post-merge gate on 877abc5 (user's own merge of a0736e4 styles + #117, pushed): shared build 0, safe-app tsc/vite/sass all 0; tests 322/325 — the 3 failures are all in s2s-cid-view-section.test.ts and are CAUSED BY USER'S a0736e4 (removed `${view.publication}` span from CID header; 3 pre-existing tests assert the publication text renders). T3's 5 new tests all pass; the 2 pre-existing records-tab failures are GONE (user's styles commit removed those tests). NOT a T3 regression — awaiting user's decision on the 3 tests (update tests to drop publication assertion, or restore the span). Remote+local agent/t3-cache deleted, worktree removed, panes closed 2026-10-09. Single-model review limitation (pi-only) flagged per AGENTS.md.

## 2026-10-08 — safe-app hide unused 'feed' record from records tab (PR #99 open, awaiting human merge)

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
| 2026-10-08 | lead (direct, mechanical) | /home/joera/code/s2s-safeapp-records-feed | fix/records-tab-hide-feed | pi | deepseek-v4-flash-0731 | hide legacy `feed` on-chain record from records table (PR #98 already shipped the alias UI) |

Feature commit: `550be07` (filter `feed` out of `filteredRecords` via `HIDDEN_RECORD_KEYS` + new test asserting exclusion from count+rows). Gates: type-check 0; vitest 34/34 files, 286/286; QA 7/7 PASS (after copying gitignored root `.env` into the fresh worktree — QA failure without it was the missing `VITE_DRPC_API_KEY`, not a code regression). PR: https://github.com/Joera/S2S-monorepo/pull/99 (single-model review limitation per AGENTS.md).

## 2026-10-08 — safe-app s2s-table title row + action buttons (orchestrated) — MERGED 4c5ccc3

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
| 2026-10-08 | MERGED | /home/joera/code/s2s-safeapp-table-title | feat/safeapp-table-title | pi | deepseek-v4-flash-0731 | move section-title+count into s2s-table, flex toolbar row (title left / filters right), sync button icon+name, revoke icon, copy-content-id icon-before-text CSS |

Feature commits: `2db4e60` (feature: title/countSuffix/titleAction on <s2s-table>, .table-toolbar row, Sync icon+name buttons, ph-x revoke, copy-content-id :host row-reverse flex, dead count state/refresh CSS removed) + `4c5ccc3` (review fix: border-top:none on in-toolbar .table-filters). Reviewer `rev-table-title` APPROVED (2 non-blocking: doubled-divider border-top — fixed; copy-content-id long-title overflow — declined, not a regression). In-scope tests 14/14; type-check 0; QA 7/7 PASS on merged main.

GOTCHAS:
- Shared workspace dep: fresh worktree needs `shared` built (`pnpm build` in shared/) before type-check/build — main had shared/dist prebuilt.
- Committed main was RED at a4d7b86: commit `4974860` removed `<h2>Soul2Soul Publication Editor</h2>` from s2s-app.ts but didn't update tests/components/s2s-app.test.ts:275 → 1 failing test on clean main (281 pass). Main checkout LOOKED green only because it had an uncommitted local edit removing that assertion. Lead fixed on main as `d603a08` (drop stale assertion, test-only).
- Main checkout had unrelated uncommitted style experiments (button-styles/filter-styles/table-styles + Azeret zip + the test assertion edit) from the font wave — stashed table-styles.ts to ff-merge, popped cleanly; NOT committed (user's in-progress work, left dirty).
- Merge was ff from a4d7b86; after merge HEAD = 4c5ccc3, then d603a08 (test fix). Post-merge: build 0 (282/282 tests), QA 7/7.
- Single-model review limitation (pi-only) — flagged per AGENTS.md.

# s2s worktree registry

Tracks active/orchestrated worktrees and their sub-agent sessions. Hybrid runs: orchestrator
dispatching to a builder sub-agent in its own worktree; human merges each PR.

Convention (2026-10-08): a task == one PR the human approves; subtasks are commits on
the feature branch that lead to that PR. After the human merges, orchestrator syncs local
main (`git fetch origin && git merge --ff-only origin/main`), removes the worktree, deletes
the branch, and marks this entry MERGED <sha> (see brain/agents.md → Merge & PR protocol).

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

## 2026-09-03 — feat/render-500-nonjson-harden

**Task:** Harden the PREVIEW branch of `runAction` in `shared/src/rendering/helpers.ts` — the
neutralpress render PREP stage fails with `SyntaxError: Unexpected token 'I', "Internal S"... is
not valid JSON` because `runAction()` does an unwrapped `await r.json()` on the Bun runner response.
When the runner returns HTTP 500 with a plain-text body (Hono default 'Internal Server Error'),
`r.json()` throws the raw SyntaxError (opaque, unactionable). Add an `AbortSignal.timeout(10000)`
on the fetch (mirroring the runner's 10s IPFS fetch timeout) and a defensive body read that wraps
non-JSON bodies in an actionable `Error('runner <status> returned non-JSON: <body>')`. Live branch
(else) untouched.

**Worktree:** `~/code/s2s-render-500-nonjson-harden` (branch `feat/render-500-nonjson-harden` from main `d1cbbf8`)

**Status:** committed f203f4f, pushed, PR #89 OPEN (https://github.com/Joera/S2S-monorepo/pull/89). Not merged.
- 2026-09-03 | session=self (DeepSeek V4 Flash 0731) | worktree=/home/joera/code/s2s-serverless-error-handling | branch=feat/serverless-error-handling | agent=builder(self) | model=deepseek-v4-flash-0731 | task=harden protocol/serverless/server.ts error handling (JSON on all error paths) + regression test | PR=https://github.com/Joera/S2S-monorepo/pull/88

## 2026-10-07 — safe-app test suite (orchestrated)

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
| 2026-10-07 | 9cc0c5a | /home/joera/code/s2s-tests-plumbing (MERGED, worktree removed) | feat/tests-plumbing | pi | deepseek-v4-flash-0731 | wave1: plumbing+build-cycle — vite6, 2-project vitest, e2e scaffold, helpers; rev-1 APPROVED; gate fix f1429fa
| 2026-10-07 | 5decef8 | /home/joera/code/s2s-tests-unit-lib (MERGED, worktree removed) | feat/tests-unit-lib | pi | deepseek-v4-flash-0731 | wave1: unit tests lib/utils/filecoin — 10 files/127 tests, rev-2 APPROVED, merged
| 2026-10-07 | 67cc64a | /home/joera/code/s2s-tests-unit-state (MERGED, worktree removed) | feat/tests-unit-state | pi | deepseek-v4-flash-0731 | wave1: unit tests state layer — 11 files/94 tests, rev-3 APPROVED, merged

## 2026-10-07 — safe-app s2s-table component (orchestrated)

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
| 2026-10-07 | MERGED 19c418b | /home/joera/code/s2s-safeapp-table (MERGED, worktree removed) | feat/safeapp-table | pi | deepseek-v4-flash-0731 | extract reusable s2s-table Lit component (sort/filter chrome) + migrate deals/storage tabs + prune dead tables.scss |

  Commits: c326893 (refactor), 19c418b (fix review findings: filterLabels override restores
  "Author" dropdown label; count converged pre-paint via willUpdate). Reviewer rev-table
  APPROVED (single-model pi reviewer — no cross-vendor available). Gate gotcha: QA fails on
  a fresh worktree because .env doesn't carry over → DRPC "default" key 403s → module
  detection fails → gated tabs disabled. Copy ../.env into the worktree and rebuild; then QA
  passes 8/8. Post-merge gate on main: build (222 tests) + QA all PASS. |
| 2026-10-07 | c7c3814 | /home/joera/code/s2s-tests-components-1 (MERGED, worktree removed) | feat/tests-components-1 | pi | deepseek-v4-flash-0731 | wave2: component tests shell+atoms+whitelist+storage; rev-4 APPROVED after <s2s-table> rewrite; merged c56110f |
| 2026-10-07 | 2bbd231 | /home/joera/code/s2s-tests-components-2 (MERGED, worktree removed) | feat/tests-components-2 | pi | deepseek-v4-flash-0731 | wave2: component tests records/deals/website-tree; rev-2 APPROVED; merged 1abc6f3 |
| 2026-10-07 | b84c493 | /home/joera/code/s2s-tests-e2e (MERGED, worktree removed) | feat/tests-e2e | pi | deepseek-v4-flash-0731 | wave2: playwright e2e specs; rev-3 APPROVED + blocker fix; merged e620a95 |

## 2026-10-07 — safe-app phosphor icon migration (orchestrated)

Migrate every icon in safe-app to Phosphor Icons (@phosphor-icons/webcomponents 2.1.5, already in the
workspace store) with one consistent scale: ICON_SIZE=16 standard / ICON_SIZE_LARGE=48 hero (empty
states, standalone tree file node), ICON_WEIGHT='regular'. Killed the 14/16/18/32px mishmash (inline
lucide SVGs in copy-*, noun-refresh `<img>`, unicode emoji ✓✗✏🗑📄📁↻⚠▲▼) and deleted the dead
noun-*.svg assets.

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
| 2026-10-07 | MERGED 5a2e42f | /home/joera/code/worktrees/s2s-icon-wt0 (MERGED, removed) | agent/icon-foundation | pi | deepseek-v4-flash-0731 | dep + src/components/icon.ts contract (12 ph-* registrations, ICON_SIZE/ICON_SIZE_LARGE/ICON_WEIGHT) + main.ts bootstrap + manifest app-icon.svg; rev-icon0 APPROVED; gate gotcha: fresh worktree needs shared/dist built + root .env copied for qa |
| 2026-10-07 | MERGED dcb698b | /home/joera/code/worktrees/s2s-icon-wt1 (MERGED, removed) | agent/icon-wt1 | pi | deepseek-v4-flash-0731 | copy-* atoms: ph-copy/ph-check/ph-arrow-square-out, dead svg CSS removed; rev-icon1 APPROVED (1 low info: copy-hash white-stroke inheritance note) |
| 2026-10-07 | MERGED 8b763b2 | /home/joera/code/worktrees/s2s-icon-wt2 (MERGED, removed) | agent/icon-wt2 | pi | deepseek-v4-flash-0731 | deals/storage: ph-arrow-clockwise x3, ph-trash, ph-x, .refresh-icon/.revoke-icon CSS removed; rev-icon2 APPROVED |
| 2026-10-07 | MERGED 5aecc65 | /home/joera/code/worktrees/s2s-icon-wt3 (MERGED, removed) | agent/icon-wt3 | pi | deepseek-v4-flash-0731 | records/whitelist: ph-check/ph-x/ph-pencil-simple/ph-trash/ph-file-text(48 hero); rev-icon3 APPROVED (inline-flex on .button.thin) |
| 2026-10-07 | MERGED f320e3d | /home/joera/code/worktrees/s2s-icon-wt4 (MERGED, removed) | agent/icon-wt4 | pi | deepseek-v4-flash-0731 | website-tree/table/app/sort: ph-folder/ph-file-text/ph-trash/ph-arrow-clockwise/ph-warning; sortIndicator now returns ph-caret-up/down (+ test updated); rev-icon4 APPROVED |

  Lead cleanup 1effa39: git-rm'd 13 unused public/icons/noun-*.svg (only app-icon.svg remains, referenced
  by manifest.json). Final gate on main: build exit 0 (235 tests pass incl. concurrent wave-2 component
  tests from the other track), QA all PASS, bundle greps hit ph-copy/ph-arrow-clockwise/ph-caret-up.
  Cross-vendor review NOT possible (only pi installed) — all reviews single-model pi, flagged.
  Note: main advanced concurrently (wave-2 test commits b84c493/1abc6f3/e620a95 interleaved); my
  merges integrated cleanly, no conflicts.

## 2026-10-08 — shared cid-view: publication CID inventory (orchestrated)

Goal: shared method `buildPublicationCidView` producing the list of ALL CIDs a publication uses (deals+prev versions, publication config templates/assets, L2 ENS site tree + archive/cache JSON) → basis for later IPFS copy monitoring/cleanup. Stages are dependency-sequenced; only stage 2 (collectors) is parallel.

| date | session | worktree | branch | agent | model | task |
|---|---|---|---|---|---|---|
$0
| 2026-10-08 | 4d5a351 | /home/joera/code/worktrees/cidview-2 (stage 2a) | agent/cidview-2 | pi | deepseek-v4-flash-0731 | deals collector: deal/offer/version CIDs + tests; rev-2 APPROVE |
| 2026-10-08 | 87a0050 | /home/joera/code/worktrees/cidview-3 (stage 2b) | agent/cidview-3 | pi | deepseek-v4-flash-0731 | config collector: config/templateDAG/templates/assets CIDs + tests; rev-3 APPROVE |
| 2026-10-08 | c0a50a9 | /home/joera/code/worktrees/cidview-4 (stage 2c) | agent/cidview-4 | pi | deepseek-v4-flash-0731 | tree+archive collectors: site tree + content_cache CIDs + tests; rev-4 APPROVE |
| 2026-10-08 | 7ada982 | /home/joera/code/worktrees/cidview-5 (stage 3) | agent/cidview-5 | pi | deepseek-v4-flash-0731 | coordinator: buildPublicationCidView + zod validation + adapter factory + tests; rev-5 APPROVE; PR #104 (MERGED); stuck impl-5 restarted as impl-5b |
| 2026-10-08 | eacf227 | /home/joera/code/worktrees/cidview-6 (stage 4) | agent/cidview-6 | pi | deepseek-v4-flash-0731 | safe-app CID-inventory section in Storage tab (real adapter + read-only UI); Filecoin tables kept for comparison; rev-6 APPROVE; PR #106 MERGED; wt/branch/remote deleted 2026-10-08 |
| 2026-10-08 | 8e15ee8+71c495a | /home/joera/code/worktrees/cidview-instr | agent/cidview-instr | pi | deepseek-v4-flash-0731 | instrument adapter phases with [cid-view] timing logs + SLOW warn; add missing 30s cat timeout; rev1 REQUEST_CHANGES (lint/prettier/comment) -> rev2 APPROVE; PR #108 MERGED; wt/branch/remote deleted 2026-10-08 |
| 2026-10-08 | 3ca6171+7e32307 | /home/joera/code/worktrees/cidview-cache | agent/cidview-cache | pi | deepseek-v4-flash-0731 | localStorage SWR cache for CID inventory (s2s.cidview.<pub>), house-schema validation, staleness hint + ticker, rebuild timing logs; rev1 REQUEST_CHANGES (schema/lint/test-type/prettier) -> rev2 APPROVE; PR #109 MERGED; wt/branch/remote deleted 2026-10-08 |
| 2026-10-08 | 775c352+fffc88f+182bfad (+fix 8d65b90+3fe1752) | /home/joera/code/worktrees/cidview-diff (stage 1 perf) | agent/cidview-diff | pi | deepseek-v4-flash-0731 | parallel version reads (bounded 8, deterministic) + incremental version-diff primitives (DealCidSnapshot/deriveDealCidSnapshot/dealFingerprint/collectDealCidsIncremental; fingerprint fast-path → 0 version calls; per-genesis count+tail diff; count-0 guard; revoked-history retention; fail-open). rev-diff R1 REQUEST_CHANGES (6: HIGH complete:false unreachable via fail-open adapter — getDeals/getOffers rethrow + n===0-for-live-genesis guard; MED dedupe keep-last so current-version note survives; LOW same-block same-cid fp corner doc'd; LOW truncation guard → complete:false; LOW revoked no current-note; NIT range count param) → R2 APPROVE (2 non-blocking nits). PR #112 MERGED b35cfdb (squash). Gate on main: shared cid-view 52/52, safe-app 321/321, pnpm build exit 0. wt/branch/remote deleted 2026-10-08. NOTE: impl-diff reached 'done' 3× without committing — lead committed/verified gates each time.

## 2026-10-10 — filecoin false-positive fix (PR #124)
- Worktree: `/home/joera/code/wt-filecoin-fp` on branch `fix/filecoin-false-positive` (from main `dd4ec1b`).
- Commit `51c6ed5`: kill the s2s-deal→filecoin hybrid; filecoin = serving boost/lotus/venus/fvm/spade provider only.
- Reviewer: rev-filecoin-fp (pi, pane wJ:p16) → APPROVE; verdict archived `brain/reviews/2026-10-10-filecoin-fp-APPROVE.txt`.
- PR #124 open for user merge. Post-merge gate + worktree/cleanup TODO after user merges.
- Pane wJ:p16 closed; agent rev-filecoin-fp released.

## 2026-10-10 — config mirror to Filebase + Pinata (PR #125) — MERGED + CLEANED
- Worktree `/home/joera/code/wt-config-mirror`, branch `fix/config-mirror-filebase-pinata`, commit `97939db`.
- ConfigBuilder.buildConfig now also fires-and-forget mirrors to Filebase + Pinata (kubo stays awaited primary); content-addressed CID premise verified (identical CIDs across kubo/filebase/pinata).
- Lead-done directly (small single-file change, flagged deviation); PR #125 user rebase-merged as `8f9cf13`.
- **CLEANUP DONE 2026-10-10:** worktree removed, local+remote branch deleted (tree verified identical to merged commit).

## 2026-10-10 — filecoin false-positive fix (PR #124) — MERGED + CLEANED
- Worktree `/home/joera/code/wt-filecoin-fp`, branch `fix/filecoin-false-positive`, commit `51c6ed5`.
- PR #124 user rebase-merged as `d8ebb9f`. Verdict archived `brain/reviews/2026-10-10-filecoin-fp-APPROVE.txt`.
- **CLEANUP DONE 2026-10-10:** worktree removed, local+remote branch deleted (only tree delta vs merged = user's own ipfs-check/docker-compose.yaml).

## 2026-10-10 — shared retrievability parser (PR #126) — OPEN
- Goal: pure module `shared/src/cid-view/retrieval-parser.ts` — ipfs-check `/batch` NDJSON → per-CID verdict (kubo/pinata/filebase/filecoin flags, copies, provider totals) + category aggregates + actionable lists; single source of truth to replace safe-app's inline classifier (wiring = follow-up).
- Classifier (empirically validated): served = Bitswap.Found || HTTP.Found; kubo by agent; pinata/filebase by host; filecoin by Addr-host ↔ Synapse SP map (`curio.akave.xyz`, `main.ezpdpz.net`, `main2.ezpdpz.net`, `foc.dealbot.site`, `pdp-main.topblocks.io`, `pdp.lotus.dedyn.io`) or agent `boost|lotus|venus|fvm|spade`; per-platform flag once per CID.
- Worktree: `/home/joera/code/wt-parser` on branch `feat/cid-retrieval-parser` (rebased onto origin/main `c5b5d51`). Commits: `1fe0251` feat + `1be47b0` fix (malformed provider robustness).
- Worker: impl-parser (pi, pane wJ:p17); reviewer: rev-parser (pi, pane wJ:p18) R1 REQUEST_CHANGES (1 blocking: `result:[null]` crashed whole batch parse — fixed, 2 new tests) → R2 APPROVE (independent reproduction). Verdict archived `brain/reviews/2026-10-10-parser-APPROVE.txt`. Panes closed.
- Gate: shared retrieval-parser 29/29, eslint 0, build green. Single-model limitation (only pi) flagged.
- **PR #126 open** for user merge. After merge: remove `wt-parser` + branch + remote, then wire safe-app `statusFromCheckLine` to the shared parser (follow-up).

## 2026-10-10 — CID table Type column (PR #127) — OPEN
- Short intermezzo: collapse the CID inventory table's Category + Source columns into one **Type** column.
- Mapping (done directly by lead — small single-component change, flagged deviation): deal→source, deal-version→version, config/template-dag/template→config, assets-root/asset→asset, site-root/site-file→html, archive→cache, offer→offer, offer-version→offer version, archive-item→cache item. Badge keeps category color class; exact category in `title`.
- Worktree `/home/joera/code/wt-cidtype`, branch `feat/cid-type-column`, commit `9279cbe`. Base origin/main `c3b6edb` (includes #126 parser).
- Gate (lead-verified): full `pnpm -C safe-app test` 37/37 files, 353/353 pass; component lint 9 (baseline 11, zero new — removed dead categoryClass); type-check:tests 79 pre-existing, zero new.
- **PR #127 open** for user merge. After merge: remove `wt-cidtype` + branch + remote.
### 2026-10-10 update — chips become filter buttons (PR #127)
- Follow-up commit `264d3c0` on the same branch (one coherent feature): chips now use the Type classification and become table filters.
- Layout: one `.chips-row`, two containers — container 1 = counters + Type chips; container 2 = copies-count + health chips (healthy/need healing/no copies) + source flags. Same pill design; `.active` state + "× clear filters".
- Filters AND-combine type/copies/health; reset on view change. Counts from the same unique-cid rows the table renders. Unchecked rows excluded from copies/health filters.
- Gate (lead-verified): full safe-app 37/37 files, 355/355 pass (2 new filter tests); component lint 7 (zero new, down from 9 baseline); type-check:tests 79 pre-existing.
- PR #127 body updated to cover both commits. After user merge: remove `wt-cidtype` + branch.
### 2026-10-10 — filter chips re-packaged as PR #128 (originally #127)
- **Root cause discovered**: user merged PR #127 at 15:56 with head `9279cbe` (Type column ONLY). The filter-chips commit `264d3c0` was pushed after the merge → orphaned on the merged branch, never entered the merge → deployed bundle had Type column but no filter chips ("no changes").
- Re-packaged: worktree `/home/joera/code/wt-filterchips`, branch `feat/cid-filter-chips` from origin/main `7ab20e7`, cherry-picked `264d3c0` (clean — same tree) → commit `2c08a1f`. Gate green (355/355, lint 7 zero-new). **PR #128 opened**.
- `wt-cidtype` + `feat/cid-type-column` cleanup due (branch merged, Type column live).
### 2026-10-10 — PR #128 layout rework (commit `16ce594`)
- New `.chips-top` full-width row above the chips row: unique-CIDs counter + × clear filters (only when a filter is active).
- `.chips-row` no longer wraps; `.chips-group` containers get `flex: 1` (two equal columns).
- `button.chip` explicit `font-size: .75rem` + `text-transform: none`.
- Removed per-source availability chips (`.flag-on`/`.flag-off` + markup + CSS) — source still visible via Type badges + retrievability columns.
- Tests: dropped deals/config/tree/archive ✓/✗ assertions; added `.chips-top` assertions (unique CIDs present, no clear-filters when idle). Gate: 37/37, 355/355; lint 7 zero-new.
