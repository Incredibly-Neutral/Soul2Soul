// ============================================================================
// IPFS adapter — shared S2SIPFSMethods configured from the CLI env.
// Provides Kubo add/cat, Pinata + Filebase backup pins, and the Filecoin
// hot-storage leg via backupToProviders.
// ============================================================================

import { S2SIPFSMethods } from '@s2s/soul2soul-shared';

import type { CliConfig } from '../core/config';

export function createIpfs(config: CliConfig): S2SIPFSMethods {
  return new S2SIPFSMethods(
    config.kuboGateway,
    config.pinataJwt ?? '',
    config.pinataGateway ?? '',
    config.filebaseToken,
    config.kuboToken,
  );
}
