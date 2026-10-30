import { describe, it, expect } from 'vitest';
import {
  isFilterActive,
  filterRows,
  filterByColumn,
  uniqueValues,
  uniqueValuesForColumn,
} from '../../src/utils/filter';
import type { TableColumn } from '../../src/utils/sort';

interface Row {
  id: number;
  status: string;
  author?: string;
  cost?: number;
}

const columns: TableColumn<Row>[] = [
  { key: 'status', label: 'Status', get: (r) => r.status },
  { key: 'author', label: 'Author', get: (r) => r.author },
  { key: 'cost', label: 'Cost', get: (r) => r.cost },
];

const rows: Row[] = [
  { id: 1, status: 'deal', author: 'alice', cost: 10 },
  { id: 2, status: 'offer', author: 'bob', cost: 20 },
  { id: 3, status: 'deal', author: 'alice', cost: 30 },
  { id: 4, status: 'retracted' },
];

describe('isFilterActive', () => {
  it('is false when the key is absent or empty', () => {
    expect(isFilterActive({}, 'status')).toBe(false);
    expect(isFilterActive({ status: '' }, 'status')).toBe(false);
    expect(isFilterActive({ author: 'alice' }, 'status')).toBe(false);
  });

  it('is true when the key has a non-empty value', () => {
    expect(isFilterActive({ status: 'deal' }, 'status')).toBe(true);
  });
});

describe('filterRows', () => {
  it('returns a new copy when no value (All)', () => {
    const out = filterRows(rows, (r) => r.status, '');
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it('keeps rows whose extracted value equals the filter value', () => {
    const out = filterRows(rows, (r) => r.status, 'deal');
    expect(out.map((r) => r.id)).toEqual([1, 3]);
  });

  it('compares stringified values (numbers match their string form)', () => {
    const out = filterRows(rows, (r) => r.cost, '20');
    expect(out.map((r) => r.id)).toEqual([2]);
  });

  it('never mutates the input', () => {
    const snapshot = JSON.stringify(rows);
    filterRows(rows, (r) => r.status, 'deal');
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe('filterByColumn', () => {
  it('applies active filters with AND semantics', () => {
    const out = filterByColumn(rows, columns, { status: 'deal', author: 'alice' });
    expect(out.map((r) => r.id)).toEqual([1, 3]);
  });

  it('ignores unknown column keys and empty values', () => {
    const out = filterByColumn(rows, columns, { nope: 'x', author: '' });
    expect(out).toEqual(rows);
  });

  it('returns a new array and never mutates the input', () => {
    const snapshot = JSON.stringify(rows);
    const out = filterByColumn(rows, columns, { status: 'deal' });
    expect(out).not.toBe(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it('matches null/undefined column values as the empty string (All only)', () => {
    const out = filterByColumn(rows, columns, { author: '' });
    expect(out).toEqual(rows);
  });
});

describe('uniqueValues', () => {
  it('returns sorted unique non-empty values', () => {
    expect(uniqueValues(rows, (r) => r.status)).toEqual(['deal', 'offer', 'retracted']);
  });

  it('excludes empty/null/undefined values', () => {
    // author is undefined for id 4 — excluded
    expect(uniqueValues(rows, (r) => r.author)).toEqual(['alice', 'bob']);
  });

  it('dedupes and sorts numerically-aware strings', () => {
    const vals = uniqueValues(rows, (r) => r.cost);
    // 10, 20, 30 with numeric collation
    expect(vals).toEqual(['10', '20', '30']);
  });
});

describe('uniqueValuesForColumn', () => {
  it('uses the column get extractor', () => {
    expect(uniqueValuesForColumn(rows, columns, 'status')).toEqual(['deal', 'offer', 'retracted']);
  });

  it('returns [] for an unknown column key', () => {
    expect(uniqueValuesForColumn(rows, columns, 'missing')).toEqual([]);
  });
});
