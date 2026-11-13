// ============================================================================
// `s2s drafts list` — which drafts module answers for an author Safe, and what
// its log holds.
//
// The reads are faked as one object (`DraftsSeam`), the same shape
// `author-contracts.test.ts` replaces: the Safe's enabled-module list, the
// factory index, `count()` and `fetchAllPaged`. What is under test is the
// decision — enabled before factory, the error when neither answers, pages of
// 100 until a short one — and the two documents the command prints, not viem's
// encoding.
// ============================================================================

import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  readDrafts,
  resolveDraftsModule,
  type DraftsSeam,
  type RawDraftEntry,
} from '../src/core/drafts';
import { draftsListLines, runDraftsList } from '../src/commands/drafts-list';
import { draftsHelpEntries, findDraftsCommand } from '../src/commands/index';
import type { CliContext } from '../src/core/context';
import { CliError } from '../src/lib/errors';
import { successEnvelope, type CliOut } from '../src/lib/out';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const OTHER_SAFE = '0x1111111111111111111111111111111111111111' as Address;
const FACTORY = '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' as Address;
const DRAFTS = '0x0000000000000000000000000000000000000011' as Address;
const FACTORY_DRAFTS = '0x0000000000000000000000000000000000000012' as Address;
const RPC = 'http://127.0.0.1:8545';

/** One raw log entry as the ABI hands it back. */
function raw(index: number, overrides: Partial<RawDraftEntry> = {}): RawDraftEntry {
  const genesis: Hex = `0x${String(index).padStart(2, '0').repeat(32)}`;
  return {
    genesis,
    author: SAFE,
    cid: `bafy-draft-${String(index)}`,
    timestamp: 1700000000n + BigInt(index),
    versionCount: 1n,
    ...overrides,
  };
}

interface FakeOptions {
  /** The module the Safe's enabled list answers, if any. */
  enabled?: Address | null;
  /** The Safe the enabled module's `safe()` answers; defaults to this author's. */
  boundTo?: Address;
  /** The newest drafts proxy the factory index names, if any. */
  factory?: Address | null;
  /** The whole log; pages are sliced out of it. */
  log?: RawDraftEntry[];
}

interface PageCall {
  offset: bigint;
  limit: bigint;
}

/** The seam, with the calls it received, so the paging is asserted not assumed. */
function fakeSeam(options: FakeOptions = {}) {
  const log = options.log ?? [];
  const pages: PageCall[] = [];
  let factoryReads = 0;

  const seam: DraftsSeam = {
    readEnabled: () =>
      Promise.resolve({
        modules: options.enabled ? [options.enabled] : [],
        byRole: {
          drafts: options.enabled ? [options.enabled] : [],
          ownerHistory: [],
        },
        drafts: options.enabled ?? null,
        ownerHistory: null,
      }),
    readModuleSafe: ({ module }) =>
      Promise.resolve(module === options.enabled ? (options.boundTo ?? SAFE) : null),
    readFactory: () => {
      factoryReads += 1;
      return Promise.resolve({
        factory: FACTORY,
        drafts: options.factory ?? null,
        ownerHistory: null,
        guard: null,
      });
    },
    readCount: () => Promise.resolve(BigInt(log.length)),
    readPage: ({ offset, limit }) => {
      pages.push({ offset, limit });
      return Promise.resolve(log.slice(Number(offset), Number(offset + limit)));
    },
  };

  return { seam, pages, factoryReads: () => factoryReads };
}

describe('resolveDraftsModule', () => {
  it('takes the module the Safe enabled, and never reads the factory index', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, factory: FACTORY_DRAFTS });
    const resolved = await resolveDraftsModule(
      { safe: SAFE, rpcUrl: RPC, factory: FACTORY },
      chain.seam,
    );

    expect(resolved).toEqual({ address: DRAFTS, source: 'enabled' });
    expect(chain.factoryReads()).toBe(0);
  });

  it('falls back to the newest factory index entry when the Safe enables nothing', async () => {
    const chain = fakeSeam({ enabled: null, factory: FACTORY_DRAFTS });
    const resolved = await resolveDraftsModule(
      { safe: SAFE, rpcUrl: RPC, factory: FACTORY },
      chain.seam,
    );

    expect(resolved).toEqual({ address: FACTORY_DRAFTS, source: 'factory' });
    expect(chain.factoryReads()).toBe(1);
  });

  it('does not read as this Safe a module the Safe enabled but another Safe owns', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, boundTo: OTHER_SAFE, factory: FACTORY_DRAFTS });
    const resolved = await resolveDraftsModule(
      { safe: SAFE, rpcUrl: RPC, factory: FACTORY },
      chain.seam,
    );

    // `enableModule` takes any address; the module's own `safe()` says whose log it holds.
    expect(resolved).toEqual({ address: FACTORY_DRAFTS, source: 'factory' });
    expect(chain.factoryReads()).toBe(1);
  });

  it('names `s2s author init` when the only enabled module belongs to another Safe', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, boundTo: OTHER_SAFE, factory: null });

    await expect(
      resolveDraftsModule({ safe: SAFE, rpcUrl: RPC, factory: FACTORY }, chain.seam),
    ).rejects.toMatchObject({ code: 'no_drafts_module' });
  });

  it('names `s2s author init` when neither answers', async () => {
    const chain = fakeSeam({ enabled: null, factory: null });

    await expect(
      resolveDraftsModule({ safe: SAFE, rpcUrl: RPC, factory: FACTORY }, chain.seam),
    ).rejects.toThrow(/run: s2s author init/);

    await expect(
      resolveDraftsModule({ safe: SAFE, rpcUrl: RPC, factory: FACTORY }, chain.seam),
    ).rejects.toMatchObject({ code: 'no_drafts_module' });
  });
});

