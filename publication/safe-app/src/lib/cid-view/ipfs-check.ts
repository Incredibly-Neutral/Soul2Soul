// src/lib/cid-view/ipfs-check.ts — safe-app wiring of the shared ipfs-check
// batch client (split out of the former single-file src/lib/cid-view.ts).
//
// The transport/orchestration itself lives in shared (checkBatch,
// statusFromCheckLine, checkRetrievability). This module only wires the shared
// core to the app's localStorage cache and pins the app's batch size. Keeping
// the batch size here (and NOT in shared) is deliberate: 3 cids per POST keeps
// the UI incremental; the shared default of 50 exists for non-browser callers.
import { checkRetrievability as checkRetrievabilityShared } from '@s2s/soul2soul-shared/safe-app';
import type {
  CidRetrievabilityMap,
  CidRetrievabilityStatus,
  PublicationCidView,
} from '@s2s/soul2soul-shared/safe-app';
import { appendRawBatchLog, loadRetrievabilityMap, saveRetrievabilityMap } from './cache.js';

/** CIDs per batch POST. Streaming keeps the UI incremental regardless. */
const RETRIEVABILITY_BATCH_SIZE = 3;

/**
 * Check retrievability for the given cids via the ipfs-check batch endpoint
 * (shared chunked + streamed core), merging into `prev` (default: the
 * localStorage cache) and persisting to localStorage after each chunk. Never
 * throws — a failed chunk marks its cids with an error status.
 */
export function checkRetrievability(
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
  return checkRetrievabilityShared(publication, view, cids, {
    ...opts,
    batchSize: opts?.batchSize ?? RETRIEVABILITY_BATCH_SIZE,
    cache: {
      load: (p) => loadRetrievabilityMap(p),
      save: (p, m) => {
        saveRetrievabilityMap(p, m);
      },
      logRaw: (p, n, raw) => {
        appendRawBatchLog(p, n, raw);
      },
    },
  });
}
