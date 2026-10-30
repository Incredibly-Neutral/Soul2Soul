// shared heal primitive — pin a remote CID everywhere, transport-agnostic.
//
// Given a CID that lives on the remote kubo node ("remkubo"), make sure it is
// pinned across a provider array (default: kubo pin/add, pinata, filebase, and
// filecoin with 2 copies). Consumed by safe-app first (it flips its
// availability dots from `sources`), and elsewhere later.
//
// Transport-agnostic by design: the only network surface is WHATWG fetch +
// AbortSignal + performance — no Node/browser-only deps, no new dependencies.
// The kubo target is `config.source` (the remote kubo gateway, both the source
// for provider pulls AND the kubo pin target). Pinata/Filebase reuse the
// existing pinCidFromRemote primitive (see ../pin/index.ts) rather than
// reimplementing those providers.
//
// Fail-open: healCid NEVER rejects for a per-provider error — a throwing
// provider (network down, bad token, 5xx) marks that HealResult ok:false,
// records `error`, and the other providers still run. The outcome aggregates
// `ok` (every requested provider ok) and `partial` (some ok, some failed).
// Programming errors (a malformed config) may still surface.
import { pinCidFromRemote } from '../pin/index.js';

export type HealProvider = 'kubo' | 'pinata' | 'filebase' | 'filecoin';
export const HEAL_PROVIDERS: readonly HealProvider[] = ['kubo', 'pinata', 'filebase', 'filecoin'];

/**
 * Filecoin uploader: fetch the CAR for `cid` from `source` and commit >=2
 * Filecoin copies. Injected by the caller (safe-app wires the real one) so the
 * core stays dependency-free; when absent, filecoin heals fail with a clear
 * error instead of silently pretending.
 */
export interface HealFilecoinUploader {
  (cid: string, source: string): Promise<{
    pieceCid?: string;
    copyCount: number;
    copies?: Array<{ provider: string; dealId?: string }>;
  }>;
}

export interface HealConfig {
  /** Remote kubo gateway (source AND the kubo pin target), e.g. 'https://ipfs.transport-union.dev' (no trailing slash). */
  source: string;
  pinataJwt?: string;
  filebaseToken?: string;
  /** Raw kubo RPC bearer token (write auth for pin/add). */
  kuboToken?: string;
  /** Filecoin uploader (2 copies). When absent, filecoin heals fail with a clear error. */
  filecoin?: HealFilecoinUploader;
}

export interface HealResult {
  provider: HealProvider;
  ok: boolean;
  error?: string;
  ms?: number;
  pieceCid?: string; // filecoin only
  copyCount?: number; // filecoin only
  copies?: Array<{ provider: string; dealId?: string }>; // filecoin only
}

export interface HealOutcome {
  cid: string;
  results: HealResult[];
  ok: boolean; // every requested provider ok
  partial: boolean; // some ok, some failed
  /** Providers confirmed holding a copy after healing. */
  sources: Partial<Record<HealProvider, boolean>>;
}

export interface HealOptions {
  /** Max providers healed in parallel (default 2; 1 = serial). */
  concurrency?: number;
  /** Clock override, kept for parity with retrievability's now() so callers
   *  can pass one deterministic clock. The HealResult contract carries no
   *  timestamp today, so it is currently unused — reserved for API stability. */
  now?: () => Date;
}

/**
 * Pin `cid` from the remote kubo source across the requested providers.
 *
 * Fail-open: healCid never rejects for a per-provider error. Each provider is
 * attempted independently (concurrency-limited); a failure is recorded on that
 * HealResult and healing continues. Only a broken config (e.g. `source` that
 * isn't a string) can escape — and even then the offending provider alone
 * fails via the catch boundary.
 */
