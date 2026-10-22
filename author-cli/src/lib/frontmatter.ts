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
/**
 * Frontmatter key holding the CID of the last upload — the value `propose`
 * offers on-chain. Written back by `upload`; overridable with `--cid`.
 *
 * Ephemeral by nature: it names one upload of one revision of the note, so it
 * is rewritten on every upload and goes stale as soon as the body is edited.
 * That staleness is only *detectable* by the binary (it owns the file), which
 * is why the value lives here rather than in an editor's session state.
 */
export const KUBO_CID_KEY = 'kubo_cid';

/**
 * Resolve the content CID for `propose`: an explicit `--cid` wins, else the
 * `kubo_cid` written back by the last `upload`. Returns `undefined` when
 * neither is available (the caller turns that into a usage error).
 */
export function resolveKuboCid(
  explicit: string | undefined,
  frontmatter: Record<string, unknown>,
): string | undefined {
  if (explicit) return explicit;
  const stored = frontmatter[KUBO_CID_KEY];
  if (typeof stored !== 'string') return undefined;
  const trimmed = stored.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function upsertFrontmatter(raw: string, updates: Record<string, string>): string {
  const { frontmatter, body } = extractFrontmatter(raw);
  const doc = new Document(frontmatter);
  for (const [key, value] of Object.entries(updates)) {
    doc.set(key, value);
  }
  const yamlText = doc.toString().trimEnd();
  return `---\n${yamlText}\n---\n${body}`;
}
