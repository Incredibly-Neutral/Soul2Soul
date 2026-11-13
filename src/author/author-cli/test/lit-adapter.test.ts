// ============================================================================
// The Lit adapter — what the CLI hands LitService so it can execute an action.
//
// There is no inline action code in this CLI, and no action CID ships in it
// either: encrypt runs from the CID the protocol records module holds
// (`lit_action_encrypt`), with `lit.encryptActionCid` as the override. These
// tests assert the wiring — a service that throws "missing actions.encrypt" is
// the failure that motivated it — not the Lit exchange, which shared's own tests
// own.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { createLitService, NO_ENCRYPT_ACTION } from '../src/adapters/lit';
import { loadConfig } from '../src/core/config';

/** Never the developer's real ~/.config/s2s: a blank machine, as in config.test. */
const nowhere = {
  userConfigPath: '/nonexistent/s2s/custom.json',
  projectConfigPath: '/nonexistent/.s2sconfig.json',
  legacyConfigPath: '/nonexistent/s2s/config.json',
  defaultsPath: '/nonexistent/s2s/defaults.json',
  authorsPath: '/nonexistent/s2s/authors.json',
};

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

/** The private fields LitService keeps — the seam this adapter is. */
const wired = (env: NodeJS.ProcessEnv = {}, cid: string | undefined = env.LIT_ENCRYPT_ACTION_CID) => {
  const svc = createLitService(loadConfig(env, nowhere), cid);
  return svc as unknown as {
    gateway?: string;
    actions: { encrypt?: string; decrypt?: string };
    accountKey?: string;
  };
};

describe('createLitService', () => {
  it('hands over the resolved CID of the encrypt action bundle', () => {
    expect(wired({}, CID).actions).toEqual({ encrypt: CID });
  });

  it('feeds the CID it is given, not a second read of the config', () => {
    // The resolver (`core/context.ts`) is the only place precedence lives: a CID
    // that came from the protocol record arrives here exactly like a configured one.
    expect(wired({ LIT_ENCRYPT_ACTION_CID: 'bafyfromconfig' }, CID).actions.encrypt).toBe(CID);
  });

  it('fails closed with both remedies when no CID resolved', async () => {
    const svc = createLitService(loadConfig({}, nowhere));
    expect((svc as unknown as { actions: Record<string, unknown> }).actions.encrypt).toBeUndefined();

    await expect(svc.encrypt('usage-key', '0xpkp', 'plaintext')).rejects.toThrow(NO_ENCRYPT_ACTION);
    // Both ways to supply it are named, because either one is a fix.
    expect(NO_ENCRYPT_ACTION).toContain('s2s config set lit.encryptActionCid <cid>');
    expect(NO_ENCRYPT_ACTION).toContain('src/press/scripts/lit/update-protocol.ts');
  });

  it('uses the Kubo gateway the CLI already reads content through, with a scheme', () => {
    // The config keeps the endpoint without its scheme (shared's kuboPost adds
    // it); an action fetch concatenates the base as-is.
    expect(wired({}).gateway).toBe('https://ipfs.transport-union.dev');
    expect(wired({ S2S_KUBO_GATEWAY: 'gw.example' }).gateway).toBe('https://gw.example');
    expect(wired({ S2S_KUBO_GATEWAY: 'http://127.0.0.1:5001' }).gateway).toBe(
      'http://127.0.0.1:5001',
    );
    expect(wired({ S2S_KUBO_GATEWAY: 'https://gw.example/' }).gateway).toBe('https://gw.example');
  });

  it('adds no second gateway setting and no second credential', () => {
    const svc = wired({ LIT_ACCOUNT_KEY: '0x' + 'ab'.repeat(32) }, CID);
    expect(svc.accountKey).toBe('0x' + 'ab'.repeat(32));
    expect(Object.keys(svc.actions)).toEqual(['encrypt']);
  });
});
