// s2s-table.ts — reusable sortable/filterable data table for the safe-app.
//
// Generic Lit element (<s2s-table>) that owns the sort+filter pipeline and the
// filter toolbar for the interactive tables (Offers/Deals, Pieces/Data Sets).
// Hosts supply plain rows, column configs, a row renderer, and the sort/filter
// state; they no longer compute filtered/sorted rows themselves.
//
// DESIGN NOTES
// - Renders into LIGHT DOM (createRenderRoot() => this) so the host tab's
//   shadow styles — the shared tableStyles/filterStyles plus per-row classes
//   such as .offer-actions / .state-badge / .cached — keep applying to the
//   rendered rows unchanged. No style migration is needed; `s2s-table` gets
//   `display:block` from table-styles.ts (the single source of table CSS).
// - The HOST owns SortState/FilterState plus the chips state (passed down as
//   properties); the component is stateless about sorting/filtering and
//   reports user intent via composed, bubbling CustomEvents:
//     * `sort`        -> detail { key }
//     * `filter`      -> detail { key, value }   ('' = All)
//     * `chip-filter` -> detail { key, values }  (toggle on/off; values: []
//                       from the clear-filters chip, per active group)
//     * `count`       -> detail { count }        (filtered row count; hosts
//                       render "N results" in titles without re-running the
//                       pipeline)
// - CHIPS MODE: when `chipsGroups` is non-empty a chips row (multi-select
//   pill chips with counts) renders above the table, alongside or instead of
//   the <table-filter> dropdowns. Active chips live in the host-owned `chips`
//   property (Record<groupKey, string[]>; empty/missing = none). Within a
//   group active values are OR'd; across groups they are AND'd with the
//   dropdown `filters`. Chip counts are computed over the FULL rows so they
//   stay stable while filtering. <s2s-table> never mutates `chips` itself —
//   it only emits `chip-filter` events. The chips CSS is injected into light
//   DOM (scoped to the host's shadow tree) so chips render styled inside
//   whatever host uses the table.
// - Pipeline order is filter-then-sort (filterByColumn -> sortByColumn), the
//   order the tabs used before this refactor.
// - `emptyText` non-empty renders the empty state when there are no rows;
//   `emptyText === ''` still renders the (header-only) table shell, preserving
//   the storage tab's zero-datasets case.
// - The trailing per-table "Actions" header cell is supported via
//   `actionsHeader` (render the cell), `actionsContent` (its markup) and
//   `actionsHeaderClass` (extra classes, e.g. hide-sm).
// - `revision`: opaque counter; bump it to force a re-render when the host's
//   transient per-row UI state (e.g. in-flight delete/terminate) changes
//   without the rows array itself changing.

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';
import {
  type SortState,
  type TableColumn,
  sortByColumn,
  sortIndicator,
} from '@/utils/sort.js';
import {
  type FilterState,
  type ChipsGroup,
  filterByColumn,
  uniqueValuesForColumn,
  chipCount,
  chipValuesForGroup,
  filterRowsByChips,
} from '@/utils/filter.js';
import { chipStyles } from '@/styles/chip-styles.js';
import './table-filter.js';
import './pet-name.js';
import { ICON_SIZE, ICON_SIZE_LARGE, ICON_WEIGHT } from '@/components/icon.js';

@customElement('s2s-table')
export class S2STable<T> extends LitElement {
  /** Column configs (sort keys, labels, value extractors). */
  @property({ attribute: false }) columns: readonly TableColumn<T>[] = [];

  /** Full, unfiltered rows from the host (the store stays the source of truth). */
  @property({ attribute: false }) rows: readonly T[] = [];

  /** Current sort state (owned by the host). */
  @property({ attribute: false }) sort: SortState | null = null;

  /** Current filter state (owned by the host). */
  @property({ attribute: false }) filters: FilterState = {};

  /** Column keys that get a <table-filter> dropdown in the toolbar. */
  @property({ attribute: false }) filterKeys: readonly string[] = [];

  /** Chips filter groups; when non-empty renders a chips row above the table
   *  (alongside or instead of the dropdown filters). */
  @property({ attribute: false }) chipsGroups: readonly ChipsGroup<T>[] = [];

  /** ACTIVE chip values per group key (host-owned, like SortState/FilterState).
   *  Empty array or missing key = no active chips for that group. Multiple
   *  values within one group = OR; across groups = AND (also AND with the
   *  dropdown `filters`). The component never mutates this — it only emits
   *  `chip-filter` events. */
  @property({ attribute: false }) chips: Record<string, string[]> = {};

  /** Optional markup rendered as the top chips row (e.g. a unique-CID counter
   *  chip). Rendered only when chipsGroups.length > 0. */
  @property({ attribute: false }) chipsTop: TemplateResult = html``;

