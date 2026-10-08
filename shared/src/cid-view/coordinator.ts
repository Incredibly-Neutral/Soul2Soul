// cid-view coordinator — the composition root.
//
// Runs all four collectors (deals / config / tree / archive), merges their
// entries in a stable grouped order, dedupes cross-collector, computes the
// summary + sources flags, and validates the result before returning.
//
// Fail-open philosophy: collectors never throw, so this never throws for a
// missing/failed source — the only throw is parsePublicationCidView, which
// fires on a structural violation (a real invariant bug in the composition).
import type { CidViewReadContext } from './context';
import { collectDealCids } from './deals';
import { collectConfigCids } from './config';
import { collectTreeCids, collectArchiveCids } from './tree';
import type { CidCategory, CidEntry, PublicationCidView } from './types';
import { parsePublicationCidView } from './validation';

export interface BuildCidViewOptions {
  /** Clock override for tests; defaults to new Date(). */
  now?: () => Date;
}

/** Collector order — determines the stable merge order of the view. */
const COLLECTORS: ReadonlyArray<(ctx: CidViewReadContext, publication: string) => Promise<CidEntry[]>> = [
  collectDealCids,
  collectConfigCids,
  collectTreeCids,
  collectArchiveCids,
];

/**
 * Build the full PublicationCidView for a publication.
 *
 * @param ctx          read context (chain/IPFS adapters supplied by the consumer)
 * @param publication  ENS name, e.g. 's3ntiment.eth'
 * @param opts         optional clock override
 */
export async function buildPublicationCidView(
  ctx: CidViewReadContext,
  publication: string,
  opts: BuildCidViewOptions = {},
): Promise<PublicationCidView> {
  const now = opts.now ?? (() => new Date());

  // Defensive: allSettled even though every collector is fail-open (never throws).
  const results = await Promise.allSettled(
    COLLECTORS.map((collect) => collect(ctx, publication)),
  );
  const grouped = results.map((r) => (r.status === 'fulfilled' ? r.value : []));

  // Stable merge order: deals, config, tree, archive — grouped by collector.
  const merged: CidEntry[] = [];
  for (const group of grouped) merged.push(...group);

  // Cross-collector dedupe. Identity is *content* identity: cid + genesis + path.
  // category/source are roles (a content cid legitimately appears as a deal AND
  // an archive-item) so they are excluded — the same content referenced from
  // multiple collectors is listed once, keeping the first (richest) occurrence.
  const seen = new Set<string>();
  const entries: CidEntry[] = [];
  for (const entry of merged) {
    const key = `${entry.cid}\u0000${entry.genesis ?? ''}\u0000${entry.path ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }

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

  const view: PublicationCidView = {
    publication,
    generatedAt: now().toISOString(),
    entries,
    sources,
    summary: { total: entries.length, uniqueCids, byCategory },
  };

  // Invariant: a composed view must always be structurally valid. A ZodError
  // here indicates a real composition bug — never a missing source.
  return parsePublicationCidView(view);
}
