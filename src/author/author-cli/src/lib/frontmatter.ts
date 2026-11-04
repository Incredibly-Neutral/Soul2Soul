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
 * Frontmatter key holding the CID of the last upload — the value `offer`
 * offers on-chain. Written back by `upload`; overridable with `--cid`.
 *
 * Ephemeral by nature: it names one upload of one revision of the note, so it
 * is rewritten on every upload and goes stale as soon as the body is edited.
 * That staleness is only *detectable* by the binary (it owns the file), which
 * is why the value lives here rather than in an editor's session state.
 */
export const CID_KEY = 'cid';

/**
 * Pre-rename key, still read so notes written before the rename keep resolving
 * (and so an old note's recorded CID can still be checked for encryption).
 * Never written: the write-back renames it to `CID_KEY` on the next upload.
 */
export const LEGACY_CID_KEY = 'kubo_cid';

/**
 * Resolve the content CID for `offer`: an explicit `--cid` wins, else the `cid`
 * written back by the last `upload` (or its pre-rename `kubo_cid`). Returns
 * `undefined` when neither is available (the caller turns that into a usage
 * error).
 */
export function resolveKuboCid(
  explicit: string | undefined,
  frontmatter: Record<string, unknown>,
): string | undefined {
  if (explicit) return explicit;
  for (const key of [CID_KEY, LEGACY_CID_KEY]) {
    const stored = frontmatter[key];
    if (typeof stored !== 'string') continue;
    const trimmed = stored.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

export function upsertFrontmatter(
  raw: string,
  updates: Record<string, string>,
  remove: readonly string[] = [],
): string {
  const { frontmatter, body } = extractFrontmatter(raw);
  const doc = new Document(frontmatter);
  for (const [key, value] of Object.entries(updates)) {
    doc.set(key, value);
  }
  // Removing a renamed key is what keeps one CID per note: two keys holding
  // different revisions is the state in which `offer` anchors the wrong bytes.
  for (const key of remove) {
    doc.delete(key);
  }
  const yamlText = doc.toString().trimEnd();
  return `---\n${yamlText}\n---\n${body}`;
}
