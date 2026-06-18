import { breakpoints } from "./breakpoints";

export const pillStylesString = `

    .pill  {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.875rem;
        font-weight: 500;
        padding: 0.5rem 1rem;
        border-radius: 9999px;
        border: 2px solid var(--color-yellow);
        background: var(--gray-700);
        color: var(--gray-50);
    }

    // .pill a {
    //     color: var(--gray-900);
    //     text-decoration: none;
    
    // }
    
    .module-active {
        border-color: var(--color-green);
        color: var(--gray-50);
    }
    
    .module-inactive {
        border-color: var(--color-red);
        color: var(--gray-50);
    }
`

export const pillStyles = new CSSStyleSheet();
pillStyles.replaceSync(pillStylesString)