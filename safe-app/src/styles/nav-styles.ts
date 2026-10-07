import { css } from 'lit';

export const navStyles = css`
  nav {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
  }

  nav ul {
    list-style: none;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    margin: 0;
    padding: 0;
  }

  nav a {
    color: var(--color-too-dark);
    font-style: normal;
    font-weight: 400;
    font-size: 1rem;
    text-transform: lowercase;
  }
`;
