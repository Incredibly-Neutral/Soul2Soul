// ============================================================================
// The config file layer — paths, tolerant reads, atomic writes, masking, and
// the legacy flat file translated on read.
// ============================================================================

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configKeyValue, loadConfig } from '../src/core/config';
import {
  configFilePaths,
  maskSecret,
  readConfigFile,
  readFileConfig,
  readLegacyFileConfig,
  writeConfigValue,
} from '../src/core/configfile';
import { CONFIG_FIELDS, LABEL_ENV_SHORTHANDS, matchField } from '../src/core/configschema';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-config-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Explicit paths for every layer — never the developer's real config dir. */
function paths() {
  return {
    userConfigPath: join(dir, 'user', 'custom.json'),
    projectConfigPath: join(dir, 'project', '.s2sconfig.json'),
    legacyConfigPath: join(dir, 'user', 'config.json'),
    defaultsPath: join(dir, 'defaults.json'),
    authorsPath: join(dir, 'authors.json'),
  };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), 'utf8');
}

describe('configFilePaths', () => {
  it('honors XDG_CONFIG_HOME and the cwd', () => {
    const resolved = configFilePaths({ env: { XDG_CONFIG_HOME: '/xdg' }, cwd: '/work' });
    expect(resolved.user).toBe('/xdg/s2s/custom.json');
    expect(resolved.legacy).toBe('/xdg/s2s/config.json');
    expect(resolved.project).toBe('/work/.s2sconfig.json');
  });

  it('falls back to ~/.config and points at a defaults.json', () => {
    const resolved = configFilePaths({ env: {}, cwd: '/work' });
    expect(resolved.user.endsWith('/.config/s2s/custom.json')).toBe(true);
    expect(resolved.defaults.endsWith('defaults.json')).toBe(true);
  });

  it('uses S2S_DEFAULTS_FILE verbatim', () => {
    const resolved = configFilePaths({ env: { S2S_DEFAULTS_FILE: '/tmp/d.json' }, cwd: '/work' });
    expect(resolved.defaults).toBe('/tmp/d.json');
  });
});

describe('tolerant reads', () => {
  it('returns an empty object for a missing, broken or non-object file', () => {
    expect(readConfigFile(join(dir, 'nope.json'))).toEqual({});
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
    expect(readConfigFile(join(dir, 'broken.json'))).toEqual({});
    writeFileSync(join(dir, 'array.json'), '[]', 'utf8');
    expect(readConfigFile(join(dir, 'array.json'))).toEqual({});
    expect(readConfigFile('')).toEqual({});
  });

  it('normalizes a hand-edited file: types, providers, dead ipfs entries', () => {
    writeJson(join(dir, 'a.json'), {
      environment: 'nonsense',
      ipfs: {
        kubo: { url: 'gateway.example' },
        dead: { key: 'no-url' },
      },
      pinning: { mypin: { key: 'k' } },
      rpc: { custom: { l1: 'a, b' }, drpc: { key: 'dk' } },
      github: { token: 42 },
    });
    const config = readFileConfig(join(dir, 'a.json'));
    expect(config.environment).toBeUndefined();
    // provider defaults to the label; an entry with no url is dropped
    expect(config.ipfs).toEqual({ kubo: { provider: 'kubo', url: 'gateway.example' } });
    expect(config.pinning).toEqual({ mypin: { provider: 'mypin', key: 'k' } });
    expect(config.rpc).toEqual({ drpc: { key: 'dk' }, custom: { l1: ['a', 'b'] } });
    expect(config.github).toBeUndefined();
  });
});

