// src/lib/cid-view.ts — safe-app context adapter for the shared cid-view module.
//
// Builds the concrete `CidViewReadContext` (chain + IPFS transports) the
// shared cid-view collectors need, from the safe-app's existing clients:
//   - deals/offers/versions : SafeIntegration.publicationModule (ethers v6)
//   - config                : store `config` record → S2SIPFSMethods.fetchFromKubo
//   - ENS text reads        : evmRead on the L2 ENS records contract
//   - dagGet                : S2SIPFSMethods.dagGet
//   - ls/cat                : raw Kubo gateway POSTs (same as website-tree-tab)
//
// Fail-open by design (mirrors the shared collectors): every method degrades
// to []/''/{}/null on a missing module, record or network failure so the CID
// inventory never throws and never sinks the Storage tab.
import {
  S2SIPFSMethods,
  buildPublicationCidView,
  parseCidRetrievabilityMap,
} from '@s2s/soul2soul-shared/safe-app';
import type {
  CidRetrievabilityMap,
  CidRetrievabilityStatus,
  CidViewReadContext,
  DealRead,
  PublicationCidView,
  RetrievabilitySource,
  VersionRead,
} from '@s2s/soul2soul-shared/safe-app';
import type { S2SProtocolInfo } from '@s2s/soul2soul-shared/safe-app';
import { keccak256, toBytes } from 'viem';
import type { SafeIntegration } from './safe-integration.js';
import { evmRead } from './evm.js';
import { store } from '../state/index.js';
import { IPFS_URL } from './ipfs-fs.factory.js';

/** Minimal getText ABI for the L2 ENS records contract (exact s2s-app pattern). */
const RECORDS_CONTRACT_ABI = ['function getText(bytes32 node, string key) view returns (string)'];

/**
 * Normalise a string reference to a bytes32 hex id — local mirror of the
 * shared identity helper, implemented with viem so we never touch the root
 * shared barrel (which pulls in identity/contract-id and its global ethers).
 * - already 0x-prefixed 64-hex → passed through lowercased
 * - otherwise → keccak256 of the UTF-8 bytes
 */
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
function toBytes32Id(ref: string): string {
  const t = ref.trim();
  return HEX32_RE.test(t) ? t.toLowerCase() : keccak256(toBytes(t));
}

/** Hard cap on versions walked per genesis (pathological-history guard). */
const MAX_VERSIONS = 100;
/** Max parallel getVersion reads within one genesis (worker pool). */
const VERSION_READ_CONCURRENCY = 8;
/** Kubo ls timeout, matching s2s-website-tree-tab.ts. */
const LS_TIMEOUT_MS = 15_000;
/** Kubo cat timeout — the previously-missing timeout, same pattern as ls. */
const CAT_TIMEOUT_MS = 30_000;
/** Phase considered SLOW (>=10s) — highlighted with a console.warn. */
const SLOW_MS = 10_000;

/**
 * Per-phase timing log for the CID inventory walk. Always console.info; when a
 * phase exceeds SLOW_MS it switches to a console.warn to visually flag a stall.
 */
function logPhase(label: string, ms: number, detail?: string) {
  const suffix = detail ? ` ${detail}` : '';
  if (ms >= SLOW_MS) console.warn(`[cid-view] SLOW ${label} ${String(Math.round(ms))}ms${suffix}`);
  else console.info(`[cid-view] ${label} ${String(Math.round(ms))}ms${suffix}`);
}

/** Single shared Kubo client — same args as s2s-records-tab makeIPFS(). */
function makeIPFS(): S2SIPFSMethods {
  return new S2SIPFSMethods(
    'https://ipfs.transport-union.dev',
    import.meta.env.VITE_PINATA_JWT,
    'https://neutralpress.mypinata.cloud',
    import.meta.env.VITE_FILEBASE_TOKEN || '',
  );
}

/** Map a raw deal/offer row ({timestamp: bigint}) to a DealRead (number). */
function toDealRead(
  row: { genesis: string; author: string; cid: string; timestamp: bigint },
  status: 'deal' | 'offer',
): DealRead {
  return {
    genesis: row.genesis,
    author: row.author,
    cid: row.cid,
    timestamp: Number(row.timestamp),
    status,
  };
}

