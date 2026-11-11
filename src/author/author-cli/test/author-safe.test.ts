// ============================================================================
// The author Safe: derived from the key, or given to the store.
//
// A derived row is predicted from `s2s_${eoa}`. A `given` row is a Safe the
// key was filed into as one owner, so the address is read from the store and
// never re-derived: no salt, no deployment by this CLI, one signature only when
// the Safe needs one. The chain reads are passed in as a seam, so this file
// touches no RPC.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { keccak256, toBytes } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authorSafeSalt,
  AUTHOR_SAFE_SALT_PREFIX,
  authorSafeState,
  createAuthorWriteRunner,
  ensureAuthorSafe,
  givenSafeInUse,
  initAuthorSafe,
  type GivenSafeReader,
} from '../src/core/author-safe';
import { saltNonceFor } from '../src/adapters/tx-runner';
import { authorEoa, writeAuthors, type AuthorsStore } from '../src/core/authors';
import type { CliConfig } from '../src/core/config';
import type { CliContext } from '../src/core/context';
import type { CliOut } from '../src/lib/out';

const EOA = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387';
/** privkey 1: a key nobody can use. */
const KEY = `0x${'00'.repeat(31)}01` as `0x${string}`;
const OTHER_EOA = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const SAFE = '0x00000000000000000000000000000000000000aa';
const RPC = 'http://127.0.0.1:0/test-rpc';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-author-safe-test-'));
  // The store path resolves through XDG_CONFIG_HOME, so the real ~/.config/s2s
  // is never read or written by these tests.
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  vi.stubEnv('S2S_PRIVATE_KEY', '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function storePath(): string {
  return join(dir, 's2s', 'authors.json');
}

function seed(record: AuthorsStore['authors'][string]): void {
  writeAuthors({ active: 'zomi', authors: { zomi: record } }, storePath());
}

/** A config that resolves to the stored key, so the store's given Safe applies. */
function config(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    privateKey: KEY,
    author: { name: 'zomi', safe: SAFE, source: 'store' },
    bundler: { url: undefined },
    paymaster: {},
    ...overrides,
  } as unknown as CliConfig;
}

function ctx(overrides: Partial<CliConfig> = {}): CliContext {
  return {
    config: config(overrides),
    eoaAddress: authorEoa(KEY) ?? (EOA as `0x${string}`),
    rpcs: { L1: [], L2: [RPC] },
    out: {
      json: false,
      log: () => undefined,
      warn: () => undefined,
      result: () => undefined,
    } as CliOut,
  } as unknown as CliContext;
}

/** The chain answer for a 1-of-1 Safe: the shape every given-Safe read returns. */
function oneOfOne(): GivenSafeReader {
  const eoa = authorEoa(KEY) ?? (EOA as `0x${string}`);
  return () => Promise.resolve({ deployed: true, threshold: 1n, owners: [eoa] });
}

describe('author Safe identity', () => {
  it('salts with the plugin prefix and the EOA only (no chain)', () => {
    expect(AUTHOR_SAFE_SALT_PREFIX).toBe('s2s_');
    expect(authorSafeSalt(EOA)).toBe(`s2s_${EOA}`);
  });

  it('derives the salt-nonce exactly as 0xobsidian does (unmasked keccak)', () => {
    // 0xobsidian: saltNonce = BigInt(keccak256(toBytes(`s2s_${eoa}`)))
    // Any masking would change the CREATE2 input and thus the address.
    const salt = authorSafeSalt(EOA);
    expect(saltNonceFor(salt)).toBe(BigInt(keccak256(toBytes(salt))));
    expect(saltNonceFor(salt) < 2n ** 128n).toBe(false);
  });
});

describe('author Safe derivation is pinned to 0xobsidian', () => {
  it('pins the L2 singleton, factory, version and entry point', async () => {
    const m = await import('../src/core/author-safe');
    expect(m.SAFE_L2_SINGLETON).toBe('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762');
    expect(m.SAFE_PROXY_FACTORY).toBe('0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67');
    expect(m.AUTHOR_SAFE_VERSION).toBe('1.4.1');
    // Pinned, not config-driven: the 4337 module address is part of the Safe
    // initializer, so a different entry point means a different author id.
    expect(m.AUTHOR_SAFE_ENTRY_POINT).toBe('0.7');
  });
});