describe('readDrafts', () => {
  it('pages by 100 and stops on the short final page', async () => {
    const log = Array.from({ length: 250 }, (_, index) => raw(index));
    const chain = fakeSeam({ enabled: DRAFTS, log });

    const drafts = await readDrafts({ address: DRAFTS, rpcUrl: RPC }, chain.seam);

    expect(drafts).toHaveLength(250);
    expect(chain.pages).toEqual([
      { offset: 0n, limit: 100n },
      { offset: 100n, limit: 100n },
      { offset: 200n, limit: 100n },
    ]);
    // Insertion order, and the numbers are narrowed rather than left as bigints.
    expect(drafts[0]).toEqual({
      genesis: raw(0).genesis,
      cid: 'bafy-draft-0',
      author: SAFE,
      timestamp: 1700000000,
      versionCount: 1,
    });
    expect(drafts[249]?.genesis).toBe(raw(249).genesis);
    expect(chain.pages.every((page) => page.limit < 2n ** 255n)).toBe(true);
  });

  it('sends no page call at all for an empty log', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, log: [] });

    expect(await readDrafts({ address: DRAFTS, rpcUrl: RPC }, chain.seam)).toEqual([]);
    expect(chain.pages).toEqual([]);
  });

  it('does not ask for one more page when the count is a multiple of the page size', async () => {
    const log = Array.from({ length: 200 }, (_, index) => raw(index));
    const chain = fakeSeam({ enabled: DRAFTS, log });

    await readDrafts({ address: DRAFTS, rpcUrl: RPC }, chain.seam);

    expect(chain.pages.map((page) => page.offset)).toEqual([0n, 100n]);
  });
});

interface Captured {
  out: CliOut;
  results: Record<string, unknown>[];
  human: string[];
  warnings: string[];
}

function capture(): Captured {
  const results: Record<string, unknown>[] = [];
  const human: string[] = [];
  const warnings: string[] = [];
  const out: CliOut = {
    json: false,
    log: () => undefined,
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      if (text !== undefined) human.push(text);
    },
  };
  return { out, results, human, warnings };
}

/** A context with just what the command reads: config, the L2 endpoint, output. */
function context(out: CliOut): CliContext {
  return {
    out,
    config: { author: { name: 'zomi' }, contracts: { authorFactory: FACTORY } },
    rpcs: { L1: [], L2: [RPC] },
  } as unknown as CliContext;
}

const SAFE_STATE = () => Promise.resolve({ address: SAFE, deployed: true });
const UNDEPLOYED_SAFE_STATE = () => Promise.resolve({ address: SAFE, deployed: false });

