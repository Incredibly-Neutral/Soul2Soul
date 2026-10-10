// cid-view ipfs-check NDJSON retrievability parser.
//
// Parses the ipfs-check /batch NDJSON shape into a structured per-CID
// retrievability verdict: which platforms (kubo / pinata / filebase / filecoin)
// currently hold a copy, the number of copies, provider totals, plus category
// aggregates and actionable lists (missing everywhere / single copy). This is
// the single source of truth that later replaces safe-app's inline classifier.
//
// Pure module: NO fetch / network / viem / zod (INV-7 discipline — consistent
// with the rest of cid-view). Everything here is unit-testable.
//
// ipfs-check /batch shape (verified live): one NDJSON line per CID,
//   {"cid":"<cid>","ms":123,"result": <ProviderProbe[] | object>}
// `result` is an array of provider objects normally; when the input is a
// non-CID or resolution fails it is a plain object (e.g. {"MutableResolution":
// {...}}) — a non-array `result` is treated as: no providers, all sources
// false, copies 0, error set.
//
// Classification rules (empirically validated — do not invent others):
//   1. served = DataAvailableOverBitswap.Found === true OR
//      DataAvailableOverHTTP.Found === true (HTTP checks are enabled upstream
//      via httpRetrieval=on).
//   2. hay = lowercased join of ID + ' ' + Addrs.join(' ') + ' ' +
//      ConnectionMaddrs.join(' ') + ' ' + AgentVersion. NOT Source.
//   3. Platforms: kubo (hay matches /kubo|go-ipfs/), pinata (hay has
//      "pinata"), filebase (hay has "filebase"), filecoin (an Addr host is one
//      of FILECOIN_SP_HOSTS, or AgentVersion matches FILECOIN_AGENT_RE).
//   4. One provider may set multiple platform flags; per CID each platform
//      flag is set at most once (OR across all SERVING providers).
//   5. copies = number of true sources values (0..4).
//   6. Non-array `result`: totalProviders 0, servingProviders 0, all sources
//      false, copies 0, error = short description.
//   7. A row-level `error` field or a provider ConnectionError does NOT mean
//      "failed probe" by itself — a provider that still has Found:true in
//      either protocol served. Only an absent/object `result` is a hard error.
import { RETRIEVABILITY_SOURCES, type CidRetrievabilityStatus, type RetrievabilitySource } from './retrievability';
import type { CidCategory, PublicationCidView } from './types';

/** Hostnames of our known Filecoin storage-provider gateways (SP -> platform). */
export const FILECOIN_SP_HOSTS: readonly string[] = [
  'curio.akave.xyz', // Angelo (Synapse SP 13)
  'main.ezpdpz.net', // ezpdpz-main (SP 1)
  'main2.ezpdpz.net', // ezpdpz-main2 (SP 32)
  'foc.dealbot.site', // foc-mainnet (SP 30)
  'pdp-main.topblocks.io', // TopBlocks (SP 15)
  'pdp.lotus.dedyn.io', // Mongo2Stor (SP 5)
];

/** Filecoin client agents (boost/lotus/venus/fvm/spade). */
export const FILECOIN_AGENT_RE = /boost|lotus|venus|fvm|spade/i;

/** One provider probe object from an ipfs-check row. All fields optional + loose. */
export interface IpfsCheckProvider {
  ID?: string;
  ConnectionError?: string;
  Addrs?: string[];
  ConnectionMaddrs?: string[];
  DataAvailableOverBitswap?: { Found?: boolean; Error?: string; [k: string]: unknown };
  DataAvailableOverHTTP?: { Found?: boolean; [k: string]: unknown };
  BrowserCheck?: unknown;
  Source?: string;
  AgentVersion?: string;
  [k: string]: unknown;
}

/** One NDJSON line of the /batch response. */
export interface IpfsCheckRow {
  cid: string;
  ms?: number;
  result: unknown;
  error?: string;
}

/** Classification of a single provider probe. */
export interface ParsedProvider {
  id: string;
  addrs: string[];
  agent: string;
  source: string;
  servedBitswap: boolean;
  servedHttp: boolean;
  served: boolean;
  platforms: RetrievabilitySource[];
}

