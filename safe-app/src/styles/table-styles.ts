import { css } from 'lit';

export const tableStyles = css`
  /* <s2s-table> is a custom element that renders into light DOM inside a tab's
     shadow tree; custom elements default to display:inline, so force block. */
  s2s-table {
    display: block;
  }

  .table {
    display: grid;
    gap: 0;
    overflow: hidden;
    width: 100%;
  }

  .table-header {
    padding: 0.75rem;
    border-bottom: 1px solid var(--gray-600);
    text-transform: uppercase;
    display: flex;
    justify-content: flex-start;
    align-items: center;
    border-radius: 0;
  }

  .table-header:first-child {
    padding: 0.75rem 0.75rem 0.75rem 0;
  }

  /* Clickable column headers (per-column sorting, Excel-like) */
  .table-header.sortable {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--gray-600);
    font: inherit;
    color: inherit;
    cursor: pointer;
    user-select: none;
    text-align: left;
    gap: 0.35rem;
  }

  .table-header.sortable:hover {
    color: var(--gray-200);
  }

  .sort-indicator {
    font-size: 0.7rem;
    color: var(--color-yellow);
    min-width: 0.8em;
  }

  .table-cell {
    line-height: 1.275;
    padding: 0.75rem;
    border-bottom: 1px solid var(--gray-600);
    color: var(--gray-50);
  }

  .table-cell:first-child {
    padding: 0.75rem 0.75rem 0.75rem 0;
  }

  .table-row {
    display: contents;
    cursor: pointer;
  }

  .table-row:last-of-type .table-cell {
    border-bottom: none;
  }

  .table-row:hover .table-cell {
    color: var(--gray-200);
    --copy-hash-color: var(--gray-200);
  }
`;
