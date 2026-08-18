import { S2SJob } from '../../protocol/types';

export type ActionResult<T> =
  | { ok: true; action: string; data: T; trace: any[] }
  | { ok: false; action: string; error: string; trace: any[] };

export interface PrepInput {
  publication: string;
  contentIds: string[];
  configCid?: string;
  prevRootCid?: string;
  endpoints: {
    ipfsGateway?: string;
    rpcs: { L1: string[]; L2: string[] };
  };
}
export interface PrepData {
  jobs: S2SJob[];
  remove?: { path: string; replacedBy?: string }[];
}

export interface SingleInput {
  job: S2SJob;
  signature: string;
  authorSafeAddress: string;
  publication: string;
  configCid?: string;
  preview?: boolean;
  maintainCache?: boolean;
  endpoints: {
    ipfsGateway?: string;
    rpcs: { L1: string[]; L2: string[] };
  };
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
  remove?: { path: string; replacedBy?: string }[];
  endpoints: {
    ipfsGateway?: string;
    rpcs: { L1: string[]; L2: string[] };
  };
}

export interface EvmUpdateData {
  cid: string;
  trace?: any[];
}
