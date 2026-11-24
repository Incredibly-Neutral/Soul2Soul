// ============================================================================
// Folder collections — one signed bundle, N members.
//
// A folder of markdown files is signed once as a single manuscript whose
// mediaType is COLLECTION_MEDIA_TYPE. Its body carries the folder's own page
// fields plus a `collection` document listing every member. The press decrypts
// once and expands the bundle into N page bodies; members are not individually
// signed, so an expanded member carries no objectId and no proof.
//
// Dependency-light on purpose: type-only imports, so this travels into a Lit
// Action bundle (INV-7).
// ============================================================================

import type { S2SBodyPlain, S2SCollectionDocument, S2SCollectionItem } from './types';

/** The mediaType that marks a body as a collection container, not a page. */
export const COLLECTION_MEDIA_TYPE = 'application/vnd.s2s.collection+json';

/** The manifest filename that turns a folder into one collection bundle. */
export const COLLECTION_MANIFEST_FILENAME = '_collection.md';

/**
 * True when the body is a collection container. The test is mediaType ONLY:
 * a member may carry collection metadata without re-expanding into itself.
 */
export const isCollectionContainer = (body: { mediaType?: string } | null | undefined): boolean =>
  body?.mediaType === COLLECTION_MEDIA_TYPE;

/** The id of a member: the bundle's genesis plus the member's key. */
export const collectionMemberId = (bundleId: string, key: string): string => `${bundleId}:${key}`;

/**
 * The fields a collection bundle is expanded from. A structural view of the
 * decrypted bundle, not a wire type: the press hands it whatever it decrypted.
 */
export interface CollectionBundleFields {
  id: string;
  author?: string;
  locale?: string;
  parent?: string | number;
  position?: string | number;
  postType?: string;
  creationDate?: string | number;
  modifiedDate?: string | number;
  tags?: string[];
  attributes?: unknown;
  publication?: string;
  base?: string;
  title?: string;
  slug?: string;
  content?: string;
  custom?: Record<string, unknown>;
  mediaType?: string;
  cid?: string;
  collection?: S2SCollectionDocument;
}

/** A page body produced by expanding a collection member. */
export interface S2SExpandedCollectionMember extends S2SBodyPlain {
  collectionGenesis: string;
  collectionTitle?: string;
  collectionSlug: string;
  collectionKey: string;
}

/**
 * One member's page body. The mediaType is hardcoded to text/markdown: a
 * member is always a page, never a container, so expansion cannot recurse.
 *
 * objectId, proof and plaintextHash are deliberately absent: no signature
 * covers a member, and a copied one would claim a cover it does not have.
 */
export function collectionMemberBody(
  bundle: CollectionBundleFields,
  item: S2SCollectionItem,
  index: number,
): S2SExpandedCollectionMember {
  return {
    id: collectionMemberId(bundle.id, item.key),
    author: bundle.author ?? '',
    locale: item.locale ?? bundle.locale ?? 'en',
    parent: String(item.parent ?? bundle.parent ?? 0),
    position: String(item.position ?? index + 1),
    postType: item.postType ?? bundle.postType ?? 'post',
    creationDate: String(bundle.creationDate ?? ''),
    modifiedDate: String(bundle.modifiedDate ?? ''),
    tags: [...new Set([...(bundle.tags ?? []), ...(item.tags ?? [])])],
    attributes: bundle.attributes,
    publication: bundle.publication,
    base: bundle.base,
    cid: bundle.cid,
    mediaType: 'text/markdown',
    encryption: false,
    content: item.content,
    title: item.title,
    slug: item.slug,
    custom: item.custom ?? {},
    collectionGenesis: bundle.id,
    collectionTitle: bundle.title,
    collectionSlug: bundle.collection?.slug ?? bundle.slug ?? '',
    collectionKey: item.key,
  } as S2SExpandedCollectionMember;
}

/**
 * Expand a bundle into its member page bodies. A non-container passes through
 * as a one-element array. A container with no items expands to nothing: the
 * bundle page still renders separately, and it must not leak into a collection
 * list as itself.
 */
export function expandCollection(
  bundle: CollectionBundleFields | null | undefined,
): S2SExpandedCollectionMember[] {
  if (!bundle) return [];
  if (!isCollectionContainer(bundle)) return [bundle as S2SExpandedCollectionMember];
  return (bundle.collection?.items ?? []).map((item, i) => collectionMemberBody(bundle, item, i));
}
