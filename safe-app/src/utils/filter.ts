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
