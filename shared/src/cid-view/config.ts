// cid-view config collector (stage 2b) — inventories every CID a publication
// references through its on-chain config:
//   1. configCid      → 'config'
//   2. templateCid    → 'template-dag' + each { path, cid } in the DAG → 'template'
//   3. assetsCid      → 'assets-root' + every file in the (unixfs) tree → 'asset'
//
// Pure: the only side effects are ctx calls. Never throws — on any failure it
// returns the entries collected so far (the view is best-effort by design).
import type { CidEntry } from './types';
import type { CidViewReadContext } from './context';

const MAX_DEPTH = 12;      // recursion-depth cap for the assets tree walk
const MAX_ENTRIES = 5000;  // total-entry cap (pathological DAG guard)
const CONCURRENCY = 8;     // mapWithLimit concurrency for the assets walk

/** Minimal local shape — only the fields this collector reads. */
interface ConfigLike {
  templateCid?: string;
  assetsCid?: string;
}

interface TemplateLike {
  path?: string;
  cid?: string;
  body?: string;
}

type LsEntry = { name: string; hash: string; size: number };

/**
 * Collect every CID a publication's config references. Best-effort: failures
 * degrade to the entries collected so far (or [] if even getConfig fails).
 */
export async function collectConfigCids(ctx: CidViewReadContext): Promise<CidEntry[]> {
  const entries: CidEntry[] = [];

  // 1. configCid — a config read failure yields an empty view, never a throw.
  let configResult: { cid: string; config: unknown };
  try {
    configResult = await ctx.getConfig();
  } catch {
    return [];
  }
  entries.push({ cid: configResult.cid, category: 'config', source: 'config' });

  // Parse the S2SPublicationConfig shape with a local assertion (don't
  // over-validate). A non-object config contributes nothing further.
  const config = configResult.config;
  if (config === null || typeof config !== 'object') {
    return entries;
  }
  const cfg = config as ConfigLike;

  // 2. Templates DAG.
  const templateCid = typeof cfg.templateCid === 'string' ? cfg.templateCid : '';
  if (templateCid !== '') {
    entries.push({ cid: templateCid, category: 'template-dag', source: 'config' });
    await collectTemplates(ctx, templateCid, entries);
  }

  // 3. Assets tree.
  const assetsCid = typeof cfg.assetsCid === 'string' ? cfg.assetsCid : '';
  if (assetsCid !== '') {
    entries.push({ cid: assetsCid, category: 'assets-root', source: 'config' });
    try {
      await walkAssets(ctx, assetsCid, '', entries, 0);
    } catch {
      // ignore — keep whatever was collected before the failure
    }
  }

  return dedupe(entries);
}

/** Read the templates DAG and emit one 'template' entry per file. */
async function collectTemplates(
  ctx: CidViewReadContext,
  templateCid: string,
  entries: CidEntry[],
): Promise<void> {
  let dag: unknown;
  try {
    dag = await ctx.dagGet(templateCid);
  } catch {
    return; // dagGet failed → the template-dag entry is already emitted, carry on
  }

  // Legacy builds may wrap the array under a `templates` key.
  let templates: unknown = dag;
  if (!Array.isArray(templates) && templates !== null && typeof templates === 'object') {
    const wrapped = templates as { templates?: unknown };
    templates = Array.isArray(wrapped.templates) ? wrapped.templates : [];
  }
  if (!Array.isArray(templates)) {
    return; // not an array and no `templates` array → treat as empty
  }

  for (const el of templates as TemplateLike[]) {
    if (el === null || typeof el !== 'object') continue;
    const elCid = typeof el.cid === 'string' ? el.cid : '';
    if (elCid === '') continue;
    entries.push({
      cid: elCid,
      category: 'template',
      source: 'config',
      path: el.path,
      role: el.path,
    });
  }
}

/**
 * Recursive assets-tree walk. A node is a directory iff `ls` returns a
 * non-empty array; a leaf (ls → [] or throws) is emitted as an 'asset'.
 */
async function walkAssets(
  ctx: CidViewReadContext,
  dirCid: string,
  prefix: string,
  entries: CidEntry[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let children: LsEntry[];
  try {
    children = await ctx.ls(dirCid);
  } catch {
    return; // ls threw → stop this branch
  }
  if (!Array.isArray(children) || children.length === 0) return;

  await mapWithLimit(children, CONCURRENCY, async (child) => {
    if (entries.length >= MAX_ENTRIES) return;
    const relPath = prefix === '' ? child.name : `${prefix}/${child.name}`;

    // Distinguish a directory (ls yields children) from a leaf (ls → [] or throws).
    let sub: LsEntry[];
    try {
      sub = await ctx.ls(child.hash);
    } catch {
      sub = [];
    }
    if (Array.isArray(sub) && sub.length > 0) {
      await walkAssets(ctx, child.hash, relPath, entries, depth + 1);
    } else {
      entries.push({
        cid: child.hash,
        category: 'asset',
        source: 'config',
        path: relPath,
        size: child.size,
      });
    }
  });
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function mapWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/** Drop exact duplicate entries (same cid/category/source/role/path/size/...). */
function dedupe(entries: CidEntry[]): CidEntry[] {
  const seen = new Set<string>();
  const out: CidEntry[] = [];
  for (const e of entries) {
    const key = JSON.stringify(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
