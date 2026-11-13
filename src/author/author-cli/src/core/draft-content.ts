// ============================================================================
// The bytes behind one row of the drafts log — read from the gateway,
// decrypted with the GATES-1 action, and rebuilt as a note.
//
// The log names a genesis, a CID and a Safe; the item at that CID is the signed
// envelope every upload produces, and its body is either ciphertext
// (`encryption: true`) or the JSON body document itself. A draft belongs to its
// author, so the ciphertext is opened with the author's own credential:
//
//   signature   `signMessage('lit actions auth')` from this machine's key — a
//               PERSONAL message, not the raw digest, because the action
//               recovers it with EIP-191 (`extractSignerAddress(hashMessage(…))`).
//   params      the protocol PKP, the author Safe, the genesis and the L2
//               endpoints. The action does the gating: it resolves the Safe's
//               drafts log and owner history and refuses unless the genesis is
//               in the log and the signer was an owner when the version landed.
//   plaintext   what the author signed — the body document, as JSON text.
//
// No crypto lives here. The action is the only decryptor, and its refusal is
// the only refusal: `LitService.decrypt` already redacts the reason and keeps
// the payload out, so this module re-states the reason and never the bytes.
//
// The note rebuilt from that plaintext is the note the CLI can upload again:
// the same frontmatter keys the uploader reads (`genesis`, `cid`, `author`,
// `creation_date`, `modified_date`, `encrypted`), the title as a `# heading`
// (the parser's own title field, so a re-parse finds it), and the body document's
// content below it. The CLI's own writer (`upsertFrontmatter`) serialises the
// block, so the file it writes is the file it reads.
//
// The title is the item's `label` — the manuscript's short public name — and the
// genesis when there is none. Nothing invents a name: an absent label means the
// genesis id, exactly as a listing resolves it.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  bodyForKey,
  extractFrontmatter,
  slugifyTitle,
  toBytes32Id,
  type AnyS2SContentItem,
  type DecryptParams,
} from '@s2s/soul2soul-shared';

import { requireSetting } from './config';
import type { CliContext } from './context';
import type { DraftEntry } from './drafts';
import { CliError, UsageError, errorText } from '../lib/errors';
import { CID_KEY, ENCRYPTED_KEY, LEGACY_CID_KEY, upsertFrontmatter } from '../lib/frontmatter';

/** The message the caller signs; the action rebuilds it with `hashMessage`. */
export const AUTH_MESSAGE = 'lit actions auth';

// ===========================================================================
// Which row the user meant
// ===========================================================================

/** One row of the log, and the 1-based order `s2s drafts list` printed for it. */
export interface ResolvedDraftRef {
  entry: DraftEntry;
  order: number;
}

/** What the log holds, in words, for an error that has to say why the ref missed. */
function logHolds(count: number): string {
  if (count === 0) return 'the log holds no drafts';
  return `the log holds ${String(count)} draft${count === 1 ? '' : 's'}`;
}

/**
 * Resolve `s2s drafts fetch <ref>`: the 1-based order `drafts list` printed, or
 * a genesis (bytes32, or any id `toBytes32Id` normalises to the key the log
 * holds).
 *
 * A miss is never a zeroed row. The module's own `fetch` answers an unknown
 * genesis with `versionCount == 0` and no revert, which is exactly the shape a
 * caller mistakes for a draft, so both misses are errors and both name the
 * command that prints the refs that do work.
 */
export function resolveDraftRef(ref: string, drafts: readonly DraftEntry[]): ResolvedDraftRef {
  const trimmed = ref.trim();
  if (trimmed === '') {
    throw new UsageError('s2s drafts fetch <order|genesis> — the ref is empty');
  }

  if (/^[0-9]+$/.test(trimmed)) {
    const order = Number(trimmed);
    const entry = drafts[order - 1];
    if (entry === undefined) {
      throw new CliError(
        `no draft ${trimmed} in the author Safe's log — ${logHolds(drafts.length)}; run: s2s drafts list`,
        1,
        'no_such_draft',
      );
    }
    return { entry, order };
  }

  const id = toBytes32Id(trimmed).toLowerCase();
  const index = drafts.findIndex((draft) => draft.genesis.toLowerCase() === id);
  const entry = index === -1 ? undefined : drafts[index];
  if (entry === undefined || entry.versionCount === 0) {
    const spelled = trimmed.toLowerCase() === id ? trimmed : `${trimmed} (${id})`;
    throw new CliError(
      `no draft ${spelled} in the author Safe's log — ${logHolds(drafts.length)}; run: s2s drafts list`,
      1,
      'no_such_draft',
    );
  }
  return { entry, order: index + 1 };
}

// ===========================================================================
// The stored item and its plaintext
// ===========================================================================

/** The parts of a stored item the read path touches; everything else is ignored. */
export interface StoredDraftItem {
  public: Record<string, unknown>;
  encryption?: unknown;
  body?: unknown;
  bodies?: unknown;
}

