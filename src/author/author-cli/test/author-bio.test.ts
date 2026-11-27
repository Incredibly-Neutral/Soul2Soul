// ============================================================================
// `s2s author bio` — read, set and clear the author's `bio` record.
//
// The chain seam, the store, the config and the runner are faked
// (`AuthorBioDeps`), so what is under test is the command's decisions: which
// record key is read, which call is sent and with what args, what the read-back
// must say, and the four ways it refuses (empty, over cap, `--clear` with a
// value, a module that `author init` has not installed).
// ============================================================================

import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { authorBio, runAuthorBio, type AuthorBioDeps } from '../src/commands/author-bio';
import { BIO_KEY, BIO_MAX_LENGTH, PEN_NAME_KEY } from '../src/core/author-records';
import type { RecordsResolution } from '../src/core/author-records';
import type { AuthorsStore } from '../src/core/authors';
import type { CliConfig } from '../src/core/config';
import { CliError, UsageError } from '../src/lib/errors';
import { parseArgs } from '../src/lib/args';
import type { CliOut } from '../src/lib/out';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const RECORDS = '0x0000000000000000000000000000000000000d06' as Address;
const FACTORY = '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' as Address;
const IMPLEMENTATION = '0x0000000000000000000000000000000000000d07' as Address;
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OTHER = '0x1111111111111111111111111111111111111111' as Address;

interface Captured {
  out: CliOut;
  results: Record<string, unknown>[];
  human: string[];
  logs: string[];
}

function capture(): Captured {
  const results: Record<string, unknown>[] = [];
  const human: string[] = [];
  const logs: string[] = [];
  const out: CliOut = {
    json: false,
    log: (message: string) => logs.push(message),
    warn: () => undefined,
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      if (text !== undefined) human.push(text);
    },
  };
  return { out, results, human, logs };
}

function store(overrides: Partial<AuthorsStore['authors'][string]> = {}): AuthorsStore {
  return {
    active: 'zomi',
    authors: {
      zomi: {
        privateKey: PRIVATE_KEY,
        safe: SAFE,
        ...overrides,
      },
    },
  };
}

const CONFIG = { rpc: { l1: [], l2: ['http://127.0.0.1:8545'] } } as unknown as CliConfig;

interface FakeChainState {
  records: Record<string, string>;
  enabled: Address[];
  resolution?: RecordsResolution;
  /** Make the write land as a revert: the read-back keeps the old value. */
  revertWrites?: boolean;
}

function fakeDeps(options: {
  records?: Record<string, string>;
  enabled?: Address[];
  resolution?: RecordsResolution;
  revertWrites?: boolean;
  authors?: AuthorsStore;
}) {
  const state: FakeChainState = {
    records: { ...(options.records ?? {}) },
    enabled: [...(options.enabled ?? [SAFE, RECORDS])],
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.revertWrites ? { revertWrites: true } : {}),
  };
  const sent: { to: Address; abi: string; method: string; args: unknown[] }[] = [];
  const opened: number[] = [];

  const deps: AuthorBioDeps = {
    store: () => options.authors ?? store(),
    config: () => CONFIG,
    resolve: () =>
      Promise.resolve(
        state.resolution ?? {
          factory: FACTORY,
          kind: '0x00' as Hex,
          implementation: IMPLEMENTATION,
          address: RECORDS,
        },
      ),
    readRecord: ({ key }) => Promise.resolve(state.records[key] ?? null),
    readEnabled: () => Promise.resolve(state.enabled),
    openRunner: () => {
      opened.push(1);
      return Promise.resolve({
        genericTx: (
          to: Address,
          abi: string,
          method: string,
          args: unknown[],
        ): Promise<string> => {
          sent.push({ to, abi, method, args });
          if (!state.revertWrites) {
            if (method === 'setRecord') {
              const [key, value] = args as [string, string];
              state.records[key] = value;
            }
            if (method === 'deleteRecord') {
              const [key] = args as [string];
              delete state.records[key];
            }
          }
          return Promise.resolve('0xdeadbeef');
        },
      });
    },
  };
  return { deps, sent, opened, state };
}

const BIO_ARGS = { booleanFlags: ['clear'] } as const;

describe('s2s author bio (read)', () => {
  it('prints both records and the module address', async () => {
    const { deps, opened } = fakeDeps({ records: { [PEN_NAME_KEY]: 'zomi', [BIO_KEY]: 'writes about protocols' } });
    const sink = capture();

    await runAuthorBio(sink.out, parseArgs([], BIO_ARGS), deps);

    expect(sink.results[0]).toEqual({
      action: 'author.bio',
      safe: SAFE,
      records: RECORDS,
      penName: 'zomi',
      bio: 'writes about protocols',
    });
    expect(sink.human[0]).toContain(`records     : ${RECORDS}`);
    expect(sink.human[0]).toContain('pen_name    : zomi');
    expect(sink.human[0]).toContain('bio         : writes about protocols');
    // A read sends nothing, so no bundler client is opened.
    expect(opened).toHaveLength(0);
  });

  it('says absent when the records module holds neither', async () => {
    const { deps } = fakeDeps({});
    const sink = capture();

    await runAuthorBio(sink.out, parseArgs([], BIO_ARGS), deps);

    expect(sink.results[0]).toMatchObject({ penName: null, bio: null });
    expect(sink.human[0]).toContain('pen_name    : (absent)');
    expect(sink.human[0]).toContain('bio         : (absent)');
  });
});

