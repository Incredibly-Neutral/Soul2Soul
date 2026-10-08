import { css } from 'lit';

export const sectionStyles = css`
  .section {
    margin-bottom: 3rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .section-title {
    font-size: 1.6rem;
    font-weight: 500;
    color: var(--gray-50);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .section-description {
    color: var(--gray-50);
    margin-bottom: 1.5rem;
  }

  .list_header {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
  }
`;
