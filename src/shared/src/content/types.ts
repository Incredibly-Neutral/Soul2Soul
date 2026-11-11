/**
 * @deprecated Use the new content-item types from shared/src/manuscript/types.ts instead.
 *
 * The new types replace these with:
 * - S2SPublicContent → shared/src/manuscript/types.ts (signed, bare author address, specVersion, mediaType, plaintextHash)
 * - S2SToEncrypt → S2SContentBody (shared/src/manuscript/types.ts)
 * - S2SContentItem → shared/src/manuscript/types.ts (flat: public + objectId + proof + encryption + body)
 *
 * Old types kept for backward compatibility during migration. New code should
 * import from '@s2s/soul2soul-shared' (the protocol module).
 */

export interface S2SPublicContent {
    creationDate:  number,
    modifiedDate: number,
    language: string,
    parent: number,
    position: number,
    postType: string,
    publications: string[],
    tags: string[],
    plainTextHash: string
    encryption: boolean,
    encrypted?: string
    content?: string,
    custom?: string,
    title?: string,
    slug?: string
}

export interface S2SToEncrypt {
    content: string,
    custom: string,
    title: string,
    slug: string
}

/** @deprecated Extends the deprecated S2SPublicContent. Use the new S2SContentItem from manuscript/types.ts. */
export interface S2SContentItem extends S2SPublicContent {
}