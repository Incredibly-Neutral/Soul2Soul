// cid-view ipfs-check transport client — the network + orchestration layer.
//
// This is the ONLY place in cid-view that talks to the network (INV-7: the
// parser in ./retrieval-parser.ts stays pure). It owns:
//   - checkBatch            : one POST /batch request, NDJSON streamed line-by-line
//   - statusFromCheckLine   : map one line to a CidRetrievabilityStatus
//   - checkRetrievability   : chunked batch orchestration, merging into prev,
//                             fail-open, with the cache injected (storage-agnostic)
//
// The user's self-hosted ipfs-check instance serves POST /batch with
// { cids: [...] } and streams one NDJSON line per checked cid as it finishes
// (deduped + checked in parallel server-side). A single batch request already
// returns the full per-cid report, so the shared per-source hasCopy runner
// (./retrievability.ts) is intentionally NOT used here.
//
// Outcome model (advice applied): instead of collapsing each provider to
// true/false, classify the PROBE into 'serves' / 'missing' / 'unreachable' and
// derive a per-cid CheckState ('ok' | 'no-providers' | 'inconclusive' |
// 'not-served' | 'failed'). The point: an overloaded check node returns
// providers as UNREACHABLE — that must read as "couldn't verify" (inconclusive),
// never as "no copies". So an inconclusive/failed pass keeps the last-known
// result (sources/copies/checkedAt) and only flags the state + lastError,
// which also keeps those cids unfresh so the next auto pass retries them.
//
// Fail-open by design (mirrors the shared core): a failed batch POST marks the
// chunk's cids 'failed' (keeping any last-known result) and the wrapper never
// throws; the cache adapters default to no-ops.
import { emptyStatus, type CidRetrievabilityMap, type CidRetrievabilityStatus, type CheckState } from './retrievability';
import type { PublicationCidView } from './types';
import { classifyProvider, type IpfsCheckProvider, type IpfsCheckRow } from './retrieval-parser';

/** Base URL of the user's self-hosted ipfs-check instance (overridable). */
export const IPFS_CHECK_ENDPOINT = 'https://ipfs-check.transport-union.dev';

/** Default CIDs per /batch POST when the caller doesn't override. */
const DEFAULT_RETRIEVABILITY_BATCH_SIZE = 50;

/** One NDJSON line of the /batch response (alias of the parser row type). */
export type IpfsCheckLine = IpfsCheckRow;

/** Storage adapters the batch orchestrator persists through. Injected so the
 *  shared core stays free of window/localStorage (browser-only concerns). */
export interface IpfsCheckBatchCache {
  /** Load the last-known retrievability map for a publication (null = none). */
  load(publication: string): CidRetrievabilityMap | null;
  /** Persist the map for a publication. */
  save(publication: string, map: CidRetrievabilityMap): void;
  /** Append one raw /batch response body to the debug log (bounded by the impl). */
  logRaw(publication: string, cids: number, raw: string): void;
}

const NO_OP_CACHE: IpfsCheckBatchCache = {
  load: () => null,
  save: () => undefined,
  logRaw: () => undefined,
};

/** Options for a single checkBatch POST. */
export interface CheckBatchOptions {
  /** Override the default endpoint (tests / mirrors). */
  endpoint?: string;
  signal?: AbortSignal;
  /** Called with the FULL raw response body once the stream completes (or errors). */
  onRaw?: (raw: string) => void;
}

/**
 * POST one batch of cids to the ipfs-check /batch endpoint and stream the
 * NDJSON response, invoking `onResult` once per line as each cid finishes
 * (the server checks the batch in parallel and streams results incrementally).
 */
