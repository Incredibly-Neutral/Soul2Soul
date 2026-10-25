import { describe, expect, it } from 'vitest';

import { loadConfig, requireSetting } from '../src/core/config';

describe('loadConfig', () => {
  // Isolate from the developer's real ~/.config/s2s/config.json — a machine with a
  // configured CLI must behave exactly like a blank one for these assertions.
  const noFiles = {
    userConfigPath: '/nonexistent/s2s/config.json',
    projectConfigPath: '/nonexistent/.s2sconfig.json',
  };

  it('applies defaults for an empty environment', () => {
    const config = loadConfig({}, noFiles);
    expect(config.environment).toBe('prod');
    expect(config.kuboGateway).toBe('ipfs.transport-union.dev');
    expect(config.runnerUrl).toBe('https://run.transport-union.dev/run');
    expect(config.rpc).toEqual({ L1: [], L2: [] });
    expect(config.filecoin.chain).toBe('mainnet');
    expect(config.filecoin.rpcUrl).toBe('https://api.node.glif.io/rpc/v1');
    expect(config.bundler.entryPoint).toBe('0.7');
    expect(config.bundler.baseUrl).toBeUndefined();
  });

  it('honors explicit overrides', () => {
    const config = loadConfig({
      S2S_ENV: 'dev',
      S2S_ENTRY_POINT: '0.7',
      S2S_FILECOIN_CHAIN: 'calibration',
      S2S_PRIVATE_KEY: '0xabc',
      LIT_USAGE_KEY: 'lit-usage',
      GITHUB_TOKEN: 'gh-token',
      S2S_KUBO_GATEWAY: 'http://127.0.0.1:5001',
      S2S_BUNDLER_URL: 'https://bundler.example',
      S2S_PAYMASTER_URL: 'https://paymaster.example',
    });
    expect(config.environment).toBe('dev');
    expect(config.bundler.entryPoint).toBe('0.7');
    expect(config.filecoin.chain).toBe('calibration');
    expect(config.privateKey).toBe('0xabc');
    expect(config.litUsageKey).toBe('lit-usage');
    expect(config.githubToken).toBe('gh-token');
    expect(config.kuboGateway).toBe('http://127.0.0.1:5001');
    expect(config.bundler.baseUrl).toBe('https://bundler.example');
    expect(config.bundler.paymasterUrl).toBe('https://paymaster.example');
  });

  it('parses comma-separated RPC lists with a fallback chain', () => {
    const config = loadConfig({ S2S_RPC_L1: 'a, b , c', BASE_RPC_URL: 'z' });
    expect(config.rpc.L1).toEqual(['a', 'b', 'c']);
    expect(config.rpc.L2).toEqual(['z']);
  });

  it('derives per-chain Pimlico endpoints from a bare API key', async () => {
    const { bundlerEndpoints } = await import('../src/core/config');
    const config = loadConfig({ S2S_PIMLICO_KEY: 'pk_123' }, noFiles);
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=pk_123',
      paymasterUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=pk_123',
    });
    // Same key, different chain → different endpoint (one key, not one URL).
    expect(bundlerEndpoints(config, 1)?.bundlerUrl).toBe(
      'https://api.pimlico.io/v2/1/rpc?apikey=pk_123',
    );
  });

  it('lets an explicit bundler URL win and drops sponsorship unless asked', async () => {
    const { bundlerEndpoints } = await import('../src/core/config');
    const config = loadConfig({ S2S_BUNDLER_URL: 'https://bundler.example' }, noFiles);
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://bundler.example',
      paymasterUrl: undefined,
    });
    expect(bundlerEndpoints(loadConfig({}, noFiles), 8453)).toBeUndefined();
  });

  it('reads LIT_* and S2S_GITHUB_TOKEN aliases', () => {
    const config = loadConfig({ LIT_ACCOUNT_KEY: 'la', LIT_USAGE_KEY: 'lu', S2S_GITHUB_TOKEN: 'gt' });
    expect(config.litAccountKey).toBe('la');
    expect(config.litUsageKey).toBe('lu');
    expect(config.githubToken).toBe('gt');
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
