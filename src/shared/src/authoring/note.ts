// ============================================================================
// Pure markdown-note parser — the single source of truth for turning a raw
// note (Obsidian- or plain-markdown style) into the pieces needed for signing
// and publishing.
//
// Extracted from neutralpress' `ContentController.parseNote` (which is bound
// to Obsidian's TFile/metadataCache) so the headless author-cli can parse the
// exact same shape from a plain file. The obsidian-specific steps — image
// distribution (`distributeImages`) and frontmatter write-back — stay in the
// host; this module is read-only and dependency-light (yaml + marked + slugify).
// ============================================================================

import { marked } from 'marked';
import slugify from 'slugify';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

import { publicationEnsFromTags } from './tags';

/**
 * yaml's core schema coerces `0x…` scalars to numbers (genesis/content_id are
 * stored as hex strings in frontmatter; a hex token that fits in a float is
 * silently mangled into scientific notation). Restore the original text for
 * every 0x-prefixed scalar anywhere in the document (nested maps, flow, lists).
 */
const HEX_RE = /^0x[0-9a-fA-F]+$/;

function restoreHexStrings(node: unknown): void {
  if (!node) return;
  if (isMap(node)) {
    for (const pair of node.items) {
      restoreHexStrings(pair.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      restoreHexStrings(item);
    }
  } else if (isScalar(node)) {
    if (typeof node.source === 'string' && HEX_RE.test(node.source) && typeof node.value !== 'string') {
      node.value = node.source;
    }
  }
}

/** Frontmatter keys that belong to the protocol, not the custom bag. */
export const KNOWN_FRONTMATTER_KEYS = new Set([
  'content_id',
  'post_type',
  'language',
  'tags',
  'parent',
  'position',
  'encryption',
  'title',
  'modified_date',
  'creation_date',
  // The CID of the last upload is written back by the CLI for `offer`; it is
  // never template data. `kubo_cid` is its pre-rename spelling, kept here until
  // old notes have been through one upload.
  'cid',
  'kubo_cid',
  'genesis',
  'author',
]);

/** The structured, host-agnostic result of parsing a note. */
export interface ParsedNote {
  /** Legacy on-chain content id (frontmatter `content_id`), if any. */
  contentId: string | null;
  postType: string;
  locale: string;
  tags: string[];
  parent: number;
  position: number;
  encryption: boolean;
  title: string;
  slug: string;
  /** Markdown body rendered to HTML, summary markers stripped. */
  content: string;
  summary: string | undefined;
  /** Frontmatter keys outside `KNOWN_FRONTMATTER_KEYS`. */
  custom: Record<string, unknown>;
  /** Publication ENS names claimed via `--s2s` tags. */
  publications: string[];
  /** Stable on-chain identity (frontmatter `genesis`), if any. */
  genesis: string | null;
  /** Raw parsed frontmatter, if the file had a block. */
  frontmatter: Record<string, unknown>;
}

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Extract the YAML frontmatter block (`---` delimited at the top of the file)
 * and the remaining body. A file without a leading frontmatter block yields an
 * empty frontmatter and the whole file as body.
 */
export function extractFrontmatter(raw: string): FrontmatterResult {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }
  const lines = raw.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }
  const block = lines.slice(1, end).join('\n');
  let frontmatter: Record<string, unknown> = {};
  try {
    const doc = parseDocument(block);
    if (doc.contents) restoreHexStrings(doc.contents);
    const parsed = doc.toJS() as unknown;
    if (parsed && typeof parsed === 'object') {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed frontmatter block degrades to no frontmatter rather than
    // aborting the note parse.
    frontmatter = {};
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n') };
}

/**
 * Mirror neutralpress' slugify options exactly, so the CLI and the Obsidian
 * plugin derive identical slugs from the same title.
 */
export function slugifyTitle(title: string): string {
  return slugify(title, {
    lower: true,
    remove: /['"?!.,:;()\[\]{}@#$%^&*+=<>~`|\\]/g,
    strict: true,
  });
}

/**
 * Extract the title and base from a note body.
 *
 * Mirrors neutralpress `extractTitleAndBase`: strips `.base` embed references
 * (`![[x.base]]`), then promotes a leading `# ` heading to the title. The
 * `.base` filename is not surfaced in the parse result (neutralpress keeps it
 * internal too) — only the stripped body and derived title are returned.
 */
export function extractTitleAndBase(raw: string): {
  body: string;
  title: string | undefined;
} {
  let content = raw;

  const baseRegex = /!\[\[(.*?)\.base(\.md)?\]\]/g;
  content = content.replace(baseRegex, '');
  content = content.replace(/^\n+/, '');

  let title: string | undefined;
  if (content.startsWith('# ')) {
    const parts = content.split('\n');
    title = parts[0].replace('# ', '').trim();
    parts.shift();
    content = parts.join('\n').trim();
  }

  return { body: content, title };
}

/** Split an HTML body on `<!--more-->` / `<!--split-->` into summary + content. */
export function deriveSummary(html: string): { summary: string | undefined; content: string } {
  const MORE = /<!--more-->/i;
  const SPLIT = /<!--split-->/i;
  const moreIdx = html.search(MORE);
  const splitIdx = html.search(SPLIT);
  const cutIdx = [moreIdx, splitIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];

  const summary = cutIdx >= 0 ? html.slice(0, cutIdx).trim() : undefined;
  const content =
    splitIdx >= 0
      ? html.slice(splitIdx).replace(SPLIT, '').trim()
      : html.replace(MORE, '').trim();
  return { summary, content };
}

/**
 * Parse a raw markdown note into the structured pieces used for signing and
 * publishing. Host-agnostic: the caller supplies the file text and filename.
 */
export async function parseMarkdownNote(raw: string, filename: string): Promise<ParsedNote> {
  const { frontmatter, body: rawBody } = extractFrontmatter(raw);
  const fallbackTitle = filename.replace(/\.[^/.]+$/, '') || (frontmatter.title as string) || '';
  const { body, title: headingTitle } = extractTitleAndBase(rawBody);
  const resolvedTitle = headingTitle?.trim() ? headingTitle : fallbackTitle;
  const slug = (frontmatter.slug as string) || slugifyTitle(resolvedTitle);

  const tags = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as unknown[])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
    : [];

  const custom: Record<string, unknown> = {};
  for (const key of Object.keys(frontmatter)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
      custom[key] = frontmatter[key];
    }
  }

  const mdContent = await marked(body);
  const { summary, content } = deriveSummary(mdContent);

  return {
    contentId: frontmatter.content_id ? asString(frontmatter.content_id) : null,
    postType: (frontmatter.post_type as string) || 'post',
    locale: (frontmatter.language as string) || 'en',
    tags,
    parent: frontmatter.parent ? Number.parseInt(asString(frontmatter.parent) ?? '', 10) || 0 : 0,
    position: frontmatter.position ? Number.parseInt(asString(frontmatter.position) ?? '', 10) || 0 : 0,
    encryption: Boolean(frontmatter.encryption),
    title: resolvedTitle,
    slug,
    content,
    summary,
    custom,
    publications: publicationEnsFromTags(tags),
    genesis: frontmatter.genesis ? asString(frontmatter.genesis) : null,
    frontmatter,
  };
}

/**
 * Coerce an unknown frontmatter scalar to its string form. Objects are not
 * stringable (avoid `String()` falling back to `[object Object]`).
 */
function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return null;
}
