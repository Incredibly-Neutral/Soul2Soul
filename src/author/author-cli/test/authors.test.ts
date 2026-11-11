import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';

import {
  activeAuthorRecord,
  addAuthor,
  addSigner,
  authorEoa,
  authorRowForKey,
  authorsFilePath,
  findAuthor,
  findAuthorByKey,
  findAuthorName,
  givenSafeOf,
  isGivenSafe,
  isValidPetName,
  readAuthors,
  rememberAuthorSafe,
  removeAuthor,
  safeProblem,
  writeAuthors,
  writeBackAuthorSafe,
  type AuthorRecord,
  type AuthorsStore,
} from '../src/core/authors';
import { loadConfig, type LoadConfigOptions } from '../src/core/config';
import { writeConfigValue } from '../src/core/configfile';
import { authorNew, resolveKeySource } from '../src/commands/author-new';
import { authorSwitch } from '../src/commands/author-switch';
import { authorList } from '../src/commands/author-list';
import { authorRm } from '../src/commands/author-rm';
import { authorStoreCommands, findAuthorStoreCommand } from '../src/commands/author-store';
import { parseArgs } from '../src/lib/args';
import type { CliOut } from '../src/lib/out';

/** Valid keys nobody can use: privkey 1 and 2. */
const KEY_A = `0x${'00'.repeat(31)}01`;
const KEY_B = `0x${'00'.repeat(31)}02`;
const EOA_A = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-authors-test-'));
  // The store path resolves through XDG_CONFIG_HOME, so pointing that at the
  // temp dir keeps every command test away from the real ~/.config/s2s.
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  // No RPC: `author new` must degrade to safe: null instead of reaching out.
  vi.stubEnv('S2S_RPC_L2', '');
  vi.stubEnv('BASE_RPC_URL', '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function storePath(): string {
  return join(dir, 'xdg', 's2s', 'authors.json');
}

function localPath(name: string): string {
  return join(dir, `${name}.json`);
}

function store(active: string | null, authors: AuthorsStore['authors']): AuthorsStore {
  return { active, authors };
}

interface CapturedOut {
  out: CliOut;
  results: unknown[];
  warnings: string[];
}

/** Capture the typed output sink a command writes to (no mocks, no `any`). */
function capture(): CapturedOut {
  const results: unknown[] = [];
  const warnings: string[] = [];
  const out: CliOut = {
    json: true,
    log: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    result: (data: unknown) => {
      results.push(data);
    },
  };
  return { out, results, warnings };
}

