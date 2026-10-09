// cid-view — canonical types + read-context + collectors + coordinator.
// Collectors: deals.ts (deal/offer/version), config.ts (config/templates/assets),
// tree.ts (site tree + archive). The coordinator (coordinator.ts) composes all
// four into the final PublicationCidView; validation.ts provides the zod
// schemas; adapter.ts turns consumer transport deps into a CidViewReadContext.
export * from './types';
export * from './context';
export * from './deals';
export * from './config';
export * from './tree';
export * from './adapter';
export * from './validation';
export * from './retrievability';
export * from './coordinator';
