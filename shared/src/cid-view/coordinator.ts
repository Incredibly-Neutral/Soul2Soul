// cid-view coordinator — the composition root.
//
// Two build paths:
//   COLD        — runs all four collectors (deals / config / tree / archive),
//                 merges their entries in a stable grouped order, dedupes
//                 cross-collector, computes the summary + sources flags, and
//                 attaches a `meta` block (completeness + layer roots + deal
//                 fingerprint + per-genesis version counts) so the NEXT
//                 refresh can go incremental.
//   INCREMENTAL — when the caller supplies a `prev` view whose meta.complete is
//                 true, diffs each layer against prev instead of re-running
//                 every collector: the deal layer diffs through
//                 collectDealCidsIncremental (zero version calls when the deal
//                 fingerprint is unchanged), and each config/tree/archive layer
//                 is reused verbatim when its on-chain root is unchanged (zero
//                 dagGet/ls/cat). Any layer whose root read fails, or whose
//                 deal diff reports incomplete, flips meta.complete=false so
//                 the NEXT refresh falls back to a cold rebuild (self-healing).
//
// Fail-open philosophy: collectors never throw, so this never throws for a
// missing/failed source — the only throw is parsePublicationCidView, which
// fires on a structural violation (a real invariant bug in the composition).
import { namehash } from 'viem/ens';
import { decodeContenthashWrapped } from '../ipfs/contenthash';
import type { CidViewReadContext } from './context';
import {
  collectDealCids,
  collectDealCidsIncremental,
  dealFingerprint,
  deriveDealCidSnapshot,
} from './deals';
import type { DealCidSnapshot } from './deals';
import { collectConfigCids } from './config';
import { collectTreeCids, collectArchiveCids } from './tree';
import type { CidCategory, CidEntry, PublicationCidView } from './types';
import { parsePublicationCidView } from './validation';

export interface BuildCidViewOptions {
  /** Clock override for tests; defaults to new Date(). */
  now?: () => Date;
  /**
   * Previous view to diff against (e.g. the one persisted by safe-app's SWR
   * cache). Only used when prev.meta?.complete === true; otherwise the build
   * falls back to the cold path.
   */
  prev?: PublicationCidView;
}

/** Collector order — determines the stable merge order of the view. */
const COLLECTORS: readonly ((
  ctx: CidViewReadContext,
  publication: string,
) => Promise<CidEntry[]>)[] = [
  collectDealCids,
  collectConfigCids,
  collectTreeCids,
  collectArchiveCids,
];

/**
 * Merge collector groups in stable order (deals, config, tree, archive) with
 * cross-collector dedupe. Identity is *content* identity: cid + genesis + path.
 * category/source are roles (a content cid legitimately appears as a deal AND
 * an archive-item) so they are excluded — the same content referenced from
 * multiple collectors is listed once, keeping the first (richest) occurrence.
 */
