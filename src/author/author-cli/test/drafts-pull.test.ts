// ============================================================================
// `s2s drafts pull <folder>` — every draft in the log becomes a note in the
// folder, and no note that is already there is thrown away.
//
// The chain is faked as in `drafts-fetch.test.ts`, but the folder is real: each
// test works in its own temp directory, because the comparison under test is
// between a file on disk and the log. What matters is the status decision —
// written, present, behind, failed — and that `--force` is the only thing that
// rewrites a note somebody edited.
// ============================================================================

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../src/core/context';
import type { DraftEntry, DraftsSeam, RawDraftEntry } from '../src/core/drafts';
import { draftsPullLines, runDraftsPull } from '../src/commands/drafts-pull';
import type { CliOut } from '../src/lib/out';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as const;
const DRAFTS = '0x0000000000000000000000000000000000000011' as const;
const FACTORY = '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' as const;
const RPC = 'http://127.0.0.1:8545';
const PKP = '0x' + 'ab'.repeat(32);

const GENESIS_0: `0x${string}` = `0x${'01'.repeat(32)}`;
const GENESIS_1: `0x${string}` = `0x${'02'.repeat(32)}`;
const CIPHERTEXT = JSON.stringify('gAAAAAB' + 'z'.repeat(40));

function bodyDocument(title: string, content: string): string {
  return JSON.stringify({ title, slug: title.toLowerCase(), content, custom: {} });
}

/** One row of the log. */
function entry(index: number, overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    genesis: index === 0 ? GENESIS_0 : GENESIS_1,
    cid: `bafy-draft-${String(index)}`,
    author: SAFE,
    timestamp: 1794589140 + index,
    versionCount: 1,
    ...overrides,
  };
}

function raw(draft: DraftEntry): RawDraftEntry {
  return {
    genesis: draft.genesis,
    author: SAFE,
    cid: draft.cid,
    timestamp: BigInt(draft.timestamp),
    versionCount: BigInt(draft.versionCount),
  };
}

function seam(drafts: DraftEntry[]): DraftsSeam {
  const log = drafts.map(raw);
  return {
    readEnabled: () =>
      Promise.resolve({
        modules: [DRAFTS],
        byRole: { drafts: [DRAFTS], ownerHistory: [] },
        drafts: DRAFTS,
        ownerHistory: null,
      }),
    readModuleSafe: () => Promise.resolve(SAFE),
    readFactory: () =>
      Promise.resolve({ factory: FACTORY, drafts: null, ownerHistory: null, guard: null }),
    readCount: () => Promise.resolve(BigInt(log.length)),
    readPage: ({ offset, limit }) =>
      Promise.resolve(log.slice(Number(offset), Number(offset + limit))),
    readVersionCount: () => Promise.resolve(0n),
  };
}

/** The item stored at a CID: encrypted, labelled, one body. */
function item(label: string) {
  return {
    public: {
      specVersion: '2',
      author: SAFE,
      creationDate: 1700000000,
      modifiedDate: 1700000600,
      label,
    },
    encryption: true,
    bodies: { s2s: CIPHERTEXT },
  };
}

interface Captured {
  out: CliOut;
  human: string[];
  logs: string[];
  warnings: string[];
  results: Record<string, unknown>[];
}

function capture(json = false): Captured {
  const human: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const results: Record<string, unknown>[] = [];
  const out: CliOut = {
    json,
    log: (message: string) => logs.push(message),
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      if (text !== undefined) human.push(text);
    },
  };
  return { out, human, logs, warnings, results };
}

/**
 * The context, with one plaintext per genesis and one stored item per CID, so a
 * test says what each draft *is* rather than what each call returns.
 */
function context(options: {
  cap?: Captured;
  items: Record<string, ReturnType<typeof item>>;
  plaintexts: Record<string, string>;
  refuse?: string[];
}) {
  const cap = options.cap ?? capture();
  const fetchFromKubo = vi.fn((cid: string) => {
    const stored = options.items[cid];
    return stored === undefined
      ? Promise.reject(new Error(`404 from the gateway for ${cid}`))
      : Promise.resolve(stored);
  });
  const decrypt = vi.fn((_key: string, params: { genesis: string }) => {
    if (options.refuse?.includes(params.genesis) === true) {
      return Promise.reject(new Error('decrypt refused: the signer was not an owner then'));
    }
    const plaintext = options.plaintexts[params.genesis];
    return plaintext === undefined
      ? Promise.reject(new Error(`no plaintext for ${params.genesis}`))
      : Promise.resolve(plaintext);
  });

  const ctx = {
    out: cap.out,
    config: {
      author: { name: 'zomi' },
      contracts: { authorFactory: FACTORY },
      lit: { usageKey: 'lit-key' },
    },
    rpcs: { L1: [], L2: [RPC] },
    protocolInfo: { pkp: PKP },
    ipfs: { fetchFromKubo },
    lit: { decrypt },
    signer: { signMessage: () => Promise.resolve('0xsigned') },
  } as unknown as CliContext;

  return { ctx, cap, fetchFromKubo, decrypt };
}