describe('author store file', () => {
  it('round-trips through the file at mode 0600', () => {
    const path = localPath('round-trip');
    writeAuthors(store('zomi', { zomi: { privateKey: KEY_A, safe: null } }), path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    // a trailing newline keeps the file diff-friendly
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    expect(readAuthors(path)).toEqual(store('zomi', { zomi: { privateKey: KEY_A, safe: null } }));
  });

  it('normalises a bare-hex key on read and write', () => {
    const path = localPath('bare-hex');
    writeAuthors(store('zomi', { zomi: { privateKey: KEY_A.slice(2), safe: null } }), path);
    expect(readAuthors(path).authors.zomi?.privateKey).toBe(KEY_A);
  });

  it('tolerates a missing, corrupt or malformed file', () => {
    expect(readAuthors(localPath('absent'))).toEqual(store(null, {}));

    const corruptPath = join(dir, 'corrupt.json');
    writeFileSync(corruptPath, '{ not json');
    expect(readAuthors(corruptPath)).toEqual(store(null, {}));

    const malformed = localPath('malformed');
    writeFileSync(
      malformed,
      JSON.stringify({
        active: 'ghost',
        authors: {
          good: { privateKey: KEY_A, safe: null },
          'bad name': { privateKey: KEY_B, safe: null },
          noKey: {},
        },
      }),
    );
    // an unknown active name, an invalid pet name and a record without a key
    // are dropped; the usable author survives
    expect(readAuthors(malformed)).toEqual(
      store(null, { good: { privateKey: KEY_A, safe: null } }),
    );
  });

  it('writes a predicted Safe back only when it changed', () => {
    const path = localPath('write-back');
    writeAuthors(store('zomi', { zomi: { privateKey: KEY_A, safe: null } }), path);
    expect(writeBackAuthorSafe('zomi', '0xSafe', path)).toBe(true);
    expect(readAuthors(path).authors.zomi?.safe).toBe('0xSafe');
    expect(writeBackAuthorSafe('zomi', '0xSafe', path)).toBe(false);
  });
});

describe('pet names', () => {
  it('accepts the documented shape and rejects the rest', () => {
    for (const name of ['zomi', 'Zomi', 'a', 'a.b_c-d', '0xobsidian', 'x'.repeat(64)]) {
      expect(isValidPetName(name), name).toBe(true);
    }
    for (const name of ['', '-lead', '.dot', '_under', 'has space', 'slash/es', 'x'.repeat(65)]) {
      expect(isValidPetName(name), name).toBe(false);
    }
  });

  it('treats names as unique case-insensitively', () => {
    const data = store('zomi', { zomi: { privateKey: KEY_A, safe: null } });
    expect(findAuthorName(data, 'zomi')).toBe('zomi');
    expect(findAuthorName(data, 'Zomi')).toBe('zomi');
    expect(findAuthorName(data, 'ZOMI')).toBe('zomi');
    expect(findAuthorName(data, 'bob')).toBeUndefined();
  });

  it('files one key under exactly one pet name', () => {
    const data = store('zomi', { zomi: { privateKey: KEY_A, safe: null } });
    expect(findAuthorByKey(data, KEY_A)).toBe('zomi');
    // the case of the hex digits must not matter
    expect(findAuthorByKey(data, KEY_A.toUpperCase().replace('0X', '0x'))).toBe('zomi');
    expect(findAuthorByKey(data, KEY_B)).toBeUndefined();
  });

  it('adds an author as the active one', () => {
    const next = addAuthor(
      store('zomi', { zomi: { privateKey: KEY_A, safe: null } }),
      'bob',
      KEY_B,
      '0xSafe',
    );
    expect(next.active).toBe('bob');
    expect(Object.keys(next.authors)).toEqual(['zomi', 'bob']);
  });

  it('moves the active slot on when the active author is removed', () => {
    const two = store('bob', {
      zomi: { privateKey: KEY_A, safe: null },
      bob: { privateKey: KEY_B, safe: null },
    });
    // removing a non-active author leaves `active` alone
    expect(removeAuthor(two, 'zomi').active).toBe('bob');
    // removing the active one picks the first remaining author, in file order
    expect(removeAuthor(two, 'bob')).toEqual(
      store('zomi', { zomi: { privateKey: KEY_A, safe: null } }),
    );
    // the last one out leaves no active author
    expect(
      removeAuthor(store('zomi', { zomi: { privateKey: KEY_A, safe: null } }), 'zomi'),
    ).toEqual(store(null, {}));
  });

  it('resolves the active record and the EOA of a stored key', () => {
    const data = store('zomi', { zomi: { privateKey: KEY_A, safe: '0xSafe' } });
    expect(activeAuthorRecord(data)).toEqual({ name: 'zomi', privateKey: KEY_A, safe: '0xSafe' });
    expect(activeAuthorRecord(store(null, {}))).toBeUndefined();
    expect(authorEoa(KEY_A)).toBe(EOA_A);
    expect(authorEoa('0xnot-a-key')).toBeUndefined();
    expect(findAuthor(data, 'ZOMI')?.name).toBe('zomi');
  });
});

describe('authors.json location', () => {
  it('honours XDG_CONFIG_HOME and falls back to ~/.config when blank', () => {
    expect(authorsFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/user')).toBe(
      '/tmp/xdg/s2s/authors.json',
    );
    expect(authorsFilePath({ XDG_CONFIG_HOME: '   ' }, '/home/user')).toBe(
      '/home/user/.config/s2s/authors.json',
    );
    expect(authorsFilePath({}, '/home/user')).toBe('/home/user/.config/s2s/authors.json');
  });
});

describe('signing-key precedence', () => {
  function paths(): LoadConfigOptions {
    return {
      userConfigPath: join(dir, 'prec', 'user', 'config.json'),
      projectConfigPath: join(dir, 'prec', 'project', '.s2sconfig.json'),
      authorsPath: join(dir, 'prec', 'authors.json'),
    };
  }

  beforeEach(() => {
    writeConfigValue(join(dir, 'prec', 'user', 'config.json'), 'privateKey', KEY_B);
    writeConfigValue(join(dir, 'prec', 'project', '.s2sconfig.json'), 'privateKey', KEY_A);
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_B, safe: '0xSafe' } }),
      join(dir, 'prec', 'authors.json'),
    );
  });

  it('resolves env > project > store > user', () => {
    const envKey = `0x${'00'.repeat(31)}03`;

    const fromEnv = loadConfig({ S2S_PRIVATE_KEY: envKey }, paths());
    expect(fromEnv.privateKey).toBe(envKey);
    expect(fromEnv.author).toEqual({ name: undefined, safe: undefined, source: 'env' });

    const fromProject = loadConfig({}, paths());
    expect(fromProject.privateKey).toBe(KEY_A);
    expect(fromProject.author).toEqual({ name: undefined, safe: undefined, source: 'project' });

    rmSync(join(dir, 'prec', 'project', '.s2sconfig.json'));
    const fromStore = loadConfig({}, paths());
    expect(fromStore.privateKey).toBe(KEY_B);
    expect(fromStore.author).toEqual({ name: 'zomi', safe: '0xSafe', source: 'store' });

    rmSync(join(dir, 'prec', 'authors.json'));
    const fromUser = loadConfig({}, paths());
    expect(fromUser.privateKey).toBe(KEY_B);
    expect(fromUser.author).toEqual({ name: undefined, safe: undefined, source: 'user' });

    rmSync(join(dir, 'prec', 'user', 'config.json'));
    const none = loadConfig({}, paths());
    expect(none.privateKey).toBeUndefined();
    expect(none.author).toBeUndefined();
  });

  it('normalises a bare-hex key from the store and reports its missing Safe', () => {
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A.slice(2), safe: null } }),
      join(dir, 'prec', 'authors.json'),
    );
    rmSync(join(dir, 'prec', 'project', '.s2sconfig.json'));

    const config = loadConfig({}, paths());
    expect(config.privateKey).toBe(KEY_A);
    expect(config.author).toEqual({ name: 'zomi', safe: undefined, source: 'store' });
  });
});

