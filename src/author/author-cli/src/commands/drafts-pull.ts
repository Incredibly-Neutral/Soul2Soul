// ============================================================================
// s2s drafts pull <folder> — make every draft in the log a note in a folder.
//
// Pull only. Nothing is signed, uploaded or appended: the log is the source, the
// folder is the destination, and a note that is already there is never thrown
// away. Every draft becomes a note, created if missing, named by its title
// (the item's `label`, else the genesis) exactly as `drafts fetch` names it.
//
// The comparison is the recorded CID, because that is the only thing both sides
// carry. A note whose `cid` equals the log's latest is `present`; one that
// differs is `behind` and is left untouched — a local edit is the author's work,
// and a pull is not the command that discards it. `--force` rewrites it.
//
// The rows are a summary, ordered by the log and printed on stderr:
//
//   order  status  path
//
// `written` (created or, under --force, rewritten), `present`, `behind`,
// `failed`. A failed draft does not stop the run — one unreadable item must not
// cost the author the other nine — so the rows are printed after the loop and
// the exit code is non-zero if any failed, which is how a script sees it.
//
// Files carrying another genesis, and files carrying none, are untouched: a pull
// writes into a folder, it does not adopt one.
// ============================================================================

import type { CliContext } from '../core/context';
import { readDraftsLog, type DraftsLogDeps } from '../core/drafts';
import {
  buildDraftNote,
  indexDraftFolder,
  newDraftNotePath,
  readDraftContent,
  writeDraftNote,
  type DraftContentDeps,
} from '../core/draft-content';
import type { CommandSpec } from '../lib/command';
import { UsageError, errorText } from '../lib/errors';

export type DraftsPullStatus = 'written' | 'present' | 'behind' | 'failed';

/** One draft's outcome: the row in the summary and the entry in the envelope. */
export interface DraftsPullRow {
  genesis: string;
  cid: string;
  status: DraftsPullStatus;
  /**
   * The note's path. Empty only for a `failed` row whose failure happened before
   * a path was chosen (a decrypt refusal names no file).
   */
  path: string;
}

/** The result the Neovim contract reads. */
export interface DraftsPullResult {
  action: 'drafts.pull';
  folder: string;
  drafts: DraftsPullRow[];
}

/** What the pull reads; a test replaces the log read and the item read whole. */
export type DraftsPullDeps = Partial<DraftsLogDeps> & Partial<DraftContentDeps>;

export interface DraftsPullOptions {
  /** Rewrite a note whose recorded CID is behind, instead of leaving it. */
  force?: boolean;
}

/** A pull is a summary plus the exit code it implies; the caller owns the code. */
export interface DraftsPullOutcome {
  result: DraftsPullResult;
  /** How many rows ended `failed` — non-zero sets the process exit code. */
  failed: number;
}

/**
 * The stderr summary: `order  status  path`, one row per draft, in log order.
 *
 * The order is the one `s2s drafts list` prints, so a row here can be fetched
 * directly. A `failed` row whose failure landed before a path was chosen has no
 * path column rather than a trailing blank one.
 */
export function draftsPullLines(rows: readonly DraftsPullRow[]): string[] {
  return rows.map((row, index) =>
    [`${String(index + 1)}  ${row.status}`, row.path].filter((part) => part !== '').join('  '),
  );
}

export async function runDraftsPull(
  ctx: CliContext,
  folder: string,
  options: DraftsPullOptions = {},
  overrides: DraftsPullDeps = {},
): Promise<DraftsPullOutcome> {
  const log = await readDraftsLog(ctx, overrides);
  const present = indexDraftFolder(folder);
  const rows: DraftsPullRow[] = [];
  let failed = 0;

  for (const [index, entry] of log.drafts.entries()) {
    const order = index + 1;
    const existing = present.get(entry.genesis.toLowerCase());

    if (existing?.cid === entry.cid) {
      rows.push({ genesis: entry.genesis, cid: entry.cid, status: 'present', path: existing.path });
      continue;
    }
    if (existing !== undefined && options.force !== true) {
      // A note that differs is a note someone edited. Say so and leave it: the
      // pull has no business deciding which side is newer.
      rows.push({ genesis: entry.genesis, cid: entry.cid, status: 'behind', path: existing.path });
      continue;
    }

    try {
      const content = await readDraftContent(ctx, entry, overrides);
      const note = buildDraftNote(content);
      const path =
        existing !== undefined ? existing.path : newDraftNotePath(folder, note.slug, entry.genesis);
      writeDraftNote(path, note.text);
      present.set(entry.genesis.toLowerCase(), { path, cid: entry.cid });
      rows.push({ genesis: entry.genesis, cid: entry.cid, status: 'written', path });
    } catch (err) {
      failed += 1;
      rows.push({ genesis: entry.genesis, cid: entry.cid, status: 'failed', path: '' });
      ctx.out.warn(`draft ${String(order)} (${entry.genesis}) failed: ${errorText(err)}`);
    }
  }

  const result: DraftsPullResult = { action: 'drafts.pull', folder, drafts: rows };
  if (ctx.out.json) {
    // The envelope already carries every row; the human rows would only repeat
    // themselves on stderr.
    ctx.out.result(result);
  } else {
    for (const line of draftsPullLines(rows)) ctx.out.log(line);
  }
  return { result, failed };
}

export const draftsPull: CommandSpec = {
  name: 'pull',
  summary: "Make every draft in the active author Safe's log a note in a folder.",
  params: '<folder>',
  detail:
    'Creates the notes that are missing and leaves the rest alone. A note whose recorded CID is behind is reported, not overwritten; --force rewrites it.',
  flags: {
    force: {
      type: 'boolean',
      summary: 'rewrite notes whose recorded CID is behind the log',
    },
  },
  async run(ctx, args) {
    const folder = args.positionals[0];
    if (folder === undefined || folder.trim() === '') {
      throw new UsageError('s2s drafts pull <folder> — the folder is missing');
    }
    const outcome = await runDraftsPull(ctx, folder, { force: args.flags.force === true });
    return outcome.failed === 0 ? 0 : 1;
  },
};
