import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COLLECTION_MANIFEST_FILENAME,
  COLLECTION_MEDIA_TYPE,
  parseMarkdownNote,
} from '@s2s/soul2soul-shared';

import { loadCollectionDocument } from '../src/core/collection';
import { noteSigningInputs } from '../src/core/author';
import { requireNotePath } from '../src/commands/helpers';
import { UsageError } from '../src/lib/errors';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-collection-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  return path;
};

const MANIFEST = [
  '---',
  'title: Book',
  'slug: book',
  'post_type: chapter',
  'tags: [saga]',
  '---',
  '# Book',
  '',
].join('\n');

async function loadManifestText(
  text: string,
): Promise<Awaited<ReturnType<typeof loadCollectionDocument>>> {
  const path = write(COLLECTION_MANIFEST_FILENAME, text);
  const manifest = await parseMarkdownNote(
    readFileSync(path, 'utf8'),
    COLLECTION_MANIFEST_FILENAME,
  );
  return loadCollectionDocument(path, manifest);
}

const loadManifest = (): ReturnType<typeof loadManifestText> => loadManifestText(MANIFEST);

describe('loadCollectionDocument', () => {
  it('reads members in filename order and inherits only the manifest post type', async () => {
    write(
      '01-a.md',
      ['---', 'title: First', 'tags: [alpha]', 'customkey: one', '---', '# First', ''].join('\n'),
    );
    write(
      '02-b.md',
      [
        '---',
        'title: Second',
        'slug: second-page',
        'post_type: appendix',
        '---',
        '# Second',
        '',
      ].join('\n'),
    );

    const document = await loadManifest();

    expect(document.slug).toBe('book');
    expect(document.items.map((item) => item.key)).toEqual(['first', 'second-page']);
    expect(document.items.map((item) => item.slug)).toEqual(['first', 'second-page']);

    // The member without a post_type takes the manifest's chapter type; the one
    // that declares its own keeps it.
    expect(document.items[0]?.postType).toBe('chapter');
    expect(document.items[1]?.postType).toBe('appendix');

    // Position defaults to folder order; tags and custom belong to the member.
    expect(document.items.map((item) => item.position)).toEqual([1, 2]);
    expect(document.items[0]?.tags).toEqual(['alpha']);
    expect(document.items[1]?.tags).toEqual([]);
    expect(document.items[0]?.custom).toEqual({ customkey: 'one' });
  });

  it('refuses two members that resolve to the same key, naming both files', async () => {
    write('x.md', ['---', 'slug: same', '---', '# X', ''].join('\n'));
    write('y.md', ['---', 'slug: same', '---', '# Y', ''].join('\n'));

    let caught: unknown;
    try {
      await loadManifest();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    const message = caught instanceof Error ? caught.message : '';
    expect(message).toContain('duplicate collection key "same"');
    expect(message).toContain('x.md');
    expect(message).toContain('y.md');
  });

  it('inherits language and parent from raw frontmatter, not the parser default', async () => {
    write('01-a.md', ['---', 'title: Eins', '---', '# Eins', ''].join('\n'));

    const document = await loadManifestText(
      [
        '---',
        'title: Buch',
        'slug: buch',
        'post_type: chapter',
        'language: de',
        'parent: 7',
        '---',
        '# Buch',
        '',
      ].join('\n'),
    );

    // The member has no `language` or `parent` key, so it takes the manifest's
    // values instead of the parser's `en`/`0` defaults.
    expect(document.items[0]?.locale).toBe('de');
    expect(document.items[0]?.parent).toBe(7);
  });

  it('refuses a member whose slug equals the folder slug', async () => {
    write('chapter-one.md', ['---', '# Chapter One', ''].join('\n'));

    let caught: unknown;
    try {
      await loadManifestText(
        ['---', 'title: Book', 'slug: chapter-one', 'post_type: chapter', '---', '# Book', ''].join(
          '\n',
        ),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UsageError);
    const message = caught instanceof Error ? caught.message : '';
    expect(message).toContain('collides');
    expect(message).toContain(COLLECTION_MANIFEST_FILENAME);
    expect(message).toContain('chapter-one.md');
  });

  it('allows an empty folder: the bundle is an empty collection', async () => {
    const document = await loadManifest();
    expect(document.items).toEqual([]);
  });
});

describe('noteSigningInputs collection', () => {
  it('signs a collection media type and body when a document is given', async () => {
    const path = write(COLLECTION_MANIFEST_FILENAME, MANIFEST);
    const parsed = await parseMarkdownNote(
      readFileSync(path, 'utf8'),
      COLLECTION_MANIFEST_FILENAME,
    );
    const collection = { slug: 'book', items: [] };

    const { pub, body } = noteSigningInputs(
      parsed,
      { subdomain: 'book', creationDate: 1700000000, modifiedDate: 1700000600 },
      { collection },
    );

    expect(pub.mediaType).toBe(COLLECTION_MEDIA_TYPE);
    expect(body.collection).toBe(collection);
  });

  it('leaves a plain note as text/markdown with no collection key', async () => {
    const path = write(COLLECTION_MANIFEST_FILENAME, MANIFEST);
    const parsed = await parseMarkdownNote(
      readFileSync(path, 'utf8'),
      COLLECTION_MANIFEST_FILENAME,
    );

    const { pub, body } = noteSigningInputs(parsed, {
      subdomain: 'book',
      creationDate: 1700000000,
      modifiedDate: 1700000600,
    });

    expect(pub.mediaType).toBe('text/markdown');
    expect('collection' in body).toBe(false);
  });
});

describe('requireNotePath', () => {
  it('resolves a folder to its collection manifest', () => {
    writeFileSync(join(dir, COLLECTION_MANIFEST_FILENAME), MANIFEST, 'utf8');
    expect(requireNotePath({ flags: {}, positionals: [dir] })).toBe(
      join(dir, COLLECTION_MANIFEST_FILENAME),
    );
  });

  it('refuses a folder without a manifest', () => {
    expect(() => requireNotePath({ flags: {}, positionals: [dir] })).toThrow(UsageError);
    expect(() => requireNotePath({ flags: {}, positionals: [dir] })).toThrow(
      `no ${COLLECTION_MANIFEST_FILENAME} in ${dir}`,
    );
  });
});