describe('a given Safe', () => {
  // Lower case in, checksummed on the way into the store.
  const SAFE_ADDRESS = '0xabcd00000000000000000000000000000000def1';
  const SAFE = getAddress(SAFE_ADDRESS);
  const SAFE_DERIVED = getAddress('0xabcd00000000000000000000000000000000def2');
  const KEY_C = `0x${'00'.repeat(31)}03`;

  it('files a key into an existing Safe and records the provenance', () => {
    const path = localPath('add-signer');
    writeAuthors(store('zomi', { zomi: { privateKey: KEY_A, safe: null } }), path);

    const filed = addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE }, path);
    expect(filed).toEqual({ name: 'signer1', privateKey: KEY_B, safe: SAFE, safeSource: 'given' });

    const stored = readAuthors(path);
    // A new identity is the one you want next, same rule as `author new`.
    expect(stored.active).toBe('signer1');
    expect(stored.authors.signer1).toEqual({ privateKey: KEY_B, safe: SAFE, safeSource: 'given' });
    expect(isGivenSafe(stored.authors.signer1)).toBe(true);
    expect(givenSafeOf(stored.authors.signer1)).toBe(SAFE);
    // The derived row is untouched: it has no provenance field at all.
    expect(stored.authors.zomi).toEqual({ privateKey: KEY_A, safe: null });
  });

  it('rejects a taken name, a key filed elsewhere and a Safe already filed', () => {
    const path = localPath('add-signer-collisions');
    writeAuthors(store('zomi', { zomi: { privateKey: KEY_A, safe: null } }), path);
    addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE }, path);

    expect(() => addSigner({ name: 'ZOMI', privateKey: KEY_C, safe: SAFE_DERIVED }, path)).toThrow(
      /author 'zomi' already exists/,
    );
    expect(() => addSigner({ name: 'other', privateKey: KEY_A, safe: SAFE_DERIVED }, path)).toThrow(
      /already belongs to author 'zomi'/,
    );
    // One Safe, one author: the address compares case-insensitively.
    expect(() =>
      addSigner({ name: 'signer2', privateKey: KEY_C, safe: SAFE.toLowerCase() }, path),
    ).toThrow(/is already filed under author 'signer1'/);
    expect(readAuthors(path).authors.signer2).toBeUndefined();
  });

  it('reads a row without the field as derived', () => {
    const record: AuthorRecord = { privateKey: KEY_A, safe: SAFE };
    expect(isGivenSafe(record)).toBe(false);
    expect(givenSafeOf(record)).toBeUndefined();
    expect(isGivenSafe(undefined)).toBe(false);
    expect(givenSafeOf(undefined)).toBeUndefined();
    // `derived` may be spelled out; it still answers the same.
    expect(isGivenSafe({ ...record, safeSource: 'derived' })).toBe(false);
  });

  it('keeps a row it cannot interpret, without deriving it', () => {
    // Reading stays tolerant: `author list`, `switch` and `rm` are how a broken
    // file gets repaired, and none of them needs a provenance.
    const path = localPath('bogus-source');
    const file = JSON.stringify({
      active: 'zomi',
      authors: { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'Given' } },
    });
    writeFileSync(path, file);

    const store = readAuthors(path);
    expect(store.authors.zomi?.safe).toBe(SAFE);
    expect(isGivenSafe(store.authors.zomi)).toBe(false);
    expect(store.authors.zomi?.unreadableSafeSource).toBe('Given');
    expect(safeProblem('zomi', store.authors.zomi as AuthorRecord, path)).toMatch(
      /'zomi' has safeSource "Given"/,
    );
    // Never written back: a derived address would replace the stored one.
    expect(writeBackAuthorSafe('zomi', SAFE_DERIVED, path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(file);
    // And the row can still be removed without a text editor, and another
    // row's write leaves this one byte-identical: the reading is not format.
    const kept = removeAuthor(store, 'zomi');
    expect(kept.authors.zomi).toBeUndefined();
    writeAuthors(
      { active: null, authors: { ...store.authors, other: { privateKey: KEY_B, safe: null } } },
      path,
    );
    expect(JSON.parse(readFileSync(path, 'utf8')).authors.zomi).toEqual({
      privateKey: KEY_A,
      safe: SAFE,
      safeSource: 'Given',
    });
  });

  it('names a given row whose Safe is not an address, and keeps it readable', () => {
    const path = localPath('bogus-safe');
    writeFileSync(
      path,
      JSON.stringify({
        active: 'zomi',
        authors: { zomi: { privateKey: KEY_A, safe: 'not-an-address', safeSource: 'given' } },
      }),
    );
    const store = readAuthors(path);
    expect(store.authors.zomi?.safe).toBe('not-an-address');
    expect(safeProblem('zomi', store.authors.zomi as AuthorRecord, path)).toMatch(
      /has safe not-an-address — that is not an address/,
    );
    // A given row with no address is refused too: deriving would deploy one.
    expect(
      safeProblem('zomi', { privateKey: KEY_A, safe: null, safeSource: 'given' }, path),
    ).toMatch(/marked as given but carries no Safe address/);
    // A derived row's cached address is a prediction, so re-deriving repairs it.
    expect(
      safeProblem('zomi', { privateKey: KEY_A, safe: 'not-an-address' }, path),
    ).toBeUndefined();
  });

  it('finds a row by key, whichever row is active', () => {
    const row = authorRowForKey(
      {
        active: 'zomi',
        authors: {
          zomi: { privateKey: KEY_A, safe: null },
          signer1: { privateKey: KEY_B, safe: SAFE, safeSource: 'given' },
        },
      },
      KEY_B,
    );
    expect(row?.name).toBe('signer1');
    expect(givenSafeOf(row)).toBe(SAFE);
    expect(authorRowForKey({ active: 'zomi', authors: {} }, KEY_B)).toBeUndefined();
  });

  it('rejects a Safe that is not an address, or a broken checksum', () => {
    const path = localPath('add-signer-address');
    writeAuthors(store('zomi', { zomi: { privateKey: KEY_A, safe: null } }), path);

    expect(() => addSigner({ name: 'signer1', privateKey: KEY_B, safe: 'safe.eth' }, path)).toThrow(
      /'safe\.eth' is not an address/,
    );
    expect(() => addSigner({ name: 'signer1', privateKey: KEY_B, safe: '0xnothex' }, path)).toThrow(
      /is not an address/,
    );
    // Mixed case with the wrong checksum is a transcription error, not an address.
    const mistyped = `0xAbCd00000000000000000000000000000000dEf1`;
    expect(() => addSigner({ name: 'signer1', privateKey: KEY_B, safe: mistyped }, path)).toThrow(
      /is not an address/,
    );
    expect(readAuthors(path).authors.signer1).toBeUndefined();

    // A lower-case address is filed in its checksummed form.
    const filed = addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE_ADDRESS }, path);
    expect(filed.safe).toBe(SAFE);
    expect(readAuthors(path).authors.signer1?.safe).toBe(SAFE);
  });

  it('never has its address replaced by a derived one', () => {
    const path = localPath('given-write-back');
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' } }),
      path,
    );

    expect(writeBackAuthorSafe('zomi', SAFE_DERIVED, path)).toBe(false);
    expect(readAuthors(path).authors.zomi?.safe).toBe(SAFE);

    // The command path (`author address` / `init`) goes through the same guard.
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' } }),
      storePath(),
    );
    rememberAuthorSafe({ name: 'zomi', source: 'store' }, SAFE_DERIVED, () => undefined);
    expect(readAuthors(storePath()).authors.zomi).toEqual({
      privateKey: KEY_A,
      safe: SAFE,
      safeSource: 'given',
    });
  });
});