  /** Renders one row's cells; receives (row, index). */
  @property({ attribute: false }) rowRenderer: (row: T, index: number) => TemplateResult =
    () => html``;

  /** Empty-state message. '' renders the header-only table shell instead. */
  @property({ type: String }) emptyText = 'No rows match the current filters';

  /** CSS grid-template-columns value for the .table grid. */
  @property({ type: String }) gridTemplate = '';

  /** Render the trailing "Actions" header cell after the columns. */
  @property({ type: Boolean }) actionsHeader = false;

  /** Extra classes for the actions header cell (e.g. 'hide-sm'). */
  @property({ type: String }) actionsHeaderClass = '';

  /** Content of the actions header cell (refresh button, 'Actions', ...). */
  @property({ attribute: false }) actionsContent: TemplateResult = html``;

  /** Section title rendered left of the toolbar; '' hides it. The count in
   *  the parens is this.filteredRows.length (filtered rows after the pipeline). */
  @property({ type: String }) title = '';

  /** Text appended after the count inside the parens (e.g. ' pieces'). */
  @property({ type: String }) countSuffix = '';

  /** Optional markup rendered as the LAST item in the toolbar row, after the
   *  filters (e.g. the sync/refresh button). */
  @property({ attribute: false }) titleAction: TemplateResult = html``;

  /** Opaque counter; bump to force a re-render (see header note). */
  @property({ type: Number }) revision = 0;

  /**
   * Optional label overrides for the <table-filter> dropdowns, keyed by column
   * key. Falls back to the column label. Used to keep the historical toolbar
   * labels (e.g. "Author" for the deals/offers author column, whose column
   * label is "Author (safe)") byte-identical to before the refactor.
   */
  @property({ attribute: false }) filterLabels: Record<string, string> = {};

  /** Renders into light DOM so host shadow styles reach the table. */
  createRenderRoot() {
    return this;
  }

  /** Rows after the filter+sort pipeline; computed once per update in willUpdate(). */
  private filteredRows: T[] = [];
  private lastEmittedCount = -1;

  /**
   * Compute the filtered/sorted rows and emit the filtered count to the host
   * HERE (start of the update cycle) rather than in updated(), so the host's
   * "N results" titles converge within the same pre-paint microtask flush the
   * component's own update runs in. Hosts still own SortState/FilterState; the
   * count event is just a convenience so they need not re-run the pipeline.
   */
  protected willUpdate(_changed: PropertyValues) {
    // Filter first, then sort — the order the tabs used before this refactor.
    // The chips filter (AND across groups, OR within a group) combines with the
    // single-value dropdown filters (AND) before sorting.
    this.filteredRows = sortByColumn(
      filterRowsByChips(
        filterByColumn(this.rows, this.columns, this.filters),
        this.chipsGroups,
        this.chips,
      ),
      this.columns,
      this.sort,
    );
    this.emitCountIfChanged();
  }

