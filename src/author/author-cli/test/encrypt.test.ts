import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LitService, buildSignedContentItem, noOpEncrypt, parseMarkdownNote } from '@s2s/soul2soul-shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Both modules pull things vitest cannot resolve/run offline: the Filecoin
// adapter imports @filoz/synapse-sdk (unresolvable here), and authorSafeState
// needs an L2 RPC. The write path only uses them for their side effects.
vi.mock('../src/adapters/filecoin', () => ({
  createFilecoinStorage: () => Promise.resolve(undefined),
}));
const { makeOfferSpy } = vi.hoisted(() => ({
  makeOfferSpy: vi.fn(() => Promise.resolve('0x' + 'ff'.repeat(32))),
}));
// The publication service is chain-bound; only `makeOffer` matters here.
vi.mock('../src/core/service', () => ({
  PublicationService: {
    init: vi.fn(() =>
      Promise.resolve({
        subdomain: 'test',
        makeOffer: makeOfferSpy,
        getMultiSig: () => '0x2222222222222222222222222222222222222222',
        localePathsOf: () => Promise.resolve({}),
        retract: () => Promise.resolve('0x' + 'ee'.repeat(32)),
      }),
    ),
  },
}));
vi.mock('../src/core/author-safe', () => ({
  authorSafeState: vi.fn(() => Promise.reject(new Error('SAFE_REACHED'))),
}));

import { authorSafeState } from '../src/core/author-safe';
import { authorWrite, offerContent } from '../src/core/author';
import type { CliContext } from '../src/core/context';
import { assertCiphertext, buildEncryptFn, fetchStoredItem } from '../src/core/encrypt';
import { CliError, UsageError } from '../src/lib/errors';

const PKP = '0x' + '11'.repeat(20);
const AUTHOR_ADDR = '0x2222222222222222222222222222222222222222';
const AUTHOR = `did:ethr:${AUTHOR_ADDR}`;

/** A TypedDataSigner that produces a well-formed dummy signature (no keys). */
const fakeSigner = {
  getAddress: () => AUTHOR_ADDR,
  signTypedData: () => Promise.resolve('0x' + '33'.repeat(65)),
};

const FAKE_SAFE = {
  address: AUTHOR_ADDR as `0x${string}`,
  eoa: AUTHOR_ADDR as `0x${string}`,
  salt: 's2s_' + AUTHOR_ADDR,
  chain: 'base' as const,
  deployed: true,
};

const pub = {
  specVersion: '1',
  postType: 'post',
  mediaType: 'text/markdown',
  parent: '0',
  position: '0',
  publication: 'test',
  locale: 'en',
  createdAt: 1_700_000_000,
  base: 'hello',
  tags: [] as string[],
  attributes: undefined,
};

const body = { title: 'Hello', slug: 'hello', content: '<p>secret</p>', custom: {} };

beforeEach(() => {
  vi.mocked(authorSafeState).mockReset();
  makeOfferSpy.mockClear();
});