describe('store command registry', () => {
  it('is the table cli.ts dispatches before the context is built', () => {
    // cli.ts looks these up by name and runs them without buildContext; the
    // routing itself is hand-smoke-tested (see the spec's live notes).
    expect(authorStoreCommands.map((command) => command.name)).toEqual([
      'new',
      'switch',
      'list',
      'rm',
    ]);
    for (const command of authorStoreCommands) {
      expect(findAuthorStoreCommand(command.name)).toBe(command);
      // Every store action declares its flags, so cli.ts parses it strictly and
      // renders `--help` from the same spec.
      expect(command.flags).toBeTypeOf('object');
    }
    expect(findAuthorStoreCommand('upload')).toBeUndefined();
  });
});

describe('which key `author new` files', () => {
  // A phrase nobody should ever use on a real chain.
  const PHRASE =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('prefers --key, then --mnemonic, then stdin, then a generated phrase', () => {
    const stdin = (): string => KEY_B;
    const phrase = (): string => PHRASE;
    expect(resolveKeySource({ key: KEY_A }, { stdin, phrase })).toEqual({
      privateKey: KEY_A,
      generated: false,
    });
    expect(resolveKeySource({ mnemonic: PHRASE }, { stdin, phrase })).toEqual({
      privateKey: resolveKeySource({ mnemonic: PHRASE }).privateKey,
      mnemonic: PHRASE,
      generated: false,
    });
    expect(resolveKeySource({}, { stdin, phrase })).toEqual({
      privateKey: KEY_B,
      generated: false,
    });
    expect(resolveKeySource({}, { stdin: () => undefined, phrase })).toEqual({
      privateKey: resolveKeySource({ mnemonic: PHRASE }).privateKey,
      mnemonic: PHRASE,
      generated: true,
    });
  });

  it('reads a piped phrase as a phrase, not as a key', () => {
    const stdin = (): string => `  ${PHRASE}\n`;
    const fromKey = resolveKeySource({ mnemonic: PHRASE });
    expect(resolveKeySource({}, { stdin })).toEqual({ ...fromKey, generated: false });
  });

  it("derives the published \"abandon … about\" key at m/44'/60'/0'/0/0", () => {
    // The well-known vector for this phrase, so this pins the BIP39 seed + BIP44
    // path rather than "some key came out".
    expect(resolveKeySource({ mnemonic: PHRASE }).privateKey).toBe(
      '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727',
    );
  });

  it('rejects a phrase that is not a phrase', () => {
    expect(() => resolveKeySource({ mnemonic: 'not a phrase at all' })).toThrow(/invalid mnemonic/);
  });

  it('generates a 12-word phrase whose key is usable', () => {
    const { privateKey, mnemonic, generated } = resolveKeySource({}, { stdin: () => undefined });
    expect(generated).toBe(true);
    expect(mnemonic?.split(' ')).toHaveLength(12);
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(authorEoa(privateKey)).toMatch(/^0x[0-9A-Fa-f]{40}$/);
  });
});

