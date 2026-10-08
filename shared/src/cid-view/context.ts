// cid-view read-context interface — pure abstraction so collectors are
// unit-testable without chain/IPFS. No viem/ethers/IPFS calls here: this is a
// contract; the concrete implementation (later stage) supplies the adapters.
import type { DealRead, VersionRead } from './types';

export interface CidViewReadContext {
  /** Latest CID per genesis from the publication module (getDeals / getOffers). */
  getDeals(): Promise<DealRead[]>;
  getOffers(): Promise<DealRead[]>;
  /** Full version history (incl. tombstoned) for one genesis (getVersionCount + getVersion). */
  getVersions(genesis: string): Promise<VersionRead[]>;
  /**
   * Length of the append-only version array for one genesis (0 if none) — the
   * monotonic per-genesis watermark used by incremental diffs. Optional so
   * existing test fakes that only exercise the cold collectors keep compiling;
   * the concrete adapter and safe-app always provide it.
   */
  getVersionCount?(genesis: string): Promise<number>;
  /**
   * Versions [fromIndex, count) for one genesis — the incremental-diff
   * primitive. Optional for the same reason as getVersionCount; the
   * incremental collector treats a missing primitive as a read failure.
   * `count` is the on-chain version count for this genesis already fetched by
   * the caller: when provided the implementation SHOULD skip its own internal
   * count read (still applying the count<=0 → [] guard) to avoid a redundant
   * RPC per genesis; when absent it falls back to reading it (cold getVersions).
   */
  getVersionsRange?(genesis: string, fromIndex: number, count?: number): Promise<VersionRead[]>;
  /** Publication config: cid = configCid (from the on-chain `config` record), config = parsed S2SPublicationConfig. */
  getConfig(): Promise<{ cid: string; config: unknown }>;
  /** Read a DAG node as JSON (used for the templates DAG: array of {path,cid,body}). */
  dagGet(cid: string): Promise<unknown>;
  /** List a directory node; each item has name + hash(CID) + size. */
  ls(cid: string): Promise<Array<{ name: string; hash: string; size: number }>>;
  /** Raw text content of a leaf (archive JSON). */
  cat(cid: string): Promise<string>;
  /** ENS records contract getText(node, key) on L2 (Base). */
  getEnsText(node: string, key: string): Promise<string>;
}
