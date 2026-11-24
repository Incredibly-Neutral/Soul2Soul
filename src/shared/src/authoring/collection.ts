// ============================================================================
// Folder collections — the manifest and its members become one document.
//
// Pure mapping from parsed notes to the collection document a bundle body
// carries. No fs, no yaml, no slug inference and no markdown rendering:
// ParsedNote already carries the slug and the rendered content.
// ============================================================================

import type { ParsedNote } from './note';
import type { S2SCollectionDocument, S2SCollectionItem } from '../manuscript/types';

/**
 * Build the collection document from the folder's manifest note and its member
 * notes, in folder order. A member's slug is its key, so a duplicate key is a
 * folder with two files that resolve to the same name: refuse it rather than
 * silently overwrite one member with the other. The CLI adds filenames.
 */
export function buildCollectionDocument(
  manifest: ParsedNote,
  members: ParsedNote[],
): S2SCollectionDocument {
  const seen = new Set<string>();
  const items: S2SCollectionItem[] = members.map((member, i) => {
    const key = member.slug;
    if (seen.has(key)) throw new Error(`duplicate collection key "${key}"`);
    seen.add(key);
    return {
      key,
      title: member.title,
      slug: member.slug,
      content: member.content,
      postType: member.postType,
      position: member.position || i + 1,
      parent: member.parent,
      locale: member.locale,
      tags: member.tags,
      custom: member.custom,
    };
  });

  return { slug: manifest.slug, items };
}
