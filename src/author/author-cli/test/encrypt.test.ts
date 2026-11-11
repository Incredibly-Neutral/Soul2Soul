import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LitService,
  bodyForKey,
  buildSignedContentItem,
  noOpEncrypt,
  parseMarkdownNote,
  type AnyS2SContentItem,
  type S2SContentItemV3,
} from '@s2s/soul2soul-shared';
import { parse as parseYaml } from 'yaml';
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
// The author the write path signs with: the author Safe's bare address. Items
// pinned before the change carry `did:ethr:0x…` instead; nothing writes that
// form now, and only read paths still strip the prefix.
const AUTHOR = AUTHOR_ADDR;

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
  specVersion: '2' as const,
  postType: 'post',
  mediaType: 'text/markdown',
  parent: '0',
  position: '0',
  publication: 'test',
  locale: 'en',
  creationDate: 1_700_000_000,
  modifiedDate: 1_700_000_100,
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

  it('wraps raw non-JSON text, which is what Lit actually returns', () => {
    // The live `/lit_action` encrypt returns bare base64: no JSON, no
    // `dataToEncryptHash`. The read path does `JSON.parse(body.content)`, so the
    // writer wraps it and parse yields exactly the bytes Lit returned.
    const raw = 'gAAAAAB' + 'x'.repeat(60) + '==/';
    const stored = assertCiphertext(raw);
    expect(stored).toBe(JSON.stringify(raw));
    expect(JSON.parse(stored)).toBe(raw);
  });

  it('keeps a result that is already JSON text', () => {
    const obj = JSON.stringify({ ciphertext: 'abc', dataToEncryptHash: 'def' });
    expect(assertCiphertext(obj)).toBe(obj);
    const str = JSON.stringify('abc');
    expect(assertCiphertext(str)).toBe(str);
  });

  it('rejects an encoder that echoes the plaintext back', () => {
    const plaintext = JSON.stringify(body);
    expect(() => assertCiphertext(plaintext, plaintext)).toThrow(/plaintext unchanged/);
    // Re-serialised / JSON-encoded echoes are the same leak.
    expect(() => assertCiphertext(JSON.stringify(plaintext), plaintext)).toThrow(
      /plaintext unchanged/,
    );
    expect(() => assertCiphertext(JSON.stringify(body), plaintext)).toThrow(/plaintext unchanged/);
    // The same leak in the non-JSON branch: a plaintext that is not JSON text.
    expect(() => assertCiphertext('just some prose', 'just some prose')).toThrow(
      /plaintext unchanged/,
    );
  });
});

