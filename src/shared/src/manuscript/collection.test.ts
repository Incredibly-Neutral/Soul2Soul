import { describe, expect, it } from 'vitest';

import {
  COLLECTION_MEDIA_TYPE,
  COLLECTION_MANIFEST_FILENAME,
  collectionMemberId,
  expandCollection,
  isCollectionContainer,
  type CollectionBundleFields,
  type S2SExpandedCollectionMember,
} from './collection';

/** The member half of the expansion: a non-container passthrough is not one. */
function expandMembers(bundle: CollectionBundleFields): S2SExpandedCollectionMember[] {
  return expandCollection(bundle).filter(
    (body): body is S2SExpandedCollectionMember => 'collectionKey' in body,
  );
}

const BUNDLE: CollectionBundleFields = {
  id: '0xbundle',
  author: '0xauthor',
  locale: 'fr',
  parent: '0',
  position: '1',
  postType: 'page',
  creationDate: '1700000000',
  modifiedDate: '1700000001',
  tags: ['shared', 'folder'],
  publication: 'acme.soul2soul.eth',
  base: 'https://example.test/acme',
  title: 'My Folder',
  slug: 'my-folder',
  content: '',
  mediaType: COLLECTION_MEDIA_TYPE,
  cid: 'QmBundle',
  collection: {
    slug: 'my-folder',
    items: [
      {
        key: 'first',
        title: 'First',
        slug: 'first',
        content: '<p>one</p>',
        tags: ['shared', 'own'],
        position: 3,
        locale: 'de',
        postType: 'article',
        custom: { a: 1 },
      },
      {
        key: 'second',
        title: 'Second',
        slug: 'second',
        content: '<p>two</p>',
      },
    ],
  },
};

describe('manuscript/collection', () => {
  it('names the mediaType and the manifest filename', () => {
    expect(COLLECTION_MEDIA_TYPE).toBe('application/vnd.s2s.collection+json');
    expect(COLLECTION_MANIFEST_FILENAME).toBe('_collection.md');
  });

  it('tests the container by mediaType only', () => {
    expect(isCollectionContainer({ mediaType: COLLECTION_MEDIA_TYPE })).toBe(true);
    expect(isCollectionContainer({ mediaType: 'text/markdown' })).toBe(false);
    expect(
      isCollectionContainer({ collection: BUNDLE.collection } as unknown as { mediaType?: string }),
    ).toBe(false);
    expect(isCollectionContainer(null)).toBe(false);
    expect(isCollectionContainer(undefined)).toBe(false);
  });

  it('builds a member id from the bundle id and the key', () => {
    expect(collectionMemberId('0xbundle', 'first')).toBe('0xbundle:first');
  });

  it('expands a bundle into one page body per member', () => {
    const members = expandMembers(BUNDLE);

    expect(members).toHaveLength(2);
    expect(members.map((m) => m.id)).toEqual(['0xbundle:first', '0xbundle:second']);
    expect(members.map((m) => m.collectionKey)).toEqual(['first', 'second']);
    expect(members.map((m) => m.collectionGenesis)).toEqual(['0xbundle', '0xbundle']);
    expect(members[0]?.collectionSlug).toBe('my-folder');
    expect(members[0]?.collectionTitle).toBe('My Folder');
  });

  it('hardcodes the member mediaType and marks it unencrypted', () => {
    const [first] = expandMembers(BUNDLE);
    expect(first.mediaType).toBe('text/markdown');
    expect(first.encryption).toBe(false);
    expect(first.content).toBe('<p>one</p>');
  });

  it('carries no per-member signature', () => {
    const [first] = expandMembers(BUNDLE);
    expect(first).not.toHaveProperty('objectId');
    expect(first).not.toHaveProperty('proof');
    expect(first).not.toHaveProperty('plaintextHash');
  });

  it('overrides position per item and defaults to index + 1', () => {
    const members = expandMembers(BUNDLE);
    expect(members[0]?.position).toBe('3');
    expect(members[1]?.position).toBe('2');
  });

  it('inherits locale and postType from the bundle, item wins', () => {
    const members = expandMembers(BUNDLE);
    expect(members[0]?.locale).toBe('de');
    expect(members[0]?.postType).toBe('article');
    expect(members[1]?.locale).toBe('fr');
    expect(members[1]?.postType).toBe('page');
  });

  it('dedupes tags across the bundle and the item', () => {
    const members = expandMembers(BUNDLE);
    expect(members[0]?.tags).toEqual(['shared', 'folder', 'own']);
    expect(members[1]?.tags).toEqual(['shared', 'folder']);
  });

  it('falls back to en when no locale is declared', () => {
    const [first] = expandMembers({
      ...BUNDLE,
      locale: undefined,
      collection: { slug: 's', items: [{ key: 'k', title: 'T', slug: 'k', content: '' }] },
    });
    expect(first.locale).toBe('en');
    expect(first.custom).toEqual({});
  });

  it('passes a non-container through unchanged, without collection fields', () => {
    const page: CollectionBundleFields = { id: '0xpage', slug: 'page', mediaType: 'text/markdown' };
    const result = expandCollection(page);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(page);
    expect('collectionKey' in result[0]).toBe(false);
    expect('collectionGenesis' in result[0]).toBe(false);
    expect(expandCollection(null)).toEqual([]);
    expect(expandCollection(undefined)).toEqual([]);
  });

  it('expands a container with no items to nothing', () => {
    expect(expandCollection({ ...BUNDLE, collection: { slug: 's', items: [] } })).toEqual([]);
    expect(expandCollection({ ...BUNDLE, collection: undefined })).toEqual([]);
  });
});
