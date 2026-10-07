// Shared sort helpers for the safe-app tables (deals / offers / storage).
//
// Sorting is a pure display concern: `sortRows` / `sortByColumn` always return
// a NEW sorted copy and never mutate the input, so the store stays the source
// of truth and row actions (accept/retract/delete/terminate) keep targeting the
// correct rows.

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  dir: SortDirection;
}

export interface TableColumn<T> {
  /** Stable key used to identify the column in sort state and data-sort attrs. */
  key: string;
  /** Header label. */
  label: string;
  /** Optional extra classes for the header element (e.g. hide-sm). */
  cls?: string;
  /** Extract the comparable value from a row. */
  get: (row: T) => unknown;
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function isEmpty(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/**
 * Type-aware comparison:
 *  - numbers compare numerically
 *  - bigints compare numerically
 *  - Dates compare by time
 *  - booleans compare false < true
 *  - everything else compares as strings with locale-aware numeric collation
 * Empty/null/undefined values always sort last.
 */
export function compareValues(a: unknown, b: unknown): number {
  const aEmpty = isEmpty(a);
  const bEmpty = isEmpty(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * Toggle sort for a column key: first click asc, second click desc,
 * clicking a different column resets to asc.
 */
export function toggleSort(current: SortState | null, key: string): SortState {
  return current?.key === key
    ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' };
}

/**
 * Return a new sorted copy of rows. Never mutates the input, so the store
 * stays the source of truth and row actions keep targeting the right rows.
 */
export function sortRows<T>(
  rows: readonly T[],
  getValue: (row: T) => unknown,
  sort: SortState | null,
): T[] {
  if (!sort) return [...rows];
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((x, y) => dir * compareValues(getValue(x), getValue(y)));
}

/** Sort rows by a named column config (no-op copy when the key is unknown). */
export function sortByColumn<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  sort: SortState | null,
): T[] {
  if (!sort) return [...rows];
  const col = columns.find((c) => c.key === sort.key);
  return col ? sortRows(rows, col.get, sort) : [...rows];
}

/** Sort indicator (ph-* element tag name) for the active sort column, '' otherwise. */
export function sortIndicator(sort: SortState | null, key: string): string {
  return sort?.key === key ? (sort.dir === 'asc' ? 'ph-caret-up' : 'ph-caret-down') : '';
}

/** Render a clickable sortable header button for a column. */
export function renderSortableHeader<T>(col: TableColumn<T>, sort: SortState | null): string {
  const caret = sortIndicator(sort, col.key);
  // Sort caret is a phosphor ph-* element; size/weight mirror the icon
  // foundation's ICON_SIZE / ICON_WEIGHT without importing icon.js here, so
  // this pure utility stays side-effect free for node unit tests.
  const indicator = caret ? `<${caret} size="16" weight="regular"></${caret}>` : '';
  return `
    <button class="table-header sortable${col.cls ? ' ' + col.cls : ''}" data-sort="${col.key}" title="Sort by ${col.label}">
      <span>${col.label}</span>
      <span class="sort-indicator">${indicator}</span>
    </button>`;
}
