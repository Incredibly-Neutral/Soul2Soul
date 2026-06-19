import { S2SJob } from "../../protocol/types";

export type ActionResult<T> =
  | { ok: true;  action: string; data: T, trace: any[]}
  | { ok: false; action: string; error: string, trace: any[] };

export interface PrepInput  { publication: string; contentIds: string[]; configCid?: string }
export interface PrepData   { jobs: S2SJob[] }

export interface SingleInput {
  job: S2SJob;
  signature: string;
  authorSafeAddress: string;
  publication: string;
  configCid?: string;
  preview?: boolean;
}
export interface SingleData {
  job: S2SJob;
  html?: string;
  timestamp: string;
}

// ============================================================================
// EVM Update (merged/evm) — updates IPFS root CID on-chain
// ============================================================================
export interface EvmUpdateInput {
  publication: string;
  jobs: S2SJob[];
  signature: string;
  authorSafeAddress: string;
  preview?: boolean;
}

export interface EvmUpdateData {
  cid: string;
}