// ============================================================================
// Which encrypt action CID the CLI uses — the protocol record, or the config.
//
// The CLI ships no action CID: the CID of the encrypt bundle is a protocol fact
// and lives in the records module (`lit_action_encrypt`), written by
// press/scripts/lit/update-protocol.ts and read with every other action record
// in shared's `getProtocolInfo` (`litActions.encrypt`). `lit.encryptActionCid`
// (file or LIT_ENCRYPT_ACTION_CID) is the override, and its presence wins
// without consulting the record.
//
// There is no second resolution here: the record arrives on `protocolInfo`, so
// a timed-out RPC cannot be mistaken for "the record is not written".
// ============================================================================

import { describe, expect, it } from 'vitest';

import { createLitService } from '../src/adapters/lit';
import { loadConfig } from '../src/core/config';
import { resolveEncryptActionCid } from '../src/core/context';

/** Never the developer's real ~/.config/s2s. */
const nowhere = {
  userConfigPath: '/nonexistent/s2s/custom.json',
  projectConfigPath: '/nonexistent/.s2sconfig.json',
  legacyConfigPath: '/nonexistent/s2s/config.json',
  defaultsPath: '/nonexistent/s2s/defaults.json',
  authorsPath: '/nonexistent/s2s/authors.json',
};

const RECORD_CID = 'QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh';

/** The shape shared returns: `litActions` with the optional actions absent. */
function protocolWith(encrypt?: string) {
  return {
    litActions: {
      prep: 'Qmprep',
      render: 'Qmrender',
      update: 'Qmupdate',
      ...(encrypt === undefined ? {} : { encrypt }),
    },
  };
}

describe('resolveEncryptActionCid', () => {
  it('uses the protocol record when no config value is set', () => {
    const config = loadConfig({}, nowhere);

    expect(resolveEncryptActionCid(config, protocolWith(RECORD_CID))).toBe(RECORD_CID);
  });

  it('lets the config (or env) value win over the record', () => {
    const fromEnv = loadConfig({ LIT_ENCRYPT_ACTION_CID: 'bafyfromenv' }, nowhere);

    // The record may say something else entirely; the override is not asked to agree.
    expect(resolveEncryptActionCid(fromEnv, protocolWith(RECORD_CID))).toBe('bafyfromenv');
  });

  it('treats a blank config value as unset and falls back to the record', () => {
    const config = loadConfig({ LIT_ENCRYPT_ACTION_CID: '   ' }, nowhere);

    expect(resolveEncryptActionCid(config, protocolWith(RECORD_CID))).toBe(RECORD_CID);
  });

  it('treats an unwritten record as absent rather than empty', () => {
    const config = loadConfig({}, nowhere);

    expect(resolveEncryptActionCid(config, protocolWith())).toBeUndefined();
    expect(resolveEncryptActionCid(config, protocolWith(''))).toBeUndefined();
  });

  it('resolves nothing when neither names a CID, and the encrypt path says why', async () => {
    const config = loadConfig({}, nowhere);
    const cid = resolveEncryptActionCid(config, protocolWith());

    expect(cid).toBeUndefined();
    const svc = createLitService(config, cid);
    await expect(svc.encrypt('usage-key', '0xpkp', 'plaintext')).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('lit_action_encrypt'),
    });
  });
});
