// ============================================================================
// A folder as one collection manuscript — the CLI's read of the manifest and
// its members. No chain, no IPFS: the document is built from the folder alone,
// so every path that signs the bundle builds the same one.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  COLLECTION_MANIFEST_FILENAME,
  buildCollectionDocument,
  parseMarkdownNote,
} from '@s2s/soul2soul-shared';
import type { ParsedNote, S2SCollectionDocument } from '@s2s/soul2soul-shared';

import { UsageError } from '../lib/errors';

/** Byte order, not locale order: the member order is the document's order. */
const byFilename = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Load the collection document a folder manifest describes.
 *
 * Members are the folder's other markdown files, in filename order. A member
 * inherits the manifest's `post_type`, `language` and `parent` only when its own
 * frontmatter omits the key: the folder sets the defaults, not an override. The
 * inheritance keys off the raw frontmatter because the parser already fills
 * `post`/`en`/`0`, and passing those defaults through would stop the press's
 * own manifest fallback from ever firing. `position`, `tags` and `custom` stay
 * the member's — the manifest has no say in a chapter's place or its metadata.
 */
export async function loadCollectionDocument(
  manifestPath: string,
  manifest: ParsedNote,
): Promise<S2SCollectionDocument> {
  const folder = dirname(manifestPath);
  const files = readdirSync(folder, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith('.md') && entry.name !== COLLECTION_MANIFEST_FILENAME,
    )
    .map((entry) => entry.name)
    .sort(byFilename);

  const members: ParsedNote[] = [];
  const filesBySlug = new Map<string, string[]>();
  for (const name of files) {
    const member = await parseMarkdownNote(readFileSync(join(folder, name), 'utf8'), name);
    if (!('post_type' in member.frontmatter)) member.postType = manifest.postType;
    if (!('language' in member.frontmatter)) member.locale = manifest.locale;
    if (!('parent' in member.frontmatter)) member.parent = manifest.parent;
    members.push(member);
    filesBySlug.set(member.slug, [...(filesBySlug.get(member.slug) ?? []), name]);
  }

  let document: S2SCollectionDocument;
  try {
    document = buildCollectionDocument(manifest, members);
  } catch (err) {
    const key = duplicateKey(err);
    if (key === undefined) throw err;
    const names = filesBySlug.get(key) ?? [];
    throw new UsageError(
      `duplicate collection key "${key}": ${listNames(names)} resolve to the same page name — rename one of them`,
    );
  }

  // The bundle's own page and a member's page must not resolve to one path. The
  // press would write both and the last one would win.
  for (const item of document.items) {
    if (item.slug !== document.slug) continue;
    const memberFile = filesBySlug.get(item.slug)?.[0] ?? '(unknown file)';
    throw new UsageError(
      `collection slug "${document.slug}" collides with the member page in ${memberFile}: ${basename(manifestPath)} (the folder) and ${memberFile} resolve to the same page path — rename one of them`,
    );
  }

  return document;
}

/** Every colliding file, as `a.md, b.md and c.md`. */
function listNames(names: readonly string[]): string {
  if (names.length === 0) return '(unknown files)';
  return names.reduce(
    (text, name, i) =>
      i === 0 ? name : i === names.length - 1 ? `${text} and ${name}` : `${text}, ${name}`,
    '',
  );
}

/** The key out of `duplicate collection key "<slug>"`, or undefined for any other error. */
function duplicateKey(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  return /^duplicate collection key "(.*)"$/.exec(err.message)?.[1];
}
