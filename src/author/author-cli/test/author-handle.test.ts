// ============================================================================
// `s2s author handle` — the author Safe's unique name in the registry.
//
// The registry is faked (`AuthorHandleDeps`), including its state machine, so
// what is under test is the command's decisions:
//
//   * status with no positional reads nameOf / entry / versionOf and sends
//     nothing;
//   * a register asks `check` first and sends nothing when the name is taken;
//   * the records pointer is the module `resolveRecords` returned AND the Safe
//     has enabled; `--records` overrides it only with code, and the gate note
//     rides on a refusal;
//   * a release reads what the Safe holds first, sends `release()` only then,
//     and reads the empty name back;
//   * a registry address with no code is "not deployed yet", never an RPC
//     failure;
//   * every usage mistake (two names, `--check --release`, `--check` alone,
//     `--records --release`) is refused before any read.
// ============================================================================

import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  authorHandle,
  runAuthorHandle,
  type AuthorHandleDeps,
} from '../src/commands/author-handle';
import {
  authorRegistryAddress,
  ZERO_ADDRESS,
  type HandleCheck,
  type RegistryEntry,
} from '../src/core/author-registry';
import type { RecordsResolution } from '../src/core/author-records';
import type { AuthorsStore } from '../src/core/authors';
import type { CliConfig } from '../src/core/config';
import { CliError, UsageError } from '../src/lib/errors';
import { parseArgs } from '../src/lib/args';
import type { CliOut } from '../src/lib/out';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const REGISTRY = '0x00000000000000000000000000000000000000c1' as Address;
const OTHER_REGISTRY = '0x00000000000000000000000000000000000000c2' as Address;
const RECORDS = '0x0000000000000000000000000000000000000d06' as Address;
const OTHER_RECORDS = '0x0000000000000000000000000000000000000d07' as Address;
const FACTORY = '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' as Address;
const IMPLEMENTATION = '0x0000000000000000000000000000000000000d08' as Address;
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RPC = 'http://127.0.0.1:8545';

const BOOLEANS = { booleanFlags: ['check', 'release'] } as const;

interface Captured {
  out: CliOut;
  results: Record<string, unknown>[];
  human: string[];
  logs: string[];
  warnings: string[];
}

function capture(): Captured {
  const results: Record<string, unknown>[] = [];
  const human: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const out: CliOut = {
    json: false,
    log: (message: string) => logs.push(message),
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      if (text !== undefined) human.push(text);
    },
  };
  return { out, results, human, logs, warnings };
}

function store(overrides: Partial<AuthorsStore['authors'][string]> = {}): AuthorsStore {
  return {
    active: 'zomi',
    authors: {
      zomi: { privateKey: PRIVATE_KEY, safe: SAFE, ...overrides },
    },
  };
}

function config(registry: Address = REGISTRY): CliConfig {
  return {
    rpc: { l1: [], l2: [RPC] },
    contracts: { authorFactory: FACTORY, registry },
  } as unknown as CliConfig;
}

const ZERO_ENTRY: RegistryEntry = {
  safe: ZERO_ADDRESS,
  handle: '',
  version: 0,
  registeredAt: 0,
  recordsLocation: ZERO_ADDRESS,
};

interface FakeOptions {
  name?: string | null;
  version?: number;
  entryRecords?: Address;
  checks?: Record<string, HandleCheck>;
  /** The check the fake answers when `checks` has no entry for the name. */
  resolution?: RecordsResolution;
  enabled?: Address[];
  /** Addresses that carry code; the registry and records are here by default. */
  code?: Address[];
  /** The Safe holds a different handle than the one asked for. */
  holder?: Address;
  registry?: Address;
  authors?: AuthorsStore;
  /** A write that lands as a revert: the read-back keeps the old state. */
  revertWrites?: boolean;
}

