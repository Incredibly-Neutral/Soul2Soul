import { describe, expect, it } from 'vitest';

import { buildCollectionDocument } from './collection';
import type { ParsedNote } from './note';

function note(overrides: Partial<ParsedNote> = {}): ParsedNote {
  return {
    contentId: null,
    postType: 'post',
    locale: 'en',
    tags: [],
    parent: 0,
    position: 0,
    encryption: false,
    title: 'Untitled',
    label: null,
    slug: 'untitled',
    content: '<p></p>',
    summary: undefined,
    custom: {},
    publications: [],
    genesis: null,
    frontmatter: {},
    ...overrides,
  };
}

describe('authoring/collection', () => {
  it('maps the manifest slug and every member field', () => {
    const document = buildCollectionDocument(note({ slug: 'my-folder' }), [
      note({
        slug: 'first',
        title: 'First',
        content: '<p>one</p>',
        postType: 'article',
        position: 4,
        parent: 2,
        locale: 'de',
        tags: ['a', 'b'],
        custom: { x: 1 },
      }),
      note({ slug: 'second', title: 'Second', content: '<p>two</p>' }),
    ]);

    expect(document.slug).toBe('my-folder');
    expect(document.items).toEqual([
      {
        key: 'first',
        title: 'First',
        slug: 'first',
        content: '<p>one</p>',
        postType: 'article',
        position: 4,
        parent: 2,
        locale: 'de',
        tags: ['a', 'b'],
        custom: { x: 1 },
      },
      {
        key: 'second',
        title: 'Second',
        slug: 'second',
        content: '<p>two</p>',
        postType: 'post',
        position: 2,
        parent: 0,
        locale: 'en',
        tags: [],
        custom: {},
      },
    ]);
  });

  it('defaults a missing position to index + 1', () => {
    const document = buildCollectionDocument(note(), [
      note({ slug: 'a', position: 0 }),
      note({ slug: 'b', position: 0 }),
    ]);

    expect(document.items.map((item) => item.position)).toEqual([1, 2]);
  });

  it('refuses a duplicate member slug', () => {
    expect(() =>
      buildCollectionDocument(note(), [note({ slug: 'same' }), note({ slug: 'same' })]),
    ).toThrow('duplicate collection key "same"');
  });
});
