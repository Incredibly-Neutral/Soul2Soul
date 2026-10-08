// cid-view — STAGE 1 types/contract layer + STAGE 2b config collector.
// The remaining collectors (deals.ts / tree.ts) and the coordinator come in
// later stages. Re-export the canonical types, the read-context interface and
// the config collector.
export * from './types';
export * from './context';
export * from './config';