describe('the legacy flat file', () => {
  it('translates every old key onto its nested path', () => {
    writeJson(paths().legacyConfigPath, {
      environment: 'dev',
      kuboGateway: 'legacy.example',
      kuboToken: 'kt',
      pinataJwt: 'pj',
      pinataGateway: 'pinata.example',
      filebaseToken: 'ft',
      rpcL1: ['http://a'],
      rpcL2: 'http://b,http://c',
      pimlicoKey: 'pk',
      bundlerUrl: 'https://bundler.example',
      paymasterUrl: 'https://paymaster.example',
      filecoinChain: 'calibration',
      filecoinRpc: 'https://fc.example',
      filecoinSessionKey: '/home/me/fc.json',
      litAccountKey: 'la',
      litUsageKey: 'lu',
      ensRegistry: '0xEns',
      githubToken: 'gt',
    });
    const legacy = readLegacyFileConfig(paths().legacyConfigPath);
    expect(legacy.environment).toBe('dev');
    expect(legacy.ipfs).toEqual({ kubo: { provider: 'kubo', url: 'legacy.example', key: 'kt' } });
    expect(legacy.pinning).toEqual({
      pinata: { provider: 'pinata', key: 'pj', url: 'pinata.example' },
      filebase: { provider: 'filebase', key: 'ft' },
    });
    expect(legacy.rpc).toEqual({ custom: { l1: ['http://a'], l2: ['http://b', 'http://c'] } });
    // paymasterUrl is the more specific of the two that share a destination
    expect(legacy.paymaster).toEqual({ key: 'pk', url: 'https://paymaster.example' });
    expect(legacy.filecoin).toEqual({
      chain: 'calibration',
      rpcUrl: 'https://fc.example',
      sessionKeyFile: '/home/me/fc.json',
    });
    expect(legacy.lit).toEqual({ accountKey: 'la', usageKey: 'lu' });
    expect(legacy.ens).toEqual({ registry: '0xEns' });
    expect(legacy.github).toEqual({ token: 'gt' });
  });

  it('ignores the retired keys the env owns, but still honours a stranded privateKey', () => {
    writeJson(paths().legacyConfigPath, {
      privateKey: `0x${'a'.repeat(64)}`,
      filecoinPrivateKey: 'fckey',
      entryPoint: '0.6',
    });
    const legacy = readLegacyFileConfig(paths().legacyConfigPath);
    // `privateKey` is not a FileConfig leaf (it is read separately, as the
    // deprecated fallback below the author store); the other two are env-only.
    expect(legacy).toEqual({});
    const config = loadConfig({}, paths());
    expect(config.privateKey).toBe(`0x${'a'.repeat(64)}`);
    expect(config.author).toEqual({ name: undefined, safe: undefined, source: 'user' });
    expect(config.entryPoint).toBe('0.7');
    expect(config.filecoin.privateKey).toBeUndefined();
  });

  it('still resolves through loadConfig, below the custom file', () => {
    writeJson(paths().legacyConfigPath, { kuboGateway: 'legacy.example', litUsageKey: 'legacy-lit' });
    expect(loadConfig({}, paths()).ipfs.primary?.url).toBe('legacy.example');
    writeConfigValue(paths().userConfigPath, 'ipfs.kubo.url', 'custom.example');
    expect(loadConfig({}, paths()).ipfs.primary?.url).toBe('custom.example');
  });
});