export async function checkBatch(
  cids: readonly string[],
  onResult: (line: IpfsCheckRow) => void,
  options: CheckBatchOptions = {},
): Promise<void> {
  const res = await fetch(`${options.endpoint ?? IPFS_CHECK_ENDPOINT}/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cids }),
    signal: options.signal,
  });
  if (!res.ok || !res.body) throw new Error(`ipfs-check batch HTTP ${String(res.status)}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let raw = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      raw += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) onResult(JSON.parse(line) as IpfsCheckRow);
      }
    }
  } finally {
    // Deliver whatever made it across (a partial body on error is still useful).
    options.onRaw?.(raw);
  }
}

/**
 * Map one /batch NDJSON line to a CidRetrievabilityStatus.
 *
 * Provider probes are classified into outcomes ('serves' / 'missing' /
 * 'unreachable') and folded into a per-cid CheckState, so "no copies" is only
 * ever claimed when a provider was actually reached and confirmed missing.
 *
 * Conventions:
 *  - A row-level `error` field → state 'failed'; the previous result (or the
 *    empty baseline) is kept and only lastError/lastErrorAt are written, so a
 *    failed check never reads as lost data and the cid stays unfresh (retried
 *    by the next auto pass).
 *  - A NON-array `result` (e.g. MutableResolution for a non-CID input) is "no
 *    providers, NOT an error" — state 'no-providers' (deliberate divergence
 *    from parseRow, which synthesizes a hard error for it).
 *  - All providers UNREACHABLE → state 'inconclusive'; when a previous result
 *    exists it is preserved (sources/copies/checkedAt) and only flagged, so an
 *    overloaded check node never looks like the cid lost its copies.
 */
export function statusFromCheckLine(
  line: IpfsCheckRow,
  options: { now?: () => string; prev?: CidRetrievabilityStatus } = {},
): CidRetrievabilityStatus {
  const checkedAt = (options.now ?? (() => new Date().toISOString()))();

  // Check itself failed: keep the previous result (or empty baseline), flag it.
  if (line.error) {
    return {
      ...(options.prev ?? emptyStatus()),
      state: 'failed',
      lastError: line.error,
      lastErrorAt: checkedAt,
    };
  }

  const providers = Array.isArray(line.result) ? dedupeById(line.result) : [];
  if (providers.length === 0) {
    return { ...emptyStatus(), checkedAt, state: 'no-providers', providersFound: 0 };
  }

  const sources = emptyStatus().sources;
  for (const p of providers) {
    if (providerOutcome(p) !== 'serves') continue;
    for (const s of classifyProvider(p).platforms) sources[s] = true;
  }
  const copies = Object.values(sources).filter(Boolean).length;
  const state: CheckState =
    copies > 0
      ? 'ok'
      : providers.every((p) => providerOutcome(p) === 'unreachable')
        ? 'inconclusive'
        : 'not-served';

  // Could not reach ANY provider → no signal this pass. Keep the last-known
  // result and just flag it (inconclusive + lastErrorAt), so the cid stays
  // unfresh and the next auto pass retries it instead of painting it lost.
  if (state === 'inconclusive' && options.prev) {
    return {
      ...options.prev,
      state: 'inconclusive',
      providersFound: providers.length,
      ms: line.ms,
      lastError: 'all providers unreachable',
      lastErrorAt: checkedAt,
    };
  }

  return { checkedAt, copies, sources, state, providersFound: providers.length, ms: line.ms };
}

/** How one provider's probe resolved — the atom behind CheckState. */
export type ProviderOutcome = 'serves' | 'missing' | 'unreachable';

/**
 * Classify a single provider probe. 'serves' (Found in either protocol) wins
 * over everything else; a probe that errored out is 'unreachable' (we could not
 * reach it, so we know nothing) rather than 'missing'. The per-protocol Error
 * fields are treated as unreachable too — ipfs-check reports connection
 * failures there as often as in the top-level ConnectionError — so an
 * overloaded check node surfaces as inconclusive, never as "no copies".
 */
export function providerOutcome(p: IpfsCheckProvider): ProviderOutcome {
  if (p.DataAvailableOverBitswap?.Found || p.DataAvailableOverHTTP?.Found) return 'serves';
  if (p.ConnectionError || p.DataAvailableOverBitswap?.Error || p.DataAvailableOverHTTP?.Error) {
    return 'unreachable';
  }
  return 'missing';
}

