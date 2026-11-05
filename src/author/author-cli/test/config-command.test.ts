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
import { configKeyValue, loadConfig } from '../src/core/config';
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

function capture(): {
  out: CliOut;
  results: Record<string, unknown>[];
  warnings: string[];
  humans: string[];
} {
  const results: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const humans: string[] = [];
  const out: CliOut = {
    json: true,
    log: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    result: (data: unknown, human?: string) => {
      results.push(data as Record<string, unknown>);
      if (human !== undefined) humans.push(human);
    },
  };
  return { out, results, warnings, humans };
}

function run(action: 'get' | 'list' | 'set' | 'unset', argv: string[]) {
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

  it('writes a marker for a value the builtin floor supplies', () => {
    const file = configFile('custom.json', {});

    run('unset', ['filecoin.rpcUrl']);

    expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toEqual({
      filecoin: { rpcUrl: null },
    });
    expect(configKeyValue('filecoin.rpcUrl')).toBeUndefined();
    // …and the resolver does not put the registry default back: unset means
    // unset, even when the value it replaced came from the compiled-in floor.
    const loaded = loadConfig(
      {},
      { userConfigPath: file, projectConfigPath: '', legacyConfigPath: '', authorsPath: '' },
    );
    expect(loaded.filecoin.rpcUrl).toBe('');
  });

  it('writes an unset marker when a lower layer still supplies the value', () => {
    // Nothing in custom.json to delete, and the value keeps resolving from the
    // read-only legacy file: deleting is not enough, the marker is.
    configFile('config.json', { pinataJwt: 'legacy-jwt' });
    const file = configFile('custom.json', {});

    const sink = run('unset', ['pinning.pinata.key']);

    expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toEqual({
      pinning: { pinata: { key: null } },
    });
    expect(sink.results[0]).toMatchObject({
      action: 'config.unset',
      key: 'pinning.pinata.key',
      tombstone: true,
    });
    // …and the value really is gone from the effective config.
    expect(configKeyValue('pinning.pinata.key')).toBeUndefined();
  });

  it('writes a marker when the target holds a copy and a lower layer holds another', () => {
    configFile('config.json', { pinataJwt: 'legacy-jwt' });
    const file = configFile('custom.json', { pinning: { pinata: { key: 'custom-jwt' } } });

    const sink = run('unset', ['pinning.pinata.key']);

    // Deleting the custom copy would reveal the legacy one: the marker is what
    // makes the revocation stick all the way down.
    expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toEqual({
      pinning: { pinata: { key: null } },
    });
    expect(sink.results[0]).toMatchObject({ tombstone: true });
    expect(configKeyValue('pinning.pinata.key')).toBeUndefined();
  });

  it('leaves no marker when nothing below supplies the value', () => {
    const file = configFile('custom.json', { pinning: { pinata: { key: 'jwt' } } });

    const sink = run('unset', ['pinning.pinata.key']);

    expect(readConfigFile(file)).toEqual({});
    expect(sink.results[0]).not.toHaveProperty('tombstone');
  });

  it('creates no custom.json on a machine that never had one', () => {
    // Nothing supplies this leaf anywhere: a delete is a no-op, and a no-op
    // must not leave an empty custom file behind (same rule as a privateKey
    // unset).
    const file = join(dir, 's2s', 'custom.json');

    const sink = run('unset', ['pinning.filebase.key']);

    expect(existsSync(file)).toBe(false);
    expect(sink.warnings).toEqual([]);
  });

  it('does not write a marker when a higher layer supplies the value', () => {
    // A tombstone can only suppress layers BELOW the file it is written into.
    // With the project file holding the value, a null in custom.json would do
    // nothing while the result said the key was gone — and for a secret that
    // is a false "I removed it".
    process.chdir(dir);
    writeFileSync(
      join(dir, '.s2sconfig.json'),
      JSON.stringify({ paymaster: { key: 'PR0JECTKEY' } }),
      'utf8',
    );
    const file = configFile('custom.json', {});

    const sink = run('unset', ['paymaster.key']);

    expect(readConfigFile(file)).toEqual({});
    expect(sink.results[0]).toMatchObject({ suppliedBy: 'project' });
    expect(sink.results[0]).not.toHaveProperty('tombstone');
    expect(sink.warnings[0]).toContain('.s2sconfig.json');
    expect(sink.warnings[0]).toMatch(/--local/);
    // …and the value really is still in effect, which is what it said.
    expect(configKeyValue('paymaster.key')).toBe('PR0JECTKEY');
  });

  it('does not write a marker when the env supplies the value, and names the var', () => {
    vi.stubEnv('S2S_GITHUB_TOKEN', 'gh-token');
    const file = configFile('custom.json', {});

    const sink = run('unset', ['github.token']);

    expect(readConfigFile(file)).toEqual({});
    expect(sink.results[0]).toMatchObject({ suppliedBy: 'env' });
    expect(sink.warnings[0]).toContain('S2S_GITHUB_TOKEN');
    expect(configKeyValue('github.token')).toBe('gh-token');
  });

  it('still removes a duplicate in the target while the project layer wins', () => {
    // The copy in custom.json is real litter; deleting it cannot touch the
    // project file, so the delete is honest on its own (no marker).
    process.chdir(dir);
    writeFileSync(
      join(dir, '.s2sconfig.json'),
      JSON.stringify({ lit: { usageKey: 'project-usage' } }),
      'utf8',
    );
    const file = configFile('custom.json', { lit: { usageKey: 'custom-usage' } });

    const sink = run('unset', ['lit.usageKey']);

    expect(readConfigFile(file)).toEqual({});
    expect(sink.results[0]).toMatchObject({ suppliedBy: 'project' });
    expect(configKeyValue('lit.usageKey')).toBe('project-usage');
  });

  it('rejects a prototype segment instead of walking onto Object.prototype', () => {
    configFile('custom.json', {});

    expect(() => run('set', ['ipfs.__proto__.url', 'evil.example'])).toThrow(/unknown config key/);
    expect(() => run('unset', ['ipfs.__proto__.url'])).toThrow(/unknown config key/);
    expect(({} as Record<string, unknown>).url).toBeUndefined();
  });

  it('refuses entryPoint, which is env-only', () => {
    const file = configFile('custom.json', {});

    expect(() => run('set', ['entryPoint', '0.6'])).toThrow(UsageError);
    expect(() => run('set', ['entryPoint', '0.6'])).toThrow(/S2S_ENTRY_POINT/);
    // A file value would never be read — so nothing is written.
    expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toEqual({});
  });

  it('warns when a credential rides in a URL written to the project file', () => {
    process.chdir(dir);
    configFile('custom.json', {});
    const url = 'https://api.pimlico.io/v2/8453/rpc?apikey=pk_live_secret';

    const sink = run('set', ['paymaster.url', url, '--local']);

    expect(sink.warnings[0]).toMatch(/credential/);
    expect(sink.warnings[0]).toMatch(/\.s2sconfig\.json/);
  });

  it('does not warn about a plain URL', () => {
    process.chdir(dir);
    configFile('custom.json', {});

    const sink = run('set', ['paymaster.url', 'https://bundler.example', '--local']);

    expect(sink.warnings).toEqual([]);
  });

  it('masks a query-string credential in get and list', () => {
    const url = 'https://api.pimlico.io/v2/8453/rpc?apikey=pk_live_secret';
    configFile('custom.json', { paymaster: { url } });

    const gotten = run('get', ['paymaster.url']);
    expect(gotten.results[0]).toMatchObject({
      key: 'paymaster.url',
      value: 'https://api.pimlico.io/v2/8453/rpc?apikey=********',
    });
    expect(JSON.stringify(gotten.results[0])).not.toContain('pk_live_secret');

    const listed = run('list', []);
    expect(JSON.stringify(listed.results[0])).not.toContain('pk_live_secret');
    expect(JSON.stringify(listed.results[0])).toContain('api.pimlico.io');
  });

  it('masks a credential in a label-map URL, in get and list', () => {
    // `pinning.*.url` / `ipfs.*.url` carry tokens too (a Pinata gateway with
    // `?key=`, a Kubo endpoint with `?token=`): they are `url: true` leaves.
    configFile('custom.json', {
      ipfs: { kubo: { url: 'https://gw.example/api?token=S3CRETTOKEN' } },
      pinning: { pinata: { url: 'https://pinata.example/api?key=S3CRETKEY' } },
    });

    for (const [key, endpoint] of [
      ['ipfs.kubo.url', 'https://gw.example/api?token=********'],
      ['pinning.pinata.url', 'https://pinata.example/api?key=********'],
    ] as const) {
      const gotten = run('get', [key]);
      expect(gotten.results[0]).toMatchObject({ key, value: endpoint });
    }

    const listed = run('list', []);
    const payload = JSON.stringify(listed.results[0]);
    expect(payload).not.toContain('S3CRETTOKEN');
    expect(payload).not.toContain('S3CRETKEY');
    // …the endpoint stays readable, so the table still says which gateway it is.
    expect(payload).toContain('gw.example');
    expect(payload).toContain('pinata.example');
  });

  it('warns about a credential in a label-map URL written to the project file', () => {
    process.chdir(dir);
    configFile('custom.json', {});

    const sink = run('set', ['ipfs.kubo.url', 'https://gw.example/?token=S3', '--local']);

    expect(sink.warnings[0]).toMatch(/credential/);
    expect(sink.warnings[0]).toMatch(/\.s2sconfig\.json/);
  });

  it('does not invent a masked secret for a label that has no credential', () => {
    // `maskSecret('')` used to return `********`, so `list` claimed a credential
    // for a gateway-only label while `get` said (unset).
    configFile('custom.json', { pinning: { pinata: { provider: 'pinata', url: 'mine.example' } } });

    expect(run('get', ['pinning.pinata.key']).results[0]).toMatchObject({ value: null });
    const listed = run('list', []);
    expect(JSON.stringify(listed.results[0])).not.toContain('pinning.pinata.key');
    expect(listed.humans[0] ?? '').not.toContain('pinning.pinata.key');
  });
});
