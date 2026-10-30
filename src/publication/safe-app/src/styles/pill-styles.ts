import { css } from 'lit';

export const pillStyles = css`
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.25rem .75rem;
    border-radius: 9999px;
    border: 1px solid var(--color-yellow);
    background: var(--gray-700);
    color: var(--gray-50);
  }

  .module-active {
    border-color: var(--color-green);
    color: var(--gray-50);
  }

  .module-inactive {
    border-color: var(--color-red);
    color: var(--gray-50);
  }
`;
