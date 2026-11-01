import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BinaryNotFoundError, clearResolverCache, resolveBinary, run } from '../src/spawn';
import { offerResult, uploadResult } from './fixtures';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-fake-'));
  clearResolverCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeBinary(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

const echoArgv = (payload: string): string =>
  `echo "$@" > "${join(dir, 'argv.txt')}"\nprintf '%s' '${payload}'\nexit 0`;

describe('run — exit codes', () => {
  it('captures stdout and exit 0', async () => {
    const bin = fakeBinary('s2s-ok', echoArgv(JSON.stringify(uploadResult)));
    const result = await run({ bin, args: ['author', 'upload', '/a.md', '--json'], cwd: dir });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'upload' });
    expect(result.aborted).toBe(false);
  });

  it('passes argv through in order, note absolute, --json last', async () => {
    const bool = fakeBinary('s2s-argv', echoArgv('{}'));
    await run({
      bin: bool,
      args: [
        'author',
        'offer',
        '/home/joera/notes/a.md',
        '--publication',
        'p.soul2soul.eth',
        '--json',
      ],
      cwd: dir,
    });
    expect(readFileSync(join(dir, 'argv.txt'), 'utf8').trim()).toBe(
      'author offer /home/joera/notes/a.md --publication p.soul2soul.eth --json',
    );
  });

  it.each([1, 2, 3])('reports exit %i without rejecting', async (code) => {
    const bin = fakeBinary(
      `s2s-${code}`,
      `printf '%s' '{"ok":false,"error":"boom"}'\nexit ${code}`,
    );
    const result = await run({ bin, args: ['author', 'upload', '/a.md', '--json'], cwd: dir });
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: 'boom' });
  });

  it('returns empty stdout as empty, not as an error', async () => {
    const bin = fakeBinary('s2s-silent', 'exit 0');
    const result = await run({ bin, args: ['--version', '--json'], cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('handles a large stdout without truncation', async () => {
    const bin = fakeBinary('s2s-big', `head -c 600000 /dev/zero | tr '\\0' 'x'`);
    const result = await run({ bin, args: ['author', 'upload', '/a.md', '--json'], cwd: dir });
    expect(result.stdout.length).toBe(600000);
  });
});

describe('run — stderr', () => {
  it('streams complete stderr lines and never mixes them into stdout', async () => {
    const bin = fakeBinary(
      's2s-stderr',
      `printf 'uploading…\\npinning (best effort)\\n' >&2\nprintf '%s' '${JSON.stringify(offerResult)}'`,
    );

    const lines: string[] = [];
    const result = await run({
      bin,
      args: ['author', 'offer', '/a.md', '--json'],
      cwd: dir,
      onStderr: (line) => lines.push(line),
    });

    expect(lines).toEqual(['uploading…', 'pinning (best effort)']);
    expect(result.stdout).not.toContain('uploading');
    expect(result.stderr).toContain('uploading');
  });

  it('flushes a final stderr line with no trailing newline', async () => {
    const bin = fakeBinary('s2s-stderr-tail', `printf 'no newline' >&2\nprintf '{}'`);
    const lines: string[] = [];
    await run({ bin, args: [], cwd: dir, onStderr: (line) => lines.push(line) });
    expect(lines).toEqual(['no newline']);
  });
});

describe('run — missing binary and cancellation', () => {
  it('raises BinaryNotFoundError, never a bare ENOENT', async () => {
    await expect(
      run({ bin: join(dir, 'not-here'), args: ['--json'], cwd: dir }),
    ).rejects.toBeInstanceOf(BinaryNotFoundError);
  });

  it('names the binary in the message', async () => {
    await expect(run({ bin: join(dir, 'nope'), args: [], cwd: dir })).rejects.toThrow(
      /install it on this host/,
    );
  });

  it('kills the child on abort and still resolves', async () => {
    const bin = fakeBinary('s2s-slow', 'sleep 5\nprintf \'{"action":"upload"}\'');
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 60);

    const result = await run({
      bin,
      args: ['author', 'upload', '/a.md', '--json'],
      cwd: dir,
      signal: controller.signal,
    });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.aborted).toBe(true);
  });

  it('treats timeoutMs as a kill, not a rejection — and names it as a timeout', async () => {
    const bin = fakeBinary('s2s-timeout', 'sleep 5');
    const result = await run({ bin, args: [], cwd: dir, timeoutMs: 60 });
    expect(result.timedOut).toBe(true);
    // Not a user cancel: nothing aborted the signal.
    expect(result.aborted).toBe(false);
    expect(result.code === null || result.code > 0).toBe(true);
  });

  it('SIGKILLs a child that ignores SIGTERM and still settles', async () => {
    const bin = fakeBinary('s2s-stubborn', "trap '' TERM\nwhile :; do :; done");
    const started = Date.now();
    const result = await run({ bin, args: [], cwd: dir, timeoutMs: 100, killGraceMs: 100 });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.timedOut).toBe(true);
  });

  it('never reports a timeout as a user cancel', async () => {
    const bin = fakeBinary('s2s-timeout-abort', 'sleep 5');
    const controller = new AbortController();
    const result = await run({
      bin,
      args: [],
      cwd: dir,
      signal: controller.signal,
      timeoutMs: 60,
    });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });
});

