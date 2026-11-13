// ============================================================================
// The reason a /lit_action refusal carries.
//
// Lit answers 403 with a bare JSON string (`"…"`), not an object. The client
// read only `error` / `message` / `detail`, so the thrown message was `HTTP 403
// from /lit_action` with nothing after it — the one case where the diagnosis is
// in the body. This pins that a string body becomes the reason, redacted, and
// that an object body still resolves the way it always did.
// ============================================================================

import { describe, expect, it, vi, afterEach } from 'vitest';
import { LitService } from '../lit.service.js';

const ACTION_CID = 'QmShR3yn4EMK34YcKFUviKY78i7v4hEp7jqZkxHV5MhY7b';
const CODE = 'function main(){}';

/** Answer each URL the decrypt path touches, in order, with a canned reply. */
const stubFetch = (refusal: string) =>
  vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/v0/cat')) {
      return new Response(CODE, { status: 200 });
    }
    if (url.includes('/get_lit_action_ipfs_id')) {
      return new Response(JSON.stringify(ACTION_CID), { status: 200 });
    }
    return new Response(refusal, { status: 403 });
  });

const service = () =>
  new LitService({
    environment: 'prod',
    gateway: 'http://gateway.invalid',
    accountKey: 'account-key',
    actions: { decrypt: ACTION_CID },
  });

const decrypt = (key: string) =>
  service().decrypt(key, {
    pkpId: '0x0522b95938c3a18988bf71da2f964f8a52ae4004',
    genesis: `0x${'11'.repeat(32)}`,
    authorSafe: `0x${'22'.repeat(20)}`,
    signature: `0x${'33'.repeat(65)}`,
    rpcs: { L2: ['http://rpc.invalid'] },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a /lit_action refusal', () => {
  it('uses a bare JSON string body as the reason', async () => {
    vi.stubGlobal('fetch', stubFetch(JSON.stringify('Action not permitted for this usage key')));

    await expect(decrypt('usage-key')).rejects.toThrow(
      /HTTP 403 from \/lit_action: Action not permitted/,
    );
  });

  it('still reads an object body', async () => {
    vi.stubGlobal('fetch', stubFetch(JSON.stringify({ message: 'nope, not this action' })));

    await expect(decrypt('usage-key')).rejects.toThrow(/nope, not this action/);
  });

  it('never puts the usage key in the reason', async () => {
    const usageKey = '9i8zKrv71/aaaaaaaaaaaaaaaaaaaaaaaaaa=';
    vi.stubGlobal(
      'fetch',
      stubFetch(JSON.stringify(`denied for key ${usageKey} on action`)),
    );

    const failure = await decrypt(usageKey).catch((err: Error) => err);
    expect(String((failure as Error).message)).not.toContain(usageKey);
    expect(String((failure as Error).message)).toContain('<redacted>');
  });
});
