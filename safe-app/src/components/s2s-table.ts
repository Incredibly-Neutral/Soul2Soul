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
// - The HOST owns SortState/FilterState (passed down as properties); the
//   component is stateless about sorting/filtering and reports user intent via
//   composed, bubbling CustomEvents:
//     * `sort`   -> detail { key }
//     * `filter` -> detail { key, value }   ('' = All)
//     * `count`  -> detail { count }        (filtered row count; hosts render
//                   "N results" in titles without re-running the pipeline)
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
  filterByColumn,
  uniqueValuesForColumn,
} from '@/utils/filter.js';
import './table-filter.js';
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
    this.filteredRows = sortByColumn(
      filterByColumn(this.rows, this.columns, this.filters),
      this.columns,
      this.sort,
    );
    if (this.filteredRows.length !== this.lastEmittedCount) {
      this.lastEmittedCount = this.filteredRows.length;
      this.dispatchEvent(
        new CustomEvent('count', {
          detail: { count: this.filteredRows.length },
          bubbles: true,
          composed: true,
        }),
      );
    }
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
    return tag ? html`<${tag} size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></${tag}>` : '';
  }

  render() {
    const rows = this.filteredRows;

    return html`
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