describe('author commands', () => {
  function seed(): string {
    const path = storePath();
    writeAuthors(
      store('zomi', {
        zomi: { privateKey: KEY_A, safe: '0xSafe' },
        bob: { privateKey: KEY_B, safe: null },
      }),
      path,
    );
    return path;
  }

  it('new files a key under a pet name and activates it (unreachable RPC → safe: null)', async () => {
    // Prediction reads the L2 Safe factory, so keep it offline: a failing fetch
    // must leave the key stored with safe: null, not lose it.
    vi.stubGlobal('fetch', () => {
      throw new Error('offline');
    });
    const sink = capture();
    await authorNew.run(sink.out, parseArgs(['zomi', '--key', KEY_A]));

    const stored = readAuthors(storePath());
    expect(stored.active).toBe('zomi');
    expect(stored.authors.zomi?.privateKey).toBe(KEY_A);
    expect(stored.authors.zomi?.safe).toBeNull();
    expect(sink.warnings[0]).toMatch(/could not predict the author Safe/);
    expect(sink.results[0]).toMatchObject({
      action: 'author.new',
      name: 'zomi',
      eoa: EOA_A,
      safe: null,
      active: true,
      file: storePath(),
    });
  });

  it('new rejects a duplicate pet name (case-insensitive) and a duplicate key', async () => {
    seed();
    await expect(authorNew.run(capture().out, parseArgs(['ZOMI', '--key', KEY_B]))).rejects.toThrow(
      /author 'zomi' already exists/,
    );
    await expect(
      authorNew.run(capture().out, parseArgs(['carol', '--key', KEY_A])),
    ).rejects.toThrow(/already belongs to author 'zomi'/);
    // an invalid key is a usage error, not a stored record
    await expect(
      authorNew.run(capture().out, parseArgs(['carol', '--key', '0xdeadbeef'])),
    ).rejects.toThrow(/invalid private key/);
  });

  it('switches the active author by pet name', async () => {
    const path = seed();
    const sink = capture();
    await authorSwitch.run(sink.out, parseArgs(['BOB']));

    expect(readAuthors(path).active).toBe('bob');
    expect(sink.results[0]).toEqual({
      action: 'author.switch',
      name: 'bob',
      eoa: authorEoa(KEY_B),
      safe: null,
      file: path,
    });
  });

  it('rejects an unknown author and names the known ones', () => {
    seed();
    // `switch` is synchronous (no RPC, no await) — the usage error throws here.
    expect(() => authorSwitch.run(capture().out, parseArgs(['ghost']))).toThrow(
      /unknown author 'ghost' — known authors: zomi, bob/,
    );
  });

  it('lists every author and marks the active one', async () => {
    seed();
    const sink = capture();
    await authorList.run(sink.out, parseArgs([]));

    expect(sink.results[0]).toEqual({
      action: 'author.list',
      active: 'zomi',
      authors: [
        { name: 'zomi', eoa: EOA_A, safe: '0xSafe', active: true },
        { name: 'bob', eoa: authorEoa(KEY_B), safe: null, active: false },
      ],
    });
  });

  it('lists a given author by the Safe the store holds, with no salt', async () => {
    const given = '0xAbCd00000000000000000000000000000000dEf9';
    const path = storePath();
    writeAuthors(
      store('signer1', { signer1: { privateKey: KEY_B, safe: given, safeSource: 'given' } }),
      path,
    );
    const sink = capture();
    await authorList.run(sink.out, parseArgs([]));

    expect(sink.results[0]).toEqual({
      action: 'author.list',
      active: 'signer1',
      authors: [{ name: 'signer1', eoa: authorEoa(KEY_B), safe: given, active: true }],
    });
  });

  it('removes the active author and hands the slot to the first remaining one', async () => {
    const path = seed();
    const sink = capture();
    await authorRm.run(sink.out, parseArgs(['ZOMI']));

    expect(sink.results[0]).toMatchObject({
      action: 'author.rm',
      name: 'zomi',
      file: path,
      active: 'bob',
    });
    expect(Object.keys(readAuthors(path).authors)).toEqual(['bob']);
  });
});
