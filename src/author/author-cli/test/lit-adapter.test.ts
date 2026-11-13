// ============================================================================
// The Lit adapter — what the CLI hands LitService so it can execute an action.
//
// There is no inline action code in this CLI: encrypt runs from
// `lit.encryptActionCid`, fetched through the gateway the CLI already reads
// content through. These tests assert the wiring itself (a service that throws
// "missing actions.encrypt" is the failure that motivated it), not the Lit
// exchange, which shared's own tests own.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { createLitService } from '../src/adapters/lit';
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
const wired = (env: NodeJS.ProcessEnv = {}) => {
  const svc = createLitService(loadConfig(env, nowhere));
  return svc as unknown as {
    gateway?: string;
    actions: { encrypt?: string; decrypt?: string };
    accountKey?: string;
  };
};

describe('createLitService', () => {
  it('hands over the CID of the encrypt action bundle', () => {
    const svc = wired({ LIT_ENCRYPT_ACTION_CID: CID });
    expect(svc.actions).toEqual({ encrypt: CID });
  });

  it('is unset when no CID is configured, so the encrypt path fails closed', () => {
    // The file layer is asserted in config.test.ts; here the point is that the
    // adapter passes the absence through rather than inventing a CID.
    expect(wired({}).actions.encrypt).toBeUndefined();
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
    const svc = wired({ LIT_ACCOUNT_KEY: '0x' + 'ab'.repeat(32), LIT_ENCRYPT_ACTION_CID: CID });
    expect(svc.accountKey).toBe('0x' + 'ab'.repeat(32));
    expect(Object.keys(svc.actions)).toEqual(['encrypt']);
  });
});
