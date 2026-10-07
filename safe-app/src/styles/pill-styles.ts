import { css } from 'lit';

export const pillStyles = css`
  .pill {
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

  .module-active {
    border-color: var(--color-green);
    color: var(--gray-50);
  }

  .module-inactive {
    border-color: var(--color-red);
    color: var(--gray-50);
  }
`;
