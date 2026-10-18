import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, requireSetting, configKeyValue } from '../src/core/config';
import {
  CONFIG_FIELD,
  CONFIG_FIELDS,
  maskSecret,
  readConfigFile,
  writeConfigValue,
} from '../src/core/configfile';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-config-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function paths(): { userConfigPath: string; projectConfigPath: string } {
  return { userConfigPath: join(dir, 'user', 'config.json'), projectConfigPath: join(dir, 'project', '.s2sconfig.json') };
}

describe('config file layer', () => {
  it('covers every setting that loadConfig reads', () => {
    // The registry is the single source of truth: every CliConfig leaf must be
    // reachable via a known key, and defaults must resolve through it.
    const withEmpty = loadConfig({}, paths());
    expect(withEmpty.kuboGateway).toBe('ipfs.transport-union.dev');
    expect(withEmpty.runnerUrl).toBe('https://run.transport-union.dev/run');
    expect(withEmpty.filecoin.rpcUrl).toBe('https://api.node.glif.io/rpc/v1');
    expect(withEmpty.bundler.entryPoint).toBe('0.6');
    // Spot-check the sensitive leaves are registry-backed too.
    for (const key of ['privateKey', 'litAccountKey', 'litUsageKey', 'kuboToken']) {
      expect(CONFIG_FIELD[key], key).toBeDefined();
    }
  });

  it('gives defaults when no env and no config file are present', () => {
    const config = loadConfig({}, paths());
    expect(config.environment).toBe('prod');
    expect(config.privateKey).toBeUndefined();
    expect(config.kuboGateway).toBe('ipfs.transport-union.dev');
    expect(config.rpc).toEqual({ L1: [], L2: [] });
  });

  it('precedence: env > project file > user file > default', () => {
    // user file beats default
    writeConfigValue(paths().userConfigPath, 'kuboGateway', 'https://user.example');
    expect(loadConfig({}, paths()).kuboGateway).toBe('https://user.example');

    // project file beats user file
    writeConfigValue(paths().projectConfigPath, 'kuboGateway', 'https://project.example');
    expect(loadConfig({}, paths()).kuboGateway).toBe('https://project.example');

    // env beats both
    expect(loadConfig({ S2S_KUBO_GATEWAY: 'https://env.example' }, paths()).kuboGateway).toBe(
      'https://env.example',
    );
  });

  it('reads list values from the config file as arrays or comma strings', () => {
    writeConfigValue(paths().projectConfigPath, 'rpcL1', ['http://a', 'http://b']);
    expect(loadConfig({}, paths()).rpc.L1).toEqual(['http://a', 'http://b']);

    writeConfigValue(paths().userConfigPath, 'rpcL2', 'http://x,http://y');
    expect(loadConfig({}, paths()).rpc.L2).toEqual(['http://x', 'http://y']);
  });

  it('reads scalar and secret values from the user file', () => {
    writeConfigValue(paths().userConfigPath, 'privateKey', '0xabc123');
    writeConfigValue(paths().userConfigPath, 'githubToken', 'gh-token');
    const config = loadConfig({}, paths());
    expect(config.privateKey).toBe('0xabc123');
    expect(config.githubToken).toBe('gh-token');
  });

  it('normalizes invalid enum values in config files back to defaults', () => {
    writeConfigValue(paths().userConfigPath, 'environment', 'staging');
    writeConfigValue(paths().userConfigPath, 'entryPoint', '0.8');
    const config = loadConfig({}, paths());
    expect(config.environment).toBe('prod');
    expect(config.bundler.entryPoint).toBe('0.6');
  });

  it('configKeyValue resolves a single effective key', () => {
    writeConfigValue(paths().userConfigPath, 'kuboGateway', 'https://user.example');
    expect(configKeyValue('kuboGateway', {}, paths())).toBe('https://user.example');
    expect(configKeyValue('kuboGateway', { S2S_KUBO_GATEWAY: 'https://env.example' }, paths())).toBe(
      'https://env.example',
    );
    expect(configKeyValue('nope', {}, paths())).toBeUndefined();
  });

  it('writeConfigValue merges and unset deletes', () => {
    const file = paths().userConfigPath;
    writeConfigValue(file, 'kuboGateway', 'https://a.example');
    writeConfigValue(file, 'runnerUrl', 'https://run.example');
    expect(readConfigFile(file)).toEqual({
      kuboGateway: 'https://a.example',
      runnerUrl: 'https://run.example',
    });
    writeConfigValue(file, 'kuboGateway', undefined);
    expect(readConfigFile(file)).toEqual({ runnerUrl: 'https://run.example' });
  });

  it('maskSecret hides the body but keeps a hint', () => {
    expect(maskSecret('0123456789abcdef')).toBe('01…cdef');
    expect(maskSecret('short')).toBe('********');
  });
});

describe('requireSetting', () => {
  it('mentions the s2s config command in the error', () => {
    expect(() => {
      requireSetting(undefined, 'S2S_PRIVATE_KEY');
    }).toThrow(/s2s config set/);
  });
});

describe('registry invariants', () => {
  it('has unique keys and unique env name sets across fields', () => {
    const keys = CONFIG_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const envNames = CONFIG_FIELDS.flatMap((f) => f.env);
    expect(new Set(envNames).size).toBe(envNames.length);
  });
});
