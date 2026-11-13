// ============================================================================
// `s2s drafts list` — which drafts module answers for an author Safe, and what
// its log holds.
//
// The reads are faked as one object (`DraftsSeam`), the same shape
// `author-contracts.test.ts` replaces: the Safe's enabled-module list, the
// factory index, `count()` and `fetchAllPaged`. What is under test is the
// decision — enabled before factory, the error when neither answers, pages of
// 100 until a short one — and the rows it prints, not viem's encoding.
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
  /** The module the Safe's enabled list answers for the drafts role, if any. */
  enabled?: Address | null;
  /** Every address on the enabled list; defaults to `enabled` alone. */
  modules?: Address[];
  /** The Safe the enabled module's `safe()` answers; null when it answers none. */
  boundTo?: Address | null;
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
        modules: options.modules ?? (options.enabled ? [options.enabled] : []),
        byRole: {
          drafts: options.enabled ? [options.enabled] : [],
          ownerHistory: [],
        },
        drafts: options.enabled ?? null,
        ownerHistory: null,
      }),
    readModuleSafe: ({ module }) =>
      Promise.resolve(
        module === options.enabled
          ? options.boundTo === undefined
            ? SAFE
            : options.boundTo
          : null,
      ),
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
    // The write path's post-append read; a list never asks for it.
    readVersionCount: () => Promise.resolve(0n),
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

    expect(resolved).toEqual({ address: DRAFTS, source: 'enabled', onEnabledList: true });
    expect(chain.factoryReads()).toBe(0);
  });

  it('falls back to the newest factory index entry when the Safe enables nothing', async () => {
    const chain = fakeSeam({ enabled: null, factory: FACTORY_DRAFTS });
    const resolved = await resolveDraftsModule(
      { safe: SAFE, rpcUrl: RPC, factory: FACTORY },
      chain.seam,
    );

    expect(resolved).toEqual({ address: FACTORY_DRAFTS, source: 'factory', onEnabledList: false });
    expect(chain.factoryReads()).toBe(1);
  });

  it('falls through when the enabled module answers the role but no safe()', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, boundTo: null, factory: FACTORY_DRAFTS });
    const resolved = await resolveDraftsModule(
      { safe: SAFE, rpcUrl: RPC, factory: FACTORY },
      chain.seam,
    );

    expect(resolved).toEqual({ address: FACTORY_DRAFTS, source: 'factory', onEnabledList: false });
  });

  it('does not read as this Safe a module the Safe enabled but another Safe owns', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, boundTo: OTHER_SAFE, factory: FACTORY_DRAFTS });
    const resolved = await resolveDraftsModule(
      { safe: SAFE, rpcUrl: RPC, factory: FACTORY },
      chain.seam,
    );

    // `enableModule` takes any address; the module's own `safe()` says whose log it holds.
    expect(resolved).toEqual({ address: FACTORY_DRAFTS, source: 'factory', onEnabledList: false });
    expect(chain.factoryReads()).toBe(1);
  });

  it('names `s2s author init` when the only enabled module belongs to another Safe', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, boundTo: OTHER_SAFE, factory: null });

    await expect(
      resolveDraftsModule({ safe: SAFE, rpcUrl: RPC, factory: FACTORY }, chain.seam),
    ).rejects.toMatchObject({ code: 'no_drafts_module' });
  });

  it('names the module it rejected when that one is bound to another Safe', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, boundTo: OTHER_SAFE, factory: null });

    await expect(
      resolveDraftsModule({ safe: SAFE, rpcUrl: RPC, factory: FACTORY }, chain.seam),
    ).rejects.toThrow(
      `no drafts module bound to author Safe ${SAFE} — the drafts module enabled here (${DRAFTS}) is bound to ${OTHER_SAFE}, not to this Safe; run: s2s author init`,
    );
  });

  it('names the module it rejected when that one answers no safe()', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, boundTo: null, factory: null });

    await expect(
      resolveDraftsModule({ safe: SAFE, rpcUrl: RPC, factory: FACTORY }, chain.seam),
    ).rejects.toThrow(
      `no drafts module bound to author Safe ${SAFE} — the drafts module enabled here (${DRAFTS}) answers no safe(), so this run cannot tell whose log it holds; run: s2s author init`,
    );
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
  it('prints one row per draft and nothing else', async () => {
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

    // The 1-based order, the genesis in full (it is the argument `append` takes),
    // the version count, then the latest block time in UTC minutes. Two spaces
    // between columns, no module line, no count line, no header row.
    expect(cap.human[0]).toBe(
      [
        `1  ${raw(0).genesis}  3  2023-11-14 22:13`,
        `2  ${raw(1).genesis}  1  2023-11-14 22:13`,
      ].join('\n'),
    );
    expect(cap.warnings).toEqual([]);
  });

  it('prints nothing at all for an empty log on an enabled module', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, log: [] });
    const cap = capture();

    await runDraftsList(context(cap.out), { seam: chain.seam, safeState: SAFE_STATE });

    // Not a blank line: no stdout write at all, and no stderr line either.
    expect(cap.results).toEqual([]);
    expect(cap.human).toEqual([]);
    expect(cap.warnings).toEqual([]);
  });

  it('still prints the JSON envelope for an empty log', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, log: [] });
    const cap = capture();
    cap.out.json = true;

    await runDraftsList(context(cap.out), { seam: chain.seam, safeState: SAFE_STATE });

    expect(cap.results[0]).toMatchObject({ count: 0, drafts: [] });
  });

  it('warns once that the factory index is permissionless when it named the module', async () => {
    const chain = fakeSeam({ enabled: null, factory: FACTORY_DRAFTS, log: [raw(0)] });
    const cap = capture();

    await runDraftsList(context(cap.out), { seam: chain.seam, safeState: SAFE_STATE });

    expect(cap.warnings).toHaveLength(1);
    expect(cap.warnings[0]).toContain('permissionless');
    expect(cap.warnings[0]).toContain('unwritten by this Safe');
    expect(cap.warnings[0]).toContain(FACTORY_DRAFTS);
    // The rows are the index's claim, not the Safe's adoption, so the warning is
    // the only place that provenance is said.
    expect(cap.human[0]).toBe(`1  ${raw(0).genesis}  1  2023-11-14 22:13`);
  });

  it('says nothing extra when the Safe enabled the module', async () => {
    const chain = fakeSeam({ enabled: DRAFTS, log: [raw(0)] });
    const cap = capture();

    await runDraftsList(context(cap.out), { seam: chain.seam, safeState: SAFE_STATE });

    expect(cap.warnings).toEqual([]);
    expect(cap.human[0]).toBe(`1  ${raw(0).genesis}  1  2023-11-14 22:13`);
  });

  it('does not warn when the factory-index module is on the enabled list', async () => {
    // The role went to DRAFTS, which is bound to another Safe; the factory index
    // names FACTORY_DRAFTS, which this Safe also enables. It is enabled, so no
    // warning — "not on the enabled list" would be false.
    const chain = fakeSeam({
      enabled: DRAFTS,
      modules: [FACTORY_DRAFTS, DRAFTS],
      boundTo: OTHER_SAFE,
      factory: FACTORY_DRAFTS,
      log: [raw(0)],
    });
    const cap = capture();

    await runDraftsList(context(cap.out), { seam: chain.seam, safeState: SAFE_STATE });

    expect(cap.warnings).toEqual([]);
    expect(cap.human[0]).toBe(`1  ${raw(0).genesis}  1  2023-11-14 22:13`);
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
  it('is the empty string for an empty log', () => {
    expect(
      draftsListLines({
        action: 'drafts.list',
        author: null,
        safe: SAFE,
        module: DRAFTS,
        source: 'enabled',
        count: 0,
        drafts: [],
      }),
    ).toBe('');
  });

  it('keeps the genesis whole and formats the timestamp as UTC minutes', () => {
    const genesis = raw(0).genesis;
    expect(
      draftsListLines({
        action: 'drafts.list',
        author: null,
        safe: SAFE,
        module: DRAFTS,
        source: 'enabled',
        count: 1,
        drafts: [
          { genesis, cid: 'bafy', author: SAFE, timestamp: 1794589140, versionCount: 12 },
        ],
      }),
    ).toBe(`1  ${genesis}  12  2026-11-13 16:59`);
  });

  it('right-aligns the order to the highest row and keeps the log order, not the timestamps', () => {
    // Ten rows: two digits of width, so the single-digit orders pad. The third
    // row carries the earliest timestamp and still sits third — the number is the
    // position in the log, not a rank.
    const drafts = Array.from({ length: 10 }, (_, index) => ({
      genesis: raw(index).genesis,
      cid: `bafy-${String(index)}`,
      author: SAFE,
      timestamp: index === 2 ? 1600000000 : 1794589140 + index,
      versionCount: 1,
    }));

    const rows = draftsListLines({
      action: 'drafts.list',
      author: null,
      safe: SAFE,
      module: DRAFTS,
      source: 'enabled',
      count: drafts.length,
      drafts,
    }).split('\n');

    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe(` 1  ${raw(0).genesis}  1  2026-11-13 16:59`);
    expect(rows[2]).toBe(` 3  ${raw(2).genesis}  1  2020-09-13 12:26`);
    expect(rows[9]).toBe(`10  ${raw(9).genesis}  1  2026-11-13 16:59`);
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
  it('is a top-level group whose actions are `list` and the `append` retry', () => {
    expect(findDraftsCommand('list')?.name).toBe('list');
    expect(findDraftsCommand('bogus')).toBeUndefined();
    expect(draftsHelpEntries.map((command) => command.name)).toEqual(['list', 'append']);
  });
});
