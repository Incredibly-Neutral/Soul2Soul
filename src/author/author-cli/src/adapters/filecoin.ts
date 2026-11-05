// ============================================================================
// Filecoin adapter — node FilecoinStorage (with the node CAR builder) for the
// article/render-root durability legs.
//
// Two init paths, mirroring 0xobsidian/neutralpress:
//   - session-key file (S2S_FILECOIN_SESSION_KEY)  → protocol-payer path
//     via initWithSessionKey
//   - direct signer key (S2S_FILECOIN_PRIVATE_KEY) → initWithSessionKey-free
//     via init()
// Returns undefined when neither is configured — callers then skip the
// Filecoin leg (fail-open, like neutralpress' uninitialised storage guard).
// ============================================================================

import { readFileSync } from 'node:fs';

import {
  FilecoinStorage,
  type FilecoinSessionKeyData,
  type FilecoinUser,
} from '@s2s/soul2soul-shared/filecoin';
import { nodeFilecoinBuilder } from '@s2s/soul2soul-shared/filecoin/car-builder/node';

import type { CliConfig } from '../core/config';

export async function createFilecoinStorage(
  config: CliConfig,
): Promise<FilecoinStorage | undefined> {
  const { filecoin } = config;

  if (filecoin.sessionKeyFile) {
    const raw = readFileSync(filecoin.sessionKeyFile, 'utf8');
    const skData = JSON.parse(raw) as FilecoinSessionKeyData;
    const storage = new FilecoinStorage({}, nodeFilecoinBuilder);
    await storage.initWithSessionKey(skData, filecoin.rpcUrl, filecoin.chain);
    return storage;
  }

  if (filecoin.privateKey) {
    const user: FilecoinUser = { user: { private_key: filecoin.privateKey } };
    const storage = new FilecoinStorage(user, nodeFilecoinBuilder);
    await storage.init(filecoin.chain);
    return storage;
  }

  return undefined;
}
