import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEnvFiles, projectEnvPath, userEnvPath } from '../src/lib/env';

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 's2s-env-home-'));
  cwd = mkdtempSync(join(tmpdir(), 's2s-env-cwd-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function writeUserEnv(body: string): string {
  const dir = join(home, '.config', 's2s');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.env');
  writeFileSync(file, body);
  return file;
}

function writeProjectEnv(body: string): string {
  const file = join(cwd, '.env');
  writeFileSync(file, body);
  return file;
}

describe('env file paths', () => {
  it('defaults the user env file to ~/.config/s2s/.env', () => {
    expect(userEnvPath({}, '/home/someone')).toBe('/home/someone/.config/s2s/.env');
  });

  it('honors XDG_CONFIG_HOME', () => {
    expect(userEnvPath({ XDG_CONFIG_HOME: '/xdg/config' }, '/home/someone')).toBe(
      '/xdg/config/s2s/.env',
    );
  });

  it('ignores a blank XDG_CONFIG_HOME', () => {
    expect(userEnvPath({ XDG_CONFIG_HOME: '   ' }, '/home/someone')).toBe(
      '/home/someone/.config/s2s/.env',
    );
  });

  it('puts the project env file in the cwd', () => {
    expect(projectEnvPath('/work/notes')).toBe('/work/notes/.env');
  });
});

describe('loadEnvFiles', () => {
  it('loads the user env file when there is no repo/project .env (the end-user case)', () => {
    const file = writeUserEnv('S2S_PRIVATE_KEY=0xabc\nS2S_KUBO_TOKEN=tok\n');
    const env: NodeJS.ProcessEnv = {};

    const loaded = loadEnvFiles({ env, cwd, home });

    expect(loaded.user).toBe(file);
    expect(loaded.project).toBeNull();
    expect(env.S2S_PRIVATE_KEY).toBe('0xabc');
    expect(env.S2S_KUBO_TOKEN).toBe('tok');
  });

  it('never overrides the real process environment', () => {
    writeUserEnv('S2S_PRIVATE_KEY=from-file\n');
    const env: NodeJS.ProcessEnv = { S2S_PRIVATE_KEY: 'from-shell' };

    loadEnvFiles({ env, cwd, home });

    expect(env.S2S_PRIVATE_KEY).toBe('from-shell');
  });

  it('lets a cwd .env override the user file but not the shell', () => {
    writeUserEnv('S2S_RUNNER_URL=user\nS2S_KUBO_GATEWAY=user-gw\n');
    writeProjectEnv('S2S_RUNNER_URL=project\n');
    const env: NodeJS.ProcessEnv = { S2S_KUBO_GATEWAY: 'shell-gw' };

    loadEnvFiles({ env, cwd, home });

    expect(env.S2S_RUNNER_URL).toBe('project');
    expect(env.S2S_KUBO_GATEWAY).toBe('shell-gw');
  });

  it('ignores an empty value in a higher layer rather than blocking the lower one', () => {
    writeUserEnv('S2S_LIT_USAGE_KEY=from-user\n');
    const env: NodeJS.ProcessEnv = { S2S_LIT_USAGE_KEY: '' };

    loadEnvFiles({ env, cwd, home });

    expect(env.S2S_LIT_USAGE_KEY).toBe('from-user');
  });

  it('reports both paths when both files exist', () => {
    const user = writeUserEnv('A=1\n');
    const project = writeProjectEnv('B=2\n');

    expect(loadEnvFiles({ env: {}, cwd, home })).toEqual({ project, user });
  });

  it('is a no-op with no files present', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(loadEnvFiles({ env, cwd, home })).toEqual({ project: null, user: null });
    expect(env).toEqual({});
  });

  it('does not crash on a malformed env file', () => {
    writeUserEnv('NOT AN ENV LINE\n@@@\n');
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadEnvFiles({ env, cwd, home })).not.toThrow();
  });

  it('is idempotent', () => {
    writeUserEnv('S2S_PRIVATE_KEY=0xabc\n');
    const env: NodeJS.ProcessEnv = {};

    loadEnvFiles({ env, cwd, home });
    loadEnvFiles({ env, cwd, home });

    expect(env.S2S_PRIVATE_KEY).toBe('0xabc');
  });
});

describe('hexKey normalization', () => {
  it('prefixes a bare 64-hex private key', async () => {
    const { hexKey } = await import('../src/core/config');
    expect(hexKey('54'.repeat(32))).toBe(`0x${'54'.repeat(32)}`);
  });

  it('leaves an already-prefixed key alone', async () => {
    const { hexKey } = await import('../src/core/config');
    expect(hexKey(`0x${'ab'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('does not touch malformed or absent values', async () => {
    const { hexKey } = await import('../src/core/config');
    expect(hexKey(undefined)).toBeUndefined();
    expect(hexKey('not-a-key')).toBe('not-a-key');
    expect(hexKey('abcd')).toBe('abcd');
  });

  it('reachable through loadConfig from a file value', async () => {
    const { loadConfig } = await import('../src/core/config');
    const dir = mkdtempSync(join(tmpdir(), 's2s-hex-'));
    const userConfigPath = join(dir, 'config.json');
    writeFileSync(userConfigPath, JSON.stringify({ privateKey: '11'.repeat(32) }));
    const cfg = loadConfig({}, { userConfigPath, projectConfigPath: join(dir, 'none.json') });
    expect(cfg.privateKey).toBe(`0x${'11'.repeat(32)}`);
    rmSync(dir, { recursive: true, force: true });
  });
});
