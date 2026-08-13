import { describe, it, expect } from 'vitest';
import { createPath } from './data.ctrlr';

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
