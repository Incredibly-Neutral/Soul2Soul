// ============================================================================
// s2s drafts fetch <ref> — read one draft back out of the log as a note.
//
// The ref is the 1-based order `s2s drafts list` printed, or a genesis id. Both
// misses (an order past the end, a genesis the log does not hold) are errors
// that name the listing: the log answers an unknown genesis with an all-zero
// row and no revert, and a zeroed row is exactly what a caller mistakes for a
// draft.
//
// The read is the log, then the item at its latest CID, then — when the item
// says its body is ciphertext — the GATES-1 decrypt action (`core/draft-content.ts`).
// What comes back is the plaintext the author signed, which is rebuilt into a
// note the CLI can upload again: frontmatter carries the row's genesis, CID,
// author and dates, the title is the item's `label` (else the genesis), and the
// body below it is the body document's content.
//
// Three outputs, one at a time:
//   (default)   write `<title-slug>.md` in the working directory, print the path
//   --out       write that path instead
//   --stdout    print the body alone and write nothing
//
// Stdout is the result and nothing else; every warning is on stderr. Under
// `--json` the envelope is `{ action, genesis, cid, author, path | null, bytes }`,
// `path` null exactly when `--stdout` suppressed the file.
// ============================================================================

import type { CliContext } from '../core/context';
import { readDraftsLog, type DraftsLogDeps } from '../core/drafts';
import {
  buildDraftNote,
  readDraftContent,
  resolveDraftRef,
  writeDraftNote,
  type DraftContentDeps,
} from '../core/draft-content';
import type { CommandSpec } from '../lib/command';
import { UsageError } from '../lib/errors';

/** The result the Neovim contract reads. */
export interface DraftsFetchResult {
  action: 'drafts.fetch';
  genesis: string;
  cid: string;
  author: string;
  /** Where the note was written; null when `--stdout` suppressed the file. */
  path: string | null;
  /** Bytes of what was produced: the file, or the body under `--stdout`. */
  bytes: number;
}

/** What the fetch reads; a test replaces the log read and the item read whole. */
export type DraftsFetchDeps = Partial<DraftsLogDeps> & Partial<DraftContentDeps>;

export interface DraftsFetchOptions {
  /** Write here instead of `<title-slug>.md`. */
  out?: string;
  /** Print the body and write nothing. */
  stdout?: boolean;
}

export async function runDraftsFetch(
  ctx: CliContext,
  ref: string,
  options: DraftsFetchOptions = {},
  overrides: DraftsFetchDeps = {},
): Promise<DraftsFetchResult> {
  if (options.stdout === true && options.out !== undefined) {
    throw new UsageError(
      's2s drafts fetch — `--stdout` writes nothing, so `--out` has no meaning with it',
    );
  }

  const log = await readDraftsLog(ctx, overrides);
  const { entry } = resolveDraftRef(ref, log.drafts);
  const content = await readDraftContent(ctx, entry, overrides);
  const note = buildDraftNote(content);

  if (options.stdout === true) {
    const result: DraftsFetchResult = {
      action: 'drafts.fetch',
      genesis: entry.genesis,
      cid: entry.cid,
      author: entry.author,
      path: null,
      bytes: Buffer.byteLength(note.body, 'utf8'),
    };
    // One trailing newline, added by `result`; the body's own is dropped so the
    // output is the body and not the body plus a blank line.
    ctx.out.result(result, note.body.replace(/\n$/, ''));
    return result;
  }

  const path = options.out ?? `${note.slug}.md`;
  writeDraftNote(path, note.text);
  const result: DraftsFetchResult = {
    action: 'drafts.fetch',
    genesis: entry.genesis,
    cid: entry.cid,
    author: entry.author,
    path,
    bytes: Buffer.byteLength(note.text, 'utf8'),
  };
  // The path is the whole human result: it is the next argument a shell needs.
  ctx.out.result(result, path);
  return result;
}

export const draftsFetch: CommandSpec = {
  name: 'fetch',
  summary: "Read a draft out of the active author Safe's drafts log as a note.",
  params: '<order|genesis>',
  detail:
    'The order is the one `s2s drafts list` prints. Writes `<title-slug>.md` here, or the body alone with --stdout.',
  flags: {
    out: {
      type: 'string',
      value: '<path>',
      summary: 'write the note here instead of <title-slug>.md',
    },
    stdout: {
      type: 'boolean',
      summary: 'print the body and write nothing',
    },
  },
  async run(ctx, args) {
    const ref = args.positionals[0];
    if (ref === undefined) {
      throw new UsageError('s2s drafts fetch <order|genesis> — the ref is missing');
    }
    const out = args.flags.out;
    const stdout = args.flags.stdout === true;
    await runDraftsFetch(ctx, ref, {
      ...(typeof out === 'string' ? { out } : {}),
      ...(stdout ? { stdout } : {}),
    });
  },
};
