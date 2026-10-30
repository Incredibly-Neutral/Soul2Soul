// Minimal endpoint for @s2s/soul2soul-shared/endpoint
// Only exports what the safe-app actually needs — no Lit, no Lens, no CCIP baggage

export type { S2SProtocolInfo } from './protocol/types';
export { getProtocolInfo } from './protocol/index';
export { ENS_NAMEWRAPPER } from './protocol/constants';
export type { S2SPublicationConfig } from './publication';
export { LitService } from './lit';

// cid-view — the unified "all CIDs in a publication" view, built for safe-app
export * from './cid-view';

// heal — pin a remote CID across providers (safe-app availability heal)
export * from './heal';

// Publication builders (used by safe-app/src/components/s2s-records-tab.ts)
export { ConfigBuilder, parseGitHubUrl } from './publication/config-builder';
export { AssetsBuilder } from './publication/assets-builder';
export { S2SIPFSMethods } from './ipfs';