describe('assertCiphertext', () => {
  it('accepts read-path ciphertext unchanged (JSON string or JSON object)', () => {
    const asString = JSON.stringify('gAAAAAB' + 'x'.repeat(40));
    const asObject = JSON.stringify({ ciphertext: 'gAAAAAB' + 'x'.repeat(40) });
    expect(assertCiphertext(asString)).toBe(asString);
    expect(assertCiphertext(asObject)).toBe(asObject);
  });

  it('rejects empty and whitespace-only results', () => {
    expect(() => assertCiphertext('')).toThrow(CliError);
    expect(() => assertCiphertext('   \n\t')).toThrow(CliError);
  });

  it('rejects a non-string result', () => {
    expect(() => assertCiphertext(undefined)).toThrow(CliError);
    expect(() => assertCiphertext(null)).toThrow(CliError);
    expect(() => assertCiphertext({ ciphertext: 'x' })).toThrow(CliError);
  });

  it('rejects a swallowed Lit error rendered with error.toString()', () => {
    expect(() => assertCiphertext('Error: Encrypt failed: bad pkp')).toThrow(/Error string/);
    expect(() => assertCiphertext('TypeError: cannot read properties of undefined')).toThrow(
      /TypeError string/,
    );
    expect(() => assertCiphertext('Encrypt failed: no such wallet')).toThrow(/Encrypt failed/);
    expect(() =>
      assertCiphertext('TimeoutError: The operation was aborted due to timeout'),
    ).toThrow(/timeout\/network error/);
    expect(() => assertCiphertext('DOMException: failed to fetch')).toThrow(/timeout\/network error/);
    expect(() => assertCiphertext('something\n    at encrypt (/app/lit.js:42:13)')).toThrow(
      /stack trace/,
    );
  });

  it('rejects parseable-but-unusable values (the whitelist, not a blacklist)', () => {
    for (const value of ['null', '0', 'true', '[]', '{}', '""', '"   "', 'null']) {
      expect(() => assertCiphertext(value), value).toThrow(CliError);
    }
  });

  it('rejects raw non-JSON text, which the read path could not JSON.parse', () => {
    // A bare base64 ciphertext is what Lit would return if it did not return JSON.
    // The message must name what arrived and what the read path needs.
    const raw = 'gAAAAAB' + 'x'.repeat(60) + '==';
    expect(() => assertCiphertext(raw)).toThrow(/raw base64-like text/);
    expect(() => assertCiphertext(raw)).toThrow(/JSON\.parse\(body\.content\)/);
    expect(() => assertCiphertext(raw)).toThrow(/read path has to accept/);
  });

  it('rejects an encoder that echoes the plaintext back', () => {
    const plaintext = JSON.stringify(body);
    expect(() => assertCiphertext(plaintext, plaintext)).toThrow(/plaintext unchanged/);
    // Re-serialised / JSON-encoded echoes are the same leak.
    expect(() => assertCiphertext(JSON.stringify(plaintext), plaintext)).toThrow(
      /plaintext unchanged/,
    );
    expect(() => assertCiphertext(JSON.stringify(body), plaintext)).toThrow(/plaintext unchanged/);
  });
});

