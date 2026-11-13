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
// The note rebuilt from that plaintext is a note this CLI can upload again, and
// what it carries is everything the write path signs: the body document's own
// title (written as a `# heading`, which is where the parser reads a title), its
// content, its `custom` bag, and the public block's `postType`, `locale`, `tags`,
// `parent`, `position` and `label` in the frontmatter keys the parser reads for
// them. The row's `genesis`, `cid`, `author` and dates ride beside them, which is
// what makes the next upload a version of this draft rather than a new one.
//
// What is not reproduced is the signature: `proof`, `objectId` and
// `plaintextHash` are derived at upload, `modifiedDate` becomes the upload's own
// time, and `attributes` are never signed by this CLI at all.
//
// The title is the item's `label` — the manuscript's short public name — and
// when there is none the body document's own title, and the genesis only when
// the item names itself nowhere. A hex id is a row address, never a heading.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  bodyForKey,
  extractFrontmatter,
  extractTitleAndBase,
  slugifyTitle,
  toBytes32Id,
  type AnyS2SContentItem,
  type DecryptParams,
} from '@s2s/soul2soul-shared';

import { requireSetting } from './config';
import type { CliContext } from './context';
import type { DraftEntry } from './drafts';
import { CliError, UsageError, errorText } from '../lib/errors';
import {
  CID_KEY,
  ENCRYPTED_KEY,
  LEGACY_CID_KEY,
  resolveKuboCid,
  upsertFrontmatter,
} from '../lib/frontmatter';

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

/** The signed body document: what this CLI's own upload puts behind a CID. */
interface BodyDocument {
  title: string | undefined;
  slug: string | undefined;
  content: string | undefined;
  custom: Record<string, unknown>;
}

/**
 * Read the plaintext as a body document, when it is one.
 *
 * Another host may store markdown, or JSON of its own shape; anything that is
 * not this CLI's `{ title, slug, content, custom }` is `undefined`, and the
 * caller treats the plaintext as the content it is.
 */
function bodyDocument(plaintext: string): BodyDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  const custom = document.custom;
  return {
    title: nonEmptyString(document.title),
    slug: nonEmptyString(document.slug),
    content: typeof document.content === 'string' ? document.content : undefined,
    custom:
      custom !== null && typeof custom === 'object' && !Array.isArray(custom)
        ? (custom as Record<string, unknown>)
        : {},
  };
}

/** The longest file stem a note takes; the collision suffix is added after it. */
export const DRAFT_SLUG_MAX = 96;

/**
 * The note's title: the item's `label`, then the body document's own title, then
 * the genesis.
 *
 * The label is public and unsigned, and it is the only human name a reader gets
 * without a key; the genesis is what a listing shows when there is none. It is
 * a fallback for naming a file, never for the document's heading.
 */
export function draftNoteTitle(entry: DraftEntry, item: StoredDraftItem, heading?: string): string {
  return nonEmptyString(item.public.label) ?? heading ?? entry.genesis;
}

/**
 * The file stem for a title: the shared slugifier, capped so a long label cannot
 * outrun the filesystem's name limit, and `draft` when nothing survives it.
 *
 * The cap is on the stem alone; the collision fallback appends `-` and eight hex
 * characters after it, so both cap and suffix stay inside a 255-byte name.
 */
export function draftNoteSlug(title: string): string {
  const slug = slugifyTitle(title);
  if (slug.length <= DRAFT_SLUG_MAX) return slug === '' ? 'draft' : slug;
  const capped = slug.slice(0, DRAFT_SLUG_MAX).replace(/-+$/, '');
  return capped === '' ? 'draft' : capped;
}

/**
 * The body below the frontmatter: a `# title` heading, then the content.
 *
 * The heading is what makes the title survive a re-parse — the parser reads the
 * title from it, and falls back to the filename only when there is none. No
 * heading is written when the item names itself nowhere: a hollow `# 0x…` would
 * be the note inventing a name, and the genesis is already in the frontmatter.
 */
function noteBody(heading: string | undefined, content: string): string {
  const trimmed = content.trim();
  if (heading === undefined) return trimmed === '' ? '' : `${trimmed}\n`;
  return trimmed === '' ? `# ${heading}\n` : `# ${heading}\n\n${trimmed}\n`;
}

/** A list of strings from a stored value, for `tags`; anything else is no tags. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** A frontmatter scalar from a stored value: strings as given, numbers as text. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Rebuild the note from the plaintext and the item's public metadata.
 *
 * The body is the body document's `content`, its custom bag is written back as
 * frontmatter keys, and the public block's fields are written in the keys the
 * parser reads them from, so the next upload signs the same values. The dates are
 * the signed ones (`creationDate` / `modifiedDate`, the v1 `createdAt` before
 * them), falling back to the block time of the append that is the only other
 * time the log knows. `encrypted` records the state the item actually has, so a
 * re-upload encrypts exactly what was encrypted and leaves a plaintext draft in
 * the clear.
 */
