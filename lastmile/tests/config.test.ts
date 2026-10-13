/**
 * Tests for the lastmile config.toml loader.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, configDefaults, type AppConfig } from '../src/config.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'lastmile-config-test-'));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a TOML snippet to a temp file and return its path. */
function writeConfig(toml: string): string {
  const p = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, toml, 'utf8');
  return p;
}

const VALID_MINIMAL = `
rpc_urls = ["https://rpc-a.example", "https://rpc-b.example"]

[[magazines]]
domain        = "s3ntiment.com"
ens_name      = "s3ntiment.eth"
nginx_include = "/etc/nginx/lastmile/s3ntiment.conf"
state_dir     = "/var/lib/lastmile/s3ntiment"
`;

describe('configDefaults', () => {
  it('returns the documented defaults with empty arrays', () => {
    const d = configDefaults();
    expect(d.magazines).toEqual([]);
    expect(d.rpcUrls).toEqual([]);
    expect(d.kuboApiUrl).toBe('http://127.0.0.1:25011');
    expect(d.kuboGatewayUrl).toBe('http://127.0.0.1:28080');
    expect(d.pollIntervalMs).toBe(60_000);
    expect(d.rollbackDepth).toBe(5);
    expect(d.nginxTestCmd).toBe('sudo -n nginx -t');
    expect(d.nginxReloadCmd).toBe('sudo -n nginx -s reload');
    expect(d.alertCmd).toBeNull();
  });
});

