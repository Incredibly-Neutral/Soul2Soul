import { describe, it, expect } from 'vitest';
import { createPath, sortCollection } from './data.ctrlr';

// ============================================================================
// createPath unit tests — config-driven locale routing (monolingual by default).
//
// The behavior matrix:
//   - localePaths absent  → clean pass-through, no prefix, any locale
//   - localePaths present → prefix = localePaths[body.locale] ?? localePaths.default ?? ''
//   - {slug} substitution and the `!body.encryption && body.slug` gate are
//     unchanged (no locale routing for the slug itself).
// ============================================================================

// Template path containing a slug placeholder. In the matrix rows the body has
// NO slug, so the literal `{slug}` survives — those rows isolate the prefix
// logic. Dedicated rows below exercise slug substitution.
const SLUG_PATH = '/{slug}/';

const baseBody = {
  id: 't1',
  author: '0xAuthor',
  locale: 'nl',
  parent: '',
  position: '',
  postType: 'post',
  creationDate: '2026-08-13',
  modifiedDate: '2026-08-13',
  tags: [],
  publication: 'test.s2s',
  encryption: false,
  title: 'Title',
  slug: undefined as string | undefined,
  content: 'plain',
  custom: {},
};

const body = (overrides: Record<string, unknown> = {}) => ({ ...baseBody, ...overrides }) as any;
const tpl = (path: string) => ({ reference: 'post', file: 'post', path }) as any;

