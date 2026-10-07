import { css } from 'lit';

export const typograhyStyles = css`
  body, p, div {
    font-family: var(--font-body, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif);
    font-weight: 400;
    line-height: 1.55;
  }

  h1 {
    font-size: 3.2rem;
    font-family: var(--font-headline, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    font-style: normal;
    font-weight: 400;
  }

  h2 {
    font-family: var(--font-headline, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    font-style: normal;
    font-weight: 700;
  }

  h3 {
    font-family: var(--font-headline, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    font-style: normal;
    font-weight: 700;
  }

  code, pre, .mono {
    font-family: var(--font-mono, 'Monaco', 'Menlo', 'Ubuntu Mono', monospace);
    font-style: normal;
  }
`;
