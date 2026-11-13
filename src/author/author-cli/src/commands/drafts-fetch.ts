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
// Writing over a note is a decision, and the same one `drafts pull` makes: a
// path holding another genesis, or this genesis at another version, is refused
// and named, and `--force` is what overwrites it. A pull never discards a local
// edit, and neither does a fetch.
//
// Stdout is the result and nothing else; every warning is on stderr. Under
// `--json` the envelope is `{ action, genesis, cid, author, path | null, bytes }`,
// and `--stdout` is refused with `--json`: stdout is one stream, and a body that
// a JSON consumer cannot get is worth refusing rather than leaving half-printed.
// `bytes` is the length of what was written, or of what was printed.
// ============================================================================

import type { CliContext } from '../core/context';
import { readDraftsLog, type DraftsLogDeps } from '../core/drafts';
import {
  buildDraftNote,
  draftFileState,
  readDraftContent,
  readDraftNote,
  resolveDraftRef,
  writeDraftNote,
  type DraftContentDeps,
  type DraftFileNote,
} from '../core/draft-content';
import type { CommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';

/** The result the Neovim contract reads. */
export interface DraftsFetchResult {
  action: 'drafts.fetch';
  genesis: string;
  cid: string;
  author: string;
  /** Where the note was written; null when `--stdout` suppressed the file. */
  path: string | null;
  /** Bytes of what was produced: the file, or the printed body under `--stdout`. */
  bytes: number;
}

/** What the fetch reads; a test replaces the log read and the item read whole. */
export type DraftsFetchDeps = Partial<DraftsLogDeps> & Partial<DraftContentDeps>;

export interface DraftsFetchOptions {
  /** Write here instead of `<title-slug>.md`. */
  out?: string;
  /** Print the body and write nothing. */
  stdout?: boolean;
  /** Overwrite a note that holds another version (or another draft) at that path. */
  force?: boolean;
}

/**
 * Why a path may not be written, in the terms the user needs to decide.
 *
 * `behind` names the version the file records against the one the log holds, so
 * "overwrite it" is a comparison and not a guess; `foreign` names the other
 * genesis it belongs to.
 */
function refusalText(note: DraftFileNote, state: 'behind' | 'foreign', cid: string): string {
  if (state === 'foreign') {
    const holds = note.genesis === undefined ? 'a note with no genesis' : `draft ${note.genesis}`;
    return `it already holds ${holds}`;
  }
  const recorded = note.cid === '' ? 'no recorded CID' : note.cid;
  return `it already holds this draft at ${recorded}, and the log's latest is ${cid}`;
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
  if (options.stdout === true && ctx.out.json) {
    throw new UsageError(
      's2s drafts fetch — `--stdout` prints the body and nothing else, so it cannot be combined with `--json`; drop one of them',
    );
  }

  const log = await readDraftsLog(ctx, overrides);
  const { entry } = resolveDraftRef(ref, log.drafts);
  const content = await readDraftContent(ctx, entry, overrides);
  const note = buildDraftNote(content);

  if (options.stdout === true) {
    // One trailing newline, added by `result`; the body's own is dropped so the
    // output is the body and not the body plus a blank line.
    const printed = note.body.replace(/\n$/, '');
    const result: DraftsFetchResult = {
      action: 'drafts.fetch',
      genesis: entry.genesis,
      cid: entry.cid,
      author: entry.author,
      path: null,
      bytes: Buffer.byteLength(printed, 'utf8'),
    };
    ctx.out.result(result, printed);
    return result;
  }

  const path = options.out ?? `${note.slug}.md`;
  const there = readDraftNote(path);
  const state = draftFileState(there, entry.genesis, entry.cid);
  if (
    there !== undefined &&
    (state === 'behind' || state === 'foreign') &&
    options.force !== true
  ) {
    throw new CliError(
      `refusing to write ${path}: ${refusalText(there, state, entry.cid)} — pass --force to overwrite it, or --out another path`,
      1,
      'drafts_fetch_exists',
    );
  }
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
    'The order is the one `s2s drafts list` prints. Writes `<title-slug>.md` here, or the body alone with --stdout. Refuses to replace another note unless --force.',
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
    force: {
      type: 'boolean',
      summary: 'overwrite a note that holds another version, or another draft',
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
      ...(args.flags.force === true ? { force: true } : {}),
    });
  },
};
