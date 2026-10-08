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