/** Dedupe providers by ID, first occurrence wins. Providers without an ID are kept. */
function dedupeById(providers: readonly IpfsCheckProvider[]): IpfsCheckProvider[] {
  const seen = new Set<string>();
  const out: IpfsCheckProvider[] = [];
  for (const p of providers) {
    const id = p.ID ?? '';
    if (id !== '' && seen.has(id)) continue;
    if (id !== '') seen.add(id);
    out.push(p);
  }
  return out;
}

/** Options for a full chunked retrievability pass. */
export interface CheckRetrievabilityOptions {
  /** Override the baseline instead of loading from the cache. */
  prev?: CidRetrievabilityMap;
  /** Persistence adapters (default: no-op — nothing is stored). */
  cache?: IpfsCheckBatchCache;
  /** Called per cid as soon as its line streams in. */
  onResult?: (cid: string, status: CidRetrievabilityStatus) => void;
  /** CIDs per /batch POST (default 50). */
  batchSize?: number;
  signal?: AbortSignal;
  /** Override the default endpoint (tests / mirrors). */
  endpoint?: string;
}

/**
 * Check retrievability for the given cids via the ipfs-check batch endpoint,
 * chunked + streamed, merging into `prev` (default: the injected cache's
 * stored map). Unchecked cids in `prev` are preserved. Persists after each
 * chunk. Never throws — a failed chunk marks its cids with an error status.
 */
export async function checkRetrievability(
  publication: string,
  view: PublicationCidView,
  cids: readonly string[],
  options: CheckRetrievabilityOptions = {},
): Promise<CidRetrievabilityMap> {
  const cache: IpfsCheckBatchCache = options.cache ?? NO_OP_CACHE;
  const prev = options.prev ?? cache.load(publication) ?? {};
  // `view` is part of the public signature (the component passes its current
  // view) but the batch adapter no longer derives anything from it — ipfs-check
  // reports the serving providers directly.
  void view;
  const result: CidRetrievabilityMap = { ...prev };
  const batchSize = options.batchSize ?? DEFAULT_RETRIEVABILITY_BATCH_SIZE;
  const now = () => new Date().toISOString();

  if (cids.length === 0) {
    cache.save(publication, result);
    return result;
  }

  for (let i = 0; i < cids.length; i += batchSize) {
    const chunk = cids.slice(i, i + batchSize);
    // Cids in this chunk that never produced a line (failed before streaming
    // them, or the request errored) get an error status so they still record
    // checkedAt + error — fail-open.
    const failed = new Set(chunk);
    console.info(`[cid-view] retrievability batch ${String(chunk.length)} cids`);
    try {
      await checkBatch(
        chunk,
        (line) => {
          failed.delete(line.cid);
          const status = statusFromCheckLine(line, { prev: result[line.cid] });
          result[line.cid] = status;
          options.onResult?.(line.cid, status);
        },
        {
          signal: options.signal,
          endpoint: options.endpoint,
          onRaw: (raw) => {
            cache.logRaw(publication, chunk.length, raw);
          },
        },
      );
    } catch (err) {
      // An aborted pass (disconnect / recheck / publication switch) must NOT be
      // recorded as a per-cid error — rethrow so the caller's loop stops.
      if (options.signal?.aborted) throw err;
      const message = err instanceof Error && err.message !== '' ? err.message : String(err);
      for (const cid of failed) {
        // Keep any last-known result; flag the check as failed (retryable).
        const status: CidRetrievabilityStatus = {
          ...(result[cid] ?? emptyStatus()),
          state: 'failed',
          lastError: message,
          lastErrorAt: now(),
        };
        result[cid] = status;
        options.onResult?.(cid, status);
      }
    } finally {
      cache.save(publication, result);
    }
  }
  return result;
}