export async function healCid(
  cid: string,
  config: HealConfig,
  providers: readonly HealProvider[] = HEAL_PROVIDERS,
  options: HealOptions = {},
): Promise<HealOutcome> {
  const normalized = normalizeCid(cid);
  // Empty after normalization → nothing to heal. Return a non-throwing
  // outcome so callers can always `await` and inspect, never handle a throw.
  if (normalized === '') {
    return { cid, results: [], ok: false, partial: false, sources: {} };
  }

  const concurrency = options.concurrency ?? 2;
  const results = await mapWithLimit(providers, concurrency, (provider) =>
    healOne(normalized, provider, config),
  );

  const ok = results.every((r) => r.ok);
  const anyOk = results.some((r) => r.ok);
  // Sources safe-app flips its availability dots from: only confirmed-ok
  // providers count as holding a copy after this heal.
  const sources = {} as Partial<Record<HealProvider, boolean>>;
  for (const result of results) {
    if (result.ok) sources[result.provider] = true;
  }
  return { cid: normalized, results, ok, partial: anyOk && !ok, sources };
}

/** `.trim()`, then strip a leading `ipfs://` (and re-trim the residue). */
function normalizeCid(cid: string): string {
  const trimmed = cid.trim();
  const stripped = trimmed.startsWith('ipfs://') ? trimmed.slice('ipfs://'.length) : trimmed;
  return stripped.trim();
}

/** Heal a single CID against a single provider. Never rejects. */
async function healOne(
  cid: string,
  provider: HealProvider,
  config: HealConfig,
): Promise<HealResult> {
  const t0 = performance.now();
  try {
    switch (provider) {
      case 'kubo': {
        // Local pin metadata op on the remote node that already holds the
        // blocks — just records "keep this" on the kubo side.
        const url = `${config.source}/api/v0/pin/add?arg=${encodeURIComponent(cid)}`;
        const headers: Record<string, string> = {};
        if (config.kuboToken) headers.Authorization = `Bearer ${config.kuboToken}`;
        const response = await fetch(url, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          return {
            provider,
            ok: false,
            error: `kubo pin/add failed: ${response.status} ${response.statusText}`,
            ms: elapsed(t0),
          };
        }
        return { provider, ok: true, ms: elapsed(t0) };
      }
      case 'pinata': {
        const pinned = await pinCidFromRemote(cid, config.source, config.pinataJwt ?? '', 'pinata');
        return {
          provider,
          ok: pinned,
          // pinCidFromRemote swallows its own error into a false return; give
          // consumers at least a breadcrumb when it didn't pin.
          ...(pinned ? {} : { error: 'pinata pinCidFromRemote returned false' }),
          ms: elapsed(t0),
        };
      }
      case 'filebase': {
        const pinned = await pinCidFromRemote(
          cid,
          config.source,
          config.filebaseToken ?? '',
          'filebase',
        );
        return {
          provider,
          ok: pinned,
          ...(pinned ? {} : { error: 'filebase pinCidFromRemote returned false' }),
          ms: elapsed(t0),
        };
      }
      case 'filecoin': {
        if (!config.filecoin) {
          return { provider, ok: false, error: 'no filecoin uploader configured', ms: elapsed(t0) };
        }
        const result = await config.filecoin(cid, config.source);
        const ok = result.copyCount >= 2; // the "2x filecoin" guarantee
        const heal: HealResult = { provider, ok, ms: elapsed(t0) };
        if (result.pieceCid !== undefined) heal.pieceCid = result.pieceCid;
        if (result.copies !== undefined) heal.copies = result.copies;
        // copyCount is required on the uploader result; still record defensively.
        heal.copyCount = result.copyCount;
        if (!ok) heal.error = `filecoin uploader returned ${result.copyCount} copy/copies (need >= 2)`;
        return heal;
      }
    }
  } catch (err) {
    return { provider, ok: false, error: errorMessage(err), ms: elapsed(t0) };
  }
}

function elapsed(t0: number): number {
  return Math.round(performance.now() - t0);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message;
  return String(err);
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * input order in the result. Mirrors the mapWithLimit pattern in
 * retrievability.ts / tree.ts / config.ts / deals.ts (result-returning variant).
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(items.length);
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
