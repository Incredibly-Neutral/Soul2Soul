// Minimal endpoint for @s2s/soul2soul-shared/endpoint
// Only exports what the safe-app actually needs — no Lit, no Lens, no CCIP baggage

export type { S2SProtocolInfo, PKP } from './protocol/types';
export { getProtocolInfo } from './protocol/index';
export { ENS_NAMEWRAPPER } from './protocol/constants';
export type { S2SPublicationConfig } from './publication';