function mergeGroups(groups: CidEntry[][]): CidEntry[] {
  const merged: CidEntry[] = [];
  for (const group of groups) merged.push(...group);

  const seen = new Set<string>();
  const entries: CidEntry[] = [];
  for (const entry of merged) {
    const key = `${entry.cid}\u0000${entry.genesis ?? ''}\u0000${entry.path ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

/** Assemble the shared view shape (entries/sources/summary) from final entries. */
function assembleView(
  publication: string,
  generatedAt: string,
  entries: CidEntry[],
): PublicationCidView {
  const sources = {
    deals: entries.some((e) => e.source === 'deals'),
    config: entries.some((e) => e.source === 'config'),
    tree: entries.some((e) => e.source === 'tree'),
    archive: entries.some((e) => e.source === 'archive'),
  };

  const uniqueCids = new Set(entries.map((e) => e.cid)).size;
  const byCategory: Partial<Record<CidCategory, number>> = {};
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
  }

  return {
    publication,
    generatedAt,
    entries,
    sources,
    summary: { total: entries.length, uniqueCids, byCategory },
  };
}

/**
 * Best-effort known version count per genesis — the number of '*-version'
 * entries collected for that genesis. Counted over the MERGED (pre-dedupe)
 * collector output so the 'current version' entries that cross-collector
 * dedupe later folds into their deal/offer row still count towards the count.
 */
function deriveVersionCounts(entries: CidEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.category === 'deal-version' || entry.category === 'offer-version') {
      if (!entry.genesis) continue;
      counts[entry.genesis] = (counts[entry.genesis] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Cold-path completeness: every live deal/offer genesis must have at least one
 * version entry. This catches the common cold failure — a version read for one
 * genesis failed, leaving that genesis with no version entries → complete=false
 * → the next refresh rebuilds cold. A publication with no deals/offers is
 * complete. A genesis with a single version whose cid equals its deal cid
 * (folded out of the final view by cross-collector dedupe) still counts via
 * the pre-dedupe merged entries.
 */
function coldComplete(entries: CidEntry[]): boolean {
  const versionGenesis = new Set<string>();
  for (const entry of entries) {
    if (
      (entry.category === 'deal-version' || entry.category === 'offer-version') &&
      entry.genesis
    ) {
      versionGenesis.add(entry.genesis);
    }
  }
  for (const entry of entries) {
    if ((entry.category === 'deal' || entry.category === 'offer') && entry.genesis) {
      if (!versionGenesis.has(entry.genesis)) return false;
    }
  }
  return true;
}

/** Read the publication config CID — ok=false only when the read itself failed. */
async function readConfigRoot(ctx: CidViewReadContext): Promise<{ ok: boolean; cid: string }> {
  try {
    return { ok: true, cid: (await ctx.getConfig()).cid };
  } catch {
    return { ok: false, cid: '' };
  }
}

/**
 * Restore the 'current version' entries that the cold view's cross-collector
 * dedupe folded into their deal/offer row (a version whose cid equals the live
 * deal row cid shares the dedupe key with that row, so it is dropped from the
 * view's entries). deriveDealCidSnapshot therefore under-reports the per-genesis
 * version history by one — the current version. Without the restore, an
 * unchanged-fingerprint incremental refresh would re-emit the SECOND-to-last
 * version as 'current version' (a visible drift from the cold view) and
 * under-count versionCounts. Appending the live deal/offer row's cid (which IS
 * the current version) reconstructs the exact full history the cold collector
 * would have produced.
 */
function restoreFoldedCurrentVersions(snapshot: DealCidSnapshot): void {
  for (const row of snapshot.deals) {
    const cached = snapshot.versions[row.genesis] ?? [];
    if (cached[cached.length - 1]?.cid !== row.cid) {
      snapshot.versions[row.genesis] = [
        ...cached,
        { cid: row.cid, timestamp: row.timestamp, tombstone: false },
      ];
    }
  }
  for (const row of snapshot.offers) {
    const cached = snapshot.versions[row.genesis] ?? [];
    if (cached[cached.length - 1]?.cid !== row.cid) {
      snapshot.versions[row.genesis] = [
        ...cached,
        { cid: row.cid, timestamp: row.timestamp, tombstone: false },
      ];
    }
  }
}

/**
 * Read an ENS text root (contenthash_wrapped / content_cache_<pub>) and decode
 * it — inline mirror of the tree/archive collectors' read step. ok=false only
 * when the on-chain read itself failed; an empty record OR a malformed
 * contenthash is treated as legitimately absent ({ok:true, root:''}), matching
 * the collectors.
 */
async function readEnsRoot(
  ctx: CidViewReadContext,
  node: string,
  key: string,
): Promise<{ ok: boolean; root: string }> {
  let onchain: string;
  try {
    onchain = await ctx.getEnsText(node, key);
  } catch {
    return { ok: false, root: '' };
  }
  if (!onchain) return { ok: true, root: '' };
  try {
    return { ok: true, root: decodeContenthashWrapped(onchain).toString() };
  } catch {
    return { ok: true, root: '' }; // malformed contenthash → treated as absent
  }
}

/**
 * Incremental refresh against a complete prev view. Each layer (config / tree /
 * archive) is either REUSED verbatim from prev (root unchanged), RE-WALKED
 * (root changed), treated as legitimately absent ([]), or marked incomplete
 * when its root read failed. The deal layer diffs via collectDealCidsIncremental
 * which makes zero version calls when the deal fingerprint is unchanged.
 */
async function buildIncremental(
  ctx: CidViewReadContext,
  publication: string,
  prev: PublicationCidView,
  now: () => Date,
): Promise<PublicationCidView> {
  // Deal layer — diff against the prev snapshot (zero version calls when the
  // live deal fingerprint matches prev AND every live genesis has cached history).
  const prevSnapshot = deriveDealCidSnapshot(prev);
  restoreFoldedCurrentVersions(prevSnapshot);
  const dealResult = await collectDealCidsIncremental(ctx, prevSnapshot);
  const dealEntries = dealResult.entries;

  // Config layer.
  const configRes = await readConfigRoot(ctx);
  let configEntries: CidEntry[];
  let configOk: boolean;
  if (configRes.ok && configRes.cid !== '' && configRes.cid === prev.meta?.configCid) {
    configEntries = prev.entries.filter((e) => e.source === 'config');
    configOk = true;
  } else if (configRes.ok && configRes.cid !== '') {
    configEntries = await collectConfigCids(ctx);
    configOk = true;
  } else if (configRes.ok) {
    configEntries = []; // no config record
    configOk = true;
  } else {
    configEntries = []; // config read failed
    configOk = false;
  }

  // Tree layer.
  const node = namehash(publication);
  const treeRes = await readEnsRoot(ctx, node, 'contenthash_wrapped');
  let treeEntries: CidEntry[];
  let treeOk: boolean;
  if (treeRes.ok && treeRes.root !== '' && treeRes.root === prev.meta?.siteRoot) {
    treeEntries = prev.entries.filter((e) => e.source === 'tree');
    treeOk = true;
  } else if (treeRes.ok && treeRes.root !== '') {
    treeEntries = await collectTreeCids(ctx, publication);
    treeOk = true;
  } else if (treeRes.ok) {
    treeEntries = []; // no site published
    treeOk = true;
  } else {
    treeEntries = []; // ENS read failed
    treeOk = false;
  }

  // Archive layer.
  const archiveRes = await readEnsRoot(ctx, node, `content_cache_${publication}`);
  let archiveEntries: CidEntry[];
  let archiveOk: boolean;
  if (archiveRes.ok && archiveRes.root !== '' && archiveRes.root === prev.meta?.archiveRoot) {
    archiveEntries = prev.entries.filter((e) => e.source === 'archive');
    archiveOk = true;
  } else if (archiveRes.ok && archiveRes.root !== '') {
    archiveEntries = await collectArchiveCids(ctx, publication);
    archiveOk = true;
  } else if (archiveRes.ok) {
    archiveEntries = []; // no cache pointer
    archiveOk = true;
  } else {
    archiveEntries = []; // ENS read failed
    archiveOk = false;
  }

  const preDeduped = [...dealEntries, ...configEntries, ...treeEntries, ...archiveEntries];
  const entries = mergeGroups([dealEntries, configEntries, treeEntries, archiveEntries]);
  const view = assembleView(publication, now().toISOString(), entries);

  // Meta for the incremental view. A reused layer is complete BY INHERITANCE
  // (we only enter the incremental path when prev.meta.complete === true); a
  // re-walked layer is complete when its root read succeeded. A failed root
  // read or deal diff flips complete=false → next refresh rebuilds cold.
  view.meta = {
    complete: dealResult.complete && configOk && treeOk && archiveOk,
    fingerprint: dealResult.fingerprint,
    configCid: configRes.cid,
    siteRoot: treeRes.root,
    archiveRoot: archiveRes.root,
    versionCounts: deriveVersionCounts(preDeduped),
  };

  // Invariant: a composed view must always be structurally valid. A ZodError
  // here indicates a real composition bug — never a missing source.
  return parsePublicationCidView(view);
}

/**
 * Build the full PublicationCidView for a publication.
 *
 * @param ctx          read context (chain/IPFS adapters supplied by the consumer)
 * @param publication  ENS name, e.g. 's3ntiment.eth'
 * @param opts         optional clock override + previous view for incremental diff
 */
export async function buildPublicationCidView(
  ctx: CidViewReadContext,
  publication: string,
  opts: BuildCidViewOptions = {},
): Promise<PublicationCidView> {
  const now = opts.now ?? (() => new Date());
  const prev = opts.prev;

  // Incremental warm path — only when a complete baseline exists. An absent
  // meta block (pre-meta cached blob) or an incomplete one falls back to cold.
  if (prev?.meta?.complete === true) {
    return buildIncremental(ctx, publication, prev, now);
  }

  // Cold path: full rebuild, attaching a fresh meta block for the next refresh.
  // Defensive: allSettled even though every collector is fail-open (never throws).
  const results = await Promise.allSettled(COLLECTORS.map((collect) => collect(ctx, publication)));
  const grouped = results.map((r) => (r.status === 'fulfilled' ? r.value : []));

  // Meta counts over the merged (pre-dedupe) output so the 'current version'
  // entries that cross-collector dedupe folds into their deal/offer row still
  // count towards versionCounts / completeness.
  const preDeduped: CidEntry[] = [];
  for (const group of grouped) preDeduped.push(...group);

  const entries = mergeGroups(grouped);
  const view = assembleView(publication, now().toISOString(), entries);

  const snapshot = deriveDealCidSnapshot(view);
  view.meta = {
    complete: coldComplete(preDeduped),
    fingerprint: dealFingerprint(snapshot.deals, snapshot.offers),
    configCid: entries.find((e) => e.category === 'config')?.cid ?? '',
    siteRoot: entries.find((e) => e.category === 'site-root')?.cid ?? '',
    archiveRoot: entries.find((e) => e.category === 'archive')?.cid ?? '',
    versionCounts: deriveVersionCounts(preDeduped),
  };

  // Invariant: a composed view must always be structurally valid. A ZodError
  // here indicates a real composition bug — never a missing source.
  return parsePublicationCidView(view);
}
