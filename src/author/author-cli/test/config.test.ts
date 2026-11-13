// ============================================================================
// `loadConfig` — the layer merge.
//
// Everything here runs on explicit paths, never the developer's real
// ~/.config/s2s: a machine with a configured CLI must behave exactly like a
// blank one for these assertions.
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // Both ends, or the failover the render pipeline relies on is gone.
    const config = loadConfig({ S2S_RPC_L1: 'a, b , c', S2S_RPC_L2: 'y, z' }, nowhere);
    expect(config.rpc.l1).toEqual(['a', 'b', 'c']);
    expect(config.rpc.l2).toEqual(['y', 'z']);
  });

  it('puts a lone explicit endpoint at the head of its chain, keeping the fallbacks', () => {
    // One endpoint is a preference, not a replacement: the public/Alchemy/Infura
    // failover behind it is what keeps a single flaky RPC from failing a render.
    const explicit = loadConfig({ MAINNET_RPC_URL: 'https://mine.example' }, nowhere);
    expect(explicit.rpc.l1[0]).toBe('https://mine.example');
    expect(explicit.rpc.l1.length).toBeGreaterThan(1);
    expect(explicit.rpc.l1).toContain('https://eth.llamarpc.com');
    // and the other chain is untouched
    expect(explicit.rpc.l2).not.toContain('https://mine.example');

    const lone = loadConfig({ S2S_RPC_L1: 'https://only-l1.example' }, nowhere);
    expect(lone.rpc.l1[0]).toBe('https://only-l1.example');
    expect(lone.rpc.l1.length).toBeGreaterThan(1);
    expect(lone.rpc.l2).not.toContain('https://only-l1.example');
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

  it('carries nothing from one call into the next', () => {
    // The bottom layers are module constants (the builtin floor, the cached
    // defaults file) and the env layer writes leaves into the merged map. If a
    // merge aliased a label entry instead of copying it, one call's env would
    // become every later call's default.
    expect(loadConfig({ S2S_KUBO_GATEWAY: 'first.example' }, nowhere).ipfs.primary?.url).toBe(
      'first.example',
    );
    expect(loadConfig({}, nowhere).ipfs.primary?.url).toBe('ipfs.transport-union.dev');
    expect(loadConfig({}, nowhere).ipfs.primary?.key).toBeUndefined();
  });
});