const SAFE_STATE = () => Promise.resolve({ address: SAFE, deployed: true });

describe('runDraftsPull', () => {
  let before: string;
  let dir: string;

  beforeEach(() => {
    before = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 's2s-pull-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the notes that are missing and names them by title', async () => {
    const drafts = [entry(0), entry(1)];
    const { ctx } = context({
      items: {
        'bafy-draft-0': item('First Draft'),
        'bafy-draft-1': item('Second Draft'),
      },
      plaintexts: {
        [GENESIS_0]: bodyDocument('First Draft', '<p>one</p>'),
        [GENESIS_1]: bodyDocument('Second Draft', '<p>two</p>'),
      },
    });

    const outcome = await runDraftsPull(
      ctx,
      'notes',
      {},
      {
        safeState: SAFE_STATE,
        seam: seam(drafts),
      },
    );

    expect(outcome.failed).toBe(0);
    expect(outcome.result.drafts).toEqual([
      {
        genesis: GENESIS_0,
        cid: 'bafy-draft-0',
        status: 'written',
        path: join('notes', 'first-draft.md'),
      },
      {
        genesis: GENESIS_1,
        cid: 'bafy-draft-1',
        status: 'written',
        path: join('notes', 'second-draft.md'),
      },
    ]);
    expect(readdirSync('notes').sort()).toEqual(['first-draft.md', 'second-draft.md']);
    expect(readFileSync(join('notes', 'first-draft.md'), 'utf8')).toContain(
      `genesis: "${GENESIS_0}"`,
    );
  });

  it('prints the rows on stderr, in log order, as `order  status  path`', async () => {
    const cap = capture();
    const { ctx } = context({
      cap,
      items: { 'bafy-draft-0': item('First Draft') },
      plaintexts: { [GENESIS_0]: bodyDocument('First Draft', '<p>one</p>') },
    });

    await runDraftsPull(ctx, 'notes', {}, { safeState: SAFE_STATE, seam: seam([entry(0)]) });

    expect(cap.logs).toEqual([`1  written  ${join('notes', 'first-draft.md')}`]);
    // Nothing on stdout: the rows are the summary, and stdout stays machine-only.
    expect(cap.human).toEqual([]);
  });

  it('leaves a note whose recorded CID is current alone: present', async () => {
    mkdirSync('notes');
    const note = [
      '---',
      `genesis: "${GENESIS_0}"`,
      'cid: bafy-draft-0',
      '---',
      '# First Draft',
      '',
      '<p>edited by hand</p>',
    ].join('\n');
    writeFileSync(join('notes', 'first-draft.md'), note);

    const { ctx, fetchFromKubo, decrypt } = context({ items: {}, plaintexts: {} });
    const outcome = await runDraftsPull(
      ctx,
      'notes',
      {},
      {
        safeState: SAFE_STATE,
        seam: seam([entry(0)]),
      },
    );

    expect(outcome.result.drafts).toEqual([
      {
        genesis: GENESIS_0,
        cid: 'bafy-draft-0',
        status: 'present',
        path: join('notes', 'first-draft.md'),
      },
    ]);
    // Nothing is fetched or decrypted to find out it is current.
    expect(fetchFromKubo).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(readFileSync(join('notes', 'first-draft.md'), 'utf8')).toBe(note);
  });

  it('reports a note that is behind and does not overwrite it', async () => {
    mkdirSync('notes');
    const note = [
      '---',
      `genesis: "${GENESIS_0}"`,
      'cid: bafy-old',
      '---',
      '# First Draft',
      '',
    ].join('\n');
    writeFileSync(join('notes', 'first-draft.md'), note);

    const { ctx, decrypt } = context({ items: {}, plaintexts: {} });
    const outcome = await runDraftsPull(
      ctx,
      'notes',
      {},
      {
        safeState: SAFE_STATE,
        seam: seam([entry(0)]),
      },
    );

    expect(outcome.failed).toBe(0);
    expect(outcome.result.drafts[0]).toMatchObject({ status: 'behind' });
    expect(outcome.result.drafts[0]?.path).toBe(join('notes', 'first-draft.md'));
    expect(decrypt).not.toHaveBeenCalled();
    // The local edit is the author's work: a pull is not the command that drops it.
    expect(readFileSync(join('notes', 'first-draft.md'), 'utf8')).toBe(note);
  });

  it('rewrites a behind note under --force, at the path it already has', async () => {
    mkdirSync('notes');
    writeFileSync(
      join('notes', 'first-draft.md'),
      ['---', `genesis: "${GENESIS_0}"`, 'cid: bafy-old', '---', '# Old', ''].join('\n'),
    );

    const { ctx } = context({
      items: { 'bafy-draft-0': item('First Draft') },
      plaintexts: { [GENESIS_0]: bodyDocument('First Draft', '<p>one</p>') },
    });
    const outcome = await runDraftsPull(
      ctx,
      'notes',
      { force: true },
      {
        safeState: SAFE_STATE,
        seam: seam([entry(0)]),
      },
    );

    expect(outcome.result.drafts[0]).toMatchObject({
      status: 'written',
      path: join('notes', 'first-draft.md'),
    });
    const text = readFileSync(join('notes', 'first-draft.md'), 'utf8');
    expect(text).toContain('cid: bafy-draft-0');
    expect(text).toContain('<p>one</p>');
  });

  it('honours the legacy kubo_cid as the recorded version', async () => {
    mkdirSync('notes');
    writeFileSync(
      join('notes', 'first-draft.md'),
      ['---', `genesis: "${GENESIS_0}"`, 'kubo_cid: bafy-draft-0', '---', '# First Draft', ''].join(
        '\n',
      ),
    );

    const { ctx, fetchFromKubo } = context({ items: {}, plaintexts: {} });
    const outcome = await runDraftsPull(
      ctx,
      'notes',
      {},
      { safeState: SAFE_STATE, seam: seam([entry(0)]) },
    );

    // A note written before the rename records the same version under the old key.
    expect(outcome.result.drafts[0]).toMatchObject({ status: 'present' });
    expect(fetchFromKubo).not.toHaveBeenCalled();
  });

  it('says so when two notes carry the same genesis, and compares the first in name order', async () => {
    const cap = capture();
    mkdirSync('notes');
    for (const name of ['aaa.md', 'zzz.md']) {
      writeFileSync(
        join('notes', name),
        ['---', `genesis: "${GENESIS_0}"`, 'cid: bafy-draft-0', '---', '# First Draft', ''].join(
          '\n',
        ),
      );
    }

    const { ctx } = context({ cap, items: {}, plaintexts: {} });
    const outcome = await runDraftsPull(
      ctx,
      'notes',
      {},
      { safeState: SAFE_STATE, seam: seam([entry(0)]) },
    );

    // Neither file is rewritten, and the duplicate is named rather than absorbed.
    expect(cap.warnings).toHaveLength(1);
    expect(cap.warnings[0]).toContain(GENESIS_0);
    expect(cap.warnings[0]).toContain(join('notes', 'aaa.md'));
    expect(cap.warnings[0]).toContain(join('notes', 'zzz.md'));
    expect(outcome.result.drafts[0]).toMatchObject({
      status: 'present',
      path: join('notes', 'aaa.md'),
    });
  });

  it('leaves files carrying another genesis, and files carrying none, untouched', async () => {
    mkdirSync('notes');
    writeFileSync(
      join('notes', 'foreign.md'),
      ['---', `genesis: "0x${'09'.repeat(32)}"`, 'cid: bafy-foreign', '---', '# Foreign', ''].join(
        '\n',
      ),
    );
    writeFileSync(join('notes', 'plain.md'), '# No frontmatter\n');

    const { ctx } = context({
      items: { 'bafy-draft-0': item('First Draft') },
      plaintexts: { [GENESIS_0]: bodyDocument('First Draft', '<p>one</p>') },
    });
    await runDraftsPull(ctx, 'notes', {}, { safeState: SAFE_STATE, seam: seam([entry(0)]) });

    expect(readFileSync(join('notes', 'foreign.md'), 'utf8')).toContain('bafy-foreign');
    expect(readFileSync(join('notes', 'plain.md'), 'utf8')).toBe('# No frontmatter\n');
  });

  it('does not overwrite a note that belongs to another genesis under the same title', async () => {
    mkdirSync('notes');
    writeFileSync(
      join('notes', 'first-draft.md'),
      ['---', `genesis: "0x${'09'.repeat(32)}"`, '---', '# Someone else', ''].join('\n'),
    );

    const { ctx } = context({
      items: { 'bafy-draft-0': item('First Draft') },
      plaintexts: { [GENESIS_0]: bodyDocument('First Draft', '<p>one</p>') },
    });
    const outcome = await runDraftsPull(
      ctx,
      'notes',
      {},
      {
        safeState: SAFE_STATE,
        seam: seam([entry(0)]),
      },
    );

    // The suffix keeps the second note beside the first, not on top of it.
    expect(outcome.result.drafts[0]).toMatchObject({
      status: 'written',
      path: join('notes', `first-draft-${GENESIS_0.slice(2, 10)}.md`),
    });
    expect(readFileSync(join('notes', 'first-draft.md'), 'utf8')).toContain('Someone else');
  });

  it('keeps going after a refusal, says which draft failed, and hands back the exit code', async () => {
    const cap = capture();
    const { ctx } = context({
      cap,
      items: {
        'bafy-draft-0': item('First Draft'),
        'bafy-draft-1': item('Second Draft'),
      },
      plaintexts: { [GENESIS_1]: bodyDocument('Second Draft', '<p>two</p>') },
      refuse: [GENESIS_0],
    });

    const outcome = await runDraftsPull(
      ctx,
      'notes',
      {},
      {
        safeState: SAFE_STATE,
        seam: seam([entry(0), entry(1)]),
      },
    );

    expect(outcome.failed).toBe(1);
    expect(outcome.result.drafts).toEqual([
      { genesis: GENESIS_0, cid: 'bafy-draft-0', status: 'failed', path: '' },
      {
        genesis: GENESIS_1,
        cid: 'bafy-draft-1',
        status: 'written',
        path: join('notes', 'second-draft.md'),
      },
    ]);
    // The reason is the action's, once, naming the row it belongs to.
    expect(cap.warnings).toHaveLength(1);
    expect(cap.warnings[0]).toContain('draft 1');
    expect(cap.warnings[0]).toContain('not an owner then');
    expect(readdirSync('notes')).toEqual(['second-draft.md']);
  });

  it('creates the folder it was given, and writes nothing but the notes', async () => {
    const { ctx } = context({
      items: { 'bafy-draft-0': item('First Draft') },
      plaintexts: { [GENESIS_0]: bodyDocument('First Draft', '<p>one</p>') },
    });
    await runDraftsPull(
      ctx,
      join('deep', 'notes'),
      {},
      {
        safeState: SAFE_STATE,
        seam: seam([entry(0)]),
      },
    );
    expect(readdirSync(join('deep', 'notes'))).toEqual(['first-draft.md']);
  });

  it('prints the envelope and no stderr rows under --json', async () => {
    const cap = capture(true);
    const { ctx } = context({
      cap,
      items: { 'bafy-draft-0': item('First Draft') },
      plaintexts: { [GENESIS_0]: bodyDocument('First Draft', '<p>one</p>') },
    });

    await runDraftsPull(ctx, 'notes', {}, { safeState: SAFE_STATE, seam: seam([entry(0)]) });

    expect(cap.results[0]).toMatchObject({
      action: 'drafts.pull',
      folder: 'notes',
      drafts: [{ genesis: GENESIS_0, cid: 'bafy-draft-0', status: 'written' }],
    });
    expect(cap.logs).toEqual([]);
  });
});

describe('draftsPullLines', () => {
  it('is `order  status  path`, and drops the path column a failure does not have', () => {
    expect(
      draftsPullLines([
        { genesis: GENESIS_0, cid: 'bafy-0', status: 'written', path: 'a.md' },
        { genesis: GENESIS_1, cid: 'bafy-1', status: 'behind', path: 'b.md' },
        { genesis: GENESIS_1, cid: 'bafy-1', status: 'failed', path: '' },
      ]),
    ).toEqual(['1  written  a.md', '2  behind  b.md', '3  failed']);
  });
});