export function buildDraftNote(content: DraftContent): DraftNote {
  const { entry, item, plaintext, encrypted } = content;
  const document = bodyDocument(plaintext);

  // A body document carries its title inside the signed bytes; a plaintext that
  // is another host's markdown carries one as its own heading.
  let heading: string | undefined;
  let body: string;
  if (document !== undefined) {
    heading = document.title;
    body = document.content ?? '';
  } else {
    const extracted = extractTitleAndBase(plaintext);
    heading = nonEmptyString(extracted.title ?? '');
    body = extracted.body;
  }

  const label = nonEmptyString(item.public.label);
  heading ??= label;
  const title = draftNoteTitle(entry, item, heading);
  const text = noteBody(heading, body);

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

  const updates: Record<string, unknown> = {
    genesis: entry.genesis,
    [CID_KEY]: entry.cid,
    author: entry.author,
    creation_date: isoDate(creation),
    modified_date: isoDate(modified),
    [ENCRYPTED_KEY]: encrypted,
  };
  // The public block, in the frontmatter keys the parser reads it back from. An
  // absent field is left out rather than written empty, so the note says only
  // what the item said.
  const postType = nonEmptyString(publicBlock.postType);
  if (postType !== undefined) updates.post_type = postType;
  const language = nonEmptyString(publicBlock.locale);
  if (language !== undefined) updates.language = language;
  const tags = stringList(publicBlock.tags);
  if (tags.length > 0) updates.tags = tags;
  const parent = scalarText(publicBlock.parent);
  if (parent !== undefined) updates.parent = parent;
  const position = scalarText(publicBlock.position);
  if (position !== undefined) updates.position = position;
  if (label !== undefined) updates.label = label;
  // The template bag, key for key: the uploader signs these into the body's
  // `custom`, and `summary` is one of them.
  for (const [key, value] of Object.entries(document?.custom ?? {})) {
    if (key === 'slug' || key in updates) continue;
    updates[key] = value;
  }
  // A body document whose slug is not the slug of its title came from a note
  // that named one. Writing it back is what keeps the re-upload's `base` the
  // same, and the key was in that note's custom bag before it was ever signed.
  const storedSlug = document?.slug;
  if (storedSlug !== undefined && storedSlug !== slugifyTitle(heading ?? title)) {
    updates.slug = storedSlug;
  }

  return {
    text: upsertFrontmatter(text, updates, [LEGACY_CID_KEY]),
    body: text,
    title,
    slug: draftNoteSlug(title),
  };
}

// ===========================================================================
// The folder — what a pull has to know before it writes
// ===========================================================================

/** A note already in the folder: where it is, and the version it records. */
export interface DraftFile {
  path: string;
  /** The frontmatter `genesis`, as the note spells it. */
  genesis: string;
  /** The version the note records (`cid`, else the legacy `kubo_cid`); empty when it records none. */
  cid: string;
}

/** What a file claims to be, which may be nothing: a plain note carries no genesis. */
export interface DraftFileNote {
  path: string;
  genesis: string | undefined;
  cid: string;
}

/**
 * What one path already holds, and whether this draft may be written over it.
 *
 * `free` is nothing there. `same` is this genesis at this version: rewriting it
 * costs no edit, since the bytes are the ones it already names. `behind` is this
 * genesis at another version, and `foreign` is another genesis — or no genesis at
 * all — which is a note that is not this draft's file to replace.
 */
export type DraftFileState = 'free' | 'same' | 'behind' | 'foreign';

export function draftFileState(
  note: DraftFileNote | undefined,
  genesis: string,
  cid: string,
): DraftFileState {
  if (note === undefined) return 'free';
  if (note.genesis === undefined) return 'foreign';
  if (note.genesis.toLowerCase() !== genesis.toLowerCase()) return 'foreign';
  return note.cid === cid ? 'same' : 'behind';
}

/**
 * Read one note's claim: its genesis and the version it records, or `undefined`
 * when there is no file at that path.
 *
 * The recorded version is resolved the way `offer` resolves it — `cid`, then the
 * legacy `kubo_cid` — because a note written before the rename is the note whose
 * version is being compared. A note that records neither is `behind` whatever
 * the log holds: nothing says which version it came from.
 */
export function readDraftNote(path: string): DraftFileNote | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const { frontmatter } = extractFrontmatter(raw);
  return {
    path,
    genesis: nonEmptyString(frontmatter.genesis),
    cid: resolveKuboCid(undefined, frontmatter) ?? '',
  };
}

/** The folder as a pull sees it: one note per genesis, and the genesises that repeat. */
export interface DraftFolderIndex {
  /** Lowercase genesis → the note that carries it (the first in name order). */
  files: Map<string, DraftFile>;
  /** Genesises more than one note carries, each with every path that carries it. */
  duplicates: { genesis: string; paths: string[] }[];
}

/**
 * Every note in `folder` that carries a genesis, keyed by that genesis.
 *
 * Read fresh on every pull, because the folder is the other half of the
 * comparison and the user may have edited a file since the last run. Names are
 * sorted so two notes carrying one genesis always resolve to the same one, and
 * the collision is reported rather than silently absorbed: two files for one
 * draft is a fact about the folder, and picking one quietly is how an author
 * comes to edit the note the tool is not comparing. A missing folder is an empty
 * index, not an error: a pull creates what it needs.
 */
export function indexDraftFolder(folder: string): DraftFolderIndex {
  const files = new Map<string, DraftFile>();
  const repeated = new Map<string, string[]>();
  if (!existsSync(folder)) return { files, duplicates: [] };

  const names = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const path = join(folder, name);
    const note = readDraftNote(path);
    if (note?.genesis === undefined) continue;
    const key = note.genesis.toLowerCase();
    const existing = files.get(key);
    if (existing === undefined) {
      files.set(key, { path, genesis: note.genesis, cid: note.cid });
      continue;
    }
    const paths = repeated.get(key) ?? [existing.path];
    paths.push(path);
    repeated.set(key, paths);
  }

  const duplicates = [...repeated].map(([key, paths]) => ({
    genesis: files.get(key)?.genesis ?? key,
    paths,
  }));
  return { files, duplicates };
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