describe('a given author Safe', () => {
  it('is the stored address, with no salt and no prediction', async () => {
    seed({ privateKey: KEY, safe: SAFE, safeSource: 'given' });
    // Any HTTP call would throw: the only read allowed is the seam.
    const fetchStub = vi.fn(() => {
      throw new Error('no network in this test');
    });
    vi.stubGlobal('fetch', fetchStub);

    const read = vi.fn(oneOfOne());
    const state = await authorSafeState(ctx(), read);

    expect(state).toEqual({
      address: SAFE,
      eoa: authorEoa(KEY),
      salt: null,
      chain: 'base',
      deployed: true,
    });
    expect(read).toHaveBeenCalledWith(SAFE);
    // `predictAuthorSafe` never ran: prediction would have hit the factory RPC.
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('is not the author id when the run signs with another key', async () => {
    seed({ privateKey: KEY, safe: SAFE, safeSource: 'given' });
    // An env key outranks the store, so this run is a different identity.
    expect(
      givenSafeInUse(config({ author: { name: undefined, safe: undefined, source: 'env' } })),
    ).toBeUndefined();
    expect(
      givenSafeInUse(config({ privateKey: `0x${'00'.repeat(31)}02` as `0x${string}` })),
    ).toBeUndefined();
  });

  it('is not a derived row', () => {
    seed({ privateKey: KEY, safe: SAFE });
    expect(givenSafeInUse(config())).toBeUndefined();
  });

  it('is never deployed by this CLI', async () => {
    // No bundler in the config: any deploy path would throw the bundler
    // UsageError, so a plain answer proves nothing was sent.
    const ensured = await ensureAuthorSafe({
      config: config({ bundler: { url: undefined } }),
      privateKey: KEY,
      rpcUrl: RPC,
      out: { log: () => undefined } as unknown as CliOut,
      safe: SAFE,
      readSafe: () => Promise.resolve({ deployed: false, threshold: 1n, owners: [] }),
    });

    expect(ensured).toEqual({
      address: SAFE,
      eoa: authorEoa(KEY),
      deployed: false,
      txHash: undefined,
    });
  });

  it('is still not deployed when a caller names no Safe', async () => {
    // `author init` installs the contracts through an ensure call that carries
    // no address; the store is the only place that knows this key has one.
    seed({ privateKey: KEY, safe: SAFE, safeSource: 'given' });
    const ensured = await ensureAuthorSafe({
      config: config({ bundler: { url: undefined } }),
      privateKey: KEY,
      rpcUrl: RPC,
      out: { log: () => undefined } as unknown as CliOut,
      readSafe: () => Promise.resolve({ deployed: true, threshold: 1n, owners: [] }),
    });

    expect(ensured).toEqual({
      address: SAFE,
      eoa: authorEoa(KEY),
      deployed: true,
      txHash: undefined,
    });
  });

  it('reports salt: null from init, without deploying', async () => {
    seed({ privateKey: KEY, safe: SAFE, safeSource: 'given' });
    const result = await initAuthorSafe(ctx(), oneOfOne());

    expect(result).toEqual({
      address: SAFE,
      eoa: authorEoa(KEY),
      salt: null,
      chain: 'base',
      deployed: true,
      txHash: undefined,
    });
  });
});

describe('author writes through a given Safe', () => {
  it('refuses a threshold one signature cannot meet, and names the reason', async () => {
    await expect(
      createAuthorWriteRunner({
        config: config(),
        eoa: authorEoa(KEY) as `0x${string}`,
        rpcUrl: RPC,
        safe: SAFE,
        readSafe: () =>
          Promise.resolve({
            deployed: true,
            threshold: 2n,
            owners: [authorEoa(KEY) as `0x${string}`, OTHER_EOA],
          }),
      }),
    ).rejects.toThrow(/needs 2 signatures[\s\S]*s2s signer queue/);
  });

  it('refuses a Safe the stored key is not an owner of', async () => {
    await expect(
      createAuthorWriteRunner({
        config: config(),
        eoa: authorEoa(KEY) as `0x${string}`,
        rpcUrl: RPC,
        safe: SAFE,
        readSafe: () => Promise.resolve({ deployed: true, threshold: 1n, owners: [OTHER_EOA] }),
      }),
    ).rejects.toThrow(/not an owner[\s\S]*s2s signer queue/);
  });

  it('lets a 1-of-1 Safe through to the userOp path', async () => {
    // The next failure is the missing bundler, which is past the provenance
    // check: a 1-of-1 given Safe writes through the existing runner.
    await expect(
      createAuthorWriteRunner({
        config: config({ bundler: { url: undefined } }),
        eoa: authorEoa(KEY) as `0x${string}`,
        rpcUrl: RPC,
        safe: SAFE,
        readSafe: oneOfOne(),
      }),
    ).rejects.toThrow(/S2S_PIMLICO_KEY|S2S_BUNDLER_URL/);
  });
});