describe('s2s author bio (write)', () => {
  it('sets a trimmed bio through the Safe, then reads it back', async () => {
    const { deps, sent, state } = fakeDeps({ records: { [PEN_NAME_KEY]: 'zomi' } });
    const sink = capture();

    await runAuthorBio(sink.out, parseArgs(['  writes about protocols  '], BIO_ARGS), deps);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(RECORDS);
    expect(sent[0]?.method).toBe('setRecord');
    expect(sent[0]?.args).toEqual([BIO_KEY, 'writes about protocols']);
    expect(state.records[BIO_KEY]).toBe('writes about protocols');
    expect(sink.results[0]).toEqual({
      action: 'author.bio.set',
      safe: SAFE,
      records: RECORDS,
      penName: 'zomi',
      bio: 'writes about protocols',
    });
  });

  it('clears with --clear', async () => {
    const { deps, sent, state } = fakeDeps({
      records: { [PEN_NAME_KEY]: 'zomi', [BIO_KEY]: 'old text' },
    });
    const sink = capture();

    await runAuthorBio(sink.out, parseArgs(['--clear'], BIO_ARGS), deps);

    expect(sent.map((call) => call.method)).toEqual(['deleteRecord']);
    expect(sent[0]?.args).toEqual([BIO_KEY]);
    expect(state.records[BIO_KEY]).toBeUndefined();
    expect(sink.results[0]).toMatchObject({ action: 'author.bio.clear', bio: null });
  });

  it('refuses an empty bio before touching the chain', async () => {
    const { deps, sent } = fakeDeps({});
    const sink = capture();

    await expect(runAuthorBio(sink.out, parseArgs(['   '], BIO_ARGS), deps)).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses a bio over the cap, naming the cap', async () => {
    const { deps, sent } = fakeDeps({});
    const sink = capture();

    await expect(
      runAuthorBio(sink.out, parseArgs(['x'.repeat(BIO_MAX_LENGTH + 1)], BIO_ARGS), deps),
    ).rejects.toThrow(/cap is 1024/);
    expect(sent).toHaveLength(0);
  });

  it('refuses more than one value positionally', async () => {
    const { deps, sent } = fakeDeps({});
    const sink = capture();

    await expect(
      runAuthorBio(sink.out, parseArgs(['one', 'two'], BIO_ARGS), deps),
    ).rejects.toBeInstanceOf(UsageError);
    expect(sent).toHaveLength(0);
  });

  it('refuses --clear together with a value', async () => {
    const { deps } = fakeDeps({});
    const sink = capture();

    await expect(
      runAuthorBio(sink.out, parseArgs(['--clear', 'text'], BIO_ARGS), deps),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('refuses to write when the transaction did not land', async () => {
    const { deps } = fakeDeps({ revertWrites: true });
    const sink = capture();

    await expect(
      runAuthorBio(sink.out, parseArgs(['new bio'], BIO_ARGS), deps),
    ).rejects.toThrow(/did not write the bio/);
  });
});

describe('s2s author bio (refusals)', () => {
  it('sends an author without a records module to `s2s author init`', async () => {
    const { deps } = fakeDeps({ enabled: [SAFE] });
    const sink = capture();

    await expect(runAuthorBio(sink.out, parseArgs([], BIO_ARGS), deps)).rejects.toThrow(
      /s2s author init/,
    );
  });

  it('sends a factory with no records implementation to `s2s author init`', async () => {
    const { deps } = fakeDeps({
      resolution: {
        factory: FACTORY,
        kind: '0x00' as Hex,
        implementation: null,
        address: null,
      },
    });
    const sink = capture();

    await expect(runAuthorBio(sink.out, parseArgs([], BIO_ARGS), deps)).rejects.toThrow(
      /s2s author init/,
    );
  });

  it('refuses when the active author has no Safe yet', async () => {
    const { deps } = fakeDeps({ authors: store({ safe: null }) });
    const sink = capture();

    await expect(runAuthorBio(sink.out, parseArgs([], BIO_ARGS), deps)).rejects.toBeInstanceOf(
      CliError,
    );
  });

  it('refuses when there is no active author', async () => {
    const { deps } = fakeDeps({ authors: { active: null, authors: {} } });
    const sink = capture();

    await expect(runAuthorBio(sink.out, parseArgs([], BIO_ARGS), deps)).rejects.toBeInstanceOf(
      UsageError,
    );
  });
});

describe('registration', () => {
  it('declares --clear and its positional', () => {
    expect(authorBio.name).toBe('bio');
    expect(authorBio.params).toBe('[<text>]');
    expect(authorBio.flags.clear?.type).toBe('boolean');
  });
});
