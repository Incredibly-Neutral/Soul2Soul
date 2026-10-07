import { css } from 'lit';
import { breakpoints } from './breakpoints.js';

export const layoutStyles = css`
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .container {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: flex-start;
    width: calc(100vw - 1.5rem);
  }

  @media (min-width: ${breakpoints.lg}px) {
    .container {
      width: 100%;
    }
  }

  .container-small {
    max-width: 600px;
  }

  .container-large {
    max-width: 1000px;
  }

  .container-full {
    width: 100vw;
  }

  .centered {
    justify-content: center;
    align-items: center;
  }

  .flex-row {
    flex-direction: row;
  }
`;