describe('buildEncryptFn', () => {
  it('passes a note without the flag straight through with noOpEncrypt', () => {
    const fn = buildEncryptFn(
      { config: { lit: {} }, protocolInfo: {}, lit: { encrypt: vi.fn() } },
      { encryption: false },
    );
    // Identity matters: shared derives `encryption: false` from `fn !== noOpEncrypt`.
    expect(fn).toBe(noOpEncrypt);
  });

  it('fails closed with a UsageError when LIT_USAGE_KEY is missing', () => {
    expect(() =>
      buildEncryptFn(
        { config: { lit: {} }, protocolInfo: { pkp: PKP }, lit: { encrypt: vi.fn() } },
        { encryption: true },
        'note.md',
      ),
    ).toThrow(/LIT_USAGE_KEY/);
  });

  it('fails closed with a UsageError when LIT_USAGE_KEY is empty', () => {
    expect(() =>
      buildEncryptFn(
        { config: { lit: { usageKey: '  ' } }, protocolInfo: { pkp: PKP }, lit: { encrypt: vi.fn() } },
        { encryption: true },
      ),
    ).toThrow(/LIT_USAGE_KEY/);
  });

  it('fails closed with a UsageError when the protocol PKP is missing or empty', () => {
    const lit = { encrypt: vi.fn() };
    expect(() =>
      buildEncryptFn({ config: { lit: { usageKey: 'k' } }, protocolInfo: {}, lit }, { encryption: true }),
    ).toThrow(/protocolInfo\.pkp/);
    expect(() =>
      buildEncryptFn(
        { config: { lit: { usageKey: 'k' } }, protocolInfo: { pkp: '  ' }, lit },
        { encryption: true },
      ),
    ).toThrow(/protocolInfo\.pkp/);
    expect(lit.encrypt).not.toHaveBeenCalled();
  });

  it('encrypts to the protocol PKP with the usage key and rejects an error-looking result', async () => {
    const encrypt = vi.fn(() => Promise.resolve('Error: Encrypt failed: action reverted'));
    const fn = buildEncryptFn(
      { config: { lit: { usageKey: 'lit-key' } }, protocolInfo: { pkp: PKP }, lit: { encrypt } },
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
      { config: { lit: { usageKey: 'lit-key' } }, protocolInfo: { pkp: PKP }, lit: { encrypt } },
      { encryption: true },
    );

    const item = await buildSignedContentItem(pub, body, fakeSigner, fn, AUTHOR);

    expect(item.encryption).toBe(true);
    expect(bodyForKey(item)).toBe(CIPHER);
    expect(item.bodies).toEqual({ s2s: CIPHER });
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
      { config: { lit: { usageKey: 'lit-key' } }, protocolInfo: { pkp: PKP }, lit: { encrypt: echo } },
      { encryption: true },
    );
    const plaintext = JSON.stringify(body);
    await expect(fn(plaintext)).rejects.toThrow(/plaintext unchanged/);
    // and the re-serialised variant, which is not a string match
    const reserialised = vi.fn((_key: string, _pkp: string) => Promise.resolve(plaintext));
    const fn2 = buildEncryptFn(
      {
        config: { lit: { usageKey: 'lit-key' } },
        protocolInfo: { pkp: PKP },
        lit: { encrypt: reserialised },
      },
      { encryption: true },
    );
    await expect(fn2(JSON.stringify(body))).rejects.toThrow(/plaintext unchanged/);
  });

  it('leaves a non-encrypted item plaintext with encryption false', async () => {
    const fn = buildEncryptFn({ config: { lit: {} }, protocolInfo: {}, lit: { encrypt: vi.fn() } }, {
      encryption: false,
    });
    const item = await buildSignedContentItem(pub, body, fakeSigner, fn, AUTHOR);
    expect(item.encryption).toBe(false);
    expect(JSON.parse(bodyForKey(item) ?? '')).toMatchObject({ title: 'Hello' });
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
      { config: { lit: { usageKey: 'usage-key' } }, protocolInfo: { pkp: PKP }, lit: svc },
      { encryption: true },
    );
    await expect(fn(JSON.stringify(body))).rejects.toThrow(/timeout\/network error/);
  });

  it('end to end: a real success passes through and is flagged encrypted', async () => {
    const cipher = JSON.stringify({ ciphertext: 'gAAAAABreal' });
    const svc = litWith(() => ({ response: { ciphertext: cipher } }));
    const fn = buildEncryptFn(
      { config: { lit: { usageKey: 'usage-key' } }, protocolInfo: { pkp: PKP }, lit: svc },
      { encryption: true },
    );
    const item = await buildSignedContentItem(pub, body, fakeSigner, fn, AUTHOR);
    expect(item.encryption).toBe(true);
    expect(bodyForKey(item)).toBe(cipher);
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

  /** The one IPFS endpoint these fixtures claim — `config.ipfs.primary` today. */
  const KUBO = { provider: 'kubo', url: 'https://gw.test' };

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
      config: {
        lit: { usageKey: overrides.litUsageKey },
        ipfs: { entries: [KUBO], primary: KUBO },
      },
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
    const item = JSON.parse(payload) as S2SContentItemV3;
    expect(item.encryption).toBe(true);
    // The storage layout: one body, under the protocol key's name, and no
    // single-body `body` key beside it.
    expect(item.bodies).toEqual({ s2s: CIPHER });
    expect(bodyForKey(item)).toBe(CIPHER);
    expect('body' in item).toBe(false);
    expect(result.kuboCid).toBe('bafyfake');
    // Frontmatter write-back happened on the temp note: `cid` (renamed from
    // `kubo_cid`), a creation_date, and a bare author address (no `did:ethr:`).
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('cid: bafyfake');
    expect(written).toMatch(/creation_date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(written).toContain('author: "0x');
    expect(written).not.toContain('did:ethr:');
    expect(written).not.toContain('kubo_cid');
  });

  it('renames a legacy kubo_cid, backfills creation_date and strips the did from the author', async () => {
    // A note written before the change: the author is stored as `did:ethr:0x…`.
    // Publishing migrates the spelling and keeps the address.
    const path = noteWith([
      'title: Hello',
      'genesis: "0x' + 'cd'.repeat(32) + '"',
      'kubo_cid: bafyplain',
      'modified_date: 2026-01-02T03:04:05',
      'author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55',
    ]);
    const { ctx } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);
    const written = readFileSync(path, 'utf8');
    // one CID key, the new name
    expect(written).toContain('cid: bafy');
    expect(written).not.toContain('kubo_cid');
    // creation_date falls back to the modified date the note already had, not to now
    expect(written).toContain('creation_date: 2026-01-02T03:04:05');
    expect(written).not.toContain(
      'creation_date: 2026-01-02T03:04:05\nmodified_date: 2026-01-02T03:04:05',
    );
    // the author keeps its address, loses only the prefix
    expect(written).toContain('author: "0x7907cB38776936B90002057d7feF3a9662ED9A55"');
    expect(written).not.toContain('did:ethr:');
  });

  it("signs a revision with the note's creation_date and this upload as modifiedDate", async () => {
    const path = noteWith([
      'title: Hello',
      'genesis: "0x' + 'ab'.repeat(32) + '"',
      'cid: bafyprevious',
      'creation_date: 2021-03-04T05:06:07',
      'modified_date: 2026-01-02T03:04:05',
    ]);
    const { ctx, uploaded } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    const before = Math.floor(Date.now() / 1000);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    const item = JSON.parse(uploaded[0] ?? '') as {
      public: { specVersion: string; creationDate: number; modifiedDate: number };
    };
    expect(item.public.specVersion).toBe('2');
    // the note's own birth, not the upload time
    expect(item.public.creationDate).toBe(Date.UTC(2021, 2, 4, 5, 6, 7) / 1000);
    expect(item.public.modifiedDate).toBeGreaterThanOrEqual(before);
    expect(item.public.modifiedDate).not.toBe(item.public.creationDate);
  });

  it('signs one instant as both dates on a first publish', async () => {
    const path = noteWith(['title: Hello']);
    const { ctx, uploaded } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    const item = JSON.parse(uploaded[0] ?? '') as {
      public: { creationDate: number; modifiedDate: number };
    };
    expect(item.public.creationDate).toBe(item.public.modifiedDate);
  });

  it('signs and writes back the modified_date it inherits, so the next revision does not drift', async () => {
    const path = noteWith(['title: Hello', 'modified_date: 2026-01-02T03:04:05']);
    const { ctx, uploaded } = fakeCtx({});
    const declared = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000;
    vi.mocked(authorSafeState).mockResolvedValue(FAKE_SAFE); // both uploads

    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);
    const first = JSON.parse(uploaded[0] ?? '') as {
      public: { creationDate: number; modifiedDate: number };
    };
    expect(first.public.creationDate).toBe(declared);
    // the write-back records the signed value, not a different one
    expect(readFileSync(path, 'utf8')).toContain('creation_date: 2026-01-02T03:04:05');

    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);
    const second = JSON.parse(uploaded[1] ?? '') as {
      public: { creationDate: number; modifiedDate: number };
    };
    expect(second.public.creationDate).toBe(declared);
    expect(second.public.modifiedDate).toBeGreaterThanOrEqual(first.public.modifiedDate);
  });

  it('refuses a creation_date that is not a date instead of re-birthing the note', async () => {
    const path = noteWith(['title: Hello', 'creation_date: last tuesday']);
    const { ctx, addToKubo } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await expect(authorWrite(ctx, path, 'test.soul2soul.eth', opts)).rejects.toThrow(/not a date/);
    expect(addToKubo).not.toHaveBeenCalled();
  });

  it('uploads the body unchanged for a note without the flag', async () => {
    const path = noteWith(['title: Hello', 'encryption: false']);
    const { ctx, uploaded } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    const payload = uploaded[0] ?? '';
    const item = JSON.parse(payload) as S2SContentItemV3;
    expect(item.encryption).toBe(false);
    expect(JSON.parse(bodyForKey(item) ?? '')).toMatchObject({
      title: 'Hello',
      content: '<p>secret body</p>',
    });
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
      fetchFromKubo: () =>
        Promise.resolve({ encryption: true, body: JSON.stringify('gAAAAABold') }),
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
      fetchFromKubo: () =>
        Promise.resolve({ encryption: true, body: JSON.stringify('gAAAAABold') }),
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
      /no recorded `cid`/,
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
      /does not resolve .*404.*Fix or remove the stale `cid`/,
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

  // -------------------------------------------------------------------------
  // The `encrypted` write-back: the note states what the last publish did
  // -------------------------------------------------------------------------

  /** The written `---` block re-parsed by YAML — what a reader of the file sees. */
  function writtenFrontmatter(path: string): Record<string, unknown> {
    const text = readFileSync(path, 'utf8');
    const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!block?.[1]) throw new Error(`no frontmatter block in:\n${text}`);
    return parseYaml(block[1]) as Record<string, unknown>;
  }

  /** How many times `key` appears as a frontmatter key (a duplicate is a bug). */
  function keyCount(path: string, key: string): number {
    return (readFileSync(path, 'utf8').match(new RegExp(`^${key}:`, 'gm')) ?? []).length;
  }

  it('writes `encrypted: false` for a plaintext publish, as an unquoted YAML boolean', async () => {
    const path = noteWith(['title: Hello']);
    const { ctx } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    const written = readFileSync(path, 'utf8');
    // the exact line, unquoted: a quoted "false" is truthy and would encrypt
    expect(written).toContain('\nencrypted: false\n');
    expect(written).not.toContain('encrypted: "false"');
    expect(written).not.toContain("encrypted: 'false'");
    const frontmatter = writtenFrontmatter(path);
    expect(frontmatter.encrypted).toBe(false);
    expect(typeof frontmatter.encrypted).toBe('boolean');
  });

  it('writes `encrypted: true` for an encrypted publish', async () => {
    // Declared as a quoted string on purpose: a fixture that already holds
    // `encrypted: true` would pass with the write-back removed, because the upsert
    // preserves a value it does not set. Here the file holds something else, so
    // only the write makes it `true`.
    const path = noteWith(['title: Hello', 'encrypted: "true"']);
    const { ctx } = fakeCtx({
      litUsageKey: 'lit-key',
      pkp: PKP,
      encrypt: () => Promise.resolve(JSON.stringify('gAAAAABwholeflow')),
    });
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('\nencrypted: true\n');
    expect(written).not.toContain('"true"');
    const frontmatter = writtenFrontmatter(path);
    expect(frontmatter.encrypted).toBe(true);
    expect(typeof frontmatter.encrypted).toBe('boolean');
    expect(frontmatter.encryption).toBeUndefined();
  });

  it('migrates a legacy `encryption: false` to `encrypted: false` and drops the old key', async () => {
    // The plaintext half of the rename: the legacy key was explicit `false`, and
    // the write-back must leave the boolean, not inherit the legacy spelling.
    const path = noteWith(['title: Hello', 'encryption: false']);
    const { ctx, uploaded } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    const item = JSON.parse(uploaded[0] ?? '') as { encryption: boolean };
    expect(item.encryption).toBe(false);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('\nencrypted: false\n');
    expect(written).not.toMatch(/^encryption:/m);
    expect(writtenFrontmatter(path).encrypted).toBe(false);
  });

  it('keeps the encryption flag out of the signed body, so it cannot shift an objectId', async () => {
    // `encrypted` is not in shared's KNOWN_FRONTMATTER_KEYS, so without the
    // delete in `authorWrite` it lands in `custom` and is signed into the body —
    // changing `plaintextHash` and with it the objectId of every encrypted note.
    const bare = noteWith(['title: Hello']);
    const flagged = noteWith(['title: Hello', 'encrypted: false']);
    const legacy = noteWith(['title: Hello', 'encryption: false']);
    const { ctx, uploaded } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValue(FAKE_SAFE);
    await authorWrite(ctx, bare, 'test.soul2soul.eth', opts);
    await authorWrite(ctx, flagged, 'test.soul2soul.eth', opts);
    await authorWrite(ctx, legacy, 'test.soul2soul.eth', opts);

    const customs = uploaded.map((payload) => {
      const item = JSON.parse(payload) as AnyS2SContentItem;
      return (JSON.parse(bodyForKey(item) ?? '') as { custom?: Record<string, unknown> }).custom;
    });
    for (const custom of customs) {
      expect(custom ?? {}).not.toHaveProperty('encrypted');
      expect(custom ?? {}).not.toHaveProperty('encryption');
    }
    // not template data: the same note text signs the same custom bag with or
    // without the flag in the file
    expect(customs[1]).toEqual(customs[0]);
    expect(customs[2]).toEqual(customs[0]);
  });

  it('migrates a legacy `encryption: true` to `encrypted: true` and drops the old key', async () => {
    // The legacy spelling is still read, so the note keeps encrypting; the
    // write-back leaves one key, naming the state that publish used.
    const path = noteWith(['title: Hello', 'encryption: true']);
    const encrypt = vi.fn(() => Promise.resolve(JSON.stringify('gAAAAABwholeflow')));
    const { ctx, uploaded } = fakeCtx({ litUsageKey: 'lit-key', pkp: PKP, encrypt });
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    expect(encrypt).toHaveBeenCalledTimes(1);
    const item = JSON.parse(uploaded[0] ?? '') as { encryption: boolean };
    // the published item's field keeps its own name
    expect(item.encryption).toBe(true);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('\nencrypted: true\n');
    expect(written).not.toMatch(/^encryption:/m);
    expect(writtenFrontmatter(path).encrypted).toBe(true);
  });

  it('states the state it used, not the declared one, when the note said a string "false"', async () => {
    // `encrypted: "false"` is truthy, so this publish encrypts; the write-back
    // replaces the string with the boolean it actually used.
    const path = noteWith(['title: Hello', 'encrypted: "false"']);
    const { ctx } = fakeCtx({
      litUsageKey: 'lit-key',
      pkp: PKP,
      encrypt: () => Promise.resolve(JSON.stringify('gAAAAABwholeflow')),
    });
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('\nencrypted: true\n');
    expect(written).not.toContain('"false"');
    expect(writtenFrontmatter(path).encrypted).toBe(true);
  });

  it('does not duplicate or reformat the key on a second publish', async () => {
    const path = noteWith(['title: Hello']);
    const { ctx } = fakeCtx({});
    vi.mocked(authorSafeState).mockResolvedValue(FAKE_SAFE); // both publishes
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);
    const first = writtenFrontmatter(path);
    await authorWrite(ctx, path, 'test.soul2soul.eth', opts);
    const second = writtenFrontmatter(path);

    expect(keyCount(path, 'encrypted')).toBe(1);
    expect(second.encrypted).toBe(false);
    // one key, same position and same spelling as after the first publish
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(readFileSync(path, 'utf8')).toContain('\nencrypted: false\n');
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
  /** The gateway this fixture claims to read through (`config.ipfs.primary`). */
  const KUBO = { provider: 'kubo', url: 'https://gw.test' };

  function fakeCtx(fetchFromKubo: (cid: string) => Promise<unknown>) {
    const spy = vi.fn(fetchFromKubo);
    const addToKubo = vi.fn(() =>
      Promise.reject(new Error('offer must not upload: the bytes are already on IPFS')),
    );
    const ctx = {
      config: { ipfs: { entries: [KUBO], primary: KUBO } },
      ipfs: { fetchFromKubo: spy, addToKubo },
      authorRunner: () => Promise.resolve({}),
      out: { log: vi.fn(), warn: vi.fn() },
    } as unknown as CliContext;
    return { ctx, fetchFromKubo: spy, addToKubo };
  }

  it('refuses a plaintext CID for an encrypted note, before any chain call', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafyplaintext',
    ]);
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: false, body: '{"title":"Hello"}' }),
    );
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
      /not JSON ciphertext/,
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
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', 'bafy--cid-plain')).rejects.toThrow(
      /refusing to offer .*bafy--cid-plain/,
    );
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
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: false, body: '{"title":"Hello"}' }),
    );
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
    ).rejects.toThrow(/not JSON ciphertext/);
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
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', 'bafy--cid-plain')).rejects.toThrow(
      /would publish the body in the clear/,
    );
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
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', 'bafy--cid-plain')).rejects.toThrow(
      /could not read the previous revision bafyencrypted/,
    );
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

  // -------------------------------------------------------------------------
  // The bodies layout: one body per key holder, read by the protocol key
  // -------------------------------------------------------------------------

  it('lets a current-layout item through when `bodies.s2s` is JSON ciphertext', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafybodies',
    ]);
    const cipher = JSON.stringify('gAAAAABok');
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: true, bodies: { s2s: cipher } }),
    );
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      /SAFE_REACHED/,
    );
  });

  it('refuses a `bodies.s2s` that is raw base64 instead of JSON text', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafybodies',
    ]);
    const raw = 'gAAAAAB' + 'z'.repeat(48);
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: true, bodies: { s2s: raw } }),
    );
    // The writer wraps bare base64 (`assertCiphertext`), so an item stored with
    // the raw string was written by something else: the offer path refuses it,
    // because the read path's `JSON.parse(body.content)` could not decrypt it.
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      /not JSON ciphertext/,
    );
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('refuses a `bodies.s2s` that is not JSON at all', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafybodies',
    ]);
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: true, bodies: { s2s: 'raw-not-json' } }),
    );
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      /not JSON ciphertext/,
    );
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('refuses a current-layout item with no body for the protocol key', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafybodies',
    ]);
    // A publication key holder's entry is not the protocol's: the reader asks
    // for `s2s`, so anything else is an item with no body for this key.
    const { ctx } = fakeCtx(() =>
      Promise.resolve({ encryption: true, bodies: { 'pub.example': JSON.stringify('gAAAAABok') } }),
    );
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', undefined)).rejects.toThrow(
      /has no string body/,
    );
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  it('refuses the downgrade when the previous revision is in the current layout', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafybodies',
    ]);
    const { ctx, fetchFromKubo } = fakeCtx(() =>
      Promise.resolve({ encryption: true, bodies: { s2s: JSON.stringify('gAAAAABold') } }),
    );
    await expect(offerContent(ctx, path, 'test.soul2soul.eth', 'bafy--cid-plain')).rejects.toThrow(
      /would publish the body in the clear/,
    );
    expect(fetchFromKubo).toHaveBeenCalledWith('bafybodies');
    expect(authorSafeState).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Legacy v2 items stay readable and are anchored verbatim
  // -------------------------------------------------------------------------

  it('offers a legacy v2 item on its own CID without re-uploading or rewriting it', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: true',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafylegacy',
    ]);
    const legacy = { encryption: true, body: JSON.stringify('gAAAAABold') };
    const { ctx, addToKubo, fetchFromKubo } = fakeCtx(() => Promise.resolve(legacy));
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);

    const result = await offerContent(ctx, path, 'test.soul2soul.eth', undefined);

    expect(result.kuboCid).toBe('bafylegacy');
    // the CID is what was read, and it is also the CID anchored on chain
    expect(fetchFromKubo).toHaveBeenCalledWith('bafylegacy');
    expect(makeOfferSpy).toHaveBeenCalledWith(genesis, 'bafylegacy');
    // offer rewrites nothing: no upload, no re-sign
    expect(addToKubo).not.toHaveBeenCalled();
  });

  it('reads a legacy v2 plaintext item for the downgrade guard and offers its CID', async () => {
    const path = noteWith([
      'title: Hello',
      'encryption: false',
      'genesis: "' + genesis + '"',
      'kubo_cid: bafylegacyplain',
    ]);
    const legacy = { encryption: false, body: '{"title":"Hello"}' };
    const { ctx, addToKubo } = fakeCtx(() => Promise.resolve(legacy));
    vi.mocked(authorSafeState).mockResolvedValueOnce(FAKE_SAFE);

    const result = await offerContent(ctx, path, 'test.soul2soul.eth', undefined);

    expect(result.kuboCid).toBe('bafylegacyplain');
    expect(makeOfferSpy).toHaveBeenCalledWith(genesis, 'bafylegacyplain');
    expect(addToKubo).not.toHaveBeenCalled();
  });
});