/** A draft whose body is readable: the row, the item, and the plaintext. */
export interface DraftContent {
  entry: DraftEntry;
  item: StoredDraftItem;
  /** The body: the JSON body document this CLI wrote, or whatever another host stored. */
  plaintext: string;
  /** Whether the item stores that body as ciphertext. */
  encrypted: boolean;
}

/** Everything a draft read does that leaves the process; faked whole in tests. */
export interface DraftContentDeps {
  /** The stored item at a CID. */
  fetchItem(ctx: CliContext, cid: string): Promise<unknown>;
  /** `signMessage(message)` — a personal message, never a raw digest. */
  sign(ctx: CliContext, message: string): Promise<string>;
  /** The GATES-1 decrypt action. */
  decrypt(ctx: CliContext, params: DecryptParams): Promise<string>;
}

export function draftContentDeps(overrides: Partial<DraftContentDeps> = {}): DraftContentDeps {
  return {
    fetchItem: overrides.fetchItem ?? ((ctx, cid) => ctx.ipfs.fetchFromKubo(cid)),
    sign: overrides.sign ?? ((ctx, message) => ctx.signer.signMessage(message)),
    decrypt:
      overrides.decrypt ??
      ((ctx, params) =>
        ctx.lit.decrypt(draftReadSetting(ctx.config.lit.usageKey, 'LIT_USAGE_KEY'), params)),
  };
}

/**
 * A Lit or protocol setting the read cannot proceed without, as a usage error.
 *
 * `requireSetting` throws a plain `Error`; a machine with no usage key is
 * misconfigured, not broken, and the exit code says so. The message names the
 * variable and nothing of the ciphertext.
 */
function draftReadSetting(value: string | undefined, name: string): string {
  let resolved: string;
  try {
    resolved = requireSetting(value, name);
  } catch (err) {
    throw new UsageError(
      `cannot decrypt the draft: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (resolved.trim() === '') {
    throw new UsageError(`cannot decrypt the draft: \`${name}\` is empty.`);
  }
  return resolved;
}

function itemOrThrow(cid: string, raw: unknown): StoredDraftItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CliError(`the item at ${cid} is not a JSON object`, 1, 'drafts_item');
  }
  const { public: block } = raw as { public?: unknown };
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    throw new CliError(
      `the item at ${cid} carries no \`public\` block, so it is not a content item`,
      1,
      'drafts_item',
    );
  }
  return raw as StoredDraftItem;
}

/**
 * Read the row's item and its body, decrypting only when the item says the body
 * is ciphertext.
 *
 * A plaintext item is copied as it stands: the bytes are public, and asking Lit
 * to open something that was never closed would be refused by the action for a
 * reason that is not a problem. The authority is the item's own flag, the same
 * one the render path reads.
 */
export async function readDraftContent(
  ctx: CliContext,
  entry: DraftEntry,
  overrides: Partial<DraftContentDeps> = {},
): Promise<DraftContent> {
  const deps = draftContentDeps(overrides);

  let raw: unknown;
  try {
    raw = await deps.fetchItem(ctx, entry.cid);
  } catch (err) {
    throw new CliError(
      `cannot read the draft at ${entry.cid}: ${errorText(err)}`,
      1,
      'drafts_item',
    );
  }
  const item = itemOrThrow(entry.cid, raw);

  const body = bodyForKey(item as unknown as AnyS2SContentItem);
  if (body === undefined || body === '') {
    throw new CliError(
      `the item at ${entry.cid} carries no readable body, so it is not a draft this CLI can rebuild`,
      1,
      'drafts_item',
    );
  }
  if (item.encryption !== true) {
    return { entry, item, plaintext: body, encrypted: false };
  }

  const pkp = draftReadSetting(ctx.protocolInfo.pkp, 'protocolInfo.pkp');
  const signature = await deps.sign(ctx, AUTH_MESSAGE);
  let plaintext: string;
  try {
    plaintext = await deps.decrypt(ctx, {
      pkpId: pkp,
      genesis: entry.genesis,
      authorSafe: entry.author,
      signature,
      rpcs: ctx.rpcs,
    });
  } catch (err) {
    // The missing-action-CID refusal is the CLI's own, with its two remedies;
    // anything else is the action's reason, which `LitService.decrypt` has
    // already redacted. Neither path can carry the payload: a refusal never
    // returns one, and a plaintext body is only ever a success.
    if (err instanceof UsageError) throw err;
    throw new CliError(
      `cannot decrypt the draft at ${entry.cid}: ${errorText(err)}`,
      1,
      'drafts_decrypt',
    );
  }
  return { entry, item, plaintext, encrypted: true };
}

// ===========================================================================
// The note
// ===========================================================================

/** A note rebuilt from a draft: the file text, its title, and its file stem. */
export interface DraftNote {
  /** The whole file, frontmatter included. */
  text: string;
  /** The note's body alone: what `--stdout` prints. */
  body: string;
  title: string;
  /** The file stem — `<slug>.md` is the default name. */
  slug: string;
}

/** A trimmed, non-empty string from the item's public block; anything else is absent. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function unixSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** Unix seconds → `YYYY-MM-DDTHH:mm:ss` in UTC, the shape the write-back emits. */
function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19);
}