/**
 * Structural type for the publication-module contract surface the version
 * readers use. The safe-app stores the module as `any` (an ethers Contract);
 * casting to this narrow shape keeps the unsafe reads local and typed.
 */
interface PublicationModule {
  getVersionCount(id: string): Promise<bigint>;
  getVersion(
    id: string,
    index: number,
  ): Promise<{
    cid: string;
    timestamp: bigint;
    tombstone: boolean;
  }>;
}

/** Map `fn` over `items` with at most `limit` promises in flight, preserving input order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Build a CidViewReadContext over the safe-app's SafeIntegration + protocol
 * info. The returned context is transport-complete — the shared coordinator
 * can be run against it directly.
 */
export function buildSafeAppCidViewContext(args: {
  safeIntegration: SafeIntegration;
  protocolInfo: S2SProtocolInfo;
}): CidViewReadContext {
  const { safeIntegration, protocolInfo } = args;
  const ipfs = makeIPFS();

  // Version range reads are held as a local rather than a context method so
  // getVersions can call it without going through the read-context interface,
  // whose incremental primitives are optional for the shared test fakes.
  const getVersionsRange = async (
    genesis: string,
    fromIndex: number,
    count?: number,
  ): Promise<VersionRead[]> => {
    const t0 = performance.now();
    try {
      const publicationModule = safeIntegration.publicationModule as PublicationModule | null;
      if (!publicationModule) {
        logPhase('getVersionsRange', performance.now() - t0, `genesis=${genesis} no-module`);
        return [];
      }
      const id = toBytes32Id(genesis);
      // count (the caller's already-fetched on-chain version count) skips the
      // redundant internal count read; when absent we read it ourselves (cold
      // getVersions path). The count<=0 → [] guard applies either way.
      const total = count ?? Number(await publicationModule.getVersionCount(id));
      if (!Number.isFinite(total) || total <= 0) {
        logPhase(
          'getVersionsRange',
          performance.now() - t0,
          `genesis=${genesis} from=${String(fromIndex)} count=0`,
        );
        return [];
      }
      const start = Math.max(0, Math.floor(fromIndex));
      const limit = Math.min(total, MAX_VERSIONS);
      const indices: number[] = [];
      for (let i = start; i < limit; i++) indices.push(i);
      const versions = await mapWithLimit(indices, VERSION_READ_CONCURRENCY, async (i) => {
        const v = await publicationModule.getVersion(id, i);
        return {
          cid: v.cid,
          timestamp: Number(v.timestamp),
          tombstone: v.tombstone,
        };
      });
      logPhase(
        'getVersionsRange',
        performance.now() - t0,
        `genesis=${genesis} from=${String(fromIndex)} count=${String(versions.length)}`,
      );
      return versions;
    } catch {
      logPhase('getVersionsRange', performance.now() - t0, 'failed');
      return [];
    }
  };

  return {
    async getDeals() {
      const t0 = performance.now();
      try {
        const { deals } = await safeIntegration.getAllDealsAndOffers();
        const result = deals.map((d) => toDealRead(d, 'deal'));
        logPhase('getDeals', performance.now() - t0, `${String(result.length)} deals`);
        return result;
      } catch (error) {
        // Rethrow: the shared collectors are the fail-open boundary (cold
        // collectDealCids catches → [], incremental catches → prev-derived +
        // complete:false). Swallowing here would mask the failure from the
        // incremental collector, which relies on the throw to flag incomplete.
        logPhase('getDeals', performance.now() - t0, 'failed');
        throw error;
      }
    },

    async getOffers() {
      const t0 = performance.now();
      try {
        const { offers } = await safeIntegration.getAllDealsAndOffers();
        const result = offers.map((o) => toDealRead(o, 'offer'));
        logPhase('getOffers', performance.now() - t0, `${String(result.length)} offers`);
        return result;
      } catch (error) {
        // Rethrow (see getDeals above).
        logPhase('getOffers', performance.now() - t0, 'failed');
        throw error;
      }
    },

    async getVersionCount(genesis: string) {
      const t0 = performance.now();
      try {
        const publicationModule = safeIntegration.publicationModule as PublicationModule | null;
        if (!publicationModule) {
          logPhase('getVersionCount', performance.now() - t0, `genesis=${genesis} no-module`);
          return 0;
        }
        const id = toBytes32Id(genesis);
        const count = Number(await publicationModule.getVersionCount(id));
        logPhase(
          'getVersionCount',
          performance.now() - t0,
          `genesis=${genesis} count=${String(count)}`,
        );
        return Number.isFinite(count) && count > 0 ? count : 0;
      } catch {
        logPhase('getVersionCount', performance.now() - t0, 'failed');
        return 0;
      }
    },

    getVersionsRange,

    async getVersions(genesis: string) {
      const t0 = performance.now();
      // Reimplemented on top of the count + getVersionsRange(genesis, 0)
      // primitives so the cold path also gets within-genesis parallelism.
      // All-or-nothing per genesis: getVersionsRange returns [] on a missing
      // module, count 0, or any read failure — which preserves the count-0
      // completeness signal the incremental collector relies on.
      const versions = await getVersionsRange(genesis, 0);
      logPhase(
        'getVersions',
        performance.now() - t0,
        `genesis=${genesis} ${String(versions.length)} versions`,
      );
      return versions;
    },

    async getConfig() {
      const t0 = performance.now();
      const configCid = store.getRecord('config');
      if (!configCid) {
        logPhase('getConfig', performance.now() - t0, 'no-config');
        return { cid: '', config: {} };
      }
      try {
        const config = await ipfs.fetchFromKubo(configCid);
        logPhase('getConfig', performance.now() - t0, `cid=${configCid}`);
        return { cid: configCid, config: config ?? {} };
      } catch {
        logPhase('getConfig', performance.now() - t0, 'failed');
        return { cid: configCid, config: {} };
      }
    },

    async getEnsText(node: string, key: string) {
      const t0 = performance.now();
      if (!protocolInfo?.ensRecords) {
        logPhase('getEnsText', performance.now() - t0, `key=${key} no-ens-records`);
        return '';
      }
      try {
        const value = (await evmRead(
          8453,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'getText',
          [node, key],
        )) as string;
        logPhase('getEnsText', performance.now() - t0, `key=${key} len=${String(value.length)}`);
        return value;
      } catch {
        logPhase('getEnsText', performance.now() - t0, 'failed');
        return '';
      }
    },

    async dagGet(cid: string) {
      const t0 = performance.now();
      try {
        const result = (await ipfs.dagGet(cid)) as unknown;
        const size = Array.isArray(result) ? `${String(result.length)} entries` : 'ok';
        logPhase('dagGet', performance.now() - t0, `cid=${cid} ${size}`);
        return result;
      } catch {
        logPhase('dagGet', performance.now() - t0, `cid=${cid} failed`);
        return null;
      }
    },

    async ls(cid: string) {
      const t0 = performance.now();
      try {
        const url = `${IPFS_URL}/api/v0/ls?arg=${encodeURIComponent(cid)}`;
        const res = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(LS_TIMEOUT_MS),
        });
        if (!res.ok) {
          logPhase('ls', performance.now() - t0, `cid=${cid} http=${String(res.status)}`);
          return [];
        }
        const data = (await res.json()) as {
          Objects?: { Links?: Array<{ Name: string; Hash: string; Size: number }> | null }[];
        };
        const links = data.Objects?.[0]?.Links;
        // A file/leaf returns Links: [] (or missing) → treat as a leaf.
        if (!Array.isArray(links) || links.length === 0) {
          logPhase('ls', performance.now() - t0, `cid=${cid} 0 links`);
          return [];
        }
        const result = links.map((l) => ({
          name: l.Name,
          hash: l.Hash,
          size: l.Size ?? 0,
        }));
        logPhase('ls', performance.now() - t0, `cid=${cid} ${String(result.length)} links`);
        return result;
      } catch {
        logPhase('ls', performance.now() - t0, `cid=${cid} failed`);
        return [];
      }
    },

    async cat(cid: string) {
      const t0 = performance.now();
      try {
        const url = `${IPFS_URL}/api/v0/cat?arg=${encodeURIComponent(cid)}`;
        const res = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(CAT_TIMEOUT_MS),
        });
        if (!res.ok) {
          logPhase('cat', performance.now() - t0, `cid=${cid} http=${String(res.status)}`);
          return '';
        }
        const text = await res.text();
        logPhase('cat', performance.now() - t0, `cid=${cid} ${String(text.length)} bytes`);
        return text;
      } catch {
        logPhase('cat', performance.now() - t0, `cid=${cid} failed`);
        return '';
      }
    },
  };
}

