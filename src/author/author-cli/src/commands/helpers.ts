// ============================================================================
// Shared command helpers — argument validation + publication resolution.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parseMarkdownNote } from '@s2s/soul2soul-shared';

import { flagString, type ParsedArgs } from '../lib/args';
import { UsageError } from '../lib/errors';
import type { RenderOutcome } from '../core/author';
import type { CliContext } from '../core/context';

/** Require a single `<note>` positional that points at an existing file. */
export function requireNotePath(args: ParsedArgs): string {
  const notePath = args.positionals[0];
  if (!notePath) {
    throw new UsageError('missing required argument: <note> (path to a markdown note)');
  }
  if (!existsSync(notePath)) {
    throw new UsageError(`note file not found: ${notePath}`);
  }
  return notePath;
}

/**
 * Resolve the target publication: explicit `--publication <ens>` flag wins,
 * otherwise the first `--s2s` publication tag in the note's frontmatter.
 */
export async function resolvePublication(
  ctx: CliContext,
  args: ParsedArgs,
  notePath: string,
): Promise<string> {
  const fromFlag = flagString(args.flags, 'publication');
  if (fromFlag) return fromFlag;

  const parsed = await parseMarkdownNote(readFileSync(notePath, 'utf8'), basename(notePath));
  const fromTags = parsed.publications[0];
  if (!fromTags) {
    throw new UsageError(
      'could not determine the publication: pass --publication <ens> or add a `--s2s` publication tag to the note',
    );
  }
  return fromTags;
}

/**
 * One human line for the root-CID write (the ENS `contenthash_wrapped` update).
 * Silent when the run did not render at all; explicit when the update action
 * reported success but left no write result in its trace, because that is the
 * state in which a publish looks fine while the site stays stale.
 */
export function rootTxLine(render: RenderOutcome | undefined): string {
  if (!render) return '';
  const tx = render.rootTx;
  if (!tx) return '  root tx     : (not reported — no write result in the update trace)';
  if (!tx.success) {
    return `  root tx     : FAILED ${tx.hash ?? '(no hash)'} — ${tx.error ?? 'unknown error'}`;
  }
  const where = tx.blockNumber != null ? ` block ${tx.blockNumber}` : '';
  const status = tx.status != null ? ` status ${tx.status}` : '';
  return `  root tx     : ${tx.hash ?? '(no hash)'}${where}${status}`;
}
