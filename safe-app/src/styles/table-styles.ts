import { breakpoints } from "./breakpoints";

export const tableStylesString = `

    .table {
        display: grid;
        gap: 0;
        overflow: hidden;
        width: 100%;
    }

    .table-header {
        padding: .75rem;
        border-bottom: 1px solid var(--gray-600);
        text-transform: uppercase;
        display: flex;
        justify-content: flex-start;
        align-items: center;
    }

    .table-header:first-child {
        padding: .75rem  .75rem .75rem 0;
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
        gap: .35rem;
    }

    .table-header.sortable:hover {
        color: var(--gray-200);
    }

    .sort-indicator {
        font-size: .7rem;
        color: var(--color-yellow);
        min-width: .8em;
    }

    .table-cell {
        line-height: 1.275;
        padding: .75rem;
        border-bottom: 1px solid var(--gray-600);
        color: var(--gray-50);
    }
    
    .table-cell:first-child {
        padding: .75rem  .75rem .75rem 0;
    }

    .table-row {
        display: contents;
        cursor: pointer;

        &:last-of-type .table-cell {
            border-bottom: none
        }
    }


    .table-row:hover .table-cell {
        color: var(--gray-200);
        --copy-hash-color: var(--gray-200);
    }

`;

    // .hide-sm { display: none; }

    // @container (min-width: ${breakpoints.md}px) {
                
    //     .hide-sm { display: block; }

    // }

export const tableStyles = new CSSStyleSheet();
tableStyles.replaceSync(tableStylesString)


