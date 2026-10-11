// s2s-table.test.ts — component (browser) tests for the reusable <s2s-table>,
// focused on the new chips filter mode (multi-select pill chips with counts)
// plus a dropdown-mode regression.
//
// <s2s-table> renders into LIGHT DOM (createRenderRoot() => this), so every
// query goes through `el.querySelector(...)` — there is no shadowRoot. Rows
// are asserted via the row renderer's `.table-row` elements (data-id).

import { describe, it, expect, vi } from 'vitest';
import { html } from 'lit';
import type { S2STable } from '../../src/components/s2s-table';
import type { ChipsGroup } from '../../src/utils/filter';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-table';

interface Row {
  id: string;
  kind: string;
  copies: number;
}

const ROWS: readonly Row[] = [
  { id: 'a', kind: 'file', copies: 2 },
  { id: 'b', kind: 'file', copies: 5 },
  { id: 'c', kind: 'folder', copies: 3 },
  { id: 'd', kind: 'folder', copies: 1 },
];

const columns = [
  { key: 'id', label: 'ID', get: (r: Row) => r.id },
  { key: 'kind', label: 'Kind', get: (r: Row) => r.kind },
  { key: 'copies', label: 'Copies', get: (r: Row) => r.copies },
];

const rowRenderer = (row: Row) =>
  html`<div class="table-row" data-id=${row.id}>${row.id}</div>`;

/** Column-backed chips group over the `kind` column (chips derive from rows). */
const kindGroup: ChipsGroup<Row> = { key: 'kind', get: (r) => r.kind };

/** Bucket-style (matches) group: healthy = copies >= 3, otherwise at-risk. */
const healthGroup: ChipsGroup<Row> = {
  key: 'health',
  matches: (r, v) => (v === 'healthy' ? r.copies >= 3 : r.copies < 3),
  values: [
    { value: 'healthy', label: 'Healthy' },
    { value: 'at-risk', label: 'At risk' },
  ],
};

function mountTable(props: Record<string, unknown> = {}) {
  return mountLit<S2STable<Row>>('s2s-table', {
    columns,
    rows: ROWS,
    rowRenderer,
    ...props,
  });
}

/** data-id of every rendered row, in DOM order. */
function rowIds(el: S2STable<Row>): string[] {
  return [...el.querySelectorAll('.table-row')].map((r) => r.getAttribute('data-id') ?? '');
}