describe('layer precedence', () => {
  const env = {};

  it('orders env > project > custom > legacy > defaults > builtin', () => {
    const paths = {
      ...nowhere,
      defaultsPath: file('defaults.json', {
        environment: 'dev',
        lit: { usageKey: 'from-defaults' },
      }),
      legacyConfigPath: file('legacy.json', {
        litUsageKey: 'from-legacy',
        ensRegistry: 'legacy-ens',
      }),
      userConfigPath: file('custom.json', {
        lit: { usageKey: 'from-custom' },
        ens: { registry: 'custom-ens' },
      }),
      projectConfigPath: file('.s2sconfig.json', { lit: { usageKey: 'from-project' } }),
    };
    const config = loadConfig(env, paths);
    expect(config.lit.usageKey).toBe('from-project');
    // custom beats legacy for a key both of them set
    expect(config.ens.registry).toBe('custom-ens');
    expect(config.environment).toBe('dev');

    expect(loadConfig({ LIT_USAGE_KEY: 'from-env' }, paths).lit.usageKey).toBe('from-env');
  });

  it('carries the encrypt action CID through every lit layer', () => {
    // A CID is not a secret and not a URL, so it merges like any text leaf: the
    // CLI needs it set, or the encrypt path refuses (LitService has no inline
    // code to fall back to).
    const paths = {
      ...nowhere,
      userConfigPath: file('custom.json', { lit: { encryptActionCid: 'bafyfromfile' } }),
    };
    expect(loadConfig({}, paths).lit.encryptActionCid).toBe('bafyfromfile');
    expect(loadConfig({ LIT_ENCRYPT_ACTION_CID: 'bafyfromenv' }, paths).lit.encryptActionCid).toBe(
      'bafyfromenv',
    );
    expect(loadConfig({}, nowhere).lit.encryptActionCid).toBeUndefined();
  });

  it('keeps the lower layer credential when the higher entry names only a gateway', () => {
    // Provider identity is the ONLY isolation rule: the custom entry names the
    // same provider, so its gateway merges onto the default JWT. Blanking the
    // key here would silently stop the backup pins for a working install.
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
    expect(config.pinning).toEqual([
      { provider: 'pinata', key: 'default-jwt', url: 'mine.example' },
    ]);
  });

  it('merges a label entry field by field when the provider is unchanged', () => {
    // `s2s config set ipfs.kubo.key …` writes a credential and nothing else; the
    // gateway has to come from the layer below or the token resolves to nothing.
    const config = loadConfig(
      {},
      {
        ...nowhere,
        userConfigPath: file('custom.json', { ipfs: { kubo: { key: 'kubo-token' } } }),
      },
    );
    expect(config.ipfs.primary).toEqual({
      provider: 'kubo',
      url: 'ipfs.transport-union.dev',
      key: 'kubo-token',
    });
    // The credential-only entry is not a second gateway.
    expect(config.ipfs.entries).toHaveLength(1);
  });

  it('keeps the lower layer\'s sibling when the higher layer sets one field', () => {
    // A legacy pinataGateway must survive `config set pinning.pinata.key`.
    const config = loadConfig(
      {},
      {
        ...nowhere,
        legacyConfigPath: file('legacy.json', {
          pinataJwt: 'old-jwt',
          pinataGateway: 'pinata.example',
        }),
        userConfigPath: file('custom.json', { pinning: { pinata: { key: 'new-jwt' } } }),
      },
    );
    expect(config.pinning).toEqual([
      { provider: 'pinata', key: 'new-jwt', url: 'pinata.example' },
    ]);
  });

  it('replaces the entry whole when the higher layer names another provider', () => {
    const config = loadConfig(
      {},
      {
        ...nowhere,
        defaultsPath: file('defaults.json', {
          ipfs: { kubo: { provider: 'kubo', url: 'default.example', key: 'default-token' } },
        }),
        userConfigPath: file('custom.json', {
          ipfs: { kubo: { provider: 'other', url: 'mine.example' } },
        }),
      },
    );
    // No mixing across providers: the kubo token must not ride along.
    expect(config.ipfs.primary).toEqual({ provider: 'other', url: 'mine.example' });
  });

  it('merges singletons field by field across layers', () => {
    const config = loadConfig(
      {},
      {
        ...nowhere,
        defaultsPath: file('defaults.json', {
          paymaster: { key: 'default-key', url: 'default-url' },
        }),
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
        defaultsPath: file('defaults.json', {
          ipfs: { kubo: { provider: 'kubo', url: 'd.example' } },
        }),
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
    const config = loadConfig(
      {},
      { ...nowhere, defaultsPath: join(process.cwd(), 'defaults.json') },
    );
    expect(config.ipfs.primary?.url).toBe('ipfs.transport-union.dev');
    expect(config.pinning).toEqual([]);
    expect(config.filecoin.chain).toBe('mainnet');
  });
});

describe('unset markers', () => {
  it('lets a custom null clear a value a lower layer still supplies', () => {
    const paths = {
      ...nowhere,
      legacyConfigPath: file('legacy.json', {
        pinataJwt: 'legacy-jwt',
        pinataGateway: 'pinata.example',
      }),
      userConfigPath: file('custom.json', { pinning: { pinata: { key: null } } }),
    };
    const config = loadConfig({}, paths);
    // The tombstone clears the legacy token; the sibling still resolves, and an
    // unset key is ABSENT (not `''`, which would read as a credential in list).
    expect(configKeyValue('pinning.pinata.key', {}, paths)).toBeUndefined();
    expect(config.pinning).toEqual([{ provider: 'pinata', url: 'pinata.example' }]);
  });

  it('clears a whole label when the marker sits on the label', () => {
    const paths = {
      ...nowhere,
      defaultsPath: file('defaults.json', {
        ipfs: {
          kubo: { provider: 'kubo', url: 'default.example' },
          mine: { provider: 'custom', url: 'mine.example' },
        },
      }),
      userConfigPath: file('custom.json', { ipfs: { kubo: null } }),
    };
    expect(loadConfig({}, paths).ipfs.entries.map((entry) => entry.url)).toEqual(['mine.example']);
  });

  it('lets a higher layer beat a marker below it', () => {
    const paths = {
      ...nowhere,
      userConfigPath: file('custom.json', { pinning: { pinata: { key: null } } }),
      projectConfigPath: file('project.json', {
        pinning: { pinata: { key: 'project-jwt' } },
      }),
    };
    expect(loadConfig({}, paths).pinning).toEqual([{ provider: 'pinata', key: 'project-jwt' }]);
  });

  it('does not let a label marker wipe a sibling a higher layer sets', () => {
    const paths = {
      ...nowhere,
      defaultsPath: file('defaults.json', {
        ipfs: { kubo: { provider: 'kubo', url: 'default.example' } },
      }),
      userConfigPath: file('custom.json', { ipfs: { kubo: null } }),
      projectConfigPath: file('project.json', { ipfs: { kubo: { url: 'project.example' } } }),
    };
    expect(loadConfig({}, paths).ipfs.primary).toEqual({
      provider: 'kubo',
      url: 'project.example',
    });
  });

  it('does not let a file tombstone silence the env', () => {
    const paths = {
      ...nowhere,
      userConfigPath: file('custom.json', { pinning: { pinata: { key: null } } }),
    };
    // The env layer sits above the files and is not a file statement.
    expect(loadConfig({ S2S_PINATA_JWT: 'env-jwt' }, paths).pinning).toEqual([
      { provider: 'pinata', key: 'env-jwt' },
    ]);
  });
});

describe('the path seams', () => {
  it('pins every layer, defaults included, when any path is given', () => {
    const defaultsPath = file('defaults.json', {
      ipfs: { kubo: { provider: 'kubo', url: 'env-named.example' } },
    });
    const config = loadConfig(
      { S2S_DEFAULTS_FILE: defaultsPath },
      {
        userConfigPath: file('custom.json', {}),
        projectConfigPath: join(dir, 'project.json'),
        legacyConfigPath: join(dir, 'legacy.json'),
        authorsPath: join(dir, 'authors.json'),
      },
    );
    // No `defaultsPath` ⇒ the compiled-in floor, never the file the env names:
    // a caller that pins one path pins the whole set.
    expect(config.ipfs.primary?.url).toBe('ipfs.transport-union.dev');
  });

  it('resolves the standard locations with the env the caller passed', () => {
    mkdirSync(join(dir, 's2s'), { recursive: true });
    writeFileSync(
      join(dir, 's2s', 'custom.json'),
      JSON.stringify({ lit: { usageKey: 'from-xdg' } }),
      'utf8',
    );
    // Same env for the paths as for the layers, or a test (or a wrapper with a
    // relocated XDG) reads the developer's real ~/.config/s2s.
    expect(loadConfig({ XDG_CONFIG_HOME: dir }, {}).lit.usageKey).toBe('from-xdg');
  });
});

describe('the signing key', () => {
  /**
   * A `privateKey` a config file may still hold (installs that predate the
   * author store, or a key kept next to the rest of the settings). It resolves
   * BELOW the store, reports `project`/`user`, and warns exactly once per file.
   */
  const keyFile = (name: string, privateKey: string): string =>
    file(name, { privateKey, lit: { usageKey: 'from-same-file' } });

  it('falls back to a file key below the store: project > custom > legacy', () => {
    const paths = {
      ...nowhere,
      projectConfigPath: keyFile('.s2sconfig.json', `0x${'1'.repeat(64)}`),
      userConfigPath: keyFile('custom.json', `0x${'2'.repeat(64)}`),
      legacyConfigPath: keyFile('legacy.json', `0x${'3'.repeat(64)}`),
    };
    const fromProject = loadConfig({}, paths);
    expect(fromProject.privateKey).toBe(`0x${'1'.repeat(64)}`);
    expect(fromProject.author).toEqual({ name: undefined, safe: undefined, source: 'project' });

    const fromCustom = loadConfig({}, { ...paths, projectConfigPath: join(dir, 'absent.json') });
    expect(fromCustom.privateKey).toBe(`0x${'2'.repeat(64)}`);
    expect(fromCustom.author).toEqual({ name: undefined, safe: undefined, source: 'user' });

    const fromLegacy = loadConfig(
      {},
      {
        ...paths,
        projectConfigPath: join(dir, 'absent.json'),
        userConfigPath: join(dir, 'absent-too.json'),
      },
    );
    // The old flat config.json IS the user layer; it was `source: 'user'` before.
    expect(fromLegacy.privateKey).toBe(`0x${'3'.repeat(64)}`);
    expect(fromLegacy.author).toEqual({ name: undefined, safe: undefined, source: 'user' });
  });

  it('still lets the env and the store win over a file key', () => {
    const paths = {
      ...nowhere,
      userConfigPath: keyFile('custom.json', `0x${'2'.repeat(64)}`),
      authorsPath: file('authors.json', {
        active: 'zomi',
        authors: { zomi: { privateKey: `0x${'c'.repeat(64)}`, safe: '0xSafe' } },
      }),
    };
    expect(loadConfig({}, paths).author).toEqual({ name: 'zomi', safe: '0xSafe', source: 'store' });
    expect(loadConfig({ S2S_PRIVATE_KEY: `0x${'e'.repeat(64)}` }, paths).author).toEqual({
      name: undefined,
      safe: undefined,
      source: 'env',
    });
  });

  it('normalizes a bare-hex file key like every other key', () => {
    const paths = { ...nowhere, userConfigPath: keyFile('custom.json', '4'.repeat(64)) };
    expect(loadConfig({}, paths).privateKey).toBe(`0x${'4'.repeat(64)}`);
  });

  it('warns once per file, on stderr, and says how to retire it', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });

    try {
      const path = keyFile('custom.json', `0x${'5'.repeat(64)}`);
      const paths = { ...nowhere, userConfigPath: path };
      // `config list` + every `config get` reload the config; it must not repeat.
      loadConfig({}, paths);
      loadConfig({}, paths);

      expect(writes).toHaveLength(1);
      const warning = writes[0] ?? '';
      expect(warning).toMatch(/deprecated/);
      expect(warning).toContain(path);
      expect(warning).toMatch(/s2s author new/);
      expect(warning).toMatch(/s2s config unset privateKey/);

      // A key the env or the store supplies is not deprecated: nothing said.
      writes.length = 0;
      loadConfig({ S2S_PRIVATE_KEY: `0x${'e'.repeat(64)}` }, paths);
      expect(writes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('says how to retire the key, in one grammatical sentence', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });

    try {
      const paths = {
        ...nowhere,
        legacyConfigPath: keyFile('legacy.json', `0x${'6'.repeat(64)}`),
      };
      loadConfig({}, paths);
      const warning = writes[0] ?? '';
      // The legacy branch cannot name a command, so it names the edit — and the
      // sentence has to survive that substitution (it used to splice into
      // "then remove it with delete the … line by hand").
      expect(warning).toContain('then remove it by hand');
      expect(warning).toMatch(/delete the `privateKey` line/);
      expect(warning).not.toMatch(/with (delete|by hand)/);
    } finally {
      spy.mockRestore();
    }
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

  it('treats an explicit bundler URL with no Pimlico key as no sponsorship', () => {
    // The regression this guards: folding the two URLs into one leaf made the
    // bundler double as the paymaster, so a userOp went to a bundler endpoint
    // as if it were a paymaster and failed where `main` ran it unsponsored.
    const config = loadConfig({ S2S_BUNDLER_URL: 'https://bundler.example' }, nowhere);
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://bundler.example',
      paymasterUrl: undefined,
    });
  });

  it('keeps the derived Pimlico paymaster behind an explicit bundler', () => {
    const config = loadConfig(
      { S2S_PIMLICO_KEY: 'pk_123', S2S_BUNDLER_URL: 'https://bundler.example' },
      nowhere,
    );
    // A different bundler says nothing about who pays: the key still does.
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://bundler.example',
      paymasterUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=pk_123',
    });
  });

  it('lets an explicit paymaster URL override only the paymaster role', () => {
    const config = loadConfig(
      { S2S_PIMLICO_KEY: 'pk_123', S2S_PAYMASTER_URL: 'https://paymaster.example' },
      nowhere,
    );
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=pk_123',
      paymasterUrl: 'https://paymaster.example',
    });
  });

  it('keeps the two env vars independent when both are set', () => {
    const config = loadConfig(
      { S2S_BUNDLER_URL: 'https://bundler.example', S2S_PAYMASTER_URL: 'https://paymaster.example' },
      nowhere,
    );
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://bundler.example',
      paymasterUrl: 'https://paymaster.example',
    });
  });

  it('maps the two legacy flat keys onto their own leaves', () => {
    // `bundlerUrl` + `paymasterUrl` used to share a destination, so the later
    // key won and the user's real bundler was silently dropped.
    const config = loadConfig(
      {},
      {
        ...nowhere,
        legacyConfigPath: file('legacy.json', {
          bundlerUrl: 'https://bundler.example',
          paymasterUrl: 'https://paymaster.example',
        }),
      },
    );
    expect(bundlerEndpoints(config, 8453)).toEqual({
      bundlerUrl: 'https://bundler.example',
      paymasterUrl: 'https://paymaster.example',
    });
  });

  it('is undefined without a key or an explicit endpoint', () => {
    expect(bundlerEndpoints(loadConfig({}, nowhere), 8453)).toBeUndefined();
  });
});