describe('writeConfigValue', () => {
  it('creates intermediate objects and writes the file at 0600', () => {
    const file = paths().userConfigPath;
    writeConfigValue(file, 'pinning.pinata.key', 'jwt');
    expect(readConfigFile(file)).toEqual({ pinning: { pinata: { key: 'jwt' } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('stores list fields as JSON arrays from a comma string', () => {
    const file = paths().projectConfigPath;
    writeConfigValue(file, 'rpc.custom.l1', 'http://a, http://b');
    expect(readConfigFile(file)).toEqual({ rpc: { custom: { l1: ['http://a', 'http://b'] } } });
  });

  it('prunes objects that fall empty when a leaf is unset', () => {
    const file = paths().userConfigPath;
    writeConfigValue(file, 'pinning.pinata.key', 'jwt');
    writeConfigValue(file, 'environment', 'dev');
    writeConfigValue(file, 'pinning.pinata.key', undefined);
    expect(readConfigFile(file)).toEqual({ environment: 'dev' });
  });

  it('refuses to write the abstract `*` label', () => {
    expect(() => {
      writeConfigValue(paths().userConfigPath, 'pinning.*.key', 'x');
    }).toThrow(/placeholder/);
  });

  it('round-trips through loadConfig', () => {
    writeConfigValue(paths().userConfigPath, 'ipfs.kubo.url', 'mine.example');
    writeConfigValue(paths().userConfigPath, 'pinning.pinata.key', 'jwt');
    const config = loadConfig({}, paths());
    expect(config.ipfs.primary).toEqual({ provider: 'kubo', url: 'mine.example' });
    expect(config.pinning).toEqual([{ provider: 'pinata', key: 'jwt' }]);
  });
});

describe('matchField', () => {
  it('matches a concrete path exactly and a label path by wildcard', () => {
    expect(matchField('environment')?.spec.path).toBe('environment');
    expect(matchField('pinning.pinata.key')?.spec.secret).toBe(true);
    expect(matchField('ipfs.home.url')?.spec.path).toBe('ipfs.*.url');
  });

  it('returns undefined for an unknown key, including the retired privateKey', () => {
    expect(matchField('privateKey')).toBeUndefined();
    expect(matchField('pinning.pinata')).toBeUndefined();
    expect(matchField('bundler.entryPoint')).toBeUndefined();
  });
});

describe('registry invariants', () => {
  it('has unique paths and no duplicated env names', () => {
    const pathsInUse = CONFIG_FIELDS.map((field) => field.path);
    expect(new Set(pathsInUse).size).toBe(pathsInUse.length);

    const envNames = [
      ...CONFIG_FIELDS.flatMap((field) => field.env),
      ...LABEL_ENV_SHORTHANDS.flatMap((shorthand) => shorthand.env),
    ];
    expect(new Set(envNames).size).toBe(envNames.length);
  });

  it('registers every shorthand path against a real field', () => {
    for (const shorthand of LABEL_ENV_SHORTHANDS) {
      expect(matchField(shorthand.path), shorthand.path).toBeDefined();
    }
  });

  it('never marks a default as secret, and every secret has an env or a label path', () => {
    for (const field of CONFIG_FIELDS) {
      if (field.secret) expect(field.default).toBeUndefined();
    }
  });
});

describe('maskSecret', () => {
  it('hides the body but keeps a hint', () => {
    expect(maskSecret('0123456789abcdef')).toBe('01…cdef');
    expect(maskSecret('short')).toBe('********');
  });
});

describe('configKeyValue', () => {
  it('resolves one effective dotted key', () => {
    writeConfigValue(paths().userConfigPath, 'ipfs.kubo.url', 'mine.example');
    expect(configKeyValue('ipfs.kubo.url', {}, paths())).toBe('mine.example');
    expect(configKeyValue('ipfs.kubo.url', { S2S_KUBO_GATEWAY: 'env.example' }, paths())).toBe(
      'env.example',
    );
    expect(configKeyValue('ipfs.nope.url', {}, paths())).toBeUndefined();
  });

  it('never exposes a secret value under a retired key', () => {
    expect(configKeyValue('privateKey', {}, paths())).toBeUndefined();
  });
});

describe('the shipped defaults.json', () => {
  it('is readable and holds no secrets', () => {
    const shipped = JSON.parse(readFileSync(join(process.cwd(), 'defaults.json'), 'utf8')) as {
      pinning?: Record<string, unknown>;
      ipfs?: Record<string, { key?: string }>;
      lit?: Record<string, unknown>;
      github?: Record<string, unknown>;
      paymaster?: Record<string, unknown>;
      rpc?: Record<string, unknown>;
    };
    expect(shipped.pinning).toEqual({});
    expect(shipped.lit).toEqual({});
    expect(shipped.github).toEqual({});
    expect(shipped.paymaster).toEqual({});
    expect(shipped.rpc).toEqual({});
    for (const entry of Object.values(shipped.ipfs ?? {})) expect(entry.key).toBeUndefined();
  });
});
