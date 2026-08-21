// Reusable filter styles for the safe-app tables (deals / offers / storage).
//
// Adopted by the <table-filter> custom element (component styles) and by the
// tab components (the `.table-filters` toolbar that hosts the dropdowns).
// Kept here in the style files rather than inline in component render
// templates, per the repo CSS convention.

export const filterStylesString = `
    /* Toolbar that hosts the filter dropdowns above a table */
    .table-filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.75rem 1.5rem;
        padding: 0.5rem 0 0.75rem 0;
    }

    /* <table-filter> component root */
    .table-filter {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
    }

    .table-filter__label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--gray-400);
        white-space: nowrap;
    }

    .table-filter__select {
        background: var(--gray-800);
        color: var(--gray-100);
        border: 1px solid var(--gray-600);
        border-radius: 0.375rem;
        padding: 0.3rem 0.5rem;
        font: inherit;
        font-size: 0.875rem;
        cursor: pointer;
        max-width: 16rem;
    }

    .table-filter__select:hover {
        border-color: var(--gray-500);
    }

    .table-filter__select:focus-visible {
        outline: 2px solid var(--color-yellow);
        outline-offset: 1px;
    }
`;

export const filterStyles = new CSSStyleSheet();
filterStyles.replaceSync(filterStylesString);
