import { css } from 'lit';

export const buttonStyles = css`
  .button-group {
    display: flex;
    gap: 1rem;
    margin-top: 2rem;
  }

  button {

    font-family: var(--font-mono);
    transition: border-color 0.2s, transform 0.1s;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: transparent;
    border: 1px solid var(--gray-600, #4b5563);
    color: var(--gray-200, #e5e7eb);
    padding: 0.35rem 0.7rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  button:hover:not(:disabled) {
  
    border-color: var(--color-yellow)
  }


  .button:disabled {
    cursor: not-allowed;
    transform: none;
  }

  .btn-primary {
    background: var(--color-yellow);
    color: black;
  }

  .btn-secondary {
    background: var(--color-green);
  }

  .btn-danger {
    background: var(--color-red);
  }

  .btn-danger:hover {
    background: var(--color-red);
  }

  .button.has-icon {
    background: transparent;
    border: none;
    padding: 0.25rem 0.5rem;
  }
`;
