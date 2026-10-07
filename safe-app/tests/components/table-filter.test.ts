import { describe, it, expect, vi } from 'vitest';
import type { TableFilter } from '../../src/components/table-filter';
import { mountLit } from '../helpers/mount';
import '../../src/components/table-filter';

describe('table-filter', () => {

  it('renders the label and an All option plus one option per supplied value', async () => {
    const el = await mountLit<TableFilter>('table-filter', {
      label: 'Kind',
      options: ['file', 'folder', 'archive'],
    });
    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.getAttribute('aria-label')).toBe('Kind');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'file', 'folder', 'archive']);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'All',
      'file',
      'folder',
      'archive',
    ]);
  });

  it('reflects the value property and marks the matching option selected', async () => {
    const el = await mountLit<TableFilter>('table-filter', {
      label: 'State',
      options: ['Active', 'Terminated'],
      value: 'Terminated',
    });
    expect(el.getAttribute('value')).toBe('Terminated');
    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('Terminated');
  });

  it('emits a composed change event with detail.value when the user picks an option', async () => {
    const el = await mountLit<TableFilter>('table-filter', {
      label: 'Kind',
      options: ['file', 'folder'],
    });
    const onChange = vi.fn();
    el.addEventListener('change', onChange);

    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    select.value = 'folder';
    select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await el.updateComplete;

    expect(el.value).toBe('folder');
    // The component re-dispatches its own composed CustomEvent after the native
    // select change; take the last one carrying the component's detail.
    const evt = onChange.mock.calls.map((c) => c[0]).find((e) => e.detail?.value === 'folder');
    expect(evt).toBeTruthy();
    expect(evt.detail.value).toBe('folder');
    expect(evt.bubbles).toBe(true);
    expect(evt.composed).toBe(true);
  });

  it('returns to All (empty string) when the placeholder is selected', async () => {
    const el = await mountLit<TableFilter>('table-filter', {
      label: 'Kind',
      options: ['file'],
      value: 'file',
    });
    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await el.updateComplete;
    expect(el.value).toBe('');
  });
});
