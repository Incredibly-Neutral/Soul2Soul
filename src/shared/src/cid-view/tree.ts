// cid-view TREE + ARCHIVE collectors — stage 2c of the CID inventory.
//
// These walk the *published site* and the *publication cache* to enumerate the
// CIDs a publication actually uses:
//   - collectTreeCids    : site root (contenthash_wrapped, INV-6) + every file
//                          inside the IPFS site tree
//   - collectArchiveCids : archive/cache pointer (content_cache_<publication>)
//                          + every content item CID referenced in the Archive
//
// Both are pure `CidViewReadContext` calls (no chain/IPFS adapters here) and
// both are fail-open: they collect what succeeded and never throw. On the L2
// records/CCIP read path the ENS text records are not always present, and the
// published tree / archive blob can be corrupt or missing — so every step
// degrades gracefully instead of failing the whole inventory.
import { namehash } from 'viem/ens';
import { decodeContenthashWrapped } from '../ipfs/contenthash';
import type { CidEntry } from './types';
import type { CidViewReadContext } from './context';

// ───────────────────────────────────────────────────────────────────────────
// Walk tuning
// ───────────────────────────────────────────────────────────────────────────

const LS_CONCURRENCY = 8; // max parallel ctx.ls probes per directory level
const MAX_DEPTH = 12; // don't recurse deeper than this
const MAX_ENTRIES = 5000; // hard cap on site-file entries collected
const SITE_ROOT_KEY = 'contenthash_wrapped'; // INV-6 on-chain key

// ───────────────────────────────────────────────────────────────────────────
// Small worker pool — map `fn` over `items` with at most `limit` promises in
// flight. Never rejects: each element resolves to a settled result so a single
// slow/failed `ls` can't abort the walk of its siblings.
// ─────────────────────────────────────────────────────────────────────────────

async function mapWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        await fn(items[index]);
      } catch {
        // swallow per-item failures — the walk is fail-open
      }
    }
  });
  await Promise.all(workers);
}

