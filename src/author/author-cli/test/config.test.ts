// ============================================================================
// `loadConfig` — the layer merge.
//
// Everything here runs on explicit paths, never the developer's real
// ~/.config/s2s: a machine with a configured CLI must behave exactly like a
// blank one for these assertions.
// ============================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bundlerEndpoints,
  configKeyValue,
  configSections,
  loadConfig,
  requireSetting,
} from '../src/core/config';

const nowhere = {
  userConfigPath: '/nonexistent/s2s/custom.json',
  projectConfigPath: '/nonexistent/.s2sconfig.json',
  legacyConfigPath: '/nonexistent/s2s/config.json',
  defaultsPath: '/nonexistent/s2s/defaults.json',
  authorsPath: '/nonexistent/s2s/authors.json',
};

/** A throwaway directory of config files, torn down after each test. */
let dir = '';
const file = (name: string, data: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data), 'utf8');
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('applies the builtin defaults with no files and no env', () => {
    const config = loadConfig({}, nowhere);
    expect(config.environment).toBe('prod');
    expect(config.entryPoint).toBe('0.7');
    expect(config.ipfs.primary?.url).toBe('ipfs.transport-union.dev');
    expect(config.ipfs.entries).toHaveLength(1);
    expect(config.pinning).toEqual([]);
    expect(config.runnerUrl).toBe('https://run.transport-union.dev/run');
    expect(config.filecoin.chain).toBe('mainnet');
    expect(config.filecoin.rpcUrl).toBe('https://api.node.glif.io/rpc/v1');
    expect(config.paymaster).toEqual({ key: undefined, url: undefined });
    expect(config.privateKey).toBeUndefined();
    expect(config.author).toBeUndefined();
    // Not empty: the keyless public endpoints are the floor of the chain.
    expect(config.rpc.l1[0]).toBe('https://eth.llamarpc.com');
    expect(config.rpc.l2[0]).toBe('https://mainnet.base.org');
  });

  it('honors explicit env overrides across every section', () => {
    const config = loadConfig(
      {
        S2S_ENV: 'dev',
        S2S_FILECOIN_CHAIN: 'calibration',
        S2S_PRIVATE_KEY: '0xabc',
        LIT_ACCOUNT_KEY: 'la',
        LIT_USAGE_KEY: 'lit-usage',
        GITHUB_TOKEN: 'gh-token',
        S2S_KUBO_GATEWAY: 'http://127.0.0.1:5001',
        S2S_KUBO_TOKEN: 'kubo-token',
        S2S_PINATA_JWT: 'pinata-jwt',
        S2S_PINATA_GATEWAY: 'pinata.example',
        S2S_FILEBASE_TOKEN: 'filebase-token',
        S2S_PIMLICO_KEY: 'pk_123',
        S2S_ENS_REGISTRY: '0x00000000000000000000000000000000000000e1',
        S2S_RUNNER_URL: 'https://runner.example',
      },
      nowhere,
    );
    expect(config.environment).toBe('dev');
    expect(config.filecoin.chain).toBe('calibration');
    expect(config.lit).toEqual({ accountKey: 'la', usageKey: 'lit-usage' });
    expect(config.github.token).toBe('gh-token');
    expect(config.ipfs.primary).toEqual({
      provider: 'kubo',
      url: 'http://127.0.0.1:5001',
      key: 'kubo-token',
    });
    expect(config.pinning).toEqual([
      { provider: 'pinata', key: 'pinata-jwt', url: 'pinata.example' },
      { provider: 'filebase', key: 'filebase-token' },
    ]);
    expect(config.paymaster.key).toBe('pk_123');
    expect(config.ens.registry).toBe('0x00000000000000000000000000000000000000e1');
    expect(config.runnerUrl).toBe('https://runner.example');
  });

  it('parses comma-separated RPC lists and lets them replace the chain', () => {
    const config = loadConfig({ S2S_RPC_L1: 'a, b , c', BASE_RPC_URL: 'z' }, nowhere);
    expect(config.rpc.l1).toEqual(['a', 'b', 'c']);
    expect(config.rpc.l2).toEqual(['z']);
  });

  it('derives the failover chain from an Alchemy/DRPC key in the file', () => {
    const config = loadConfig(
      {},
      { ...nowhere, userConfigPath: file('custom.json', { rpc: { drpc: { key: 'dkey' } } }) },
    );
    expect(config.rpc.l1[0]).toBe('https://lb.drpc.live/eth/dkey');
    expect(config.rpc.l2[0]).toBe('https://lb.drpc.live/base/dkey');
  });

  it('falls back to the builtin default on an unknown enum value', () => {
    expect(loadConfig({ S2S_ENV: 'staging' }, nowhere).environment).toBe('prod');
    expect(loadConfig({ S2S_ENTRY_POINT: '0.9' }, nowhere).entryPoint).toBe('0.7');
    expect(loadConfig({ S2S_ENTRY_POINT: '0.6' }, nowhere).entryPoint).toBe('0.6');
  });

  it('reads LIT_* and S2S_GITHUB_TOKEN aliases', () => {
    const config = loadConfig(
      { LIT_ACCOUNT_KEY: 'la', LIT_USAGE_KEY: 'lu', S2S_GITHUB_TOKEN: 'gt' },
      nowhere,
    );
    expect(config.lit.accountKey).toBe('la');
    expect(config.lit.usageKey).toBe('lu');
    expect(config.github.token).toBe('gt');
  });
});

