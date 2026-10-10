// theme.ts — S2S design tokens as CSS custom properties.
//
// This is the single source of truth for the app's theme. It is applied once
// at the document level (see main.ts) so every component — shadow DOM or not —
// inherits the variables. Components should reference these tokens via
// `var(--token, fallback)` instead of hard-coding values.
//
// Following the lit.dev convention: styles are `css` tagged template literals
// so we get static analysis, syntax highlighting, and safe composition.

import { css } from 'lit';

export const theme = css`
  :root {
    /* ------------------------------------------------------------------ */
    /* Brand / accent colors                                               */
    /*   Recolored to the CID-inventory palette (see s2s-cid-view-section) */
    /*   so the app shares one hue family: yellow=config, green=tree,      */
    /*   blue=deal, purple=offer. Red is left as the existing error color. */
    /* ------------------------------------------------------------------ */
    --color-yellow: #fcd34d;
    --color-green:  #6ee7b7;
    --color-blue:   #93c5fd;
    --color-purple: #d8b4fe;
    --color-red:    #db4233;

    /* ------------------------------------------------------------------ */
    /* Warm grayscale (light → dark)                                       */
    /* ------------------------------------------------------------------ */
    --gray-50:  #f7f4ed;
    --gray-100: #ece7db;
    --gray-200: #d8d0c0;
    --gray-300: #bdb3a0;
    --gray-400: #9c9080;
    --gray-500: #7c7163;
    --gray-600: #5f564b;
    --gray-700: #463f37;
    --gray-800: #2e2925;
    --gray-900: #1a1714;

    /* ------------------------------------------------------------------ */
    /* Semantic UI colors                                                  */
    /* ------------------------------------------------------------------ */
    --primary-color: #3b82f6;
    --primary-hover: #2563eb;
    --primary-shadow: rgba(59, 130, 246, 0.1);

    --success-color: #10b981;
    --success-hover: #059669;
    --success-bg: #dcfce7;

    --error-color: #dc2626;
    --error-hover: #b91c1c;
    --error-bg: #fef2f2;
    --error-border: #fecaca;
    --error-hover-bg: #fee2e2;

    --warning-color: #92400e;
    --warning-bg: #fef3c7;

    --neutral-color: #6b7280;
    --neutral-hover: #4b5563;

    --text-primary: #111827;
    --text-secondary: #374151;
    --text-muted: #6b7280;

    --bg-primary: #ffffff;
    --bg-secondary: #f9fafb;
    --bg-tertiary: #f3f4f6;

    --border-color: #e5e7eb;
    --border-light: #f3f4f6;

    --code-bg: #f3f4f6;
    --button-bg: #f3f4f6;
    --button-hover-bg: #e5e7eb;
    --hover-bg: #f9fafb;

    --color-too-dark: #777;

    /* ------------------------------------------------------------------ */
    /* Shadows                                                             */
    /* ------------------------------------------------------------------ */
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.1);
    --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.15);
    --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.18);

    /* ------------------------------------------------------------------ */
    /* Radius                                                              */
    /* ------------------------------------------------------------------ */
    --radius-sm: 0.375rem;
    --radius-md: 0.5rem;
    --radius-lg: 0.75rem;
    --radius-full: 9999px;

    /* ------------------------------------------------------------------ */
    /* Spacing                                                             */
    /* ------------------------------------------------------------------ */
    --spacing-xs: 0.25rem;
    --spacing-sm: 0.5rem;
    --spacing-md: 1rem;
    --spacing-lg: 1.5rem;
    --spacing-xl: 2rem;
    --spacing-2xl: 3rem;

    /* ------------------------------------------------------------------ */
    /* Typography                                                          */
    /* ------------------------------------------------------------------ */
    /* The concrete font families come from styles/fonts.ts. These aliases
       are the tokens components should reference. */
    --font-headline: var(--font-headline-family, 'Spinnaker', sans-serif);
    --font-body: var(--font-body-family, 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    --font-mono: var(--font-mono-family, 'DM Mono', 'Monaco', 'Menlo', monospace);
    --font-family: var(--font-body, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif);
  }

  /* ------------------------------------------------------------------ */
  /* Dark mode                                                           */
  /* ------------------------------------------------------------------ */
  @media (prefers-color-scheme: dark) {
    :root {
      --text-primary: #f9fafb;
      --text-secondary: #e5e7eb;
      --text-muted: #9ca3af;

      --bg-primary: #1f2937;
      --bg-secondary: #111827;
      --bg-tertiary: #374151;

      --border-color: #374151;
      --border-light: #4b5563;

      --code-bg: #374151;
      --button-bg: #374151;
      --button-hover-bg: #4b5563;
      --hover-bg: #1f2937;
    }
  }
`;
