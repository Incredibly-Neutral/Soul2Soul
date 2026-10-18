// ============================================================================
// Frontmatter write-back — the CLI's single, pure upsert of YAML frontmatter.
//
// `upsertFrontmatter` rewrites the `---` block from a fresh `Document` built
// from the parsed object, so existing key order and scalar values survive
// (comments are NOT preserved — documented caveat). Kept in its own light
// module so pure tests never drag in the Filecoin/synapse import graph.
// ============================================================================

import { extractFrontmatter } from '@s2s/soul2soul-shared';
import { Document } from 'yaml';

/**
 * Re-serialize a markdown file with `updates` merged into its YAML frontmatter.
 * Keys already present keep their position; new keys are appended. The body is
 * preserved verbatim.
 */
export function upsertFrontmatter(raw: string, updates: Record<string, string>): string {
  const { frontmatter, body } = extractFrontmatter(raw);
  const doc = new Document(frontmatter);
  for (const [key, value] of Object.entries(updates)) {
    doc.set(key, value);
  }
  const yamlText = doc.toString().trimEnd();
  return `---\n${yamlText}\n---\n${body}`;
}
