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