/**
 * The note's title: the item's `label`, else the genesis.
 *
 * The label is public and unsigned, and it is the only human name a reader gets
 * without a key; the genesis is what a listing shows when there is none. The
 * body document's own `title` is inside the plaintext and is not used here, so a
 * note fetched twice is named the same both times.
 */
export function draftNoteTitle(entry: DraftEntry, item: StoredDraftItem): string {
  return nonEmptyString(item.public.label) ?? entry.genesis;
}

/** The file stem for a title: the shared slugifier, and `draft` when nothing survives it. */
export function draftNoteSlug(title: string): string {
  return slugifyTitle(title) || 'draft';
}

/**
 * The body below the frontmatter: a `# title` heading, then the body document's
 * content.
 *
 * The heading is what makes the title survive a re-parse — the CLI's parser
 * reads the title from it, and falls back to the filename only when there is
 * none. A plaintext body that is not a body document (another host's markdown)
 * is used as it stands rather than parsed and dropped.
 */
function noteBody(title: string, plaintext: string): string {
  let content = plaintext.trimEnd();
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (parsed !== null && typeof parsed === 'object') {
      const stored = (parsed as { content?: unknown }).content;
      if (typeof stored === 'string') content = stored.trimEnd();
    }
  } catch {
    // Not a body document: the plaintext is the content.
  }
  return content === '' ? `# ${title}\n` : `# ${title}\n\n${content}\n`;
}

/**
 * Rebuild the note from the plaintext and the item's public metadata.
 *
 * The dates are the signed ones (`creationDate` / `modifiedDate`, the v1
 * `createdAt` before them), falling back to the block time of the append that
 * is the only other time the log knows. `encrypted` records the state the item
 * actually has, so a re-upload encrypts exactly what was encrypted and leaves a
 * plaintext draft in the clear.
 */
export function buildDraftNote(content: DraftContent): DraftNote {
  const { entry, item, plaintext, encrypted } = content;
  const title = draftNoteTitle(entry, item);
  const body = noteBody(title, plaintext);

  const publicBlock = item.public;
  const creation =
    unixSeconds(publicBlock.creationDate) ??
    unixSeconds(publicBlock.createdAt) ??
    unixSeconds(publicBlock.modifiedDate) ??
    entry.timestamp;
  const modified =
    unixSeconds(publicBlock.modifiedDate) ??
    unixSeconds(publicBlock.createdAt) ??
    unixSeconds(publicBlock.creationDate) ??
    entry.timestamp;

  const text = upsertFrontmatter(
    body,
    {
      genesis: entry.genesis,
      [CID_KEY]: entry.cid,
      author: entry.author,
      creation_date: isoDate(creation),
      modified_date: isoDate(modified),
      [ENCRYPTED_KEY]: encrypted,
    },
    [LEGACY_CID_KEY],
  );

  return { text, body, title, slug: draftNoteSlug(title) };
}

// ===========================================================================
// The folder — what a pull has to know before it writes
// ===========================================================================

/** A note already in the folder: where it is, and the version it records. */
export interface DraftFile {
  path: string;
  /** The frontmatter `cid`, empty when the note records none. */
  cid: string;
}

/**
 * Every note in `folder` that carries a genesis, keyed by that genesis.
 *
 * Read fresh on every pull, because the folder is the other half of the
 * comparison and the user may have edited a file since the last run. Names are
 * sorted so two files carrying one genesis always resolve to the same one. A
 * missing folder is an empty index, not an error: a pull creates what it needs.
 */
export function indexDraftFolder(folder: string): Map<string, DraftFile> {
  const index = new Map<string, DraftFile>();
  if (!existsSync(folder)) return index;

  const names = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const path = join(folder, name);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter } = extractFrontmatter(raw);
    const genesis = nonEmptyString(frontmatter.genesis);
    if (genesis === undefined) continue;
    const key = genesis.toLowerCase();
    if (index.has(key)) continue;
    index.set(key, { path, cid: nonEmptyString(frontmatter[CID_KEY]) ?? '' });
  }
  return index;
}

/** Write a note, creating the directory it needs. */
export function writeDraftNote(path: string, text: string): void {
  const directory = dirname(path);
  if (directory !== '' && directory !== '.') mkdirSync(directory, { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * Where a note that is not in the folder yet goes.
 *
 * `<slug>.md` first. That name can belong to another genesis — two drafts may
 * share a label — so a taken name falls back to the genesis suffix, and both
 * being taken is an error rather than an overwrite: a note carrying another
 * genesis is never this draft's file to replace.
 */
export function newDraftNotePath(folder: string, slug: string, genesis: string): string {
  const wanted = join(folder, `${slug}.md`);
  if (!existsSync(wanted)) return wanted;
  const alternate = join(folder, `${slug}-${genesis.slice(2, 10)}.md`);
  if (!existsSync(alternate)) return alternate;
  throw new CliError(
    `the folder already holds a note for another genesis at ${alternate} — move it, then pull again`,
    1,
    'drafts_pull_taken',
  );
}