describe('the defaults layer', () => {
  // No `defaultsPath`: the defaults layer then comes from `loadDefaults(env)`,
  // i.e. `S2S_DEFAULTS_FILE` or the file that ships with the CLI. The other
  // three layers stay pinned to the temp dir so the developer's real config
  // cannot leak into the assertions.
  const layers = () => ({
    userConfigPath: join(dir, 'custom.json'),
    projectConfigPath: join(dir, '.s2sconfig.json'),
    legacyConfigPath: join(dir, 'legacy.json'),
    authorsPath: join(dir, 'authors.json'),
  });

  it('reads a pinned defaults file as the layer under everything else', () => {
    const defaultsPath = file('defaults.json', {
      environment: 'dev',
      lit: { usageKey: 'from-defaults' },
      ipfs: { kubo: { provider: 'kubo', url: 'shipped.example' } },
    });

    // An explicit path pins the whole set (finding 10), defaults included, so
    // the file is named directly rather than through S2S_DEFAULTS_FILE.
    const config = loadConfig({}, { ...layers(), defaultsPath });

    expect(config.environment).toBe('dev');
    expect(config.lit.usageKey).toBe('from-defaults');
    expect(config.ipfs.primary?.url).toBe('shipped.example');
  });

  it('still yields a usable config when the defaults file is gone', () => {
    const config = loadConfig({}, { ...layers(), defaultsPath: join(dir, 'gone.json') });
    // The compiled-in floor (BUILTIN_FILE_CONFIG, core/configschema.ts): the
    // public gateway and the public Filecoin RPC, i.e. "no configuration".
    expect(config.ipfs.primary?.url).toBe('ipfs.transport-union.dev');
    expect(config.filecoin.rpcUrl).toBe('https://api.node.glif.io/rpc/v1');
    expect(config.environment).toBe('prod');
  });

  it('lets a custom label replace a default label whole, field by field for singletons', () => {
    const defaultsPath = file('defaults.json', {
      pinning: { pinata: { provider: 'pinata', key: 'default-jwt', url: 'default.example' } },
      paymaster: { key: 'default-key', url: 'default-bundler' },
    });
    writeFileSync(
      join(dir, 'custom.json'),
      JSON.stringify({
        pinning: { pinata: { url: 'mine.example' } },
        paymaster: { key: 'my-key' },
      }),
      'utf8',
    );

    const config = loadConfig({}, { ...layers(), defaultsPath });

    // The custom entry names only a gateway: the default JWT survives (same
    // provider merges field by field) and the gateway is the custom one.
    expect(config.pinning).toEqual([
      { provider: 'pinata', key: 'default-jwt', url: 'mine.example' },
    ]);
    // A singleton merges: the custom key wins, the default URL survives.
    expect(config.paymaster).toEqual({ key: 'my-key', url: 'default-bundler' });
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
