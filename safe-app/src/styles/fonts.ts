// fonts.ts — self-hosted font registry (lit.dev-style `css` module).
//
// The @font-face rules previously lived in public/fonts.css. They have been
// brought into the styles folder so all stylesheet concerns live here, and
// applied once at the document level (see main.ts).
//
// The font files themselves remain static assets in public/fonts/ — the
// `url('./fonts/...')` paths resolve relative to the served page, exactly as
// they did when fonts.css was a <link>.
//
// Toggle fonts at runtime by adding classes to <html>, e.g.:
//   document.documentElement.classList.add('headline-playfair','body-inter','mono-dm-mono')
//
// Options per slot (defaults as set in :root below):
//   headline: spinnaker (default) | playfair | dm-serif | caslon | grotesk | franklin | lora | oswald
//   body:     grotesk (default)   | inter | franklin | spinnaker | lora
//   mono:     fira-code (default) | dm-mono | plex-mono | azeret-mono | monaspace-neon

import { css } from 'lit';

export const fonts = css`
  /* ------------------------------------------------ */
  /* @font-face rules                                 */
  /* ------------------------------------------------ */

  /* Spinnaker — static, regular only */
  @font-face {
    font-family: 'Spinnaker';
    src: url('./fonts/Spinnaker/Spinnaker-Regular.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }

  /* Playfair Display — variable (wght 400-900) */
  @font-face {
    font-family: 'Playfair Display';
    src: url('./fonts/PlayfairDisplay/PlayfairDisplay-VariableFont_wght.ttf') format('truetype');
    font-weight: 400 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Playfair Display';
    src: url('./fonts/PlayfairDisplay/PlayfairDisplay-Italic-VariableFont_wght.ttf') format('truetype');
    font-weight: 400 900;
    font-style: italic;
    font-display: swap;
  }

  /* DM Serif Display — static, regular + italic */
  @font-face {
    font-family: 'DM Serif Display';
    src: url('./fonts/DMSerifDisplay/DMSerifDisplay-Regular.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'DM Serif Display';
    src: url('./fonts/DMSerifDisplay/DMSerifDisplay-Italic.ttf') format('truetype');
    font-weight: 400;
    font-style: italic;
    font-display: swap;
  }

  /* Libre Caslon Display — static, regular only */
  @font-face {
    font-family: 'Libre Caslon Display';
    src: url('./fonts/LibreCaslonDisplay/LibreCaslonDisplay-Regular.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }

  /* Schibsted Grotesk — variable (wght 400-900) */
  @font-face {
    font-family: 'Schibsted Grotesk';
    src: url('./fonts/SchibstedGrotesk/SchibstedGrotesk-VariableFont_wght.ttf') format('truetype');
    font-weight: 400 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Schibsted Grotesk';
    src: url('./fonts/SchibstedGrotesk/SchibstedGrotesk-Italic-VariableFont_wght.ttf') format('truetype');
    font-weight: 400 900;
    font-style: italic;
    font-display: swap;
  }

  /* Libre Franklin — variable (wght 100-900) */
  @font-face {
    font-family: 'Libre Franklin';
    src: url('./fonts/LibreFranklin/LibreFranklin-VariableFont_wght.ttf') format('truetype');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Libre Franklin';
    src: url('./fonts/LibreFranklin/LibreFranklin-Italic-VariableFont_wght.ttf') format('truetype');
    font-weight: 100 900;
    font-style: italic;
    font-display: swap;
  }

  /* Inter — variable (wght 100-900) */
  @font-face {
    font-family: 'Inter';
    src: url('./fonts/Inter/Inter-VariableFont-wght.ttf') format('truetype');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Inter';
    src: url('./fonts/Inter/Inter-Italic-VariableFont-wght.ttf') format('truetype');
    font-weight: 100 900;
    font-style: italic;
    font-display: swap;
  }

  /* DM Mono — static, regular + medium (no bold in archive) */
  @font-face {
    font-family: 'DM Mono';
    src: url('./fonts/DMMono/DMMono-Regular.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'DM Mono';
    src: url('./fonts/DMMono/DMMono-Italic.ttf') format('truetype');
    font-weight: 400;
    font-style: italic;
    font-display: swap;
  }
  @font-face {
    font-family: 'DM Mono';
    src: url('./fonts/DMMono/DMMono-Medium.ttf') format('truetype');
    font-weight: 500;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'DM Mono';
    src: url('./fonts/DMMono/DMMono-MediumItalic.ttf') format('truetype');
    font-weight: 500;
    font-style: italic;
    font-display: swap;
  }

  /* Fira Code — variable (wght 300-700) */
  @font-face {
    font-family: 'Fira Code';
    src: url('./fonts/FiraCode/FiraCode-VariableFont_wght.ttf') format('truetype');
    font-weight: 300 700;
    font-style: normal;
    font-display: swap;
  }

  /* IBM Plex Mono — static, regular + bold + italics */
  @font-face {
    font-family: 'IBM Plex Mono';
    src: url('./fonts/IBMPlexMono/IBMPlexMono-Regular.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'IBM Plex Mono';
    src: url('./fonts/IBMPlexMono/IBMPlexMono-Bold.ttf') format('truetype');
    font-weight: 700;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'IBM Plex Mono';
    src: url('./fonts/IBMPlexMono/IBMPlexMono-Italic.ttf') format('truetype');
    font-weight: 400;
    font-style: italic;
    font-display: swap;
  }
  @font-face {
    font-family: 'IBM Plex Mono';
    src: url('./fonts/IBMPlexMono/IBMPlexMono-BoldItalic.ttf') format('truetype');
    font-weight: 700;
    font-style: italic;
    font-display: swap;
  }

  /* Azeret Mono — variable (wght 100-900) */
  @font-face {
    font-family: 'Azeret Mono';
    src: url('./fonts/AzeretMono/AzeretMono-VariableFont_wght.ttf') format('truetype');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Azeret Mono';
    src: url('./fonts/AzeretMono/AzeretMono-Italic-VariableFont_wght.ttf') format('truetype');
    font-weight: 100 900;
    font-style: italic;
    font-display: swap;
  }

  /* Lora — variable (wght 400-700) */
  @font-face {
    font-family: 'Lora';
    src: url('./fonts/Lora/Lora-VariableFont_wght.ttf') format('truetype');
    font-weight: 400 700;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Lora';
    src: url('./fonts/Lora/Lora-Italic-VariableFont_wght.ttf') format('truetype');
    font-weight: 400 700;
    font-style: italic;
    font-display: swap;
  }

  /* Oswald — variable (wght 200-700), normal only */
  @font-face {
    font-family: 'Oswald';
    src: url('./fonts/Oswald/Oswald-VariableFont_wght.ttf') format('truetype');
    font-weight: 200 700;
    font-style: normal;
    font-display: swap;
  }

  /* Monaspace Neon — static (wght 200-800), normal + italic */
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-200-normal.ttf') format('truetype');
    font-weight: 200;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-200-italic.ttf') format('truetype');
    font-weight: 200;
    font-style: italic;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-300-normal.ttf') format('truetype');
    font-weight: 300;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-300-italic.ttf') format('truetype');
    font-weight: 300;
    font-style: italic;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-400-normal.ttf') format('truetype');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-400-italic.ttf') format('truetype');
    font-weight: 400;
    font-style: italic;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-500-normal.ttf') format('truetype');
    font-weight: 500;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-500-italic.ttf') format('truetype');
    font-weight: 500;
    font-style: italic;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-600-normal.ttf') format('truetype');
    font-weight: 600;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-600-italic.ttf') format('truetype');
    font-weight: 600;
    font-style: italic;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-700-normal.ttf') format('truetype');
    font-weight: 700;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-700-italic.ttf') format('truetype');
    font-weight: 700;
    font-style: italic;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-800-normal.ttf') format('truetype');
    font-weight: 800;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Monaspace Neon';
    src: url('./fonts/MonaspaceNeon/monaspace-neon-latin-800-italic.ttf') format('truetype');
    font-weight: 800;
    font-style: italic;
    font-display: swap;
  }

  /* ------------------------------------------------ */
  /* Defaults                                         */
  /* ------------------------------------------------ */
  :root {
    --font-headline-family: 'Spinnaker', sans-serif;
    --font-body-family: 'Schibsted Grotesk', sans-serif;
    /* QA monospace type — Fira Code is the only mono font in the app now. */
    --font-mono-family: 'Fira Code', monospace;
  }

  /* ------------------------------------------------ */
  /* Toggle classes (devtools: add class to <html>)   */
  /* ------------------------------------------------ */
  /* Headline */
  html.headline-spinnaker  { --font-headline-family: 'Spinnaker', sans-serif; }
  html.headline-playfair   { --font-headline-family: 'Playfair Display', serif; }
  html.headline-dm-serif   { --font-headline-family: 'DM Serif Display', serif; }
  html.headline-caslon     { --font-headline-family: 'Libre Caslon Display', serif; }
  html.headline-grotesk    { --font-headline-family: 'Schibsted Grotesk', sans-serif; }
  html.headline-franklin   { --font-headline-family: 'Libre Franklin', sans-serif; }
  html.headline-lora       { --font-headline-family: 'Lora', serif; }
  html.headline-oswald     { --font-headline-family: 'Oswald', sans-serif; }

  /* Body */
  html.body-inter          { --font-body-family: 'Inter', sans-serif; }
  html.body-franklin       { --font-body-family: 'Libre Franklin', sans-serif; }
  html.body-grotesk        { --font-body-family: 'Schibsted Grotesk', sans-serif; }
  html.body-spinnaker      { --font-body-family: 'Spinnaker', sans-serif; }
  html.body-lora           { --font-body-family: 'Lora', serif; }

  /* Mono */
  html.mono-dm-mono        { --font-mono-family: 'DM Mono', monospace; }
  html.mono-fira-code      { --font-mono-family: 'Fira Code', monospace; }
  html.mono-plex-mono      { --font-mono-family: 'IBM Plex Mono', monospace; }
  html.mono-azeret-mono    { --font-mono-family: 'Azeret Mono', monospace; }
  html.mono-monaspace-neon { --font-mono-family: 'Monaspace Neon', monospace; }
`;