  private emitCountIfChanged() {
    if (this.filteredRows.length === this.lastEmittedCount) return;
    this.lastEmittedCount = this.filteredRows.length;
    this.dispatchEvent(
      new CustomEvent('count', {
        detail: { count: this.filteredRows.length },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleSort(key: string) {
    this.dispatchEvent(
      new CustomEvent('sort', { detail: { key }, bubbles: true, composed: true }),
    );
  }

  private handleFilter(key: string, e: CustomEvent) {
    const value = e.detail.value as string;
    this.dispatchEvent(
      new CustomEvent('filter', {
        detail: { key, value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Toggle a chip value in a group and report the NEW active set to the host
   *  (never mutate `chips` here — the host owns it). */
  private handleChip(key: string, value: string) {
    const active = this.chips[key] ?? [];
    const values = active.includes(value)
      ? active.filter((v) => v !== value)
      : [...active, value];
    this.dispatchEvent(
      new CustomEvent('chip-filter', {
        detail: { key, values },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Clear-filters chip: emit one `chip-filter` per active group, values: []. */
  private handleClearFilters() {
    for (const group of this.chipsGroups) {
      const active = this.chips[group.key];
      if (!active || active.length === 0) continue;
      this.dispatchEvent(
        new CustomEvent('chip-filter', {
          detail: { key: group.key, values: [] },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private sortableHeader(col: TableColumn<T>) {
    return html`
      <button
        class="table-header sortable${col.cls ? ' ' + col.cls : ''}"
        data-sort="${col.key}"
        title="Sort by ${col.label}"
        @click=${() => this.handleSort(col.key)}
      >
        <span>${col.label}</span>
        <span class="sort-indicator">${this.sortIndicatorElement(col.key)}</span>
      </button>
    `;
  }

  /** Render the sort caret ph element for the active column, '' otherwise. */
  private sortIndicatorElement(key: string) {
    const tag = sortIndicator(this.sort, key);
    // lit does not support dynamic tag-name bindings in `html` templates, so
    // use STATIC tags for each caret the util can return ('' = no active sort).
    if (tag === 'ph-caret-up') {
      return html`<ph-caret-up size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-caret-up>`;
    }
    if (tag === 'ph-caret-down') {
      return html`<ph-caret-down size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-caret-down>`;
    }
    return '';
  }

  /** True when a TemplateResult is the empty default (html``, no markup). */
  private isEmptyTemplate(t: TemplateResult): boolean {
    return t.strings.length === 1 && t.strings[0] === '' && t.values.length === 0;
  }

  /** Top chips row (e.g. a unique-CID counter chip); '' when not provided. */
  private renderChipsTop() {
    if (this.isEmptyTemplate(this.chipsTop)) return '';
    return html`<div class="chips-top">${this.chipsTop}</div>`;
  }

  /** One chips group: a toggle chip per value with count. */
  private renderChipsGroup(group: ChipsGroup<T>) {
    const active = this.chips[group.key] ?? [];
    return html`
      <div class="chips-group" data-group=${group.key}>
        ${chipValuesForGroup(this.rows, group).map(({ value, label }) => {
          const isActive = active.includes(value);
          return html`
            <button
              type="button"
              class="chip${isActive ? ' active' : ''}"
              data-group=${group.key}
              data-value=${value}
              @click=${() => this.handleChip(group.key, value)}
            >
              <span class="chip-value">${chipCount(this.rows, group, value)}</span>
              ${group.petName
                ? html`<pet-name value=${value} readonly></pet-name>`
                : (label ?? value)}
            </button>
          `;
        })}
      </div>
    `;
  }

  /**
   * The chips section: injects the shared chip CSS into light DOM (scoped to
   * the host's shadow tree), renders the optional chipsTop, then the chips
   * row with one group per chipsGroup plus a trailing clear-filters chip when
   * any group has active values.
   */
  private renderChipsRow() {
    const anyActive = this.chipsGroups.some(
      (group) => (this.chips[group.key]?.length ?? 0) > 0,
    );
    return html`
      <style>${chipStyles}</style>
      ${this.renderChipsTop()}
      <div class="chips-row">
        ${this.chipsGroups.map((group) => this.renderChipsGroup(group))}
        ${anyActive
          ? html`
              <button
                type="button"
                class="chip clear-filters"
                @click=${this.handleClearFilters}
              >
                clear filters
              </button>
            `
          : ''}
      </div>
    `;
  }

  render() {
    const rows = this.filteredRows;
    const showToolbar = Boolean(this.title) || this.filterKeys.length > 0;
    const showChips = this.chipsGroups.length > 0;

    return html`
      ${showToolbar
        ? html`
            <div class="table-toolbar">
              <div class="table-toolbar__title">
                ${this.title
                  ? html`<h2 class="section-title">${this.title} (${this.filteredRows.length}${this.countSuffix})</h2>`
                  : nothing}
              </div>
              ${this.filterKeys.length > 0
                ? html`
                    <div class="table-filters">
                      ${this.filterKeys.map((key) => {
                        const col = this.columns.find((c) => c.key === key);
                        if (!col) return nothing;
                        return html`
                          <table-filter
                            data-key=${key}
                            label=${this.filterLabels[key] ?? col.label}
                            .value=${this.filters[key] ?? ''}
                            .options=${uniqueValuesForColumn(this.rows, this.columns, key)}
                            @change=${(e: CustomEvent) => this.handleFilter(key, e)}
                          ></table-filter>
                        `;
                      })}
                    </div>
                  `
                : ''}
              ${this.titleAction}
            </div>
          `
        : ''}

      ${showChips ? this.renderChipsRow() : ''}

      ${rows.length > 0 || this.emptyText === ''
        ? html`
            <div
              class="table"
              style=${this.gridTemplate ? `grid-template-columns: ${this.gridTemplate};` : nothing}
            >
              ${this.columns.map((col) => this.sortableHeader(col))}
              ${this.actionsHeader
                ? html`
                    <div class="table-header${this.actionsHeaderClass ? ' ' + this.actionsHeaderClass : ''}">
                      ${this.actionsContent}
                    </div>
                  `
                : ''}
              ${rows.map((row, i) => this.rowRenderer(row, i))}
            </div>
          `
        : html`
            <div class="empty-state">
              <div class="empty-icon"><ph-file-text size="${ICON_SIZE_LARGE}" weight="${ICON_WEIGHT}"></ph-file-text></div>
              <p>${this.emptyText}</p>
            </div>
          `}
    `;
  }
}
