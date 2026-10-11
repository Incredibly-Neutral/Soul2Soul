import type { S2STemplateConfig, S2SJob } from '../../protocol/types';
import type { PrepActionInput, SingleActionInput, EvmUpdateActionInput } from '../action-io';

// ============================================================================
// Canonical shared objects — used by every valid fixture
// ============================================================================

/** Minimal S2STemplateConfig used across all fixtures */
export const sampleTemplateConfig: S2STemplateConfig = {
  reference: 'post',
  file: 'post.hbs',
  path: '/{slug}',
};

/** Minimal S2SJob used across all fixtures — html is "" before single renders it */
export const sampleJob: S2SJob = {
  id: '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063',
  templateConfig: sampleTemplateConfig,
  html: '',
  path: '/hello-world',
};

// ============================================================================
// Shared endpoints fixture
// ============================================================================

export const sampleEndpoints = {
  ipfsGateway: 'https://ipfs.transport-union.dev',
  ipfsGatewayAuth: 'Bearer test-token',
  rpcs: {
    L1: ['https://lb.drpc.live/ethereum/key'],
    L2: ['https://lb.drpc.live/base/key'],
  },
};

// ============================================================================
// Valid prep input
// ============================================================================

export const validPrepInput: PrepActionInput = {
  publication: 'alice.soul2soul.eth',
  contentIds: ['lens-post-1'],
  configCid: 'QmConfig1',
  endpoints: sampleEndpoints,
};

// ============================================================================
// Valid single input
// ============================================================================

export const validSingleInput: SingleActionInput = {
  job: sampleJob,
  signature: '0xdeadbeef' as string,
  authorSafeAddress: '0xAuthorSafe' as string,
  publication: 'alice.soul2soul.eth',
  configCid: 'QmConfig1',
  endpoints: sampleEndpoints,
};

// ============================================================================
// Valid evm-update input
// ============================================================================

export const validEvmUpdateInput: EvmUpdateActionInput = {
  publication: 'alice.soul2soul.eth',
  jobs: [sampleJob],
  signature: '0xdeadbeef' as string,
  authorSafeAddress: '0xAuthorSafe' as string,
  endpoints: sampleEndpoints,
};