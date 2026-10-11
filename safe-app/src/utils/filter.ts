// Shared filter helpers for the safe-app tables (deals / offers / storage).
//
// Filtering is a pure display concern: `filterRows` / `filterByColumn` always
// return a NEW filtered copy and never mutate the input, so the store stays
// the source of truth and row actions (accept/retract/delete/terminate) keep
// targeting the correct rows. The column `get` extractors from the table
// column configs (see sort.ts) are reused so filter and sort agree on values.

import { compareValues, type TableColumn } from './sort.js';

/**
 * Filter state: a map of column key -> selected option value.
 * An absent key or an empty string means "All" (no filter for that column).
 */
export type FilterState = Record<string, string>;

/** True when a filter is active for the given column key. */
export function isFilterActive(filters: FilterState, key: string): boolean {
  return Boolean(filters[key]);
}

/**
 * Return a new filtered copy of rows whose column value equals `value`.
 * An empty `value` (All) returns a copy of the input unchanged.
 * Never mutates the input, so the store stays the source of truth.
 */
export function filterRows<T>(
  rows: readonly T[],
  getValue: (row: T) => unknown,
  value: string,
): T[] {
  if (!value) return [...rows];
  return rows.filter((row) => String(getValue(row) ?? '') === value);
}

/**
 * Apply a set of filters to rows using named column configs. Each active
 * filter narrows the result (AND semantics). Returns a NEW array and never
 * mutates the input; unknown keys are ignored.
 */
export function filterByColumn<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  filters: FilterState,
): T[] {
  let result = [...rows];
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    const col = columns.find((c) => c.key === key);
    if (col) result = filterRows(result, col.get, value);
  }
  return result;
}

/**
 * Return a NEW filter state with `key` set to `value`. An empty `value`
 * (All) removes the key. Never mutates the input, so the store stays the
 * source of truth and the host can keep owning its FilterState while the
 * <s2s-table> component reports `filter` events.
 */
export function setFilter(filters: FilterState, key: string, value: string): FilterState {
  const next = { ...filters };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

/**
 * Unique, sorted option values present in the rows for a column extractor.
 * Empty/null/undefined values are excluded (they would only match "All").
 */
export function uniqueValues<T>(
  rows: readonly T[],
  getValue: (row: T) => unknown,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const v = getValue(row);
    const s = v == null || v === '' ? '' : String(v);
    if (s !== '') seen.add(s);
  }
  return [...seen].sort(compareValues);
}

/** Unique option values for a named column config (reuses the column `get`). */
export function uniqueValuesForColumn<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  key: string,
): string[] {
  const col = columns.find((c) => c.key === key);
  return col ? uniqueValues(rows, col.get) : [];
}

// ---------------------------------------------------------------------------
// Chips filter mode (multi-select pill chips with counts) for <s2s-table>.
//
// A chips filter is a set of groups; within a group the active values are OR'd
// (a row passes if it matches ANY active value), and across groups they are
// AND'd (a row must pass every group that has active values) — the chips filter
// also ANDs with any single-value dropdown `filters`. Chip counts are meant to
// be computed over the FULL (unfiltered) rows so they stay stable while the
// host filters, so the helpers below always take the row set they should count
// over explicitly and never touch component state.

/**
 * A chips filter group: either column-backed (`get`, chips derive from the
 * distinct extracted values) or a custom bucket predicate (`matches`, e.g.
 * health buckets over a copies count). When `matches` is used the chip
 * `values` must be listed explicitly.
 */
export interface ChipsGroup<T> {
  /** Stable key, also used in the chips filter state (`chips[key]`). */
  key: string;
  /** Column-backed values: extract the value(s) from a row; counts + chips derive from distinct values. */
  get?: (row: T) => string | readonly string[];
  /** Custom membership predicate — use instead of `get` when chips are buckets. */
  matches?: (row: T, value: string) => boolean;
  /** Explicit chip values (required when `matches` is used; optional otherwise). */
  values?: readonly { value: string; label?: string }[];
}

/** True when a row matches a chip value (via `matches` or extracted `get` values). */
function chipMatchesValue<T>(group: ChipsGroup<T>, row: T, value: string): boolean {
  if (group.matches) return group.matches(row, value);
  const extracted = group.get ? group.get(row) : [];
  const list = Array.isArray(extracted) ? extracted : [extracted];
  return list.includes(value);
}

/**
 * Count rows (usually the FULL unfiltered set, so counts stay stable while
 * filtering) where a chip value matches: for `get`-based groups the extracted
 * value(s) include the value; for `matches`-based groups `matches(row, value)`.
 */
export function chipCount<T>(
  rows: readonly T[],
  group: ChipsGroup<T>,
  value: string,
): number {
  let n = 0;
  for (const row of rows) if (chipMatchesValue(group, row, value)) n++;
  return n;
}

/**
 * The chip values a group should render, derived over `rows`: the explicit
 * `values` when provided, otherwise the distinct values extracted by `get`
 * (sorted). Empty/null/undefined extracted values are excluded. Returns a NEW
 * array and never mutates the input.
 */
export function chipValuesForGroup<T>(
  rows: readonly T[],
  group: ChipsGroup<T>,
): Array<{ value: string; label?: string }> {
  if (group.values) return [...group.values];
  const seen = new Set<string>();
  for (const row of rows) {
    const extracted = group.get ? group.get(row) : [];
    const list = Array.isArray(extracted) ? extracted : [extracted];
    for (const v of list) {
      const s = v == null ? '' : String(v);
      if (s !== '') seen.add(s);
    }
  }
  return [...seen].sort(compareValues).map((value) => ({ value }));
}

/**
 * Return a NEW filtered copy of rows applying the active chips filter:
 * AND across groups, OR within a group. Groups with no active values are
 * ignored. Never mutates the input, so the store stays the source of truth.
 */
export function filterRowsByChips<T>(
  rows: readonly T[],
  chipsGroups: readonly ChipsGroup<T>[],
  chips: Record<string, string[]>,
): T[] {
  let result = [...rows];
  for (const group of chipsGroups) {
    const active = chips[group.key];
    if (!active || active.length === 0) continue;
    result = result.filter((row) =>
      active.some((value) => chipMatchesValue(group, row, value)),
    );
  }
  return result;
}
