// src/lib/cid-view/context.ts — safe-app context adapter for the shared cid-view
// module (split out of the former single-file src/lib/cid-view.ts).
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
import { S2SIPFSMethods, buildPublicationCidView } from '@s2s/soul2soul-shared/safe-app';
import type {
  CidViewReadContext,
  DealRead,
  PublicationCidView,
  VersionRead,
} from '@s2s/soul2soul-shared/safe-app';
import type { S2SProtocolInfo } from '@s2s/soul2soul-shared/safe-app';
import { keccak256, toBytes } from 'viem';
import type { SafeIntegration } from '../safe-integration.js';
import { evmRead } from '../evm.js';
import { store } from '../../state/index.js';
import { IPFS_URL } from '../ipfs-fs.factory.js';

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
    // Kubo RPC write token (raw hex — shared injects `Authorization: Bearer`).
    import.meta.env.VITE_KUBO_TOKEN || '',
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