describe('buildEncryptFn', () => {
  it('passes a note without the flag straight through with noOpEncrypt', () => {
    const fn = buildEncryptFn(
      { config: {}, protocolInfo: {}, lit: { encrypt: vi.fn() } },
      { encryption: false },
    );
    // Identity matters: shared derives `encryption: false` from `fn !== noOpEncrypt`.
    expect(fn).toBe(noOpEncrypt);
  });

  it('fails closed with a UsageError when LIT_USAGE_KEY is missing', () => {
    expect(() =>
      buildEncryptFn(
        { config: {}, protocolInfo: { pkp: PKP }, lit: { encrypt: vi.fn() } },
        { encryption: true },
        'note.md',
      ),
    ).toThrow(/LIT_USAGE_KEY/);
  });

  it('fails closed with a UsageError when LIT_USAGE_KEY is empty', () => {
    expect(() =>
      buildEncryptFn(
        { config: { litUsageKey: '  ' }, protocolInfo: { pkp: PKP }, lit: { encrypt: vi.fn() } },
        { encryption: true },
      ),
    ).toThrow(/LIT_USAGE_KEY/);
  });

  it('fails closed with a UsageError when the protocol PKP is missing or empty', () => {
    const lit = { encrypt: vi.fn() };
    expect(() =>
      buildEncryptFn({ config: { litUsageKey: 'k' }, protocolInfo: {}, lit }, { encryption: true }),
    ).toThrow(/protocolInfo\.pkp/);
    expect(() =>
      buildEncryptFn(
        { config: { litUsageKey: 'k' }, protocolInfo: { pkp: '  ' }, lit },
        { encryption: true },
      ),
    ).toThrow(/protocolInfo\.pkp/);
    expect(lit.encrypt).not.toHaveBeenCalled();
  });

  it('encrypts to the protocol PKP with the usage key and rejects an error-looking result', async () => {
    const encrypt = vi.fn(() => Promise.resolve('Error: Encrypt failed: action reverted'));
    const fn = buildEncryptFn(
      { config: { litUsageKey: 'lit-key' }, protocolInfo: { pkp: PKP }, lit: { encrypt } },
      { encryption: true },
    );
    await expect(fn('{"a":1}')).rejects.toThrow(CliError);
    expect(encrypt).toHaveBeenCalledWith('lit-key', PKP, '{"a":1}');
  });

  it('reaches buildSignedContentItem as real ciphertext and flags the item as encrypted', async () => {
    const CIPHER = JSON.stringify('gAAAAABciphertext-' + 'z'.repeat(32));
    const encrypt = vi.fn((_key: string, _pkpId: string, _message: string) =>
      Promise.resolve(CIPHER),
    );
    const fn = buildEncryptFn(
      { config: { litUsageKey: 'lit-key' }, protocolInfo: { pkp: PKP }, lit: { encrypt } },
      { encryption: true },
    );

    const item = await buildSignedContentItem(pub, body, fakeSigner, fn, AUTHOR);

    expect(item.encryption).toBe(true);
    expect(item.body).toBe(CIPHER);
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(encrypt).toHaveBeenCalledWith(
      'lit-key',
      PKP,
      expect.stringContaining('"content":"<p>secret</p>"'),
    );
  });

  it('refuses an echoing encryptor through buildEncryptFn (never reaches signing)', async () => {
    const echo = vi.fn((_key: string, _pkp: string, message: string) => Promise.resolve(message));
    const fn = buildEncryptFn(
      { config: { litUsageKey: 'lit-key' }, protocolInfo: { pkp: PKP }, lit: { encrypt: echo } },
      { encryption: true },
    );
    const plaintext = JSON.stringify(body);
    await expect(fn(plaintext)).rejects.toThrow(/plaintext unchanged/);
    // and the re-serialised variant, which is not a string match
    const reserialised = vi.fn((_key: string, _pkp: string) => Promise.resolve(plaintext));
    const fn2 = buildEncryptFn(
      {
        config: { litUsageKey: 'lit-key' },
        protocolInfo: { pkp: PKP },
        lit: { encrypt: reserialised },
      },
      { encryption: true },
    );
    await expect(fn2(JSON.stringify(body))).rejects.toThrow(/plaintext unchanged/);
  });

  it('leaves a non-encrypted item plaintext with encryption false', async () => {
    const fn = buildEncryptFn({ config: {}, protocolInfo: {}, lit: { encrypt: vi.fn() } }, {
      encryption: false,
    });
    const item = await buildSignedContentItem(pub, body, fakeSigner, fn, AUTHOR);
    expect(item.encryption).toBe(false);
    expect(JSON.parse(item.body)).toMatchObject({ title: 'Hello' });
  });
});

