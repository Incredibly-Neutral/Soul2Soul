import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';

import {
  activeAuthorRecord,
  addAuthor,
  addSigner,
  authorEoa,
  authorRowForKey,
  authorRows,
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
  removalHoldIn,
  safeProblem,
  writeAuthors,
  pendingReplacement,
  pendingReplacementIn,
  setPendingProposal,
  settleReplacement,
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
  /** The human render of each result, for the lines a table has to carry. */
  human: string[];
}

/** Capture the typed output sink a command writes to (no mocks, no `any`). */
function capture(): CapturedOut {
  const results: unknown[] = [];
  const warnings: string[] = [];
  const human: string[] = [];
  const out: CliOut = {
    json: true,
    log: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    result: (data: unknown, text?: string) => {
      results.push(data);
      human.push(text ?? '');
    },
  };
  return { out, results, warnings, human };
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

describe('a pending replacement', () => {
  const SAFE = getAddress('0xabcd00000000000000000000000000000000def1');
  const OTHER_SAFE = getAddress('0xabcd00000000000000000000000000000000def2');
  const EOA_B = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
  const KEY_C = `0x${'00'.repeat(31)}03`;

  /** `zomi` owns SAFE; `signer1` is filed to replace it, not yet an owner. */
  function chase(): string {
    const path = localPath('chase');
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' } }),
      path,
    );
    addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE, replaces: 'zomi' }, path);
    return path;
  }

  it('files the new row inactive and leaves the old row untouched', () => {
    const path = localPath('file-replacement');
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' } }),
      path,
    );

    const before = JSON.parse(readFileSync(path, 'utf8')) as { authors: Record<string, unknown> };
    const filed = addSigner(
      { name: 'signer1', privateKey: KEY_B, safe: SAFE.toLowerCase(), replaces: 'ZOMI' },
      path,
    );
    // The marker carries the stored spelling, not the one the user typed.
    expect(filed).toEqual({
      name: 'signer1',
      privateKey: KEY_B,
      safe: SAFE,
      safeSource: 'given',
      replaces: 'zomi',
    });

    const stored = readAuthors(path);
    // The old key still signs `signer confirm`, so it stays the active one.
    expect(stored.active).toBe('zomi');
    // Two rows for one Safe, which no other path in this store allows.
    expect(stored.authors.signer1).toEqual({
      privateKey: KEY_B,
      safe: SAFE,
      safeSource: 'given',
      replaces: 'zomi',
    });
    expect(stored.authors.zomi).toEqual({ privateKey: KEY_A, safe: SAFE, safeSource: 'given' });
    // Byte-for-byte: the row being replaced is not touched by filing the chase.
    expect(JSON.stringify(stored.authors.zomi)).toBe(JSON.stringify(before.authors.zomi));
    expect(pendingReplacement(SAFE, path)).toEqual({ name: 'signer1', replaces: 'zomi' });
    expect(pendingReplacementIn(stored, SAFE)).toEqual({ name: 'signer1', replaces: 'zomi' });
    expect(pendingReplacement(OTHER_SAFE, path)).toBeUndefined();
  });

  it('settles across all four outcomes', () => {
    const path = chase();

    // none: a Safe nothing is chasing.
    expect(settleReplacement(OTHER_SAFE, [], path)).toBe('none');

    // pending: the old key still owns the Safe, the newcomer does not.
    expect(settleReplacement(SAFE, [EOA_A], path)).toBe('pending');
    // collision: neither key is an owner — the old one left the list without
    // the swap putting the new one there, so waiting cannot move it on.
    expect(settleReplacement(SAFE, [], path)).toBe('collision');
    // Nothing moved: both rows, the marker and the active slot are as filed.
    expect(readAuthors(path)).toEqual({
      active: 'zomi',
      authors: {
        zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' },
        signer1: { privateKey: KEY_B, safe: SAFE, safeSource: 'given', replaces: 'zomi' },
      },
    });

    // collision: both keys are owners — the caller warns, the store is untouched.
    expect(settleReplacement(SAFE, [EOA_A, EOA_B], path)).toBe('collision');
    expect(readAuthors(path).authors.zomi).toBeDefined();
    expect(readAuthors(path).authors.signer1?.replaces).toBe('zomi');
    expect(readAuthors(path).active).toBe('zomi');

    // settled: the new key owns it, the old one does not.
    expect(settleReplacement(SAFE, [EOA_B], path)).toBe('settled');
    const settled = readAuthors(path);
    expect(settled.authors.zomi).toBeUndefined();
    expect(settled.authors.signer1).toEqual({
      privateKey: KEY_B,
      safe: SAFE,
      safeSource: 'given',
    });
    expect(settled.active).toBe('signer1');
    // Settled is a state, not a step: a second call finds nothing to settle.
    expect(settleReplacement(SAFE, [EOA_B], path)).toBe('none');
  });

  it('decides on the keys, not on the addresses the rows hold', () => {
    const path = chase();
    // These are the two EOAs of the stored keys; a row's `safe` says nothing
    // about which of them the Safe knows.
    expect(authorEoa(KEY_B)).toBe(EOA_B);
    // Owner lists arrive in whatever case the call site used.
    const shouted = EOA_A.toUpperCase().replace('0X', '0x') as Address;
    expect(settleReplacement(SAFE, [shouted, EOA_B], path)).toBe('collision');
    // An unreadable key is no evidence: the row stays pending.
    writeAuthors(
      {
        active: 'zomi',
        authors: {
          zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' },
          signer1: { privateKey: '0xnot-a-key', safe: SAFE, safeSource: 'given', replaces: 'zomi' },
        },
      },
      path,
    );
    expect(settleReplacement(SAFE, [EOA_B], path)).toBe('pending');
  });

  it('refuses a second chase for one Safe', () => {
    const path = chase();
    expect(() =>
      addSigner({ name: 'signer2', privateKey: KEY_C, safe: SAFE, replaces: 'zomi' }, path),
    ).toThrow(/already has a pending replacement under author 'signer1'/);
    // Not even without naming the row it would replace: one Safe, one chase.
    expect(() => addSigner({ name: 'signer2', privateKey: KEY_C, safe: SAFE }, path)).toThrow(
      /already has a pending replacement/,
    );
    expect(readAuthors(path).authors.signer2).toBeUndefined();
  });

  it('refuses a replacement of a row that is missing or holds another Safe', () => {
    const path = localPath('bad-replacement');
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' } }),
      path,
    );

    expect(() =>
      addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE, replaces: 'ghost' }, path),
    ).toThrow(/no author 'ghost' to replace/);
    expect(() =>
      addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE, replaces: 'signer0' }, path),
    ).toThrow(/no author 'signer0' to replace/);

    // A derived row holds no Safe, so it cannot be the row this Safe is taken from.
    writeAuthors(store('bob', { bob: { privateKey: KEY_C, safe: null } }), path);
    expect(() =>
      addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE, replaces: 'bob' }, path),
    ).toThrow(/filed for safe \(none\), not/);

    // A row filed for another Safe is a different author id, not this one.
    writeAuthors(
      store('signer0', {
        signer0: { privateKey: KEY_A, safe: OTHER_SAFE, safeSource: 'given' },
      }),
      path,
    );
    expect(() =>
      addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE, replaces: 'signer0' }, path),
    ).toThrow(/filed for safe 0x.*, not 0x/);

    // And a chase cannot replace a chase: the head of the chain must be an owner.
    const chased = chase();
    expect(() =>
      addSigner({ name: 'signer3', privateKey: KEY_C, safe: SAFE, replaces: 'signer1' }, chased),
    ).toThrow(/is itself a pending replacement/);
    expect(readAuthors(path).authors.signer1).toBeUndefined();
  });

  it('prints a pending row as pending, never as an owner', () => {
    const path = chase();
    const rows = authorRows(readAuthors(path));
    expect(rows).toEqual([
      {
        name: 'zomi',
        eoa: EOA_A,
        safe: SAFE,
        active: true,
        ownership: 'owner',
      },
      {
        name: 'signer1',
        eoa: EOA_B,
        safe: SAFE,
        active: false,
        ownership: 'pending',
        replaces: 'zomi',
      },
    ]);
    const stored = readAuthors(path);
    expect(rows.map((row) => row.ownership)).toEqual(['owner', 'pending']);
    expect(stored.authors.zomi?.replaces).toBeUndefined();
  });

  it('settles on ownership alone when the replaced row is missing', () => {
    // `author rm` of the old row used to be allowed, so a store in the wild can
    // hold a chase whose target is gone: the marker has to clear on the chain
    // fact, or it never clears at all.
    const path = localPath('chase-missing');
    writeAuthors(
      {
        active: 'zomi-next',
        authors: {
          'zomi-next': { privateKey: KEY_B, safe: SAFE, safeSource: 'given', replaces: 'ghost' },
        },
      },
      path,
    );

    // Nobody listed as an owner: the chase cannot settle, and it is not pending
    // (there is no old key left to move), so the caller warns.
    expect(settleReplacement(SAFE, [EOA_A], path)).toBe('collision');
    // The newcomer owns the Safe and there is no old row to retire: settled.
    expect(settleReplacement(SAFE, [EOA_B], path)).toBe('settled');
    expect(readAuthors(path)).toEqual({
      active: 'zomi-next',
      authors: { 'zomi-next': { privateKey: KEY_B, safe: SAFE, safeSource: 'given' } },
    });
  });

  it('holds both rows of a rotation against `author rm`', () => {
    const path = chase();
    const stored = readAuthors(path);

    // The row being replaced may be the last stored copy of the key that owns
    // the Safe, and the pending row the last copy of the key the swap adds.
    expect(removalHoldIn(stored, 'zomi')).toMatch(/being replaced|still holds a key/);
    expect(removalHoldIn(stored, 'zomi')).toContain('s2s signer rotate');
    expect(removalHoldIn(stored, 'signer1')).toContain('pending replacement');
    expect(removalHoldIn(stored, 'signer1')).toContain('s2s signer confirm');
    // A row outside the rotation is removable, and an unknown name is not a hold.
    expect(removalHoldIn(stored, 'ghost')).toBeUndefined();
    writeAuthors(
      { active: 'zomi', authors: { ...stored.authors, bob: { privateKey: KEY_C, safe: null } } },
      path,
    );
    expect(removalHoldIn(readAuthors(path), 'bob')).toBeUndefined();
    // Settled, the row is an ordinary one again.
    settleReplacement(SAFE, [EOA_B], path);
    expect(removalHoldIn(readAuthors(path), 'signer1')).toBeUndefined();
  });

  /** Two safeTxHashes, neither of which any chain has ever seen. */
  const HASH = `0x${'ab'.repeat(32)}` as const;
  const OTHER_HASH = `0x${'cd'.repeat(32)}` as const;

  /** `zomi` owns SAFE; `signer1` is filed to replace it with its swap queued. */
  function queuedChase(): string {
    const path = localPath('chase-queued');
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' } }),
      path,
    );
    addSigner(
      { name: 'signer1', privateKey: KEY_B, safe: SAFE, replaces: 'zomi', proposal: HASH },
      path,
    );
    return path;
  }

  it('reads a proposal back with the row it was filed on', () => {
    const path = localPath('filed-with-proposal');
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' } }),
      path,
    );
    const filed = addSigner(
      { name: 'signer1', privateKey: KEY_B, safe: SAFE, replaces: 'zomi', proposal: HASH },
      path,
    );
    // `addSigner` hands back what it wrote, so a caller can print the hash.
    expect(filed.proposal).toBe(HASH);
    expect(readAuthors(path).authors.signer1).toEqual({
      privateKey: KEY_B,
      safe: SAFE,
      safeSource: 'given',
      replaces: 'zomi',
      proposal: HASH,
    });
    expect(pendingReplacement(SAFE, path)).toEqual({
      name: 'signer1',
      replaces: 'zomi',
      proposal: HASH,
    });
    expect(pendingReplacementIn(readAuthors(path), SAFE)?.proposal).toBe(HASH);
  });

  it('has no proposal on a row that was filed but never queued', () => {
    const path = chase();
    expect(pendingReplacement(SAFE, path)).toEqual({ name: 'signer1', replaces: 'zomi' });
    expect(pendingReplacement(SAFE, path)?.proposal).toBeUndefined();
    expect(readAuthors(path).authors.signer1?.proposal).toBeUndefined();

    // A hand-edited non-hash reads the same: filed, never proposed. Reading is
    // tolerant, and "never proposed" is the safe reading — it re-proposes.
    writeAuthors(
      {
        active: 'zomi',
        authors: {
          zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' },
          signer1: {
            privateKey: KEY_B,
            safe: SAFE,
            safeSource: 'given',
            replaces: 'zomi',
            proposal: '0xdeadbeef' as const,
          },
        },
      },
      path,
    );
    expect(pendingReplacement(SAFE, path)).toEqual({ name: 'signer1', replaces: 'zomi' });
  });

  it('records and replaces the hash after the queue', () => {
    const path = chase();
    const row = setPendingProposal('SIGNER1', HASH, path);
    expect(row).toEqual({
      name: 'signer1',
      privateKey: KEY_B,
      safe: SAFE,
      safeSource: 'given',
      replaces: 'zomi',
      proposal: HASH,
    });
    expect(readAuthors(path).authors.signer1?.proposal).toBe(HASH);
    // Nothing else about the rotation moves: same marker, same active slot.
    expect(readAuthors(path).active).toBe('zomi');
    expect(readAuthors(path).authors.signer1?.replaces).toBe('zomi');

    // A second queue (the first proposal dropped) replaces, never appends.
    setPendingProposal('signer1', OTHER_HASH, path);
    expect(pendingReplacement(SAFE, path)?.proposal).toBe(OTHER_HASH);
  });

  it('refuses a proposal for a row that is not a pending replacement', () => {
    const path = chase();
    expect(() => setPendingProposal('zomi', HASH, path)).toThrow(
      /author 'zomi' is not a pending replacement/,
    );
    expect(() => setPendingProposal('ghost', HASH, path)).toThrow(/no author 'ghost'/);
    // A settled row is an ordinary row, so it holds no swap either.
    settleReplacement(SAFE, [EOA_B], path);
    expect(() => setPendingProposal('signer1', HASH, path)).toThrow(
      /author 'signer1' is not a pending replacement/,
    );
  });

  it('refuses a hash that is not 32 bytes, naming the row', () => {
    const path = chase();
    // A cut-off hash is a transcription error, not a proposal.
    const truncated = `0x${'ab'.repeat(31)}` as const;
    expect(() => setPendingProposal('signer1', truncated, path)).toThrow(
      /author 'signer1' proposal '0xab+/,
    );
    expect(() => setPendingProposal('signer1', `0x${'ab'.repeat(33)}` as const, path)).toThrow(
      /is not a safeTxHash/,
    );
    expect(() =>
      addSigner(
        {
          name: 'signer2',
          privateKey: KEY_C,
          safe: SAFE,
          replaces: 'zomi',
          proposal: '0xnothex' as const,
        },
        path,
      ),
    ).toThrow(/author 'signer2' proposal '0xnothex' is not a safeTxHash/);
    // Refused writes leave the store as it was.
    expect(pendingReplacement(SAFE, path)).toEqual({ name: 'signer1', replaces: 'zomi' });
    expect(readAuthors(path).authors.signer2).toBeUndefined();
  });

  it('refuses a proposal on a row that replaces nothing', () => {
    const path = localPath('proposal-alone');
    expect(() =>
      addSigner({ name: 'signer1', privateKey: KEY_B, safe: SAFE, proposal: HASH }, path),
    ).toThrow(/cannot carry a proposal without `replaces`/);
    expect(readAuthors(path).authors.signer1).toBeUndefined();
  });

  it('drops the proposal when the swap settles, and keeps it on a collision', () => {
    const path = queuedChase();

    // A collision writes nothing, and nothing has landed: the hash is how the
    // queued swap gets executed rather than proposed again, so it stays.
    expect(settleReplacement(SAFE, [], path)).toBe('collision');
    expect(readAuthors(path).authors.signer1).toEqual({
      privateKey: KEY_B,
      safe: SAFE,
      safeSource: 'given',
      replaces: 'zomi',
      proposal: HASH,
    });

    // Settled on ownership alone: the hash said the swap was queued, and that
    // is not evidence it landed. It goes with the marker in the same write.
    expect(settleReplacement(SAFE, [EOA_B], path)).toBe('settled');
    expect(readAuthors(path).authors.signer1).toEqual({
      privateKey: KEY_B,
      safe: SAFE,
      safeSource: 'given',
    });
    expect(pendingReplacement(SAFE, path)).toBeUndefined();
  });
});

