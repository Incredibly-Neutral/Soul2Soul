// font-toggles.ts
// Devtools helper: lets you switch font families at runtime from the console.
// Exposes window.__fonts with list / set / clear / current.
//
// Contract with the sibling worker (impl-a): public/fonts.css defines the
// --font-headline / --font-body / --font-mono variables on :root plus
// <html> toggle classes html.headline-<key>, html.body-<key>, html.mono-<key>.

export type FontCategory = 'headline' | 'body' | 'mono';

// Known option keys per category (must match the keys the fonts.css toggle
// classes are built from).
export const FONT_OPTIONS: Record<FontCategory, readonly string[]> = {
  headline: ['playfair', 'dm-serif', 'caslon', 'spinnaker', 'grotesk', 'franklin'],
  body: ['inter', 'franklin', 'grotesk', 'spinnaker'],
  mono: ['dm-mono', 'fira-code', 'plex-mono'],
};

const CLASS_PREFIX: Record<FontCategory, string> = {
  headline: 'headline-',
  body: 'body-',
  mono: 'mono-',
};

function isCategory(value: unknown): value is FontCategory {
  return typeof value === 'string' && value in FONT_OPTIONS;
}

function categoryClassNames(cat: FontCategory): string[] {
  const prefix = CLASS_PREFIX[cat];
  return FONT_OPTIONS[cat].map((key) => `${prefix}${key}`);
}

function removeCategoryClasses(cat: FontCategory): void {
  const html = document.documentElement;
  categoryClassNames(cat).forEach((cls) => html.classList.remove(cls));
}

function listFonts(): void {
  (Object.keys(FONT_OPTIONS) as FontCategory[]).forEach((cat) => {
    console.log(`${cat}: ${FONT_OPTIONS[cat].join(', ')}`);
  });
}

function setFont(cat: unknown, key: unknown): void {
  if (!isCategory(cat)) {
    console.warn(
      `__fonts.set: unknown category "${String(cat)}". Valid categories: ${Object.keys(FONT_OPTIONS).join(', ')}`
    );
    return;
  }
  if (typeof key !== 'string' || !FONT_OPTIONS[cat].includes(key)) {
    console.warn(
      `__fonts.set: "${String(key)}" is not a valid ${cat} font. Options: ${FONT_OPTIONS[cat].join(', ')}`
    );
    return;
  }

  const html = document.documentElement;
  // Remove any other active class from this category first, then apply.
  removeCategoryClasses(cat);
  html.classList.add(`${CLASS_PREFIX[cat]}${key}`);
}

function clearFonts(cat?: unknown): void {
  if (cat === undefined) {
    // No arg: remove every category's toggle classes.
    (Object.keys(FONT_OPTIONS) as FontCategory[]).forEach(removeCategoryClasses);
    return;
  }
  if (!isCategory(cat)) {
    console.warn(
      `__fonts.clear: unknown category "${String(cat)}". Valid categories: ${Object.keys(FONT_OPTIONS).join(', ')}`
    );
    return;
  }
  removeCategoryClasses(cat);
}

function currentFonts(): Record<FontCategory, string | null> {
  const html = document.documentElement;
  const active = {} as Record<FontCategory, string | null>;
  (Object.keys(FONT_OPTIONS) as FontCategory[]).forEach((cat) => {
    const prefix = CLASS_PREFIX[cat];
    const found = categoryClassNames(cat).find((cls) => html.classList.contains(cls));
    active[cat] = found ? found.slice(prefix.length) : null;
  });
  return active;
}

export interface FontToggles {
  list: typeof listFonts;
  set: typeof setFont;
  clear: typeof clearFonts;
  current: typeof currentFonts;
}

declare global {
  interface Window {
    __fonts?: FontToggles;
  }
}

export function initFontToggles(): void {
  if (typeof window === 'undefined') return;
  if (!window.__fonts) {
    window.__fonts = { list: listFonts, set: setFont, clear: clearFonts, current: currentFonts };
  }
}