describe('layer precedence', () => {
  const env = {};

  it('orders env > project > custom > legacy > defaults > builtin', () => {
    const paths = {
      ...nowhere,
      defaultsPath: file('defaults.json', { environment: 'dev', lit: { usageKey: 'from-defaults' } }),
      legacyConfigPath: file('legacy.json', { litUsageKey: 'from-legacy', ensRegistry: 'legacy-ens' }),
      userConfigPath: file('custom.json', { lit: { usageKey: 'from-custom' }, ens: { registry: 'custom-ens' } }),
      projectConfigPath: file('.s2sconfig.json', { lit: { usageKey: 'from-project' } }),
    };
    const config = loadConfig(env, paths);
    expect(config.lit.usageKey).toBe('from-project');
    // custom beats legacy for a key both of them set
    expect(config.ens.registry).toBe('custom-ens');
    expect(config.environment).toBe('dev');

    expect(loadConfig({ LIT_USAGE_KEY: 'from-env' }, paths).lit.usageKey).toBe('from-env');
  });

  it('replaces a pinning/ipfs label whole, never field by field', () => {
    const config = loadConfig(
      {},
      {
        ...nowhere,
        defaultsPath: file('defaults.json', {
          pinning: { pinata: { provider: 'pinata', key: 'default-jwt', url: 'default.example' } },
        }),
        userConfigPath: file('custom.json', {
          pinning: { pinata: { provider: 'pinata', url: 'mine.example' } },
        }),
      },
    );
    // The custom entry names only a gateway, so the default JWT must NOT leak in.
    expect(config.pinning).toEqual([{ provider: 'pinata', key: '', url: 'mine.example' }]);
  });

  it('merges singletons field by field across layers', () => {
    const config = loadConfig(
      {},
      {
        ...nowhere,
        defaultsPath: file('defaults.json', { paymaster: { key: 'default-key', url: 'default-url' } }),
        userConfigPath: file('custom.json', { paymaster: { key: 'my-key' } }),
      },
    );
    expect(config.paymaster).toEqual({ key: 'my-key', url: 'default-url' });
  });

  it('keeps custom labels in insertion order, custom ones first', () => {
    const config = loadConfig(
      {},
      {
        ...nowhere,
        defaultsPath: file('defaults.json', { ipfs: { kubo: { provider: 'kubo', url: 'd.example' } } }),
        userConfigPath: file('custom.json', {
          ipfs: { mine: { provider: 'custom', url: 'mine.example' } },
        }),
      },
    );
    expect(config.ipfs.entries.map((entry) => entry.url)).toEqual(['mine.example', 'd.example']);
    expect(config.ipfs.primary?.url).toBe('mine.example');
  });

  it('reads the shipped defaults.json exactly as it ships', () => {
    // The real file, not a fixture: a broken defaults.json is a release bug.
    const config = loadConfig({}, { ...nowhere, defaultsPath: join(process.cwd(), 'defaults.json') });
    expect(config.ipfs.primary?.url).toBe('ipfs.transport-union.dev');
    expect(config.pinning).toEqual([]);
    expect(config.filecoin.chain).toBe('mainnet');
  });
});