describe('a rotation refuses `author rm`', () => {
  const SAFE = getAddress('0xabcd00000000000000000000000000000000def1');

  const rmStore = (): string => {
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe: SAFE, safeSource: 'given' } }),
      storePath(),
    );
    addSigner({ name: 'zomi-next', privateKey: KEY_B, safe: SAFE, replaces: 'zomi' }, storePath());
    return storePath();
  };

  it('refuses the chased row and the pending row, by code', async () => {
    rmStore();
    const codes: (string | undefined)[] = [];
    for (const name of ['zomi', 'zomi-next']) {
      try {
        await authorRm.run(capture().out, parseArgs([name]));
        codes.push('no refusal');
      } catch (err) {
        codes.push((err as { code?: string }).code);
      }
    }
    expect(codes).toEqual(['rotation_pending', 'rotation_pending']);
    expect(Object.keys(readAuthors(storePath()).authors)).toEqual(['zomi', 'zomi-next']);
  });

  it('removes either row with --force, and warns what that costs', async () => {
    rmStore();
    const sink = capture();
    await authorRm.run(sink.out, parseArgs(['zomi-next', '--force']));

    expect(sink.results[0]).toMatchObject({ action: 'author.rm', name: 'zomi-next' });
    expect(sink.warnings[0]).toContain('rotation in flight');
    expect(Object.keys(readAuthors(storePath()).authors)).toEqual(['zomi']);
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
        { name: 'zomi', eoa: EOA_A, safe: '0xSafe', active: true, ownership: 'owner' },
        { name: 'bob', eoa: authorEoa(KEY_B), safe: null, active: false, ownership: 'owner' },
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
      authors: [
        { name: 'signer1', eoa: authorEoa(KEY_B), safe: given, active: true, ownership: 'owner' },
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

  it('lists the rows of a rotation as pending, with the row each one replaces', async () => {
    const path = storePath();
    const safe = getAddress('0xabcd00000000000000000000000000000000def1');
    writeAuthors(
      store('zomi', { zomi: { privateKey: KEY_A, safe, safeSource: 'given' } }),
      path,
    );
    addSigner({ name: 'zomi-next', privateKey: KEY_B, safe, replaces: 'zomi' }, path);
    const sink = capture();
    await authorList.run(sink.out, parseArgs([]));

    expect(sink.results[0]).toMatchObject({
      active: 'zomi',
      authors: [
        { name: 'zomi', eoa: EOA_A, active: true, ownership: 'owner' },
        {
          name: 'zomi-next',
          eoa: authorEoa(KEY_B),
          active: false,
          ownership: 'pending',
          replaces: 'zomi',
        },
      ],
    });
    // The table has to distinguish the two rows for one Safe: `signer rotate`
    // sends the user here to choose between them.
    expect(sink.human[0]).toContain('(pending)  → replaces zomi');
  });
});
