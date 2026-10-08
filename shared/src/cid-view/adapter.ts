// cid-view adapter factory — turns transport deps into a CidViewReadContext.
//
// Deliberately transport-agnostic: NO ethers/viem/fetch/IPFS-client imports.
// The shared package only declares the read contract (context.ts); the concrete
// chain/IPFS wiring (ethers v6, Kubo, ENS/CCIP reads, bytes32 decoding) is
// supplied by the consumer — safe-app already owns those clients — via this
// thin 1:1 delegate. This keeps all decoding/transport logic out of shared.
import type { CidViewReadContext } from './context';
import type { DealRead, VersionRead } from './types';

/** Transport-level dependencies a consumer (e.g. safe-app) must provide. */
export interface CidViewAdapterDeps {
  readDeals(): Promise<DealRead[]>;
  readOffers(): Promise<DealRead[]>;
  readVersions(genesis: string): Promise<VersionRead[]>;
  readVersionCount(genesis: string): Promise<number>;
  readVersionsRange(genesis: string, fromIndex: number, count?: number): Promise<VersionRead[]>;
  readConfig(): Promise<{ cid: string; config: unknown }>;
  readEnsText(node: string, key: string): Promise<string>;
  ipfs: {
    dagGet<T = unknown>(cid: string): Promise<T>;
    ls(cid: string): Promise<Array<{ name: string; hash: string; size: number }>>;
    cat(cid: string): Promise<string>;
  };
}

/**
 * Build a CidViewReadContext from consumer-supplied deps. Each method
 * delegates 1:1 to the matching dep — no logic, no validation, no transport.
 */
export function createCidViewContext(deps: CidViewAdapterDeps): CidViewReadContext {
  return {
    getDeals: () => deps.readDeals(),
    getOffers: () => deps.readOffers(),
    getVersions: (genesis: string) => deps.readVersions(genesis),
    getVersionCount: (genesis: string) => deps.readVersionCount(genesis),
    getVersionsRange: (genesis: string, fromIndex: number, count?: number) =>
      deps.readVersionsRange(genesis, fromIndex, count),
    getConfig: () => deps.readConfig(),
    getEnsText: (node: string, key: string) => deps.readEnsText(node, key),
    dagGet: (cid: string) => deps.ipfs.dagGet(cid),
    ls: (cid: string) => deps.ipfs.ls(cid),
    cat: (cid: string) => deps.ipfs.cat(cid),
  };
}
