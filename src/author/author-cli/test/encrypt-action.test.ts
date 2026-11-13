// ============================================================================
// Which encrypt action CID the CLI uses — the protocol record, or the config.
//
// The CLI ships no action CID: the CID of the encrypt bundle is a protocol fact
// and lives in the records module (`lit_action_encrypt`), written by
// press/scripts/lit/update-protocol.ts. `lit.encryptActionCid` (file or
// LIT_ENCRYPT_ACTION_CID) is the override, and its presence skips the record
// read altogether.
//
// The record read itself is ENS + an L2 call, so it arrives as a function here.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

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

describe('resolveEncryptActionCid', () => {
  it('reads the protocol record when no config value is set', async () => {
    const config = loadConfig({}, nowhere);
    const read = vi.fn(() => Promise.resolve(RECORD_CID));

    await expect(resolveEncryptActionCid(config, read)).resolves.toBe(RECORD_CID);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('lets the config (or env) value win, without reading the record', async () => {
    const fromEnv = loadConfig({ LIT_ENCRYPT_ACTION_CID: 'bafyfromenv' }, nowhere);
    const read = vi.fn(() => Promise.resolve(RECORD_CID));

    await expect(resolveEncryptActionCid(fromEnv, read)).resolves.toBe('bafyfromenv');
    // The record may say something else entirely; the override is not asked to agree.
    expect(read).not.toHaveBeenCalled();
  });

  it('treats a blank config value as unset and falls back to the record', async () => {
    const config = loadConfig({ LIT_ENCRYPT_ACTION_CID: '   ' }, nowhere);

    await expect(resolveEncryptActionCid(config, () => Promise.resolve(RECORD_CID))).resolves.toBe(
      RECORD_CID,
    );
  });

  it('resolves nothing when neither names a CID, and the encrypt path says why', async () => {
    const config = loadConfig({}, nowhere);
    const cid = await resolveEncryptActionCid(config, () => Promise.resolve(undefined));

    expect(cid).toBeUndefined();
    const svc = createLitService(config, cid);
    await expect(svc.encrypt('usage-key', '0xpkp', 'plaintext')).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('lit_action_encrypt'),
    });
  });
});
