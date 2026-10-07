import { css } from 'lit';

export const mainStyles = css`
  .container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 1.5rem;
  }

  .header {
    margin-bottom: 2rem;
  }

  h1.title {
    color: var(--gray-50);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 2rem;
    // font-family: 'DM Serif Display', serif;
    line-height: 1.2;
    margin: 2rem 0 0 0;
    text-transform: uppercase;

  }

  .subtitle {
    color: var(--gray-50);
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
  }

  .web-status {
    display: flex;
  }

  .web-status > div {
    border-right: 1px solid var(--gray-50);
    padding: 0.125rem 0.75rem;
    align-self: center;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    letter-spacing: 0.75px;
  }

  .web-status > div:first-of-type {
    padding-left: 0;
  }

  .web-status > div:last-of-type {
    border: none;
  }

  .web-status > div a {
    color: var(--gray-50);
  }

  .module-status {
    display: flex;
    gap: 1rem;
  }

  .refreshing-badge {
    color: var(--color-yellow);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    flex-direction: column;
    gap: 1.5rem;
  }

  .spinner {
    width: 3rem;
    height: 3rem;
    border: 3px solid #e5e7eb;
    border-top: 3px solid #3b82f6;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .tab-content {
    background: white;
    overflow: hidden;
  }

  .error-message {
    background: #fee2e2;
    color: #991b1b;
    padding: 1rem;
    border-radius: 0.5rem;
    margin-bottom: 1rem;
  }
`;
