// ============================================================================
// `s2s config` — the split between the retired `privateKey` (settable: never,
// removable: yes) and everything else.
//
// XDG_CONFIG_HOME points at a temp dir for every test, so the custom and
// legacy layers are files this suite owns. `--local` resolves the project file
// from the cwd, so that one test chdirs into the temp dir and back.
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findConfigCommand } from '../src/commands/config';
import { readConfigFile } from '../src/core/configfile';
import { UsageError } from '../src/lib/errors';
import { parseArgs } from '../src/lib/args';
import type { CliOut } from '../src/lib/out';

let dir: string;
let cwd: string;

/** The key nobody should keep in a config file. */
const KEY = `0x${'00'.repeat(31)}01`;
const OTHER = `0x${'00'.repeat(31)}02`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-config-cmd-'));
  cwd = process.cwd();
  vi.stubEnv('XDG_CONFIG_HOME', dir);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A config file at the custom (or another) layer. */
function configFile(layer = 'custom.json', data: Record<string, unknown> = {}): string {
  const path = join(dir, 's2s', layer);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), 'utf8');
  return path;
}

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

function run(action: 'set' | 'unset', argv: string[]) {
  const command = findConfigCommand(action);
  if (!command) throw new Error(`no config action '${action}'`);
  const sink = capture();
  command.run(sink.out, parseArgs(argv));
  return sink;
}

describe('config set privateKey', () => {
  it('is refused and points at the author store', () => {
    const file = configFile('custom.json', { environment: 'dev' });
    expect(() => run('set', ['privateKey', KEY])).toThrow(UsageError);
    // The message is the whole value of the rejection: two commands, no doc needed.
    expect(() => run('set', ['privateKey', KEY])).toThrow(/s2s author new/);
    expect(() => run('set', ['privateKey', KEY])).toThrow(/s2s author switch/);
    // nothing written
    expect(readConfigFile(file)).toEqual({ environment: 'dev' });
  });
});

describe('config unset privateKey', () => {
  it('removes a stranded key from the custom file and leaves the rest alone', () => {
    const file = configFile('custom.json', {
      privateKey: KEY,
      environment: 'dev',
      lit: { usageKey: 'lu' },
    });
    const sink = run('unset', ['privateKey']);

    expect(readConfigFile(file)).toEqual({ environment: 'dev', lit: { usageKey: 'lu' } });
    expect(sink.results[0]).toEqual({
      action: 'config.unset',
      key: 'privateKey',
      file,
      local: false,
    });
    expect(sink.warnings).toEqual([]);
  });

  it('works on the project file with --local', () => {
    // `--local` resolves the project file from the cwd, so the cwd has to be
    // the temp dir — restored in afterEach.
    process.chdir(dir);
    const project = join(dir, '.s2sconfig.json');
    writeFileSync(project, JSON.stringify({ privateKey: OTHER }), 'utf8');

    const sink = run('unset', ['privateKey', '--local']);

    expect(readConfigFile(project)).toEqual({});
    expect(sink.results[0]).toMatchObject({ action: 'config.unset', key: 'privateKey', local: true });
  });

  it('warns and creates nothing when the target file has no key', () => {
    const file = join(dir, 's2s', 'custom.json');

    const sink = run('unset', ['privateKey']);

    expect(existsSync(file)).toBe(false);
    expect(sink.warnings[0]).toMatch(/nothing to remove/);
  });

  it('names the legacy file when that is where the copy lives', () => {
    const legacy = configFile('config.json', { privateKey: KEY });
    const custom = configFile('custom.json', { environment: 'dev' });

    const sink = run('unset', ['privateKey']);

    // The legacy file is read-only for this CLI: reported, not silently kept.
    expect(readConfigFile(legacy)).toEqual({ privateKey: KEY });
    expect(readConfigFile(custom)).toEqual({ environment: 'dev' });
    expect(sink.warnings[0]).toContain(legacy);
    expect(sink.warnings[0]).toMatch(/by hand/);
  });

  it('also names a legacy copy when it removed the custom one', () => {
    configFile('config.json', { privateKey: KEY });
    const custom = configFile('custom.json', { privateKey: OTHER });

    const sink = run('unset', ['privateKey']);

    expect(readConfigFile(custom)).toEqual({});
    expect(sink.warnings[0]).toMatch(/legacy config file .*also holds a privateKey/);
  });
});

describe('config unset for a real key', () => {
  it('still prunes the leaf and reports the file', () => {
    const file = configFile('custom.json', { pinning: { pinata: { key: 'jwt' } } });

    const sink = run('unset', ['pinning.pinata.key']);

    // the empty `pinning.pinata` object is pruned with it
    expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toEqual({});
    expect(sink.results[0]).toMatchObject({
      action: 'config.unset',
      key: 'pinning.pinata.key',
      file,
    });
  });

  it('rejects an unknown key', () => {
    configFile('custom.json');
    expect(() => run('unset', ['nope.nope'])).toThrow(/unknown config key/);
  });
});
