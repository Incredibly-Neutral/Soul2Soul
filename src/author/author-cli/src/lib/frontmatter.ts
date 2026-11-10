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

/**
 * Parse a frontmatter date to unix seconds.
 *
 * Accepted: `YYYY-MM-DD` (midnight UTC), `YYYY-MM-DDTHH:mm:ss` or
 * `YYYY-MM-DD HH:mm:ss` with optional fractional seconds and an optional `Z`
 * or `±HH:MM` zone, and a `Date`. An unzoned value is UTC, because the writers
 * emit UTC (`toISOString().slice(0, 19)` drops the `Z`) — reading it as local
 * time would make the signed `creationDate` depend on the machine.
 *
 * Returns `undefined` for anything missing, empty, malformed, or impossible
 * (`2021-02-31T…`). The caller decides whether that is a fallback or an error.
 */
export function frontmatterDateToUnix(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  ];
  const millisecond = Number((match[7] ?? '').slice(0, 3).padEnd(3, '0') || 0);
  const zone = match[8];
  const offsetMinutes =
    zone === undefined || zone === 'Z'
      ? 0
      : (zone.startsWith('-') ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const date = new Date(ms);
  // Reject rollovers (`2021-13-01T…` → next year): only a real calendar time counts.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return Math.floor((ms - offsetMinutes * 60_000) / 1000);
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
