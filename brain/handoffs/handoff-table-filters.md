# Handoff: safe-app table filters (deals/offers/storage) + reusable filter component

> Per-task pick-up contract for the executing session. Consumed by the builder; superseded once the PR lands.

## Task

Add dropdown filters to the safe-app tables, built on the sortable-tables work (PR #55, merged `fdb4f9d`). Filters hide non-matching rows (Excel-like column filters). Also: create reusable components for everything re-usable, and follow the repo's CSS convention (reusable CSS in the style files, not inline in components).

## Worktree

- Worktree: `~/code/s2s-table-filters` (branch `feat/table-filters`, based on `main` @ `fdb4f9d`)
- Repo: `Joera/S2S-monorepo`; app root: `safe-app/`
- Gates (from `safe-app/`): `pnpm type-check` and `pnpm build` (tsc && vite build && pnpm sass) must pass.
- Deliverable: open a PR from `feat/table-filters` → `main`.

## Current structure (read these first)

- `safe-app/src/components/s2s-deals-tab.ts` — Offers + Deals tables. Per-column sort config `OFFER_COLUMNS` / `DEAL_COLUMNS` (Array<TableColumn<Deal>>) with `get` extractors; rows rendered as CSS-grid `.table`; sort state `offersSort` / `dealsSort`; `sortByColumn(store.offers/deals, COLUMNS, sort)`.
- `safe-app/src/components/s2s-storage-tab.ts` — Pieces + Data Sets tables. `PIECE_CO_COLUMNS` / `DATASET_COLUMNS`; sort state `piecesSort` / `datasetsSort`.
- `safe-app/src/utils/sort.ts` — shared pure sort helpers (`TableColumn`, `SortState`, `sortByColumn`, `toggleSort`, `renderSortableHeader`). **Mirror this pattern** for filters: pure helpers that return NEW arrays, never mutate the store.
- `safe-app/src/state/types.ts` — `Deal` (author, postType?, tags?, ...), `StoragePiece` (metadata: Record<string,string> → kind, scheduledForRemoval, ...), `PublicationDataSet` (pdpEndEpoch → state).
- `safe-app/src/styles/table-styles.ts` — shared CSSStyleSheet (`tableStyles`) adopted in shadow DOM. Also `button-styles.ts`, `section-styles.ts`, `typography-styles.ts`.
- `safe-app/src/styles/*.scss` — global SCSS (`main.scss` → `components.scss`, `tables.scss`, `variables.scss`), compiled by `pnpm sass` → `dist/main.css`, loaded via `<link>` in `index.html`.

## Requirements

### 1. Dropdown filters per table
- Offers table: filter by **Author** and **Post type** (dropdowns; selecting a value hides all rows except those matching).
- Deals table: filter by **Author** and **Post type**.
- Pieces table: filter by **Kind** (from `metadata.kind` — the "root cid kind" dimension).
- Data Sets table: filter by **State** (Active / Terminated, derived from `pdpEndEpoch`).
- Dropdown options derived from the unique values present in the rows, plus an "All" option to clear the filter.
- Filters combine with the existing sort (filter first, then sort). Filter state is per table.
- When a filter yields no rows, show the existing empty-state pattern (don't break the table).

### 2. Reusable components
- Create a reusable filter-dropdown custom element (e.g. `safe-app/src/components/table-filter.ts`, `<table-filter>`) used by both tabs — takes a label + options, emits a change event. Follow the existing custom-element + shadow-DOM pattern (`toggle-button.ts`, `copy-content-id.ts`).
- Add a shared pure filter helper (e.g. `safe-app/src/utils/filter.ts`) mirroring `sort.ts`: `filterRows<T>(rows, filters)` returning a new array, never mutating. Reuse the column `get` extractors where possible.

### 3. CSS convention (explicit user request)
- Reusable CSS must live in the **style files**, not inline in component render templates. The tabs currently carry large inline `<style>` blocks — do not add new reusable styles there.
- Put reusable filter/table styles in a style file (e.g. `styles/filter-styles.ts` CSSStyleSheet adopted by the filter component, and/or the `.scss` files as appropriate for where they're used).
- If any SCSS is added, it must compile via `pnpm sass` (part of the `build` gate).

### 4. Gates + PR
- `pnpm type-check` and `pnpm build` must pass from `safe-app/`.
- Open a PR from `feat/table-filters` → `main`; report the PR number and commit sha.

## Out of scope
- No changes to the store/state layer beyond what's needed to read data.
- No changes to sorting behavior.
- No changes to other tabs (records / whitelist / website-tree / app shell).