/** Per-CID verdict derived from a /batch row. */
export interface ParsedCidRetrievability {
  cid: string;
  ms?: number;
  totalProviders: number;
  servingProviders: number;
  sources: Record<RetrievabilitySource, boolean>;
  copies: number;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptySources(): Record<RetrievabilitySource, boolean> {
  return { kubo: false, pinata: false, filebase: false, filecoin: false };
}

function countTrueSources(sources: Record<RetrievabilitySource, boolean>): number {
  let count = 0;
  for (const source of RETRIEVABILITY_SOURCES) {
    if (sources[source]) count += 1;
  }
  return count;
}

/**
 * Host of a multiaddr or URL ("" when none). Handles the addr forms observed
 * live: /dns4/<host>/..., /dns/<host>/..., /dnsaddr/<host>, and https:// URLs.
 * IP addrs (/ip4/...) return "" and can never match a Filecoin SP hostname.
 */
function hostOf(addr: string): string {
  const trimmed = addr.trim();
  if (trimmed === '') return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return '';
    }
  }
  if (trimmed.startsWith('/')) {
    const m = /^\/dns(?:4|6|addr)?\/([^/]+)/i.exec(trimmed);
    return m ? m[1] : '';
  }
  return '';
}

/** True when an addr's host is one of our known Filecoin SP gateways. */
function hostIsFilecoinSp(addr: string): boolean {
  const host = hostOf(addr);
  return host !== '' && FILECOIN_SP_HOSTS.includes(host);
}

/** Short description for a non-array `result` (the hard-error case). */
function describeBadResult(result: unknown): string {
  if (result === undefined) return 'invalid result: missing providers array';
  if (isRecord(result)) {
    const keys = Object.keys(result);
    const detail = keys.length > 0 ? ` (${keys.join(', ')})` : '';
    return `invalid result: expected providers array, got object${detail}`;
  }
  return `invalid result: expected providers array, got ${typeof result}`;
}

/**
 * Classify a single provider probe. Pure — never throws. `platforms` are the
 * platforms this provider belongs to regardless of whether it served; the
 * per-CID verdict only ORs platforms of providers that actually served.
 */
export function classifyProvider(provider: IpfsCheckProvider): ParsedProvider {
  const addrs = Array.isArray(provider.Addrs) ? provider.Addrs : [];
  const maddrs = Array.isArray(provider.ConnectionMaddrs) ? provider.ConnectionMaddrs : [];
  const id = provider.ID ?? '';
  const agent = provider.AgentVersion ?? '';
  const source = provider.Source ?? '';

  const hay = [id, ...addrs, ...maddrs, agent].join(' ').toLowerCase();
  const servedBitswap = provider.DataAvailableOverBitswap?.Found === true;
  const servedHttp = provider.DataAvailableOverHTTP?.Found === true;

  const platforms = new Set<RetrievabilitySource>();
  if (/kubo|go-ipfs/.test(hay)) platforms.add('kubo');
  if (hay.includes('pinata')) platforms.add('pinata');
  if (hay.includes('filebase')) platforms.add('filebase');
  if (addrs.some(hostIsFilecoinSp) || FILECOIN_AGENT_RE.test(agent)) {
    platforms.add('filecoin');
  }

  return {
    id,
    addrs: [...addrs],
    agent,
    source,
    servedBitswap,
    servedHttp,
    served: servedBitswap || servedHttp,
    platforms: [...platforms],
  };
}

/**
 * Parse one /batch row into a per-CID verdict. Never throws. A non-object row,
 * an absent/object `result`, or an unparseable shape degrades to a hard-error
 * verdict (all sources false, copies 0, error set) instead of crashing.
 */
export function parseRow(row: unknown): ParsedCidRetrievability {
  if (!isRecord(row)) {
    return {
      cid: '',
      totalProviders: 0,
      servingProviders: 0,
      sources: emptySources(),
      copies: 0,
      error: 'invalid row: expected an object',
    };
  }

  const cid = typeof row.cid === 'string' ? row.cid : '';
  const ms = typeof row.ms === 'number' ? row.ms : undefined;
  const rowError = typeof row.error === 'string' && row.error !== '' ? row.error : undefined;
  const result = row.result;

  if (!Array.isArray(result)) {
    return {
      cid,
      ms,
      totalProviders: 0,
      servingProviders: 0,
      sources: emptySources(),
      copies: 0,
      error: rowError ?? describeBadResult(result),
    };
  }

  const providers = result.map((p) => classifyProvider(p as IpfsCheckProvider));
  const sources = emptySources();
  for (const p of providers) {
    if (!p.served) continue;
    for (const source of p.platforms) {
      sources[source] = true;
    }
  }

  const parsed: ParsedCidRetrievability = {
    cid,
    ms,
    totalProviders: providers.length,
    servingProviders: providers.filter((p) => p.served).length,
    sources,
    copies: countTrueSources(sources),
  };
  if (rowError !== undefined) parsed.error = rowError;
  return parsed;
}