function fakeDeps(options: FakeOptions = {}) {
  const registry = options.registry ?? REGISTRY;
  const names = new Map<Address, string>();
  if (options.name) names.set(SAFE, options.name);

  const entries = new Map<string, RegistryEntry>();
  const versions = new Map<string, number>();
  if (options.name) {
    entries.set(options.name, {
      safe: SAFE,
      handle: options.name,
      version: options.version ?? 1,
      registeredAt: 1_700_000_000,
      recordsLocation: options.entryRecords ?? RECORDS,
    });
    versions.set(options.name, options.version ?? 1);
  }

  const code = new Set(
    (options.code ?? [REGISTRY, OTHER_REGISTRY, RECORDS, OTHER_RECORDS]).map((address) =>
      address.toLowerCase(),
    ),
  );

  const sent: { to: Address; abi: string; method: string; args: unknown[] }[] = [];
  const opened: number[] = [];
  const resolveCalls: { safe: Address; rpcUrl: string }[] = [];
  const enabledCalls: Address[] = [];
  const readHasCodeCalls: Address[] = [];

  const resolution: RecordsResolution = options.resolution ?? {
    factory: FACTORY,
    deployed: true,
    implementation: IMPLEMENTATION,
    address: RECORDS,
    recorded: RECORDS,
  };

  const deps: AuthorHandleDeps = {
    store: () => options.authors ?? store(),
    config: () => config(registry),
    readHasCode: ({ address }) => {
      readHasCodeCalls.push(address);
      return Promise.resolve(code.has(address.toLowerCase()));
    },
    check: ({ handle }) =>
      Promise.resolve(
        options.checks?.[handle] ??
          (entries.has(handle) ? { available: false, reason: 7 } : { available: true, reason: 0 }),
      ),
    nameOf: ({ safe }) => Promise.resolve(names.get(safe) ?? null),
    entry: ({ handle }) => Promise.resolve(entries.get(handle) ?? ZERO_ENTRY),
    versionOf: ({ handle }) => Promise.resolve(versions.get(handle) ?? 0),
    resolve: ({ handle }) => Promise.resolve(entries.get(handle)?.safe ?? null),
    resolveRecords: (opts) => {
      resolveCalls.push(opts);
      return Promise.resolve(resolution);
    },
    readEnabled: ({ safe }) => {
      enabledCalls.push(safe);
      return Promise.resolve(options.enabled ?? [SAFE, RECORDS]);
    },
    openRunner: () => {
      opened.push(1);
      return Promise.resolve({
        genericTx: (to: Address, abi: string, method: string, args: unknown[]): Promise<string> => {
          sent.push({ to, abi, method, args });
          if (options.revertWrites) return Promise.resolve('0xreverted');

          if (method === 'register') {
            const [handle, records] = args as [string, Address];
            const version = (versions.get(handle) ?? 0) + 1;
            versions.set(handle, version);
            entries.set(handle, {
              safe: SAFE,
              handle,
              version,
              registeredAt: 1_700_000_001,
              recordsLocation: records,
            });
            names.set(SAFE, handle);
          }
          if (method === 'release') {
            const current = names.get(SAFE);
            if (current !== undefined) {
              entries.delete(current);
              names.delete(SAFE);
            }
          }
          return Promise.resolve('0xdeadbeef');
        },
      });
    },
  };

  return {
    deps,
    sent,
    opened,
    resolveCalls,
    enabledCalls,
    readHasCodeCalls,
    names,
    entries,
    versions,
  };
}

describe('s2s author handle (status)', () => {
  it('reports the Safe, handle, version and records with no positional', async () => {
    const { deps, opened } = fakeDeps({ name: 'alice', version: 3 });
    const sink = capture();

    await runAuthorHandle(sink.out, parseArgs([], BOOLEANS), deps);

    expect(sink.results[0]).toEqual({
      action: 'author.handle',
      safe: SAFE,
      handle: 'alice',
      version: 3,
      records: RECORDS,
      available: null,
      reason: null,
    });
    expect(sink.human[0]?.toLowerCase()).toContain(`registry    : ${REGISTRY.toLowerCase()}`);
    expect(sink.human[0]).toContain('handle      : alice.s2s');
    expect(sink.human[0]).toContain('version     : 3');
    // A read sends nothing, so no bundler client is opened.
    expect(opened).toHaveLength(0);
  });

  it('says (none) when the Safe holds no handle', async () => {
    const { deps } = fakeDeps();
    const sink = capture();

    await runAuthorHandle(sink.out, parseArgs([], BOOLEANS), deps);

    expect(sink.results[0]).toMatchObject({ handle: null, version: null, records: null });
    expect(sink.human[0]).toContain('handle      : (none)');
    expect(sink.human[0]).toContain('version     : (none)');
  });

  it('uses --registry over contracts.registry', async () => {
    const { deps } = fakeDeps({ name: 'alice' });
    const sink = capture();

    await runAuthorHandle(
      sink.out,
      parseArgs(['--registry', OTHER_REGISTRY], BOOLEANS),
      deps,
    );

    expect(sink.human[0]?.toLowerCase()).toContain(`registry    : ${OTHER_REGISTRY.toLowerCase()}`);
    expect(sink.results[0]).toMatchObject({ handle: 'alice' });
  });
});

