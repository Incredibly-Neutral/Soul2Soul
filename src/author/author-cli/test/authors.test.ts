import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeAuthorRecord,
  addAuthor,
  authorEoa,
  authorsFilePath,
  findAuthor,
  findAuthorByKey,
  findAuthorName,
  isValidPetName,
  readAuthors,
  removeAuthor,
  writeAuthors,
  writeBackAuthorSafe,
  type AuthorsStore,
} from '../src/core/authors';
import { loadConfig, type LoadConfigOptions } from '../src/core/config';
import { writeConfigValue } from '../src/core/configfile';
import { authorNew, resolvePrivateKey } from '../src/commands/author-new';
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
    expect(readAuthors(malformed)).toEqual(store(null, { good: { privateKey: KEY_A, safe: null } }));
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
    expect(removeAuthor(store('zomi', { zomi: { privateKey: KEY_A, safe: null } }), 'zomi')).toEqual(
      store(null, {}),
    );
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
  it('prefers --key, then stdin, then generates', () => {
    const stdin = (): string => KEY_B;
    const random = (): string => KEY_A;
    expect(resolvePrivateKey({ key: KEY_A }, { stdin, random })).toEqual({
      key: KEY_A,
      generated: false,
    });
    expect(resolvePrivateKey({}, { stdin, random })).toEqual({ key: KEY_B, generated: false });
    expect(resolvePrivateKey({}, { stdin: () => undefined, random })).toEqual({
      key: KEY_A,
      generated: true,
    });
  });

  it('generates a usable 32-byte key when neither is given', async () => {
    // Real CSPRNG, not a stub: the point is that the generated key is a key.
    const { key, generated } = resolvePrivateKey({}, { stdin: () => undefined });
    expect(generated).toBe(true);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(authorEoa(key)).toMatch(/^0x[0-9A-Fa-f]{40}$/);
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
    await expect(
      authorNew.run(capture().out, parseArgs(['ZOMI', '--key', KEY_B])),
    ).rejects.toThrow(/author 'zomi' already exists/);
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
