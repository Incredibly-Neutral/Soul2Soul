// ============================================================================
// IPFS adapter — shared S2SIPFSMethods configured from the resolved config.
// Provides Kubo add/cat, Pinata + Filebase backup pins, and the Filecoin
// hot-storage leg via backupToProviders.
//
// Mapping (see core/configschema.ts):
//   ipfs.entries[0]              → the primary gateway + its write token
//   pinning[provider=pinata]     → the Pinata JWT and, if given, its gateway
//   pinning[provider=filebase]   → the Filebase token
// A pinning entry with no key is a gateway-only label: it is skipped here
// rather than passed on as a credential-shaped empty string.
// ============================================================================

import { S2SIPFSMethods } from '@s2s/soul2soul-shared';

import type { CliConfig } from '../core/config';

/** The first pinning entry for a provider — whole-label merge means one per label. */
function pinningFor(config: CliConfig, provider: string): { key: string; url?: string } | undefined {
  const entry = config.pinning.find((candidate) => candidate.provider === provider);
  if (!entry || entry.key === undefined || entry.key.trim() === '') return undefined;
  return { key: entry.key, url: entry.url };
}

export function createIpfs(config: CliConfig): S2SIPFSMethods {
  const primary = config.ipfs.primary;
  const pinata = pinningFor(config, 'pinata');
  const filebase = pinningFor(config, 'filebase');

  return new S2SIPFSMethods(
    primary?.url ?? '',
    pinata?.key ?? '',
    pinata?.url ?? '',
    filebase?.key,
    primary?.key,
  );
}