describe('s2s author handle --check', () => {
  it('reports a free name and sends nothing', async () => {
    const { deps, opened } = fakeDeps();
    const sink = capture();

    await runAuthorHandle(sink.out, parseArgs(['alice', '--check'], BOOLEANS), deps);

    expect(sink.results[0]).toEqual({
      action: 'author.handle.check',
      safe: SAFE,
      handle: 'alice',
      version: null,
      records: null,
      available: true,
      reason: 0,
    });
    expect(sink.human[0]).toContain('available   : yes');
    expect(sink.human[0]).toContain('reason      : free (0)');
    expect(opened).toHaveLength(0);
  });

  it('reports a taken name with its numeric reason and sentence', async () => {
    const { deps } = fakeDeps({ name: 'alice' });
    const sink = capture();

    await runAuthorHandle(sink.out, parseArgs(['alice', '--check'], BOOLEANS), deps);

    expect(sink.results[0]).toMatchObject({ available: false, reason: 7 });
    expect(sink.human[0]).toContain('available   : no');
    expect(sink.human[0]).toContain('reason      : registered (7)');
  });

  it('surfaces an invalid character as its own reason', async () => {
    const { deps } = fakeDeps({ checks: { Alice: { available: false, reason: 1 } } });
    const sink = capture();

    await runAuthorHandle(sink.out, parseArgs(['Alice', '--check'], BOOLEANS), deps);

    expect(sink.results[0]).toMatchObject({ available: false, reason: 1 });
    expect(sink.human[0]).toContain('invalid character (1)');
  });

  it('names every registry reason with a short sentence', async () => {
    const cases: {
      reason: number;
      label: string;
      sentence: RegExp;
    }[] = [
      { reason: 1, label: 'invalid character', sentence: /outside a-z, 0-9 and '-'/ },
      { reason: 2, label: 'invalid length', sentence: /3\.\.32 bytes/ },
      { reason: 3, label: 'invalid hyphen', sentence: /leading, trailing or doubled hyphen/ },
      { reason: 4, label: 'reserved', sentence: /'a-b' is reserved/ },
      { reason: 5, label: 'skeleton taken', sentence: /another spelling of the same name/ },
      { reason: 6, label: 'cooling', sentence: /cooling down after a release/ },
      { reason: 7, label: 'registered', sentence: /already registered/ },
    ];

    for (const { reason, label, sentence } of cases) {
      const check = fakeDeps({ checks: { 'a-b': { available: false, reason } } });
      const checked = capture();
      await runAuthorHandle(checked.out, parseArgs(['a-b', '--check'], BOOLEANS), check.deps);
      expect(checked.human[0]).toContain(`reason      : ${label} (${reason})`);
      expect(checked.results[0]).toMatchObject({ available: false, reason });

      const register = fakeDeps({ checks: { 'a-b': { available: false, reason } } });
      const refused = capture();
      await expect(
        runAuthorHandle(refused.out, parseArgs(['a-b'], BOOLEANS), register.deps),
      ).rejects.toThrow(sentence);
    }
  });

  it('refuses --check without a name', async () => {
    const { deps, opened } = fakeDeps();
    const sink = capture();

    await expect(runAuthorHandle(sink.out, parseArgs(['--check'], BOOLEANS), deps)).rejects.toThrow(
      /--check.*needs a handle/,
    );
    expect(opened).toHaveLength(0);
  });

  it('refuses --check together with --release', async () => {
    const { deps } = fakeDeps();
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['alice', '--check', '--release'], BOOLEANS), deps),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('s2s author handle <name> (register)', () => {
  it('sends register with the resolved records module and reads the entry back', async () => {
    const { deps, sent, opened, resolveCalls } = fakeDeps();
    const sink = capture();

    await runAuthorHandle(sink.out, parseArgs(['alice'], BOOLEANS), deps);

    expect(resolveCalls).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to.toLowerCase()).toBe(REGISTRY.toLowerCase());
    expect(sent[0]?.method).toBe('register');
    expect(sent[0]?.args.map(String).map((arg) => arg.toLowerCase())).toEqual([
      'alice',
      RECORDS.toLowerCase(),
    ]);
    expect(opened).toHaveLength(1);
    expect(sink.results[0]).toEqual({
      action: 'author.handle.register',
      safe: SAFE,
      handle: 'alice',
      version: 1,
      records: RECORDS,
      available: null,
      reason: null,
    });
    expect(sink.human[0]).toContain('(handle registered)');
  });

  it('refuses a taken name before resolving records or sending anything', async () => {
    const { deps, sent, opened, resolveCalls } = fakeDeps({ name: 'alice' });
    const sink = capture();

    await expect(runAuthorHandle(sink.out, parseArgs(['alice'], BOOLEANS), deps)).rejects.toThrow(
      /cannot register 'alice'.*already registered.*nothing was sent/,
    );
    expect(sent).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(resolveCalls).toHaveLength(0);
  });

  it('refuses an invalid name with the registry sentence', async () => {
    const { deps, sent } = fakeDeps({ checks: { 'al ice': { available: false, reason: 1 } } });
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['al ice'], BOOLEANS), deps),
    ).rejects.toThrow(/outside a-z, 0-9 and '-'/);
    expect(sent).toHaveLength(0);
  });

  it('--records overrides the resolved module when it has code', async () => {
    const { deps, sent, resolveCalls } = fakeDeps();
    const sink = capture();

    await runAuthorHandle(
      sink.out,
      parseArgs(['alice', '--records', OTHER_RECORDS], BOOLEANS),
      deps,
    );

    expect(resolveCalls).toHaveLength(0);
    expect(sent[0]?.args.map(String).map((arg) => arg.toLowerCase())).toEqual([
      'alice',
      OTHER_RECORDS.toLowerCase(),
    ]);
    expect(String(sink.results[0]?.records).toLowerCase()).toBe(OTHER_RECORDS.toLowerCase());
  });

  it('refuses --records without code and names the gate', async () => {
    const { deps, sent } = fakeDeps({ code: [REGISTRY, RECORDS] });
    const sink = capture();
    const bare = '0x00000000000000000000000000000000000000ee' as Address;

    await expect(
      runAuthorHandle(sink.out, parseArgs(['alice', '--records', bare], BOOLEANS), deps),
    ).rejects.toThrow(/has no code.*gate accepts only the records module/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a records module the Safe has not enabled', async () => {
    const { deps, sent } = fakeDeps({ enabled: [SAFE] });
    const sink = capture();

    await expect(runAuthorHandle(sink.out, parseArgs(['alice'], BOOLEANS), deps)).rejects.toThrow(
      /not enabled on the Safe.*author init/,
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses when the factory has no records implementation', async () => {
    const { deps, sent } = fakeDeps({
      resolution: {
        factory: FACTORY,
        deployed: true,
        implementation: null,
        address: null,
        recorded: null,
      },
    });
    const sink = capture();

    await expect(runAuthorHandle(sink.out, parseArgs(['alice'], BOOLEANS), deps)).rejects.toThrow(
      /no records implementation.*author init/,
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses when the Safe has no records module', async () => {
    const { deps, sent } = fakeDeps({
      resolution: {
        factory: FACTORY,
        deployed: true,
        implementation: IMPLEMENTATION,
        address: null,
        recorded: null,
      },
    });
    const sink = capture();

    await expect(runAuthorHandle(sink.out, parseArgs(['alice'], BOOLEANS), deps)).rejects.toThrow(
      /has no records module.*author init/,
    );
    expect(sent).toHaveLength(0);
  });

  it('names a read-back that did not register the name (a reverted userOp)', async () => {
    const { deps } = fakeDeps({ revertWrites: true });
    const sink = capture();

    await expect(runAuthorHandle(sink.out, parseArgs(['alice'], BOOLEANS), deps)).rejects.toThrow(
      /did not register 'alice'.*may have reverted/,
    );
  });

  it('names the gate in a reverted --records read-back', async () => {
    const { deps } = fakeDeps({ revertWrites: true });
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['alice', '--records', OTHER_RECORDS], BOOLEANS), deps),
    ).rejects.toThrow(/gate accepts only a records module.*refused/);
  });
});