/**
 * One-shot helper: build the full PublicationCidView for a publication via the
 * safe-app adapter. Never throws — the collectors + adapter are fail-open.
 */
export async function fetchCidView(
  args: { safeIntegration: SafeIntegration; protocolInfo: S2SProtocolInfo },
  publication: string,
): Promise<PublicationCidView> {
  return buildPublicationCidView(buildSafeAppCidViewContext(args), publication);
}

// ===========================================================================
// Retrievability adapter — ipfs-check BATCH endpoint + localStorage cache.
//
// The user's self-hosted ipfs-check instance (`https://ipfs-check.transport-union.dev`)
// gained a streaming NDJSON batch endpoint: POST /batch with { cids: [...] }
// returns one line per checked cid as it finishes (deduped + checked in
// parallel server-side). This adapter owns the pass and produces the SAME
// CidRetrievabilityMap shape as the shared core (see shared/src/cid-view/
// retrievability.ts) directly from the per-cid ipfs-check report — the shared
// per-source `hasCopy` runner is intentionally NOT used here, because a single
// batch request already returns the full report per cid.
//
// Fail-open by design (mirrors the shared core): a failed batch POST marks the
// chunk's cids with an error status (checkedAt + error, all sources false) and
// the wrapper never throws; localStorage reads/writes degrade to null/no-op.

