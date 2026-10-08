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
import { S2SIPFSMethods, buildPublicationCidView } from '@s2s/soul2soul-shared/safe-app';
import type {
  CidViewReadContext,
  DealRead,
  PublicationCidView,
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
/** Kubo ls timeout, matching s2s-website-tree-tab.ts. */
const LS_TIMEOUT_MS = 15_000;

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

  return {
    async getDeals() {
      try {
        const { deals } = await safeIntegration.getAllDealsAndOffers();
        return deals.map((d) => toDealRead(d, 'deal'));
      } catch {
        return [];
      }
    },

    async getOffers() {
      try {
        const { offers } = await safeIntegration.getAllDealsAndOffers();
        return offers.map((o) => toDealRead(o, 'offer'));
      } catch {
        return [];
      }
    },

    async getVersions(genesis: string) {
      try {
        const publicationModule = safeIntegration.publicationModule;
        if (!publicationModule) return [];
        const id = toBytes32Id(genesis);
        const count = Number(await publicationModule.getVersionCount(id));
        if (!Number.isFinite(count) || count <= 0) return [];
        const limit = Math.min(count, MAX_VERSIONS);
        const versions: VersionRead[] = [];
        for (let i = 0; i < limit; i++) {
          const v = await publicationModule.getVersion(id, i);
          versions.push({
            cid: v.cid,
            timestamp: Number(v.timestamp),
            tombstone: Boolean(v.tombstone),
          });
        }
        return versions;
      } catch {
        return [];
      }
    },

    async getConfig() {
      const configCid = store.getRecord('config');
      if (!configCid) return { cid: '', config: {} };
      try {
        const config = await ipfs.fetchFromKubo(configCid);
        return { cid: configCid, config: config ?? {} };
      } catch {
        return { cid: configCid, config: {} };
      }
    },

    async getEnsText(node: string, key: string) {
      if (!protocolInfo?.ensRecords) return '';
      try {
        return await evmRead(8453, protocolInfo.ensRecords, RECORDS_CONTRACT_ABI, 'getText', [
          node,
          key,
        ]);
      } catch {
        return '';
      }
    },

    async dagGet(cid: string) {
      try {
        return await ipfs.dagGet(cid);
      } catch {
        return null;
      }
    },

    async ls(cid: string) {
      try {
        const url = `${IPFS_URL}/api/v0/ls?arg=${encodeURIComponent(cid)}`;
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(LS_TIMEOUT_MS) });
        if (!res.ok) return [];
        const data = (await res.json()) as {
          Objects?: { Links?: Array<{ Name: string; Hash: string; Size: number }> | null }[];
        };
        const links = data.Objects?.[0]?.Links;
        // A file/leaf returns Links: [] (or missing) → treat as a leaf.
        if (!Array.isArray(links) || links.length === 0) return [];
        return links.map((l) => ({
          name: l.Name,
          hash: l.Hash,
          size: l.Size ?? 0,
        }));
      } catch {
        return [];
      }
    },

    async cat(cid: string) {
      try {
        const url = `${IPFS_URL}/api/v0/cat?arg=${encodeURIComponent(cid)}`;
        const res = await fetch(url, { method: 'POST' });
        if (!res.ok) return '';
        return await res.text();
      } catch {
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
