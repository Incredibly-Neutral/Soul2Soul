// ============================================================================
// `s2s setup` — the first-run wizard, and the promises it makes:
//
//   * `--accept-defaults` asks nothing, writes nothing, needs no TTY;
//   * a non-TTY run (a pipe, CI, the editor plugin) never blocks either;
//   * the ONLY file it writes is the custom layer (custom.json), never the
//     project file, and never a value it was not asked for;
//   * it never asks about lit / ens / github / privateKey.
//
// XDG_CONFIG_HOME points at a temp dir for every test, so custom.json and the
// legacy config.json are files this suite owns. The prompt module is wrapped
// (not replaced): with no override installed, the REAL implementation runs, so
// the non-TTY tests exercise the actual stdin check rather than a fake of it.
// ============================================================================

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the wrap feeds the wizard. Empty ⇒ the real prompt, i.e. no TTY. */
interface PromptState {
  /** `undefined` ⇒ ask the real module, i.e. the actual non-TTY answer. */
  interactive: boolean | undefined;
  /** Substring of the question → the answer to give. */
  answers: Record<string, string | undefined>;
  asked: string[];
}

const promptState = vi.hoisted(
  (): PromptState => ({ interactive: undefined, answers: {}, asked: [] }),
);

vi.mock('../src/lib/prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/prompt')>();
  return {
    ...actual,
    isInteractive: (targets?: Parameters<typeof actual.isInteractive>[0]) =>
      promptState.interactive ?? actual.isInteractive(targets),
    prompt: (question: string, options?: Parameters<typeof actual.prompt>[1]) => {
      promptState.asked.push(question);
      const hit = Object.keys(promptState.answers).find((needle) => question.includes(needle));
      if (hit === undefined) return actual.prompt(question, options);
      return Promise.resolve(promptState.answers[hit]);
    },
  };
});

import { setup } from '../src/commands/setup';
import { parseArgs, parseCommandArgs } from '../src/lib/args';
import type { CliOut } from '../src/lib/out';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-setup-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  promptState.interactive = undefined;
  promptState.answers = {};
  promptState.asked = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const customFile = (): string => join(dir, 's2s', 'custom.json');
const legacyFile = (): string => join(dir, 's2s', 'config.json');
const projectFile = (): string => join(process.cwd(), '.s2sconfig.json');

function capture(): { out: CliOut; results: Record<string, unknown>[]; warnings: string[] } {
  const results: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const out: CliOut = {
    json: true,
    log: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    result: (data: unknown) => {
      results.push(data as Record<string, unknown>);
    },
  };
  return { out, results, warnings };
}

async function run(argv: string[] = []) {
  const sink = capture();
  await setup.run(sink.out, parseArgs(argv));
  const result = sink.results[0] ?? {};
  return { ...sink, result, written: result.written as string[], kept: result.kept as string[] };
}

function readCustom(): Record<string, unknown> {
  return JSON.parse(readFileSync(customFile(), 'utf8')) as Record<string, unknown>;
}

describe('s2s setup --accept-defaults', () => {
  it('writes nothing, asks nothing, and needs no TTY', async () => {
    // stdin is not a terminal under vitest — exactly the CI/editor case.
    const run1 = await run(['--accept-defaults']);

    expect(existsSync(customFile())).toBe(false);
    expect(existsSync(legacyFile())).toBe(false);
    expect(run1.written).toEqual([]);
    // Every question was kept, and not one of them was asked.
    expect(run1.kept.length).toBeGreaterThan(0);
    expect(promptState.asked).toEqual([]);
    // The non-TTY warning is for a run that WOULD have asked; --accept-defaults
    // is the documented way to say "I know", so it stays quiet.
    expect(run1.warnings).toEqual([]);
  });

  it('reports the same action shape as an interactive run', async () => {
    const { result } = await run(['--accept-defaults']);
    expect(result.action).toBe('setup');
    expect(Array.isArray(result.written)).toBe(true);
    expect(Array.isArray(result.kept)).toBe(true);
  });
});

describe('a non-TTY run without --accept-defaults', () => {
  it('does not block, writes nothing and says why', async () => {
    const { written, warnings } = await run([]);

    expect(written).toEqual([]);
    expect(existsSync(customFile())).toBe(false);
    expect(warnings[0]).toMatch(/stdin is not a terminal/);
    expect(warnings[0]).toMatch(/--accept-defaults/);
  });
});

describe('an interactive run', () => {
  /** The answers this test pastes, keyed by a substring of the question. */
  const ANSWERS = {
    'Pinata JWT': 'jwt-abc',
    'Kubo gateway URL': 'gw.example',
    'Pimlico API key': 'pk_123',
  };

  it('writes pasted values to the custom file only', async () => {
    promptState.interactive = true;
    promptState.answers = ANSWERS;
    const projectBefore = existsSync(projectFile());

    const { written } = await run([]);

    expect(written).toEqual(['pinning.pinata.key', 'ipfs.kubo.url', 'paymaster.key']);
    expect(existsSync(customFile())).toBe(true);
    expect(readCustom()).toEqual({
      pinning: { pinata: { key: 'jwt-abc', provider: 'pinata' } },
      ipfs: { kubo: { url: 'gw.example', provider: 'kubo' } },
      paymaster: { key: 'pk_123' },
    });
    // The project file is never a wizard output, and nothing else was created.
    expect(existsSync(projectFile())).toBe(projectBefore);
    expect(existsSync(legacyFile())).toBe(false);
  });

  it('never asks about, or writes, lit / ens / github / privateKey', async () => {
    promptState.interactive = true;
    promptState.answers = ANSWERS;

    await run([]);

    const asked = promptState.asked.join('\n');
    expect(asked).not.toMatch(/\blit\b/i);
    expect(asked).not.toMatch(/\bens\b/i);
    expect(asked).not.toMatch(/github/i);
    expect(asked).not.toMatch(/private ?key/i);

    // Not even as an empty section: the file holds only what was pasted.
    const sections = Object.keys(readCustom());
    expect(sections.sort()).toEqual(['ipfs', 'paymaster', 'pinning']);
    expect(readCustom()).not.toHaveProperty('lit');
    expect(readCustom()).not.toHaveProperty('ens');
    expect(readCustom()).not.toHaveProperty('github');
    expect(readCustom()).not.toHaveProperty('privateKey');
  });

  it('keeps a value the person just pressed enter on, and writes the label provider', async () => {
    promptState.interactive = true;
    // A gateway with no JWT: the pinata entry must still be resolvable, so the
    // implied `provider` is written alongside it.
    promptState.answers = { 'Pinata gateway host': 'pinata.example' };

    const { written, kept } = await run([]);

    expect(written).toEqual(['pinning.pinata.url']);
    expect(readCustom()).toEqual({
      pinning: { pinata: { url: 'pinata.example', provider: 'pinata' } },
    });
    // Every other question was kept as the provided default.
    expect(kept.length).toBeGreaterThan(0);
  });
});

describe('the flag surface', () => {
  it('takes --accept-defaults and nothing else', () => {
    expect(Object.keys(setup.flags)).toEqual(['accept-defaults']);
  });

  it('has no "pass your values on the command line" flag to support', () => {
    // setup asks; it does not take answers as arguments. The one non-interactive
    // path is --accept-defaults (write nothing), and the durable way to set a
    // value is `s2s config set <dotted.path> <value>`.
    expect(() => parseCommandArgs(['--accept-defaults'], setup.flags)).not.toThrow();
    expect(() => parseCommandArgs(['--pinata-jwt', 'jwt'], setup.flags)).toThrow(
      /unknown flag|--pinata-jwt/,
    );
  });
});