describe('fetchStoredItem', () => {
  it('reads the protocol-key body from the current layout', async () => {
    const reader = {
      fetchFromKubo: () =>
        Promise.resolve({ encryption: true, bodies: { s2s: 'x', 'pub.example': 'y' } }),
    };
    await expect(fetchStoredItem(reader, 'bafy1', 'n.md')).resolves.toEqual({
      encryption: true,
      s2sBody: 'x',
    });
  });

  it('reads a legacy v2 item out of its single `body`', async () => {
    await expect(
      fetchStoredItem({ fetchFromKubo: () => Promise.resolve({ body: 'x' }) }, 'bafy2', 'n.md'),
    ).resolves.toEqual({ encryption: false, s2sBody: 'x' });
  });

  it('reports no body when only another key holder has one', async () => {
    await expect(
      fetchStoredItem(
        {
          fetchFromKubo: () =>
            Promise.resolve({ encryption: true, bodies: { 'pub.example': 'y' } }),
        },
        'bafy5',
        'n.md',
      ),
    ).resolves.toEqual({ encryption: true, s2sBody: undefined });
  });

  it('rejects non-items, bad flags and a non-object bodies field', async () => {
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
    await expect(
      fetchStoredItem(
        { fetchFromKubo: () => Promise.resolve({ encryption: true, bodies: 'x' }) },
        'bafy6',
        'n.md',
      ),
    ).rejects.toThrow(/non-object `bodies`/);
    await expect(
      fetchStoredItem(
        { fetchFromKubo: () => Promise.resolve({ encryption: true, bodies: null }) },
        'bafy7',
        'n.md',
      ),
    ).rejects.toThrow(/non-object `bodies`/);
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
    for (const value of [
      'true',
      '"true"',
      '"false"',
      'no',
      'off',
      'yes',
      '1',
      'encrypted',
      'TRUE',
    ]) {
      expect(await flagFor(value), `encryption: ${value}`).toBe(true);
    }
  });

  it('publishes in the clear for false, null, empty and 0', async () => {
    for (const value of ['false', 'False', 'null', '~', '""', "''", '0', '']) {
      expect(await flagFor(value), `encryption: ${value}`).toBe(false);
    }
  });
});