// ===========================================================================
// The REAL LitService.encrypt failure path (not a hand-written fake)
// ===========================================================================
describe('LitService.encrypt really returns error strings (the reason for the whitelist)', () => {
  /** A LitService whose private `call` is replaced — the network seam only. */
  function litWith(impl: () => unknown): LitService {
    const svc = new LitService({ environment: 'prod' });
    (svc as unknown as { call: () => Promise<unknown> }).call = () => Promise.resolve().then(impl);
    return svc;
  }

  let log: MockInstance | undefined;
  beforeEach(() => {
    // shared's LitService console.logs { key, pkpId, message } — unrelated, noisy here.
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log?.mockRestore();
    log = undefined;
  });

  const encrypt = (svc: LitService): Promise<string> =>
    svc.encrypt('usage-key', PKP, '{"title":"x"}');

  it('a timeout surfaces as a DOMException string, which is NOT JSON', async () => {
    const svc = litWith(() =>
      Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    );
    const result = await encrypt(svc);
    expect(result).toBe('TimeoutError: The operation was aborted due to timeout');
    const parse = (): unknown => JSON.parse(result);
    expect(parse).toThrow();
    expect(() => assertCiphertext(result)).toThrow(/timeout\/network error/);
  });

  it('a fetch failure surfaces as a DOMException string', async () => {
    const svc = litWith(() => Promise.reject(new DOMException('failed to fetch', 'DOMException')));
    const result = await encrypt(svc);
    expect(result).toBe('DOMException: failed to fetch');
    expect(() => assertCiphertext(result)).toThrow(CliError);
  });

  it('an action error (has_error) is swallowed into "Error: Encrypt failed: …"', async () => {
    const svc = litWith(() => ({ has_error: true, logs: ['no such wallet'], response: {} }));
    const result = await encrypt(svc);
    // The action's log lines are withheld by shared (`describeActionLogs`), so the
    // reason survives only as a count — the string is still an error, not text.
    expect(result).toBe('Error: Encrypt failed: 1 action log line(s), 14 byte(s) withheld');
    expect(() => assertCiphertext(result)).toThrow(/Encrypt failed/);
  });

  it('a missing response surfaces as a TypeError string', async () => {
    const svc = litWith(() => ({ response: null }));
    const result = await encrypt(svc);
    expect(result).toMatch(/^TypeError:/);
    expect(() => assertCiphertext(result)).toThrow(/TypeError string/);
  });

  it('a non-string ciphertext value is returned as-is and rejected', async () => {
    const svc = litWith(() => ({ response: { ciphertext: null } }));
    const result = await encrypt(svc);
    expect(result).toBeNull();
    expect(() => assertCiphertext(result)).toThrow(CliError);
  });

  it('end to end: buildEncryptFn rejects the real failure instead of publishing it', async () => {
    const svc = litWith(() =>
      Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    );
    const fn = buildEncryptFn(
      { config: { litUsageKey: 'usage-key' }, protocolInfo: { pkp: PKP }, lit: svc },
      { encryption: true },
    );
    await expect(fn(JSON.stringify(body))).rejects.toThrow(/timeout\/network error/);
  });

  it('end to end: a real success passes through and is flagged encrypted', async () => {
    const cipher = JSON.stringify({ ciphertext: 'gAAAAABreal' });
    const svc = litWith(() => ({ response: { ciphertext: cipher } }));
    const fn = buildEncryptFn(
      { config: { litUsageKey: 'usage-key' }, protocolInfo: { pkp: PKP }, lit: svc },
      { encryption: true },
    );
    const item = await buildSignedContentItem(pub, body, fakeSigner, fn, AUTHOR);
    expect(item.encryption).toBe(true);
    expect(item.body).toBe(cipher);
  });
});