describe('s2s-table chips mode', () => {
  it('renders one .chips-group per group; each chip shows a count + label computed over the full rows', async () => {
    const el = await mountTable({ chipsGroups: [kindGroup, healthGroup] });

    // One group per chipsGroup, each keyed by its stable key.
    const groups = el.querySelectorAll('.chips-group');
    expect(groups).toHaveLength(2);
    expect(el.querySelector('.chips-group[data-group="kind"]')).toBeTruthy();
    expect(el.querySelector('.chips-group[data-group="health"]')).toBeTruthy();

    // Column-backed group: chips derive from distinct kind values.
    const kindGroupEl = el.querySelector('.chips-group[data-group="kind"]')!;
    const kindChips = [...kindGroupEl.querySelectorAll('button.chip')];
    expect(kindChips.map((c) => c.getAttribute('data-value'))).toEqual(['file', 'folder']);
    // Count + label in the cid-view order: bold count then label text.
    expect(kindChips[0]!.querySelector('.chip-value')!.textContent).toBe('2'); // file
    expect(kindChips[0]!.textContent).toContain('file');
    expect(kindChips[1]!.querySelector('.chip-value')!.textContent).toBe('2'); // folder
    expect(kindChips[1]!.textContent).toContain('folder');

    // matches-based group: explicit values, counts via the predicate.
    const healthGroupEl = el.querySelector('.chips-group[data-group="health"]')!;
    const healthChips = [...healthGroupEl.querySelectorAll('button.chip')];
    const normalize = (s: string | null) => s?.replace(/\s+/g, ' ').trim() ?? '';
    expect(healthChips.map((c) => normalize(c.textContent))).toEqual(['2 Healthy', '2 At risk']);

    // No chipsTop provided -> no .chips-top row (and no clear-filters chip yet).
    expect(el.querySelector('.chips-top')).toBeNull();
    expect(el.querySelector('.chip.clear-filters')).toBeNull();
  });

  it('clicking a chip emits a composed chip-filter {key, values:[value]}; clicking again emits {key, values:[]}', async () => {
    const el = await mountTable({ chipsGroups: [kindGroup] });
    const events: Array<{ key: string; values: string[]; bubbles: boolean; composed: boolean }> = [];
    el.addEventListener('chip-filter', (e: Event) => {
      const evt = e as CustomEvent<{ key: string; values: string[] }>;
      // The HOST owns chips: it mirrors the event back into its own state, and
      // the component stays stateless (it never mutates `chips` itself).
      el.chips = { ...el.chips, [evt.detail.key]: evt.detail.values };
      events.push({ ...evt.detail, bubbles: evt.bubbles, composed: evt.composed });
    });

    const fileChip = el.querySelector<HTMLButtonElement>(
      '.chips-group[data-group="kind"] button.chip[data-value="file"]',
    )!;
    expect(fileChip.classList.contains('active')).toBe(false);

    fileChip.click();
    await el.updateComplete;
    expect(events[0]).toEqual({ key: 'kind', values: ['file'], bubbles: true, composed: true });
    expect(fileChip.classList.contains('active')).toBe(true);

    // Toggle off: the component derives active from the (host-updated) `chips`
    // property, so the second click emits the empty set.
    fileChip.click();
    await el.updateComplete;
    expect(events[1]).toEqual({ key: 'kind', values: [], bubbles: true, composed: true });
    expect(fileChip.classList.contains('active')).toBe(false);
  });

  it('ORs chip values within one group (multi-select)', async () => {
    const el = await mountTable({
      chipsGroups: [healthGroup],
      chips: { health: ['healthy', 'at-risk'] },
    });
    // Every row matches at least one active value in the group.
    expect(rowIds(el)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ANDs chips across groups and with dropdown filters; counts stay over the full rows', async () => {
    // AND across two chips groups: file AND at-risk -> a only.
    const el = await mountTable({
      chipsGroups: [kindGroup, healthGroup],
      chips: { kind: ['file'], health: ['at-risk'] },
    });
    expect(rowIds(el)).toEqual(['a']);

    // Chip counts stay computed over the FULL rows even while filtering, so
    // the filtered-out folder chip keeps its full count (c + d = 2).
    const folderChip = el.querySelector<HTMLButtonElement>(
      '.chips-group[data-group="kind"] button.chip[data-value="folder"]',
    )!;
    expect(folderChip.querySelector('.chip-value')!.textContent).toBe('2');

    // Chips AND a dropdown filter both narrow: file (dropdown) AND healthy.
    const el2 = await mountTable({
      chipsGroups: [healthGroup],
      filters: { kind: 'file' },
      chips: { health: ['healthy'] },
    });
    expect(rowIds(el2)).toEqual(['b']);
  });

  it('shows a clear-filters chip only when a group is active and emits chip-filter per active group with values:[]', async () => {
    const el = await mountTable({
      chipsGroups: [kindGroup, healthGroup],
      chips: { kind: ['file'], health: ['healthy'] },
    });
    expect(el.querySelector('.chip.clear-filters')).toBeTruthy();

    const events: Array<{ key: string; values: string[] }> = [];
    el.addEventListener('chip-filter', (e: Event) => {
      events.push((e as CustomEvent).detail);
    });

    (el.querySelector('.chip.clear-filters') as HTMLButtonElement).click();
    expect(events).toEqual([
      { key: 'kind', values: [] },
      { key: 'health', values: [] },
    ]);

    // No active chips -> no clear-filters chip.
    const el2 = await mountTable({ chipsGroups: [kindGroup, healthGroup] });
    expect(el2.querySelector('.chip.clear-filters')).toBeNull();
  });

  it('renders chipsTop above the chips row, and nothing when chipsGroups is empty', async () => {
    const el = await mountTable({
      chipsGroups: [kindGroup],
      chipsTop: html`<span class="chip"><span class="chip-value">4</span> unique</span>`,
    });
    const top = el.querySelector('.chips-top');
    expect(top).toBeTruthy();
    expect(top!.textContent).toContain('4 unique');
    // The top chips row sits directly above the chips row.
    expect(top!.nextElementSibling?.classList.contains('chips-row')).toBe(true);

    // chipsGroups empty -> no chips-top, no chips row at all.
    const el2 = await mountTable({ chipsTop: html`<span class="chip">5 unique</span>` });
    expect(el2.querySelector('.chips-top')).toBeNull();
    expect(el2.querySelector('.chips-row')).toBeNull();
  });

  it('sorts the chips-filtered rows', async () => {
    // healthy -> b(5), c(3); asc by copies -> c, b.
    const asc = await mountTable({
      chipsGroups: [healthGroup],
      chips: { health: ['healthy'] },
      sort: { key: 'copies', dir: 'asc' },
    });
    expect(rowIds(asc)).toEqual(['c', 'b']);

    const desc = await mountTable({
      chipsGroups: [healthGroup],
      chips: { health: ['healthy'] },
      sort: { key: 'copies', dir: 'desc' },
    });
    expect(rowIds(desc)).toEqual(['b', 'c']);
  });

  it('dropdown mode is unchanged: no chips row, filter events still fire (regression)', async () => {
    const el = await mountTable({ filterKeys: ['kind'] });
    expect(el.querySelector('.chips-row')).toBeNull();
    expect(el.querySelector('.chips-group')).toBeNull();

    // The dropdown filter chain still works end to end: table-filter 'change'
    // bubbles up and s2s-table re-emits `filter`.
    const tf = el.querySelector('table-filter[data-key="kind"]') as any;
    expect(tf).toBeTruthy();
    const filterSpy = vi.fn();
    el.addEventListener('filter', filterSpy);
    tf.dispatchEvent(
      new CustomEvent('change', { detail: { value: 'file' }, bubbles: true, composed: true }),
    );
    await el.updateComplete;
    const evt = filterSpy.mock.calls.map((c) => c[0]).find((e) => e.detail?.value === 'file');
    expect(evt).toBeTruthy();
    expect(evt.detail).toEqual({ key: 'kind', value: 'file' });
  });
});