describe('s2s author handle --release', () => {
  it('releases what the Safe holds and reads the empty name back', async () => {
    const { deps, sent, names } = fakeDeps({ name: 'alice', version: 2 });
    const sink = capture();

    await runAuthorHandle(sink.out, parseArgs(['--release'], BOOLEANS), deps);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('release');
    expect(sent[0]?.args).toEqual([]);
    expect(names.get(SAFE)).toBeUndefined();
    expect(sink.results[0]).toEqual({
      action: 'author.handle.release',
      safe: SAFE,
      handle: 'alice',
      version: 2,
      records: RECORDS,
      available: null,
      reason: null,
    });
    expect(sink.human[0]).toContain('(handle released');
  });

  it('sends nothing when the Safe holds no handle', async () => {
    const { deps, sent, opened } = fakeDeps();
    const sink = capture();

    await runAuthorHandle(sink.out, parseArgs(['--release'], BOOLEANS), deps);

    expect(sent).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(sink.results[0]).toMatchObject({ handle: null });
    expect(sink.human[0]).toContain('(the Safe holds no handle — nothing to release)');
  });

  it('refuses a name another Safe owns, and names the holder', async () => {
    const { deps, sent } = fakeDeps({ name: 'alice' });
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['bob', '--release'], BOOLEANS), {
        ...deps,
        resolve: () => Promise.resolve(OTHER),
      }),
    ).rejects.toThrow(/belongs to the Safe 0x1111.*not 0x934E/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a name that belongs to another Safe even when this Safe holds none', async () => {
    const { deps, sent } = fakeDeps();
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['alice', '--release'], BOOLEANS), {
        ...deps,
        resolve: () => Promise.resolve(OTHER),
      }),
    ).rejects.toThrow(/belongs to the Safe 0x1111.*not 0x934E/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a name the Safe does not hold and names the one it does', async () => {
    const { deps, sent } = fakeDeps({ name: 'alice' });
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['bob', '--release'], BOOLEANS), deps),
    ).rejects.toThrow(/holds 'alice', not 'bob'/);
    expect(sent).toHaveLength(0);
  });

  it('refuses --records together with --release', async () => {
    const { deps } = fakeDeps({ name: 'alice' });
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['--release', '--records', RECORDS], BOOLEANS), deps),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('s2s author handle (registry)', () => {
  it('says the zero default is not deployed yet', async () => {
    const { deps } = fakeDeps({ name: 'alice', registry: ZERO_ADDRESS });
    const sink = capture();

    await expect(runAuthorHandle(sink.out, parseArgs([], BOOLEANS), deps)).rejects.toThrow(
      /no handle registry is configured yet.*not deployed/,
    );
  });

  it('says a configured address with no code is not deployed yet', async () => {
    const { deps } = fakeDeps({
      name: 'alice',
      code: [RECORDS],
      registry: REGISTRY,
    });
    const sink = capture();

    await expect(runAuthorHandle(sink.out, parseArgs(['alice'], BOOLEANS), deps)).rejects.toThrow(
      /not deployed yet.*set contracts.registry/,
    );
  });

  it('refuses two names before any read', async () => {
    const { deps, readHasCodeCalls } = fakeDeps();
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['alice', 'bob'], BOOLEANS), deps),
    ).rejects.toBeInstanceOf(UsageError);
    expect(readHasCodeCalls).toHaveLength(0);
  });
});