// ===========================================================================
// authorWrite end to end (Safe + Filecoin mocked)
// ===========================================================================
describe('authorWrite honors frontmatter encryption', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function noteWith(frontmatter: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 's2s-enc-'));
    dirs.push(dir);
    const path = join(dir, 'note.md');
    writeFileSync(path, ['---', ...frontmatter, '---', '', '# Hello', '', 'secret body'].join('\n'));
    return path;
  }

  function fakeCtx(overrides: {
    litUsageKey?: string;
    pkp?: string;
    encrypt?: (key: string, pkpId: string, message: string) => Promise<string>;
    fetchFromKubo?: (cid: string) => Promise<unknown>;
  }) {
    const uploaded: string[] = [];
    const addToKubo = vi.fn((payload: string) => {
      uploaded.push(payload);
      return Promise.resolve('bafyfake');
    });
    const fetchFromKubo = vi.fn(
      overrides.fetchFromKubo ?? (() => Promise.resolve({ encryption: false })),
    );
    const warn = vi.fn();
    const ctx = {
      config: { litUsageKey: overrides.litUsageKey, kuboGateway: 'https://gw.test' },
      protocolInfo: { pkp: overrides.pkp },
      lit: { encrypt: overrides.encrypt ?? vi.fn() },
      signer: fakeSigner,
      // only reached on the `offer: true` path (the service mock ignores it)
      authorRunner: () => Promise.resolve({}),
      ipfs: { addToKubo, fetchFromKubo },
      out: { log: vi.fn(), warn, error: vi.fn() },
    } as unknown as CliContext;
    return { ctx, addToKubo, fetchFromKubo, warn, uploaded };
  }

  const opts = { render: false, publish: false, offer: false };

  it('throws before any upload when encryption is requested without LIT_USAGE_KEY', async () => {
    const path = noteWith(['title: Hello', 'encryption: true']);
    const { ctx, addToKubo } = fakeCtx({ pkp: PKP });
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /LIT_USAGE_KEY/,
    );
    expect(addToKubo).not.toHaveBeenCalled();
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('throws before any upload when the protocol PKP is empty', async () => {
    const path = noteWith(['title: Hello', 'encryption: true']);
    const { ctx, addToKubo } = fakeCtx({ litUsageKey: 'lit-key', pkp: '' });
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /protocolInfo\.pkp/,
    );
    expect(addToKubo).not.toHaveBeenCalled();
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('uploads ciphertext with encryption: true on the happy path', async () => {
    const CIPHER = JSON.stringify('gAAAAABwholeflow');
    const path = noteWith(['title: Hello', 'encryption: true']);
    const encrypt = vi.fn(() => Promise.resolve(CIPHER));
    const { ctx, uploaded } = fakeCtx({ litUsageKey: 'lit-key', pkp: PKP, encrypt });

    // prove the call site actually uses the encrypt function: noOpEncrypt here
    // would make this suite fail on `encryption: true` / `body === CIPHER`.
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    const result = await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    expect(encrypt).toHaveBeenCalledTimes(1);
    const payload = uploaded[0] ?? '';
    const item = JSON.parse(payload) as { encryption: boolean; body: string };
    expect(item.encryption).toBe(true);
    expect(item.body).toBe(CIPHER);
    expect(result.kuboCid).toBe('bafyfake');
    // Frontmatter write-back happened on the temp note.
    expect(readFileSync(path, 'utf8')).toContain('kubo_cid: bafyfake');
  });

  it('uploads the body unchanged for a note without the flag', async () => {
    const path = noteWith(['title: Hello', 'encryption: false']);
    const { ctx, uploaded } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    const payload = uploaded[0] ?? '';
    const item = JSON.parse(payload) as { encryption: boolean; body: string };
    expect(item.encryption).toBe(false);
    expect(JSON.parse(item.body)).toMatchObject({ title: 'Hello', content: '<p>secret body</p>' });
  });

  it('an encrypt-time failure publishes nothing and offers nothing', async () => {
    const path = noteWith(['title: Hello', 'encryption: true']);
    const { ctx, addToKubo } = fakeCtx({
      litUsageKey: 'lit-key',
      pkp: PKP,
      encrypt: () =>
        Promise.reject(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
    });
    // The Safe is resolved before signing (an identity read), so it IS reached —
    // what must not happen is an upload or an offer.
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await expect(
      authorWrite(ctx, path, 'test.soul2soul.eth', { render: false, publish: false, offer: true }),
    ).rejects.toThrow(/encryption failed/);
    expect(addToKubo).not.toHaveBeenCalled();
    expect(makeOfferSpy).not.toHaveBeenCalled();
  });

  it('refuses to republish an encrypted genesis as plaintext', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "0x' + 'ab'.repeat(32) + '"',
      'kubo_cid: bafyprevious',
    ]);
    const { ctx, addToKubo } = fakeCtx({
      fetchFromKubo: () => Promise.resolve({ encryption: true, body: JSON.stringify('gAAAAABold') }),
    });
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /would publish the body in the clear/,
    );
    expect(addToKubo).not.toHaveBeenCalled();
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('allows the downgrade when --allow-plaintext is explicit', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "0x' + 'ab'.repeat(32) + '"',
      'kubo_cid: bafyprevious',
    ]);
    const { ctx, addToKubo } = fakeCtx({
      fetchFromKubo: () => Promise.resolve({ encryption: true, body: JSON.stringify('gAAAAABold') }),
    });
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', { ...opts, allowPlaintext: true });
    expect(addToKubo).toHaveBeenCalledTimes(1);
  });

  it('refuses when the previous revision cannot be read (fail closed, not warn)', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "0x' + 'ab'.repeat(32) + '"',
      'kubo_cid: bafyprevious',
    ]);
    const { ctx, addToKubo } = fakeCtx({
      fetchFromKubo: () => Promise.reject(new Error('dag/get failed: timeout')),
    });
    // A gateway hiccup is the most likely failure; continuing would publish
    // plaintext in exactly the case this guard exists for.
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /could not read the previous revision bafyprevious/,
    );
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /--allow-plaintext/,
    );
    expect(addToKubo).not.toHaveBeenCalled();
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('proceeds past an unreadable previous revision with --allow-plaintext', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "0x' + 'ab'.repeat(32) + '"',
      'kubo_cid: bafyprevious',
    ]);
    const { ctx, addToKubo } = fakeCtx({
      fetchFromKubo: () => Promise.reject(new Error('dag/get failed: timeout')),
    });
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', { ...opts, allowPlaintext: true });
    expect(addToKubo).toHaveBeenCalledTimes(1);
  });

  it('refuses (not warns) when an identity has no recorded CID', async () => {
    // Least is known in this state, so it is not a warning: an identity without
    // a recorded CID can hide an encrypted previous revision.
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "0x' + 'ab'.repeat(32) + '"',
    ]);
    const { ctx, addToKubo } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /no recorded `kubo_cid`/,
    );
    expect(addToKubo).not.toHaveBeenCalled();
  });

  it('publishes with no recorded CID under --allow-plaintext', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "0x' + 'ab'.repeat(32) + '"',
    ]);
    const { ctx, addToKubo } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', { ...opts, allowPlaintext: true });
    expect(addToKubo).toHaveBeenCalledTimes(1);
  });

  it('guards a `content_id`-only note too (no `genesis` frontmatter)', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'content_id: "0x' + 'ef'.repeat(32) + '"',
      'kubo_cid: bafyencrypted',
    ]);
    const { ctx } = fakeCtx({
      fetchFromKubo: () => Promise.resolve({ encryption: true, body: JSON.stringify('gAAAAAB') }),
    });
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /would publish the body in the clear/,
    );
  });

  it('refuses a content_id-only note whose previous revision cannot be read', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'content_id: "0x' + 'ef'.repeat(32) + '"',
      'kubo_cid: bafyencrypted',
    ]);
    const { ctx } = fakeCtx({ fetchFromKubo: () => Promise.reject(new Error('boom')) });
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /could not read the previous revision bafyencrypted/,
    );
  });

  it('names a stale CID differently from a gateway fault', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "0x' + 'ab'.repeat(32) + '"',
      'kubo_cid: bafystale',
    ]);
    const stale = fakeCtx({
      fetchFromKubo: () => Promise.reject(new Error('Failed to fetch from IPFS: 404 Not Found')),
    });
    await expect(authorWrite(stale.ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /does not resolve .*404.*Fix or remove the stale `kubo_cid`/,
    );

    const down = fakeCtx({ fetchFromKubo: () => Promise.reject(new Error('fetch failed')) });
    await expect(authorWrite(down.ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /gateway could not be reached .*--allow-plaintext/,
    );

    const timedOut = fakeCtx({
      fetchFromKubo: () =>
        Promise.reject(new Error('TimeoutError: The operation was aborted due to timeout')),
    });
    await expect(authorWrite(timedOut.ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /gateway read timed out/,
    );
  });

  it('an echoing encryptor is refused through authorWrite (plaintext never uploaded)', async () => {
    const path = noteWith(['title: Hello', 'encryption: true']);
    // returns the exact plaintext it was given — a lying `encryption: true`
    const { ctx, addToKubo, uploaded } = fakeCtx({
      litUsageKey: 'lit-key',
      pkp: PKP,
      encrypt: (_key: string, _pkp: string, message: string) => Promise.resolve(message),
    });
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(
      /plaintext unchanged/,
    );
    expect(addToKubo).not.toHaveBeenCalled();
    expect(uploaded).toEqual([]);
  });


  it('does no downgrade read for a first publish (no genesis / no recorded CID)', async () => {
    const path = noteWith(['title: Hello', 'encryption: false']);
    const { ctx, fetchFromKubo } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);
    expect(fetchFromKubo).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// offer — the CID is what gets anchored, so the ITEM is what is checked
// ===========================================================================
describe('offerContent verifies the stored item', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function noteWith(frontmatter: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 's2s-offer-'));
    dirs.push(dir);
    const path = join(dir, 'note.md');
    writeFileSync(path, ['---', ...frontmatter, '---', '', '# Hello', '', 'body'].join('\n'));
    return path;
  }

  const genesis = '0x' + 'cd'.repeat(32);

  function fakeCtx(fetchFromKubo: (cid: string) => Promise<unknown>) {
    const spy = vi.fn(fetchFromKubo);
    const ctx = {
      config: { kuboGateway: 'https://gw.test' },
      ipfs: { fetchFromKubo: spy },
      out: { log: vi.fn(), warn: vi.fn() },
    } as unknown as CliContext;
    return { ctx, fetchFromKubo: spy };
  }

  it('refuses a plaintext CID for an encrypted note, before any chain call', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyplaintext',
    ]);
    const { ctx } = fakeCtx(() => Promise.resolve({ encryption: false, body: '{"title":"Hello"}' }));
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      /declares `encryption: false`/,
    );
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('refuses an item that declares encryption but has an unreadable body', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyencrypted',
    ]);
    const { ctx } = fakeCtx(() => Promise.resolve({ encryption: true, body: 'raw-not-json' }));
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      /got non-JSON text/,
    );
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('refuses when the item cannot be fetched', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafymissing',
    ]);
    const { ctx } = fakeCtx(() => Promise.reject(new Error('Failed to fetch from IPFS')));
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      UsageError,
    );
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('lets a genuinely encrypted item through to the chain path', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyencrypted',
    ]);
    const cipher = JSON.stringify('gAAAAABok');
    const { ctx } = fakeCtx(() => Promise.resolve({ encryption: true, body: cipher }));
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      /SAFE_REACHED/,
    );
  });

  it('checks the ANCHORED cid, not the frontmatter one (--cid plaintext)', async () => {
    // frontmatter points at an encrypted item; --cid points at plaintext.
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyencrypted',
    ]);
    const cipher = JSON.stringify('gAAAAABok');
    const { ctx, fetchFromKubo } = fakeCtx((cid) =>
      cid === 'bafy--cid-plain'
        ? Promise.resolve({ encryption: false, body: '{"title":"Hello"}' })
        : Promise.resolve({ encryption: true, body: cipher }),
    );
    await expect(
      offerContent(ctx, path, 'test.soul2soul.eth', 'bafy--cid-plain'),
    ).rejects.toThrow(/refusing to offer .*bafy--cid-plain/);
    expect(fetchFromKubo).toHaveBeenCalledWith('bafy--cid-plain');
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('--allow-plaintext does NOT skip the "note says encrypted, item is plaintext" check', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyplaintext',
    ]);
    const { ctx } = fakeCtx(() => Promise.resolve({ encryption: false, body: '{"title":"Hello"}' }));
    await expect(
      offerContent(ctx, path, 'test.soul2soul.eth', undefined, { allowPlaintext: true }),
    ).rejects.toThrow(/declares `encryption: false`/);
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('--allow-plaintext does NOT skip the ciphertext validation', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafybad',
    ]);
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: true, body: 'TimeoutError: The operation was aborted' }),
    );
    await expect(
      offerContent(ctx, path, 'test.soul2soul.eth', undefined, { allowPlaintext: true }),
    ).rejects.toThrow(/encryption failed/);
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('refuses a plaintext revision when the same genesis was encrypted (downgrade)', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyencrypted',
    ]);
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: true, body: JSON.stringify('gAAAAABold') }),
    );
    await expect(
      offerContent(ctx, path, 'test.soul2soul.eth', 'bafy--cid-plain'),
    ).rejects.toThrow(/would publish the body in the clear/);
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('allows the offer downgrade with --allow-plaintext', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyencrypted',
    ]);
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: true, body: JSON.stringify('gAAAAABold') }),
    );
    await expect(
      offerContent(ctx, path, 'test.soul2soul.eth', 'bafy--cid-plain', { allowPlaintext: true }),
    ).rejects.toThrow(/SAFE_REACHED/);
  });

  it('refuses a offer when the previous revision cannot be read', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyencrypted',
    ]);
    const { ctx } = fakeCtx(() => Promise.reject(new Error('gateway timeout')));
    await expect(
      offerContent(ctx, path, 'test.soul2soul.eth', 'bafy--cid-plain'),
    ).rejects.toThrow(/could not read the previous revision bafyencrypted/);
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('lets a plaintext note through when the previous revision was plaintext too', async () => {
    const path = noteWith(['title: Hello', 'genesis: "' + genesis + '"', 'kubo_cid: bafyplain']);
    const { ctx, fetchFromKubo } = fakeCtx(() => Promise.resolve({ encryption: false }));
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      /SAFE_REACHED/,
    );
    // the downgrade guard read the previous revision, and did not refuse
    expect(fetchFromKubo).toHaveBeenCalledWith('bafyplain');
  });
});