describe('the signing key', () => {
  it('is never read from a config file', () => {
    const config = loadConfig(
      {},
      {
        ...nowhere,
        userConfigPath: file('custom.json', { privateKey: '0xfromfile' }),
        projectConfigPath: file('.s2sconfig.json', { privateKey: '0xfromproject' }),
        legacyConfigPath: file('legacy.json', { privateKey: '0xfromlegacy' }),
      },
    );
    expect(config.privateKey).toBeUndefined();
    expect(config.author).toBeUndefined();
  });

  it('prefers the env and normalizes a bare 64-char key', () => {
    const config = loadConfig(
      { S2S_PRIVATE_KEY: 'a'.repeat(64) },
      {
        ...nowhere,
        authorsPath: file('authors.json', {
          active: 'zomi',
          authors: { zomi: { privateKey: `0x${'b'.repeat(64)}`, safe: '0xSafe' } },
        }),
      },
    );
    expect(config.privateKey).toBe(`0x${'a'.repeat(64)}`);
    expect(config.author).toEqual({ name: undefined, safe: undefined, source: 'env' });
  });

  it('falls back to the active stored author', () => {
    const config = loadConfig(
      {},
      {
        ...nowhere,
        authorsPath: file('authors.json', {
          active: 'zomi',
          authors: { zomi: { privateKey: `0x${'c'.repeat(64)}`, safe: '0xSafe' } },
        }),
      },
    );
    expect(config.privateKey).toBe(`0x${'c'.repeat(64)}`);
    expect(config.author).toEqual({ name: 'zomi', safe: '0xSafe', source: 'store' });
  });
});

describe('bundlerEndpoints', () => {
  it('derives per-chain Pimlico endpoints from a bare API key', () => {
    const config = loadConfig({ S2S_PIMLICO_KEY: 'pk_123' }, nowhere);
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=pk_123',
      paymasterUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=pk_123',
    });
    // Same key, different chain → different endpoint (one key, not one URL).
    expect(bundlerEndpoints(config, 1)?.bundlerUrl).toBe(
      'https://api.pimlico.io/v2/1/rpc?apikey=pk_123',
    );
  });

  it('lets an explicit endpoint win over the derived one', () => {
    const config = loadConfig(
      { S2S_PIMLICO_KEY: 'pk_123', S2S_PAYMASTER_URL: 'https://bundler.example' },
      nowhere,
    );
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://bundler.example',
      paymasterUrl: 'https://bundler.example',
    });
  });

  it('is undefined without a key or an explicit endpoint', () => {
    expect(bundlerEndpoints(loadConfig({}, nowhere), 8453)).toBeUndefined();
  });
});

describe('configKeyValue / configSections', () => {
  // Written per test: the temp dir only exists once `beforeEach` has run.
  const paths = () => ({
    ...nowhere,
    userConfigPath: file('custom.json', {
      pinning: { pinata: { provider: 'pinata', key: 'jwt', url: 'pinata.example' } },
      rpc: { custom: { l1: ['a', 'b'] } },
      github: { token: 'gt' },
    }),
  });

  it('reads a dotted path from the effective config', () => {
    expect(configKeyValue('pinning.pinata.key', {}, paths())).toBe('jwt');
    expect(configKeyValue('pinning.pinata.url', {}, paths())).toBe('pinata.example');
    expect(configKeyValue('environment', {}, paths())).toBe('prod');
    expect(configKeyValue('entryPoint', {}, paths())).toBe('0.7');
    expect(configKeyValue('filecoin.rpcUrl', {}, paths())).toBe('https://api.node.glif.io/rpc/v1');
  });

  it('joins list values with commas, as they are typed', () => {
    expect(configKeyValue('rpc.custom.l1', {}, paths())).toBe('a,b');
  });

  it('is undefined for an unset leaf and for an unknown key', () => {
    expect(configKeyValue('pinning.filebase.key', {}, paths())).toBeUndefined();
    expect(configKeyValue('privateKey', {}, paths())).toBeUndefined();
    expect(configKeyValue('bundler.entryPoint', {}, paths())).toBeUndefined();
  });

  it('exposes the effective nested object for `config list`', () => {
    const sections = configSections({ LIT_USAGE_KEY: 'lu' }, paths());
    expect(sections.entryPoint).toBe('0.7');
    expect(sections.environment).toBe('prod');
    expect(sections.lit).toEqual({ usageKey: 'lu' });
    expect(sections.github).toEqual({ token: 'gt' });
  });
});

describe('requireSetting', () => {
  it('returns the value when present', () => {
    expect(requireSetting('v', 'X')).toBe('v');
  });

  it('throws a clear error when the value is undefined', () => {
    expect(() => {
      requireSetting(undefined, 'S2S_PRIVATE_KEY');
    }).toThrow(/S2S_PRIVATE_KEY/);
  });
});
