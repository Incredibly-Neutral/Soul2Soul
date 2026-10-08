// cid-view deals collector — inventories every CID a publication uses from its
// deal/offer ledger plus the full per-genesis version history.
//
// Best-effort by design: the view is a read-only inventory, so a failing
// sub-call (getDeals / getOffers / getVersions) yields FEWER entries, never a
// throw that would sink the whole publication. Pure function: it only calls the
// ctx read-context methods — no chain/IPFS access.
import type { CidEntry, DealRead } from './types';
import type { CidViewReadContext } from './context';

// Contract note: DealRead.timestamp / VersionRead.timestamp are unix seconds
// (numbers). The concrete adapter maps any on-chain bigints → Number before it
// reaches us, so we pass timestamps through untouched.

/** Version history for one genesis → '*-version' CidEntries (or [] on failure). */
async function versionsFor(
  ctx: CidViewReadContext,
  genesis: string,
  category: 'deal-version' | 'offer-version',
): Promise<CidEntry[]> {
  let versions: Awaited<ReturnType<CidViewReadContext['getVersions']>> = [];
  try {
    versions = await ctx.getVersions(genesis);
  } catch {
    return [];
  }
  // getVersions returns the FULL history, index 0..n-1, last = current.
  return versions.map((v, i, arr) => ({
    cid: v.cid,
    category,
    source: 'deals' as const,
    genesis,
    timestamp: v.timestamp,
    tombstoned: v.tombstone || undefined,
    note: i === arr.length - 1 ? 'current version' : undefined,
  }));
}

export async function collectDealCids(ctx: CidViewReadContext): Promise<CidEntry[]> {
  const entries: CidEntry[] = [];

  let deals: DealRead[] = [];
  try {
    deals = await ctx.getDeals();
  } catch {
    deals = [];
  }

  let offers: DealRead[] = [];
  try {
    offers = await ctx.getOffers();
  } catch {
    offers = [];
  }

  for (const deal of deals) {
    entries.push({
      cid: deal.cid,
      category: 'deal',
      source: 'deals',
      genesis: deal.genesis,
      author: deal.author,
      timestamp: deal.timestamp,
    });
    // eslint-disable-next-line no-await-in-loop
    entries.push(...(await versionsFor(ctx, deal.genesis, 'deal-version')));
  }

  for (const offer of offers) {
    entries.push({
      cid: offer.cid,
      category: 'offer',
      source: 'deals',
      genesis: offer.genesis,
      author: offer.author,
      timestamp: offer.timestamp,
    });
    // eslint-disable-next-line no-await-in-loop
    entries.push(...(await versionsFor(ctx, offer.genesis, 'offer-version')));
  }

  return dedupe(entries);
}

/** Drop exact duplicates (same cid + category + genesis), preserving first-seen order. */
function dedupe(entries: CidEntry[]): CidEntry[] {
  const seen = new Set<string>();
  const out: CidEntry[] = [];
  for (const e of entries) {
    const key = `${e.cid}\u0000${e.category}\u0000${e.genesis ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