describe('resolveBinary', () => {
  it('uses the setting verbatim without probing', async () => {
    const resolved = await resolveBinary({ setting: join(dir, 's2s') });
    expect(resolved).toEqual({ bin: join(dir, 's2s'), source: 'setting' });
  });

  it('ignores a blank setting', async () => {
    const resolved = await resolveBinary({ setting: '   ', name: 's2s-absent-xyz', shells: [] });
    expect(resolved.source).toBe('bare');
  });

  it('falls back to the bare name when nothing is found', async () => {
    const resolved = await resolveBinary({ name: 's2s-absent-xyz' });
    expect(resolved).toEqual({ bin: 's2s-absent-xyz', source: 'bare' });
  });

  it('caches a hit', async () => {
    const real = fakeBinary('s2s-hit', 'exit 0');
    const shell = fakeBinary('shell-hit', `echo '${real}'`);

    const first = await resolveBinary({ name: 's2s-hit', shells: [shell], timeoutMs: 2000 });
    const second = await resolveBinary({ name: 's2s-hit', shells: [shell], timeoutMs: 2000 });

    expect(first.source).toBe('login-shell');
    expect(second).toBe(first);
  });

  it('does not cache a miss — a freshly installed binary is found without a reload', async () => {
    const late = join(dir, 's2s-late');
    const shell = fakeBinary('shell-late', `if [ -x '${late}' ]; then echo '${late}'; fi`);

    const first = await resolveBinary({ name: 's2s-late', shells: [shell], timeoutMs: 2000 });
    expect(first).toEqual({ bin: 's2s-late', source: 'bare' });

    writeFileSync(late, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(late, 0o755);

    const second = await resolveBinary({ name: 's2s-late', shells: [shell], timeoutMs: 2000 });
    expect(second.bin).toBe(late);
    expect(second.source).toBe('login-shell');
  });
});

describe('resolveBinary — probe output', () => {
  it('takes the last non-empty line, so a profile banner is not the answer', async () => {
    const real = fakeBinary('s2s-real', 'exit 0');
    const shell = fakeBinary(
      'shell-banner',
      `echo 'welcome to my dotfiles'\necho 'last login: yesterday on pts/0'\necho '${real}'`,
    );

    const resolved = await resolveBinary({ name: 's2s-any', shells: [shell], timeoutMs: 2000 });
    expect(resolved).toEqual({ bin: real, source: 'login-shell', probe: `${shell} -lc` });
  });

  it('rejects an answer that is not an absolute path', async () => {
    const shell = fakeBinary('shell-relative', `echo 's2s-not-a-path'`);
    const resolved = await resolveBinary({ name: 's2s-any', shells: [shell], timeoutMs: 2000 });
    expect(resolved.source).toBe('bare');
  });

  it('rejects an absolute answer that does not exist', async () => {
    const shell = fakeBinary('shell-ghost', `echo '${join(dir, 'not-installed')}'`);
    const resolved = await resolveBinary({ name: 's2s-any', shells: [shell], timeoutMs: 2000 });
    expect(resolved.source).toBe('bare');
  });

  it('rejects empty probe output', async () => {
    const shell = fakeBinary('shell-silent', 'exit 0');
    const resolved = await resolveBinary({ name: 's2s-any', shells: [shell], timeoutMs: 2000 });
    expect(resolved.source).toBe('bare');
  });
});
