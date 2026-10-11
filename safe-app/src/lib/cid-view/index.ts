// src/lib/cid-view/index.ts — barrel for the safe-app cid-view lib.
//
// Replaces the former single-file src/lib/cid-view.ts. Only the surface the
// app consumes is exported here:
//   - context.ts    : buildSafeAppCidViewContext (storage tab), fetchCidView (one-shot)
//   - cache.ts      : loadRetrievabilityMap / saveRetrievabilityMap (cid-view section)
//   - ipfs-check.ts : checkRetrievability (cid-view section) — wired to the
//                     shared batch client + localStorage cache, batch size 3
//
// The transport client itself (checkBatch, statusFromCheckLine) now lives in
// shared/src/cid-view/ipfs-check-client.ts and is NOT re-exported here.
export { buildSafeAppCidViewContext, fetchCidView } from './context.js';
export { appendRawBatchLog, loadRetrievabilityMap, saveRetrievabilityMap } from './cache.js';
export { checkRetrievability } from './ipfs-check.js';