/** Base URL of the user's self-hosted ipfs-check instance. */
export const IPFS_CHECK_ENDPOINT = 'https://ipfs-check.transport-union.dev';

/** localStorage prefix for the per-publication retrievability snapshot. */
const RETRIEVABILITY_CACHE_PREFIX = 's2s.cidview.';

/** CIDs per batch POST. Streaming keeps the UI incremental regardless. */
const RETRIEVABILITY_BATCH_SIZE = 50;

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

/**
 * Structural slice of an ipfs-check provider report — just the fields the
 * classifier needs. Kept loose on purpose: the live endpoint may add fields.
 */
export interface IpfsCheckProvider {
  ID?: string;
  Addrs?: string[];
  AgentVersion?: string;
  Source?: string;
  DataAvailableOverBitswap?: { Enabled?: boolean; Found?: boolean };
  DataAvailableOverHTTP?: { Enabled?: boolean; Found?: boolean };
}

/**
 * Classify which of our retrievability platforms a provider self-identifies
 * as. Best-effort heuristics over the provider's self-reported fields; a
 * provider may match multiple platforms (pinata runs kubo → both).
 */
export function classifyProviderPlatforms(provider: IpfsCheckProvider): RetrievabilitySource[] {
  const hay =
    `${provider.ID ?? ''} ${(provider.Addrs ?? []).join(' ')} ${provider.AgentVersion ?? ''} ${provider.Source ?? ''}`.toLowerCase();
  const agent = (provider.AgentVersion ?? '').toLowerCase();
  const platforms: RetrievabilitySource[] = [];
  // Filebase: advertises on the bitswap.filebase.io hostname (or otherwise names filebase).
  if (hay.includes('filebase')) platforms.push('filebase');
  // Pinata: self-identifies as pinata (hostname / pinned-by metadata).
  if (hay.includes('pinata')) platforms.push('pinata');
  // Kubo: agent reports the reference go-ipfs/kubo stack (kubo or its old name go-ipfs).
  if (agent.startsWith('kubo') || agent.startsWith('go-ipfs')) platforms.push('kubo');
  // Filecoin: agent reports a Filecoin SP retrieval stack.
  if (/boost|lotus|venus|fvm|spade/.test(agent)) platforms.push('filecoin');
  return platforms;
}

/** One NDJSON line from the ipfs-check batch endpoint. */
export interface IpfsCheckLine {
  cid: string;
  ms?: number;
  result?: unknown;
  error?: string;
}

/**
 * POST one batch of cids to the ipfs-check /batch endpoint and stream the
 * NDJSON response, invoking `onResult` once per line as each cid finishes
 * (the server checks the batch in parallel and streams results incrementally).
 */