describe('loadConfig', () => {
  it('loads a minimal valid config with defaults filled in', () => {
    const cfg = loadConfig(writeConfig(VALID_MINIMAL));
    expect(cfg.rpcUrls).toEqual(['https://rpc-a.example', 'https://rpc-b.example']);
    expect(cfg.kuboApiUrl).toBe('http://127.0.0.1:25011');
    expect(cfg.kuboGatewayUrl).toBe('http://127.0.0.1:28080');
    expect(cfg.pollIntervalMs).toBe(60_000);
    expect(cfg.rollbackDepth).toBe(5);
    expect(cfg.nginxTestCmd).toBe('sudo -n nginx -t');
    expect(cfg.nginxReloadCmd).toBe('sudo -n nginx -s reload');
    expect(cfg.alertCmd).toBeNull();
    expect(cfg.magazines).toHaveLength(1);
    const m = cfg.magazines[0];
    expect(m.domain).toBe('s3ntiment.com');
    expect(m.ensName).toBe('s3ntiment.eth');
    expect(m.nginxInclude).toBe('/etc/nginx/lastmile/s3ntiment.conf');
    expect(m.stateDir).toBe('/var/lib/lastmile/s3ntiment');
    expect(m.kuboGatewayUrl).toBe('http://127.0.0.1:28080'); // falls back to top-level
    expect(m.kuboApiUrl).toBeUndefined(); // no override, no field
  });

  it('applies top-level overrides and per-magazine overrides', () => {
    const cfg = loadConfig(
      writeConfig(`
rpc_urls = ["https://rpc-a.example", "https://rpc-b.example"]
kubo_api_url     = "http://127.0.0.1:9999"
kubo_gateway_url = "http://127.0.0.1:8888"
poll_interval_ms = 1234
rollback_depth   = 3
nginx_test_cmd   = "nginx -t"
nginx_reload_cmd = "nginx -s reload"
alert_cmd        = "/usr/local/bin/alert.sh"

[[magazines]]
domain            = "s3ntiment.com"
ens_name          = "s3ntiment.eth"
nginx_include     = "/etc/nginx/lastmile/s3ntiment.conf"
state_dir         = "/var/lib/lastmile/s3ntiment"
kubo_gateway_url  = "http://127.0.0.1:7777"
kubo_api_url      = "http://127.0.0.1:6666"

[[magazines]]
domain        = "other.com"
ens_name      = "other.eth"
nginx_include = "/etc/nginx/lastmile/other.conf"
state_dir     = "/var/lib/lastmile/other"
`),
    );
    expect(cfg.kuboApiUrl).toBe('http://127.0.0.1:9999');
    expect(cfg.kuboGatewayUrl).toBe('http://127.0.0.1:8888');
    expect(cfg.pollIntervalMs).toBe(1234);
    expect(cfg.rollbackDepth).toBe(3);
    expect(cfg.nginxTestCmd).toBe('nginx -t');
    expect(cfg.nginxReloadCmd).toBe('nginx -s reload');
    expect(cfg.alertCmd).toBe('/usr/local/bin/alert.sh');

    expect(cfg.magazines).toHaveLength(2);
    const [a, b] = cfg.magazines;
    // Overridden per-magazine gateway + api.
    expect(a.kuboGatewayUrl).toBe('http://127.0.0.1:7777');
    expect(a.kuboApiUrl).toBe('http://127.0.0.1:6666');
    // No overrides -> fall back to top-level for gateway; no api field.
    expect(b.kuboGatewayUrl).toBe('http://127.0.0.1:8888');
    expect(b.kuboApiUrl).toBeUndefined();
  });

  it('accepts an empty magazines list', () => {
    const cfg = loadConfig(writeConfig('rpc_urls = ["a", "b"]'));
    expect(cfg.magazines).toEqual([]);
    expect(cfg.rpcUrls).toEqual(['a', 'b']);
  });

  it('throws when rpc_urls is missing', () => {
    expect(() => loadConfig(writeConfig(''))).toThrow(/rpc_urls/);
  });

  it('throws when there is only one rpc_url', () => {
    expect(() => loadConfig(writeConfig('rpc_urls = ["https://only.example"]'))).toThrow(
      /at least 2/,
    );
  });

  it('throws when poll_interval_ms is not a positive number', () => {
    const cfg = writeConfig(`rpc_urls = ["a", "b"]\npoll_interval_ms = "fast"`);
    expect(() => loadConfig(cfg)).toThrow(/poll_interval_ms/);
  });

  it('throws when rollback_depth is zero or negative', () => {
    expect(() => loadConfig(writeConfig('rpc_urls = ["a", "b"]\nrollback_depth = 0'))).toThrow(
      /rollback_depth/,
    );
  });

  it('throws on an unknown top-level key, naming it', () => {
    expect(() => loadConfig(writeConfig('rpc_urls = ["a", "b"]\nspeed = 100'))).toThrow(
      /unknown config key "speed"/,
    );
  });

  it('throws on an unknown magazine key, naming it', () => {
    expect(() =>
      loadConfig(
        writeConfig(`
rpc_urls = ["a", "b"]
[[magazines]]
domain = "x.com"
ens_name = "x.eth"
nginx_include = "/x.conf"
state_dir = "/x"
colour = "red"
`),
      ),
    ).toThrow(/unknown key "colour"/);
  });

  it('throws on a domain without a dot', () => {
    expect(() =>
      loadConfig(
        writeConfig(`rpc_urls = ["a", "b"]
[[magazines]]
domain = "localhost"
ens_name = "x.eth"
nginx_include = "/x.conf"
state_dir = "/x"
`),
      ),
    ).toThrow(/domain/);
  });

  it('throws on an ens_name that does not end in .eth', () => {
    expect(() =>
      loadConfig(
        writeConfig(`rpc_urls = ["a", "b"]
[[magazines]]
domain = "x.com"
ens_name = "x.com"
nginx_include = "/x.conf"
state_dir = "/x"
`),
      ),
    ).toThrow(/\.eth/);
  });

  it('throws on a missing required magazine field', () => {
    expect(() =>
      loadConfig(
        writeConfig(`rpc_urls = ["a", "b"]
[[magazines]]
domain = "x.com"
ens_name = "x.eth"
nginx_include = "/x.conf"
`),
      ),
    ).toThrow(/state_dir/);
  });

  it('throws on an unreadable file', () => {
    expect(() => loadConfig(join(tmpDir, 'does-not-exist.toml'))).toThrow(/cannot read config/);
  });

  it('throws on invalid TOML', () => {
    expect(() => loadConfig(writeConfig('this is not = toml [[['))).toThrow(/invalid TOML/);
  });

  it('loads the repo own config.example.toml (example lint)', () => {
    const repoExample = join(process.cwd(), 'config.example.toml');
    const cfg: AppConfig = loadConfig(repoExample);
    expect(cfg.rpcUrls.length).toBeGreaterThanOrEqual(2);
    const mag = cfg.magazines.find((m) => m.domain === 's3ntiment.com');
    expect(mag).toBeDefined();
    expect(mag?.ensName).toBe('s3ntiment.eth');
  });
});
