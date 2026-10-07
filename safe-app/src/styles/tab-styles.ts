import { css } from 'lit';

export const tabStyles = css`
  .tabs-container {
    margin-bottom: 2rem;
    width: 100%;
  }

  .tabs {
    display: flex;
    gap: 0;
    margin: 0 auto -1px auto;
  }

  .tab {
    padding: 1rem 1.5rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 400;
    color: var(--gray-50);
    transition: all 0.2s;
    border-bottom: 2px solid var(--gray-50);
    border-radius: 0;
  }

  button.tab {
    text-transform: uppercase;
  }

  button.tab:hover {
    color: var(--color-yellow);
  }

  .tab.active {
    color: var(--gray-50);
    border-bottom-color: white;
    border-left: 2px solid var(--gray-50);
    border-top: 2px solid var(--gray-50);
    border-right: 2px solid var(--gray-50);
    border-bottom: 2px solid var(--gray-900);
  }

  .tab:last-of-type {
    flex: 1;
    text-align: left;
  }
`;