export async function checkBatch(
  cids: string[],
  onResult: (r: IpfsCheckLine) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${IPFS_CHECK_ENDPOINT}/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cids }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`ipfs-check batch HTTP ${String(res.status)}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onResult(JSON.parse(line) as IpfsCheckLine);
    }
  }
}

/** All-false sources block — the shape every status carries. */
function allSourcesFalse(): Record<RetrievabilitySource, boolean> {
  return { kubo: false, pinata: false, filebase: false, filecoin: false };
}

/**
 * Build a CidRetrievabilityStatus from one ipfs-check batch line.
 *
 * - A line with `error` → that cid failed: error status, all sources false.
 * - A non-array `result` (e.g. MutableResolution for a non-CID input) → no
 *   providers (not an error): all sources false.
 * - An array → providers that `Found` the cid (over Bitswap and/or HTTP) are
 *   classified into our platforms. `filecoin` is true ONLY when a Filecoin
 *   storage-provider stack (boost/lotus/venus/fvm/spade) actually served the
 *   cid — s2s publication deals (author+publication) are NOT Filecoin storage,
 *   so a deal/version entry never implies a Filecoin copy.
 *
 * `now` is injectable for deterministic tests.
 */
export function statusFromCheckLine(
  line: IpfsCheckLine,
  now?: () => string,
): CidRetrievabilityStatus {
  const checkedAt = (now ?? (() => new Date().toISOString()))();
  if (line.error) {
    return { checkedAt, copies: 0, sources: allSourcesFalse(), error: line.error };
  }
  const result = line.result;
  if (!Array.isArray(result)) {
    return { checkedAt, copies: 0, sources: allSourcesFalse() };
  }
  const sources = allSourcesFalse();
  for (const provider of result as IpfsCheckProvider[]) {
    // A provider "serves" the cid iff it Found it over Bitswap and/or HTTP.
    const serves =
      provider.DataAvailableOverBitswap?.Found === true ||
      provider.DataAvailableOverHTTP?.Found === true;
    if (!serves) continue;
    for (const source of classifyProviderPlatforms(provider)) {
      sources[source] = true;
    }
  }
  let copies = 0;
  for (const present of Object.values(sources)) {
    if (present) copies += 1;
  }
  return { checkedAt, copies, sources };
}

/**
 * Check retrievability for the given cids via the ipfs-check batch endpoint,
 * chunked + streamed, merging into `prev` (default: the localStorage cache).
 * Unchecked cids in `prev` are preserved. Persists to localStorage after each
 * chunk. Never throws — a failed chunk marks its cids with an error status.
 */
export async function checkRetrievability(
  publication: string,
  view: PublicationCidView,
  cids: readonly string[],
  opts?: {
    prev?: CidRetrievabilityMap;
    onResult?: (cid: string, status: CidRetrievabilityStatus) => void;
    batchSize?: number;
    signal?: AbortSignal;
  },
): Promise<CidRetrievabilityMap> {
  const prev = opts?.prev ?? loadRetrievabilityMap(publication) ?? {};
  // `view` is part of the public signature (the component passes its current
  // view) but the batch adapter no longer derives anything from it — ipfs-check
  // reports the serving providers directly.
  void view;
  const result: CidRetrievabilityMap = { ...prev };
  const batchSize = opts?.batchSize ?? RETRIEVABILITY_BATCH_SIZE;
  const now = () => new Date().toISOString();

  if (cids.length === 0) {
    saveRetrievabilityMap(publication, result);
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
          const status = statusFromCheckLine(line);
          result[line.cid] = status;
          opts?.onResult?.(line.cid, status);
        },
        opts?.signal,
      );
    } catch (err) {
      // An aborted pass (disconnect / recheck / publication switch) must NOT be
      // recorded as a per-cid error — rethrow so the caller's loop stops.
      if (opts?.signal?.aborted) throw err;
      const message = err instanceof Error && err.message !== '' ? err.message : String(err);
      for (const cid of failed) {
        const status: CidRetrievabilityStatus = {
          checkedAt: now(),
          copies: 0,
          sources: allSourcesFalse(),
          error: message,
        };
        result[cid] = status;
        opts?.onResult?.(cid, status);
      }
    } finally {
      saveRetrievabilityMap(publication, result);
    }
  }
  return result;
}