/**
 * Parse a full /batch NDJSON body (one JSON object per line) into per-CID
 * verdicts, one per non-blank line, in line order. Never throws: a line that
 * fails JSON.parse becomes a hard-error verdict. Blank lines are skipped.
 */
export function parseBatchNdjson(text: string): ParsedCidRetrievability[] {
  const rows: ParsedCidRetrievability[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      rows.push({
        cid: '',
        totalProviders: 0,
        servingProviders: 0,
        sources: emptySources(),
        copies: 0,
        error: 'invalid JSON line',
      });
      continue;
    }
    rows.push(parseRow(row));
  }
  return rows;
}

/**
 * Bridge a parsed verdict to the T4a CidRetrievabilityStatus contract (imported
 * from ./retrievability). checkedAt = now().toISOString() (clock injectable for
 * tests), copies and sources copied, error carried when set.
 */
export function toCidRetrievabilityStatus(
  parsed: ParsedCidRetrievability,
  now: () => Date = () => new Date(),
): CidRetrievabilityStatus {
  const status: CidRetrievabilityStatus = {
    checkedAt: now().toISOString(),
    copies: parsed.copies,
    sources: { ...parsed.sources },
  };
  if (parsed.error !== undefined) status.error = parsed.error;
  return status;
}

/** Per-category rollup of a retrievability verdict map against a view. */
export interface CategoryAggregate {
  total: number; // view entries in this category
  serving: number; // entries whose cid has copies >= 1
  singleCopy: number; // entries whose cid has copies === 1
  missing: number; // entries whose cid has copies === 0 (unknown == missing)
}

/** Aggregate retrievability across a whole publication view. */
export interface RetrievabilityAggregate {
  total: number;
  serving: number;
  singleCopy: number;
  missing: number;
  byCategory: Partial<Record<CidCategory, CategoryAggregate>>;
  /** CIDs with copies === 0, deduped, first-appearance order. */
  missingCids: string[];
  /** CIDs with copies === 1, deduped. */
  singleCopyCids: string[];
}

/**
 * Aggregate a status map (keyed by cid) against a publication view. CIDs not
 * present in `status` count as missing (unknown = not verified = treat as
 * missing). Per category, counts view entries: serving = cid copies >= 1,
 * singleCopy = copies === 1, missing = copies === 0. The actionable cid lists
 * are deduped across entries — a cid appearing as both site-root and site-file
 * counts once in the lists, but each entry still counts in its category.
 * Pure — never mutates inputs.
 */
export function aggregateRetrievability(
  view: PublicationCidView,
  status: Record<string, CidRetrievabilityStatus>,
): RetrievabilityAggregate {
  const byCategory: Partial<Record<CidCategory, CategoryAggregate>> = {};
  const missingCids: string[] = [];
  const singleCopyCids: string[] = [];
  const seenMissing = new Set<string>();
  const seenSingle = new Set<string>();
  let total = 0;
  let serving = 0;
  let singleCopy = 0;
  let missing = 0;

  for (const entry of view.entries) {
    const cid = entry.cid.trim();
    if (cid === '') continue;
    total += 1;

    // Distinguish "verified with 0 copies" from "never checked" — both are
    // missing for our purposes, but the map lookup must be explicit.
    const st = cid in status ? status[cid] : undefined;
    const copies = st === undefined ? 0 : st.copies;

    const agg = byCategory[entry.category] ?? { total: 0, serving: 0, singleCopy: 0, missing: 0 };
    agg.total += 1;
    if (copies >= 1) {
      serving += 1;
      agg.serving += 1;
    } else {
      missing += 1;
      agg.missing += 1;
    }
    if (copies === 1) {
      singleCopy += 1;
      agg.singleCopy += 1;
    }
    byCategory[entry.category] = agg;

    if (copies === 0 && !seenMissing.has(cid)) {
      seenMissing.add(cid);
      missingCids.push(cid);
    }
    if (copies === 1 && !seenSingle.has(cid)) {
      seenSingle.add(cid);
      singleCopyCids.push(cid);
    }
  }

  return { total, serving, singleCopy, missing, byCategory, missingCids, singleCopyCids };
}