describe('createPath: monolingual default (no localePaths)', () => {
  it('returns "/" when templateConfig.path is null', () => {
    expect(createPath(body(), tpl(null as any))).toBe('/');
  });

  it('no prefix for any locale when localePaths is absent', () => {
    expect(createPath(body({ locale: 'nl' }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
    expect(createPath(body({ locale: 'en' }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
    expect(createPath(body({ locale: 'de' }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
  });

  it('no prefix for unspecified paths (non-slug) with no localePaths', () => {
    expect(createPath(body({ locale: 'en' }), tpl('/posts'))).toBe('/posts');
  });
});

describe('createPath: localePaths map', () => {
  it('locale undefined falls back to { default: "" } → no prefix', () => {
    expect(createPath(body({ locale: undefined }), tpl(SLUG_PATH), { default: '' })).toBe(
      SLUG_PATH,
    );
  });

  it('{ nl: "", en: "/en" }, locale "nl" → no prefix', () => {
    expect(createPath(body({ locale: 'nl' }), tpl(SLUG_PATH), { nl: '', en: '/en' })).toBe(
      SLUG_PATH,
    );
  });

  it('{ nl: "", en: "/en" }, locale "en" → /en prefix', () => {
    expect(createPath(body({ locale: 'en' }), tpl(SLUG_PATH), { nl: '', en: '/en' })).toBe(
      '/en' + SLUG_PATH,
    );
  });

  it('{ nl: "", en: "/en", de: "/de" }, locale "de" → /de prefix', () => {
    expect(
      createPath(body({ locale: 'de' }), tpl(SLUG_PATH), {
        nl: '',
        en: '/en',
        de: '/de',
      }),
    ).toBe('/de' + SLUG_PATH);
  });

  it('unlisted locale falls back to the default prefix', () => {
    expect(
      createPath(body({ locale: 'fr' }), tpl(SLUG_PATH), {
        nl: '',
        en: '/en',
        default: '/x',
      }),
    ).toBe('/x' + SLUG_PATH);
  });

  it('unlisted locale with no default → empty prefix (no prefix)', () => {
    expect(createPath(body({ locale: 'fr' }), tpl(SLUG_PATH), { nl: '', en: '/en' })).toBe(
      SLUG_PATH,
    );
  });
});

describe('createPath: {slug} substitution (unchanged)', () => {
  it('substitutes {slug} when unencrypted and slug present (no prefix)', () => {
    expect(createPath(body({ slug: 'hello-world' }), tpl(SLUG_PATH))).toBe('/hello-world/');
  });

  it('substitutes {slug} together with a locale prefix', () => {
    expect(
      createPath(body({ locale: 'en', slug: 'hi' }), tpl(SLUG_PATH), {
        nl: '',
        en: '/en',
      }),
    ).toBe('/en/hi/');
  });

  it('does NOT substitute {slug} when body.encryption is true', () => {
    expect(createPath(body({ encryption: true, slug: 'secret' }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
  });

  it('does NOT substitute when slug is missing', () => {
    expect(createPath(body({ slug: undefined }), tpl(SLUG_PATH))).toBe(SLUG_PATH);
  });
});

// ============================================================================
// sortCollection unit tests — optional per-collection `sortBy`.
//
// Semantics: 'position' -> ascending numeric; 'creationDate'/'modifiedDate' ->
// ascending by Date.parse; 'title' or absent -> ascending alphabetical by
// title. Missing/null/non-parseable fields sort LAST. Never mutates input.
// ============================================================================

const items = [
  {
    id: 'p3',
    title: 'Charlie',
    position: '30',
    creationDate: '2026-08-01',
    modifiedDate: '2026-08-10',
  },
  {
    id: 'p1',
    title: 'Alpha',
    position: '10',
    creationDate: '2026-08-03',
    modifiedDate: '2026-08-08',
  },
  {
    id: 'p2',
    title: 'Bravo',
    position: '20',
    creationDate: '2026-08-02',
    modifiedDate: '2026-08-09',
  },
];

const ids = (result: any[]) => result.map((i) => i.id);

describe('sortCollection: position', () => {
  it('sorts ascending by numeric position', () => {
    expect(ids(sortCollection(items, { slug: 'x', sortBy: 'position' }))).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = items.slice();
    sortCollection(input, { slug: 'x', sortBy: 'position' });
    expect(input.map((i) => i.id)).toEqual(['p3', 'p1', 'p2']);
  });
});

describe('sortCollection: creationDate / modifiedDate', () => {
  it('sorts ascending by creationDate', () => {
    expect(ids(sortCollection(items, { slug: 'x', sortBy: 'creationDate' }))).toEqual([
      'p3',
      'p2',
      'p1',
    ]);
  });

  it('sorts ascending by modifiedDate', () => {
    expect(ids(sortCollection(items, { slug: 'x', sortBy: 'modifiedDate' }))).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });
});

describe('sortCollection: title', () => {
  it('defaults to alphabetical by title when sortBy is absent', () => {
    expect(ids(sortCollection(items, { slug: 'x' }))).toEqual(['p1', 'p2', 'p3']);
  });

  it('sorts alphabetically by title for explicit sortBy "title"', () => {
    expect(ids(sortCollection(items, { slug: 'x', sortBy: 'title' }))).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('sortCollection: defensive missing/null fields', () => {
  it('sorts items with missing/null sort fields LAST', () => {
    const withMissing = [
      { id: 'has', title: 'Zulu', position: '99', creationDate: '2026-08-05' },
      { id: 'noPos', title: 'Alpha', position: null },
      { id: 'noTitle', title: null, position: '1' },
      { id: 'noDate', title: 'Bravo', creationDate: 'not-a-date' },
    ];
    // position: valid keys first in ascending order -> noTitle(1), has(99);
    // then missing-position items last (stable input order: noPos, noDate)
    expect(ids(sortCollection(withMissing, { slug: 'x', sortBy: 'position' }))).toEqual([
      'noTitle',
      'has',
      'noPos',
      'noDate',
    ]);
    // title default: null title sorts last
    expect(ids(sortCollection(withMissing, { slug: 'x' }))).toEqual([
      'noPos',
      'noDate',
      'has',
      'noTitle',
    ]);
    // creationDate: 'has' parses, the rest are unparseable/missing -> last
    // (stable input order among the undefined group)
    expect(ids(sortCollection(withMissing, { slug: 'x', sortBy: 'creationDate' }))).toEqual([
      'has',
      'noPos',
      'noTitle',
      'noDate',
    ]);
  });

  it('treats empty-string position as missing (sorts last)', () => {
    const emptyPos = [
      { id: 'a', title: 'Alpha', position: '1' },
      { id: 'b', title: 'Beta', position: '' },
      { id: 'c', title: 'Gamma', position: '2' },
    ];
    expect(ids(sortCollection(emptyPos, { slug: 'x', sortBy: 'position' }))).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('handles null/undefined items defensively without throwing', () => {
    const mixed = [
      null,
      { id: 'b', title: 'Beta', position: '2' },
      undefined,
      { id: 'a', title: 'Alpha', position: '1' },
    ];
    const survivor = sortCollection(mixed, { slug: 'x', sortBy: 'position' });
    expect(survivor.length).toBe(4);
    expect(survivor.filter(Boolean).map((i) => i.id)).toEqual(['a', 'b']);
  });
});