describe('fetchStoredItem', () => {
  it('reports the flag and body, and rejects non-items / bad flags', async () => {
    const reader = { fetchFromKubo: () => Promise.resolve({ encryption: true, body: 'x' }) };
    await expect(fetchStoredItem(reader, 'bafy1', 'n.md')).resolves.toEqual({
      encryption: true,
      body: 'x',
    });
    await expect(
      fetchStoredItem({ fetchFromKubo: () => Promise.resolve({ body: 'x' }) }, 'bafy2', 'n.md'),
    ).resolves.toEqual({ encryption: false, body: 'x' });
    await expect(
      fetchStoredItem({ fetchFromKubo: () => Promise.resolve('nope') }, 'bafy3', 'n.md'),
    ).rejects.toThrow(/not a JSON object/);
    await expect(
      fetchStoredItem(
        { fetchFromKubo: () => Promise.resolve({ encryption: 'yes' }) },
        'bafy4',
        'n.md',
      ),
    ).rejects.toThrow(/non-boolean/);
  });
});

// ===========================================================================
// Frontmatter coercion (shared/src/authoring/note.ts — pinned, not fixed here)
// ===========================================================================
describe('frontmatter `encryption` coercion (Boolean())', () => {
  async function flagFor(value: string): Promise<boolean> {
    const raw = ['---', `encryption: ${value}`, 'title: T', '---', '', 'body'].join('\n');
    return (await parseMarkdownNote(raw, 'x.md')).encryption;
  }

  it('encrypts for anything truthy, including quoted "false", no and off', async () => {
    for (const value of ['true', '"true"', '"false"', 'no', 'off', 'yes', '1', 'encrypted', 'TRUE']) {
      expect(await flagFor(value), `encryption: ${value}`).toBe(true);
    }
  });

  it('publishes in the clear for false, null, empty and 0', async () => {
    for (const value of ['false', 'False', 'null', '~', '""', "''", '0', '']) {
      expect(await flagFor(value), `encryption: ${value}`).toBe(false);
    }
  });
});