describe('drafts list output', () => {
  it('prints one row per draft, the genesis id first', async () => {
    const log = [raw(0, { versionCount: 3n }), raw(1, { versionCount: 1n })];
    const chain = fakeSeam({ enabled: DRAFTS, log });
    const cap = capture();

    await runDraftsList(context(cap.out), { seam: chain.seam, safeState: SAFE_STATE });

    const data = cap.results[0];
    if (data === undefined) throw new Error('no result');
    expect(successEnvelope(data)).toEqual({
      schemaVersion: 1,
      ok: true,
      action: 'drafts.list',
      author: 'zomi',
      safe: SAFE,
      module: DRAFTS,
      source: 'enabled',
      count: 2,
      drafts: [
        {
          genesis: raw(0).genesis,
          cid: 'bafy-draft-0',
          author: SAFE,
          timestamp: 1700000000,
          versionCount: 3,
        },
        {
          genesis: raw(1).genesis,
          cid: 'bafy-draft-1',
          author: SAFE,
          timestamp: 1700000001,
          versionCount: 1,
        },
      ],
    });

    const text = cap.human[0] ?? '';
    expect(text).toContain(`module ${DRAFTS}`);
    expect(text).toContain('enabled on the Safe');
    expect(text).toContain(`author Safe ${SAFE}`);
    // The genesis id is the row identifier, then the version count and an ISO date.
    expect(text).toContain(`${raw(0).genesis}  3  2023-11-14T22:13:20.000Z`);
    expect(cap.warnings).toEqual([]);
  });

  it("says a factory-index module is empty without calling it this Safe's log", async () => {
    const chain = fakeSeam({ enabled: null, factory: FACTORY_DRAFTS, log: [] });
    const cap = capture();

    await runDraftsList(context(cap.out), { seam: chain.seam, safeState: SAFE_STATE });

    const text = cap.human[0] ?? '';
    expect(text).toBe(
      `no drafts in module ${FACTORY_DRAFTS} (author Safe ${SAFE}) — the factory index names it for this Safe, and it holds no entries`,
    );
    // The index is permissionless: the line must not claim the Safe ever used it,
    // and it must not say "this Safe's log".
    expect(text).not.toContain("this Safe's log");
    expect(text.includes('\n')).toBe(false);
    expect(cap.results[0]).toMatchObject({
      action: 'drafts.list',
      source: 'factory',
      count: 0,
      drafts: [],
    });
    // A factory-index module is a lead, not an install: the warning says so.
    expect(cap.warnings[0]).toContain('not on the Safe');
  });

  it("says this Safe's log when an enabled module is the one that answered", async () => {
    const chain = fakeSeam({ enabled: DRAFTS, log: [] });
    const cap = capture();

    await runDraftsList(context(cap.out), { seam: chain.seam, safeState: SAFE_STATE });

    expect(cap.human[0]).toBe(
      `no drafts in module ${DRAFTS} (author Safe ${SAFE}) — nothing has been appended to this Safe's log`,
    );
    expect(cap.warnings).toEqual([]);
  });

  it('says the Safe is not deployed and names the remedy, instead of a viem error', async () => {
    const chain = fakeSeam({ enabled: DRAFTS });
    const cap = capture();

    await expect(
      runDraftsList(context(cap.out), { seam: chain.seam, safeState: UNDEPLOYED_SAFE_STATE }),
    ).rejects.toMatchObject({
      code: 'safe_not_deployed',
      message: `the author Safe ${SAFE} is not deployed yet — run: s2s author init`,
    });
    // Nothing is read against a Safe with no code: no module list, no index.
    expect(chain.factoryReads()).toBe(0);
    expect(cap.results).toEqual([]);
  });
});

describe('draftsListLines', () => {
  it('renders nothing but the empty line for a count of zero', () => {
    const text = draftsListLines({
      action: 'drafts.list',
      author: null,
      safe: SAFE,
      module: DRAFTS,
      source: 'enabled',
      count: 0,
      drafts: [],
    });
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain(DRAFTS);
  });
});

describe('CliError', () => {
  it('is the type a caller can branch on for the missing module', async () => {
    const chain = fakeSeam({ enabled: null, factory: null });
    await expect(
      resolveDraftsModule({ safe: SAFE, rpcUrl: RPC, factory: FACTORY }, chain.seam),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe('top-level dispatch', () => {
  /**
   * `cli.ts` runs `main` at import, reading the argv it finds — and its group →
   * finder ternary is otherwise unreachable from a test. `drafts list --help`
   * renders that command's own help, so a swap with `findPublicationCommand`
   * turns into `unknown drafts action 'list'` on stderr instead of the usage line.
   */
  it('routes `s2s drafts list` to the drafts registry', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const argv = process.argv;
    const exitCode = process.exitCode;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    process.argv = ['node', 's2s', 'drafts', 'list', '--help'];
    try {
      await import('../src/cli');
      await vi.waitFor(() => {
        expect(stdout.join('')).toContain('s2s drafts list [flags]');
      });
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.restoreAllMocks();
    }

    expect(stdout.join('')).toContain("List the drafts in the active author Safe's drafts module.");
    expect(stderr.join('')).toBe('');
  });
});

describe('registration', () => {
  it('is a top-level group with one action, `list`', () => {
    expect(findDraftsCommand('list')?.name).toBe('list');
    expect(findDraftsCommand('bogus')).toBeUndefined();
    expect(draftsHelpEntries.map((command) => command.name)).toEqual(['list']);
  });
});
