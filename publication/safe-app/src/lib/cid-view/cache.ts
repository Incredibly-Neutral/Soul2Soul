// src/lib/cid-view/cache.ts — localStorage persistence for the retrievability
// pass (split out of the former single-file src/lib/cid-view.ts).
//
// The shared batch client (shared/src/cid-view/ipfs-check-client.ts) persists
// through an injected IpfsCheckBatchCache; these adapters wire it to
// localStorage. Fail-open by design: missing/corrupt/schema-invalid blobs,
// quota errors and privacy mode all degrade to null/no-op — never throw.
import { parseCidRetrievabilityMap } from '@s2s/soul2soul-shared/safe-app';
import type { CidRetrievabilityMap } from '@s2s/soul2soul-shared/safe-app';

/** localStorage prefix for the per-publication retrievability snapshot. */
const RETRIEVABILITY_CACHE_PREFIX = 's2s.cidview.';

/** Raw /batch response log — a bounded debug aid to distinguish "the response
 *  really was empty" from "the parser misread it". Recent batches only, each
 *  entry truncated to RAW_BATCH_LOG_MAX_RAW chars. */
const RAW_BATCH_LOG_MAX_ENTRIES = 8;
const RAW_BATCH_LOG_MAX_RAW = 200_000;

interface RawBatchEntry {
  at: string; // ISO timestamp of the batch POST
  cids: number; // cids requested in this /batch call
  bytes: number; // raw chars stored (after truncation)
  raw: string; // full NDJSON response body
}

function rawBatchLogKey(publication: string): string {
  return RETRIEVABILITY_CACHE_PREFIX + publication + '.rawbatch';
}

/**
 * Append one raw /batch response body to the per-publication raw log in
 * localStorage (bounded ring buffer). Fail-open: quota errors and corrupt
 * blobs degrade to a console.warn, never throw.
 */
export function appendRawBatchLog(publication: string, cids: number, raw: string): void {
  try {
    const key = rawBatchLogKey(publication);
    let log: RawBatchEntry[] = [];
    const existing = window.localStorage.getItem(key);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as unknown;
        if (Array.isArray(parsed)) log = parsed as RawBatchEntry[];
      } catch {
        log = [];
      }
    }
    const truncated =
      raw.length > RAW_BATCH_LOG_MAX_RAW
        ? `${raw.slice(0, RAW_BATCH_LOG_MAX_RAW)}\n…[truncated ${String(raw.length - RAW_BATCH_LOG_MAX_RAW)} chars]`
        : raw;
    log.push({ at: new Date().toISOString(), cids, bytes: truncated.length, raw: truncated });
    if (log.length > RAW_BATCH_LOG_MAX_ENTRIES) log = log.slice(-RAW_BATCH_LOG_MAX_ENTRIES);
    const blob = JSON.stringify(log);
    try {
      window.localStorage.setItem(key, blob);
    } catch {
      // Quota exceeded (large batches): drop the oldest half and retry once.
      log = log.slice(-Math.ceil(RAW_BATCH_LOG_MAX_ENTRIES / 2));
      window.localStorage.setItem(key, JSON.stringify(log));
    }
    console.info(`[cid-view] raw /batch logged: ${String(cids)} cids, ${String(truncated.length)} bytes (${key})`);
  } catch (err) {
    console.warn('[cid-view] raw /batch log skipped', err instanceof Error ? err.message : String(err));
  }
}

function retrievabilityCacheKey(publication: string): string {
  return RETRIEVABILITY_CACHE_PREFIX + publication + '.retrievability';
}

/**
 * Read the last-known retrievability map for a publication from localStorage.
 * Fail-open: missing key, corrupt JSON or a JSON-valid but schema-invalid blob
 * (rejected by the shared parseCidRetrievabilityMap) all degrade to null,
 * mirroring loadCachedView.
 */
export function loadRetrievabilityMap(publication: string): CidRetrievabilityMap | null {
  try {
    const key = retrievabilityCacheKey(publication);
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      console.info(`[cid-view] retrievability cache MISS (${key})`);
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      console.info(`[cid-view] retrievability cache miss: non-object blob (${key})`);
      return null;
    }
    const map = parseCidRetrievabilityMap(parsed);
    console.info(
      `[cid-view] retrievability cache HIT: ${String(Object.keys(map).length)} statuses, ${String(raw.length)} bytes (${key})`,
    );
    return map;
  } catch {
    return null;
  }
}

/** Persist a retrievability map for a publication. Fail-open (storage full / privacy mode). */
export function saveRetrievabilityMap(publication: string, map: CidRetrievabilityMap): void {
  try {
    const raw = JSON.stringify(map);
    window.localStorage.setItem(retrievabilityCacheKey(publication), raw);
    console.info(
      `[cid-view] retrievability cache SAVED ${String(Object.keys(map).length)} statuses, ${String(raw.length)} bytes`,
    );
  } catch (err) {
    // The cache is best-effort — but surface a console warning so a storage
    // failure (sandboxed iframe / quota) is diagnosable rather than silent.
    console.warn('[cid-view] retrievability cache save FAILED:', err instanceof Error ? err.message : String(err));
  }
}