/** Dedupe exact duplicates (same fields/values) preserving first-seen order. */
function dedupe(entries: CidEntry[]): CidEntry[] {
  const seen = new Set<string>();
  const out: CidEntry[] = [];
  for (const entry of entries) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Tree walk
// ───────────────────────────────────────────────────────────────────────────

/**
 * Recursively walk one DAG node.
 *
 * The `CidViewReadContext.ls` contract exposes only `{name, hash, size}` — no
 * file/dir type — so a node is treated as a DIRECTORY when `ls(hash)` yields a
 * non-empty list (recurse), and as a FILE otherwise (empty list or failed
 * probe → emit a site-file entry). A leaf (file / empty dir) never recurses.
 */
async function walkNode(
  ctx: CidViewReadContext,
  cid: string,
  path: string,
  depth: number,
  entries: CidEntry[],
): Promise<void> {
  if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;

  let children: { name: string; hash: string; size: number }[];
  try {
    children = await ctx.ls(cid);
  } catch {
    return; // can't list this node — skip it, never throw
  }
  if (!Array.isArray(children) || children.length === 0) return;

  await mapWithLimit(children, LS_CONCURRENCY, async (child) => {
    if (entries.length >= MAX_ENTRIES) return;
    const childPath = path ? `${path}/${child.name}` : child.name;

    let grand: { name: string; hash: string; size: number }[] | null = null;
    try {
      grand = await ctx.ls(child.hash);
    } catch {
      grand = null;
    }

    if (grand && Array.isArray(grand) && grand.length > 0) {
      // Directory → recurse into it.
      await walkNode(ctx, child.hash, childPath, depth + 1, entries);
    } else {
      // File (or empty dir / unlistable node) → emit as a site file.
      entries.push({
        cid: child.hash,
        category: 'site-file',
        source: 'tree',
        path: childPath,
        size: child.size,
      });
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Root-read helpers
//
// Single-purpose "what is the current root CID" primitives, shared with the
// incremental coordinator: they own the ENS read + contenthash decode and
// collapse every failure mode into a small fail-open shape.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read + decode the publication's ENS `contenthash_wrapped` record (INV-6).
 *
 * Fail-open contract used by the collector (and the incremental coordinator):
 *   - a THROWN getEnsText            → `{ ok: false, root: '' }`
 *   - empty/absent record            → `{ ok: true,  root: '' }`
 *   - malformed contenthash (decode) → `{ ok: true,  root: '' }` (treated as absent)
 *   - success                        → `{ ok: true,  root: <decoded CID> }`
 */
export async function readSiteRoot(
  ctx: CidViewReadContext,
  publication: string,
): Promise<{ ok: boolean; root: string }> {
  const node = namehash(publication);

  let onchain = '';
  try {
    onchain = await ctx.getEnsText(node, SITE_ROOT_KEY);
  } catch {
    return { ok: false, root: '' }; // ENS read failed → no root available
  }
  if (!onchain) return { ok: true, root: '' }; // empty record → no site published

  try {
    return { ok: true, root: decodeContenthashWrapped(onchain).toString() };
  } catch {
    return { ok: true, root: '' }; // malformed contenthash → treat as absent
  }
}

/**
 * Read + decode the publication's `content_cache_<publication>` record.
 * Same fail-open contract as {@link readSiteRoot} (a throwing ENS read →
 * `ok:false`; empty/absent/malformed → `ok:true` with an empty root).
 */
export async function readArchiveRoot(
  ctx: CidViewReadContext,
  publication: string,
): Promise<{ ok: boolean; root: string }> {
  const node = namehash(publication);

  let onchain = '';
  try {
    onchain = await ctx.getEnsText(node, `content_cache_${publication}`);
  } catch {
    return { ok: false, root: '' }; // ENS read failed → no cache pointer
  }
  if (!onchain) return { ok: true, root: '' }; // empty record → no archive

  try {
    return { ok: true, root: decodeContenthashWrapped(onchain).toString() };
  } catch {
    return { ok: true, root: '' }; // malformed contenthash → treat as absent
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Public collectors
// ───────────────────────────────────────────────────────────────────────────

/**
 * Collect every CID of the published site tree.
 *
 * 1. Reads `contenthash_wrapped` on the L2 ENS records contract for
 *    `node = namehash(publication)`; absent/empty → no root → [].
 * 2. Decodes the EIP-1577 ipfs-ns contenthash → the site-root CID.
 * 3. Walks the tree via `ctx.ls` (bounded depth + entry cap) emitting a
 *    site-file entry per leaf with its relative path and size.
 *
 * Never throws: missing record, malformed contenthash, or a failed walk all
 * degrade to whatever was collected (root entry alone on walk failure).
 */
export async function collectTreeCids(
  ctx: CidViewReadContext,
  publication: string,
): Promise<CidEntry[]> {
  const { ok, root } = await readSiteRoot(ctx, publication);
  if (!ok || root === '') return []; // no usable root → no site inventory

  const rootEntry: CidEntry = { cid: root, category: 'site-root', source: 'tree' };
  const entries: CidEntry[] = [rootEntry];

  try {
    await walkNode(ctx, root, '', 0, entries);
  } catch {
    return [rootEntry]; // walk failed → root entry alone, never throw
  }

  return dedupe(entries);
}

/**
 * The first candidate that is a non-blank string, trimmed; undefined when none
 * is. Archive entries are untrusted JSON, so a role is picked rather than
 * assumed: an encrypted item's title is not public, and neither part may be
 * present.
 */
function firstNonBlank(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

/**
 * Collect every CID referenced by the publication archive/cache.
 *
 * 1. Reads `content_cache_<publication>` on the L2 ENS records contract;
 *    absent/empty → [].
 * 2. Decodes the contenthash → the Archive JSON CID.
 * 3. Cats the Archive, parses the `items` map (keyed by genesis) and emits an
 *    archive-item entry per non-empty entry cid.
 *
 * Never throws: missing record, malformed contenthash, unreadable/corrupt
 * archive, or missing item fields all degrade to the entries that succeeded.
 */
export async function collectArchiveCids(
  ctx: CidViewReadContext,
  publication: string,
): Promise<CidEntry[]> {
  const { ok, root } = await readArchiveRoot(ctx, publication);
  if (!ok || root === '') return []; // no usable archive pointer → no inventory

  const archiveEntry: CidEntry = { cid: root, category: 'archive', source: 'archive' };
  const entries: CidEntry[] = [archiveEntry];

  let raw: string;
  try {
    raw = await ctx.cat(root);
  } catch {
    return entries; // unreadable archive → pointer alone
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries; // invalid JSON → pointer alone
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return entries;
  const items = (parsed as { items?: unknown }).items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) return entries;

  for (const [genesis, entry] of Object.entries(items as Record<string, unknown>)) {
    const item = entry as
      | {
          cid?: unknown;
          item?: { public?: { label?: unknown; title?: unknown }; title?: unknown };
          title?: unknown;
        }
      | null
      | undefined;
    if (!item || typeof item !== 'object' || typeof item.cid !== 'string' || item.cid === '') {
      continue; // malformed entry → omit
    }
    // role is best-effort. The public label is the name a manuscript carries for
    // display, and it is the only public name an encrypted item has: the title
    // lives in the secret body, where a pocket of items predating the label
    // still carry one on the public part, and older archives put it on the
    // entry. Prefer them in that order, and never fail on a missing field.
    const publicPart = item.item?.public;
    const role = firstNonBlank(publicPart?.label, publicPart?.title, item.item?.title, item.title);
    entries.push({
      cid: item.cid,
      category: 'archive-item',
      source: 'archive',
      genesis,
      role,
    });
  }

  return dedupe(entries);
}
