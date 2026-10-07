import { describe, it, expect } from 'vitest';
import {
  compareValues,
  toggleSort,
  sortRows,
  sortByColumn,
  sortIndicator,
  renderSortableHeader,
  type TableColumn,
  type SortState,
} from '../../src/utils/sort';

interface Row {
  name: string;
  cost: number;
  ts: Date;
  flag: boolean;
  note?: string;
}

const columns: TableColumn<Row>[] = [
  { key: 'name', label: 'Name', get: (r) => r.name },
  { key: 'cost', label: 'Cost', get: (r) => r.cost },
  { key: 'ts', label: 'Date', get: (r) => r.ts },
  { key: 'flag', label: 'Flag', get: (r) => r.flag },
];

const rows: Row[] = [
  { name: 'beta', cost: 20, ts: new Date('2024-01-02T00:00:00Z'), flag: false },
  { name: 'alpha', cost: 10, ts: new Date('2024-01-01T00:00:00Z'), flag: true },
  { name: 'gamma', cost: 30, ts: new Date('2024-01-03T00:00:00Z'), flag: false },
];

describe('compareValues', () => {
  it('compares numbers numerically', () => {
    expect(compareValues(10, 20)).toBeLessThan(0);
    expect(compareValues(20, 10)).toBeGreaterThan(0);
    expect(compareValues(10, 10)).toBe(0);
  });

  it('compares bigints numerically', () => {
    expect(compareValues(1n, 2n)).toBeLessThan(0);
    expect(compareValues(2n, 1n)).toBeGreaterThan(0);
    expect(compareValues(5n, 5n)).toBe(0);
  });

  it('compares Dates by time', () => {
    const a = new Date('2024-01-01T00:00:00Z');
    const b = new Date('2024-01-02T00:00:00Z');
    expect(compareValues(a, b)).toBeLessThan(0);
    expect(compareValues(b, a)).toBeGreaterThan(0);
  });

  it('compares booleans false < true', () => {
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(true, false)).toBeGreaterThan(0);
  });

  it('compares strings with locale-aware numeric collation', () => {
    // numeric collation: item2 sorts before item10
    expect(compareValues('item2', 'item10')).toBeLessThan(0);
    expect(compareValues('apple', 'banana')).toBeLessThan(0);
  });

  it('sorts empty/null/undefined values last', () => {
    expect(compareValues('a', null)).toBeLessThan(0);
    expect(compareValues(null, 'a')).toBeGreaterThan(0);
    expect(compareValues(undefined, 'a')).toBeGreaterThan(0);
    expect(compareValues('', 'a')).toBeGreaterThan(0);
    expect(compareValues(null, null)).toBe(0);
    expect(compareValues(undefined, undefined)).toBe(0);
  });

  it('treats an empty array as empty (sorts last)', () => {
    expect(compareValues('a', [])).toBeLessThan(0);
  });
});

describe('toggleSort', () => {
  it('starts asc on a new column', () => {
    expect(toggleSort(null, 'cost')).toEqual({ key: 'cost', dir: 'asc' });
    expect(toggleSort({ key: 'name', dir: 'desc' }, 'cost')).toEqual({ key: 'cost', dir: 'asc' });
  });

  it('flips asc -> desc on the same column', () => {
    expect(toggleSort({ key: 'cost', dir: 'asc' }, 'cost')).toEqual({ key: 'cost', dir: 'desc' });
  });

  it('flips desc -> asc on the same column', () => {
    expect(toggleSort({ key: 'cost', dir: 'desc' }, 'cost')).toEqual({ key: 'cost', dir: 'asc' });
  });
});

describe('sortRows', () => {
  it('returns a copy unchanged when sort is null', () => {
    const out = sortRows(rows, (r) => r.cost, null);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it('sorts ascending by extractor', () => {
    const out = sortRows(rows, (r) => r.cost, { key: 'cost', dir: 'asc' });
    expect(out.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('sorts descending by extractor', () => {
    const out = sortRows(rows, (r) => r.cost, { key: 'cost', dir: 'desc' });
    expect(out.map((r) => r.name)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('never mutates the input', () => {
    const snapshot = JSON.stringify(rows.map((r) => ({ ...r, ts: r.ts.toISOString() })));
    sortRows(rows, (r) => r.cost, { key: 'cost', dir: 'desc' });
    expect(JSON.stringify(rows.map((r) => ({ ...r, ts: r.ts.toISOString() })))).toBe(snapshot);
  });
});

describe('sortByColumn', () => {
  it('sorts using the column get extractor', () => {
    const out = sortByColumn(rows, columns, { key: 'name', dir: 'asc' });
    expect(out.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('sorts dates via the column extractor', () => {
    const out = sortByColumn(rows, columns, { key: 'ts', dir: 'desc' });
    expect(out.map((r) => r.name)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('sorts booleans via the column extractor', () => {
    const out = sortByColumn(rows, columns, { key: 'flag', dir: 'desc' });
    expect(out.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns a copy unchanged for an unknown sort key', () => {
    const out = sortByColumn(rows, columns, { key: 'missing', dir: 'asc' });
    expect(out).toEqual(rows);
  });
});

describe('sortIndicator', () => {
  it('returns the glyph for the active column', () => {
    expect(sortIndicator({ key: 'cost', dir: 'asc' }, 'cost')).toBe('▲');
    expect(sortIndicator({ key: 'cost', dir: 'desc' }, 'cost')).toBe('▼');
  });

  it('returns empty for non-active columns or no sort', () => {
    expect(sortIndicator(null, 'cost')).toBe('');
    expect(sortIndicator({ key: 'name', dir: 'asc' }, 'cost')).toBe('');
  });
});

describe('renderSortableHeader', () => {
  const sort: SortState = { key: 'cost', dir: 'asc' };

  it('renders a sortable button with label, key and indicator', () => {
    const html = renderSortableHeader(columns[1], sort);
    expect(html).toContain('<button class="table-header sortable"');
    expect(html).toContain('data-sort="cost"');
    expect(html).toContain('title="Sort by Cost"');
    expect(html).toContain('>Cost</span>');
    expect(html).toContain('▲');
  });

  it('includes the column extra class when present', () => {
    const col: TableColumn<Row> = { key: 'x', label: 'X', cls: 'hide-sm', get: (r) => r.name };
    expect(renderSortableHeader(col, null)).toContain('table-header sortable hide-sm');
  });
});