describe('authorRegistryAddress', () => {
  it('prefers the flag, then contracts.registry, then the env var', () => {
    vi.stubEnv('S2S_REGISTRY_ADDRESS', OTHER_REGISTRY);
    try {
      expect(authorRegistryAddress({ contracts: { registry: REGISTRY } }, OTHER)).toBe(OTHER);
      expect(authorRegistryAddress({ contracts: { registry: REGISTRY } }).toLowerCase()).toBe(
        REGISTRY.toLowerCase(),
      );
      expect(authorRegistryAddress({}).toLowerCase()).toBe(OTHER_REGISTRY.toLowerCase());
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to the zero default, which is not deployed', () => {
    vi.stubEnv('S2S_REGISTRY_ADDRESS', '');
    try {
      expect(authorRegistryAddress({})).toBe(ZERO_ADDRESS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a value that is not an address', () => {
    expect(() => authorRegistryAddress({}, 'nope')).toThrow(UsageError);
  });
});

describe('the author handle command spec', () => {
  it('declares the four flags and one optional positional', () => {
    expect(authorHandle.name).toBe('handle');
    expect(authorHandle.params).toBe('[<handle>]');
    expect(Object.keys(authorHandle.flags).sort()).toEqual([
      'check',
      'records',
      'registry',
      'release',
    ]);
  });

  it('rejects a register whose read-back resolves to another Safe', async () => {
    const { deps } = fakeDeps();
    const sink = capture();

    await expect(
      runAuthorHandle(sink.out, parseArgs(['alice'], BOOLEANS), {
        ...deps,
        resolve: () => Promise.resolve(OTHER),
      }),
    ).rejects.toThrow(/resolves 'alice' to 0x1111.*not the Safe 0x934E/);
  });
});
