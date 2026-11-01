/**
 * The ONLY module that knows a binary exists.
 *
 * Two jobs: find `s2s` on this (usually *remote*) host, and run it. No `vscode` import — the
 * resolver and the runner are plain node, so the fake-binary test harness can exercise both.
 *
 * Why the resolver exists at all: in a VS Code remote window the extension host's PATH is not
 * the login shell's PATH (no `.bashrc`, no `nvm`, no profile-injected `~/.local/bin`), so a
 * binary that is plainly installed is invisible. See SPEC-author-vscode §Remote workspaces.
 */

import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface RunOptions {
  bin: string;
  args: readonly string[];
  cwd: string;
  /** Aborted → SIGTERM to the child; the promise still resolves. */
  signal?: AbortSignal;
  /** Called per complete stderr line, live. stderr is never parsed. */
  onStderr?: (line: string) => void;
  /** 0 / undefined = no timeout. The progress notification is the timeout. */
  timeoutMs?: number;
  /** Override the SIGTERM→SIGKILL grace period (test seam). Defaults to `KILL_GRACE_MS`. */
  killGraceMs?: number;
}

/** How long a child gets to honour SIGTERM before SIGKILL, and before we settle regardless. */
export const KILL_GRACE_MS = 2000;

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The user cancelled (progress token / AbortSignal). */
  aborted: boolean;
  /** We killed it on `timeoutMs` — distinct from a cancel and from a crash (spec exit table). */
  timedOut: boolean;
  durationMs: number;
}

/** The binary is not on this host — a distinct, named failure, never a bare ENOENT. */
export class BinaryNotFoundError extends Error {
  constructor(readonly bin: string) {
    super(`s2s binary not found ("${bin}") — install it on this host, or set s2s.bin`);
    this.name = 'BinaryNotFoundError';
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === 'object' && value !== null && 'code' in value;
}

export function run(options: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const { bin, args, cwd, signal, onStderr, timeoutMs, killGraceMs } = options;

  return new Promise<RunResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let pendingStderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    // Own process group (POSIX): killing the group takes down anything the binary spawned, and
    // guarantees the stdio pipes close so `close` fires. Windows is a non-goal.
    const grouped = process.platform !== 'win32';

    const child = spawnProcess(bin, [...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: grouped,
    });

    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      try {
        if (grouped && pid !== undefined) process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone — the close handler is the source of truth.
      }
    };

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    /**
     * SIGTERM, then SIGKILL if the child lingers — a stuck run must not hold the mutex. If even
     * SIGKILL never produces `close` (a wedged child or a grandchild holding the pipes), settle
     * here anyway: the caller's `finally` runs and the mutex is released no matter what.
     */
    const terminate = (): void => {
      signalGroup('SIGTERM');
      if (killTimer !== undefined) return;
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        settle({
          code: null,
          signal: 'SIGKILL',
          stdout,
          stderr,
          aborted: signal?.aborted === true,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      }, killGraceMs ?? KILL_GRACE_MS);
    };

    function onAbort(): void {
      terminate();
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (onStderr === undefined) return;
      pendingStderr += chunk;
      const lines = pendingStderr.split('\n');
      pendingStderr = lines.pop() ?? '';
      for (const line of lines) if (line.length > 0) onStderr(line);
    });

    child.on('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isErrnoException(error) && error.code === 'ENOENT') {
        reject(new BinaryNotFoundError(bin));
        return;
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    child.on('close', (code, closeSignal) => {
      if (pendingStderr.length > 0) onStderr?.(pendingStderr);
      settle({
        code,
        signal: closeSignal,
        stdout,
        stderr,
        aborted: signal?.aborted === true,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
    }
  });
}

export type BinarySource = 'setting' | 'login-shell' | 'bare';

export interface ResolvedBinary {
  bin: string;
  source: BinarySource;
  /** The probe that found it, e.g. `bash -ilc`. Absent for `setting` / `bare`. */
  probe?: string;
}

export interface ResolveOptions {
  /** `s2s.bin`. Non-empty → used verbatim, no probing. */
  setting?: string;
  /** Name to look for when probing. Defaults to `s2s`. */
  name?: string;
  /** Candidate shells, in order. Defaults to `$SHELL`, `bash`, `/bin/sh`. */
  shells?: readonly string[];
  /** Probe timeout. Defaults to 3s. */
  timeoutMs?: number;
}

const PROBE_FLAGS = ['-lc', '-ilc'] as const;

const cache = new Map<string, ResolvedBinary>();

/** Test seam: forget every cached resolution. */
export function clearResolverCache(): void {
  cache.clear();
}

function defaultShells(): readonly string[] {
  const shell = process.env['SHELL'];
  const candidates = [shell, 'bash', '/bin/sh'];
  return candidates.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * The probe runs an *interactive/login* shell (`bash -ilc`), whose profile may print banners or
 * "last login" mush on stdout. The answer is the **last** non-empty line, and only if it is an
 * absolute path that actually exists — otherwise a banner becomes the resolved binary and every
 * spawn fails ENOENT with a nonsense name.
 */
function probeAnswer(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidate = lines[lines.length - 1];
  if (candidate === undefined) return undefined;
  if (!isAbsolute(candidate)) return undefined;
  try {
    if (!existsSync(candidate)) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

async function probe(
  shell: string,
  flags: string,
  name: string,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const result = await run({
      bin: shell,
      args: [flags, `command -v ${name}`],
      cwd: process.cwd(),
      timeoutMs,
    });
    if (result.code !== 0) return undefined;
    return probeAnswer(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Resolution order (SPEC-author-vscode §Binary discovery):
 * `s2s.bin` → login-shell probe → bare name. Only a **hit** is cached: caching the miss would keep
 * doctor and Select Binary reporting "not found" after the user installs the binary, until the
 * window reloads. A miss is re-probed on the next call (`clearResolverCache()` also exists).
 */
export async function resolveBinary(options: ResolveOptions = {}): Promise<ResolvedBinary> {
  const name = options.name ?? 's2s';
  const timeoutMs = options.timeoutMs ?? 3000;
  const setting = options.setting?.trim();

  if (setting !== undefined && setting.length > 0) {
    return { bin: setting, source: 'setting' };
  }

  const shells = options.shells ?? defaultShells();
  const key = `${name}|${shells.join(',')}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  for (const shell of shells) {
    for (const flags of PROBE_FLAGS) {
      const found = await probe(shell, flags, name, timeoutMs);
      if (found !== undefined) {
        const resolved: ResolvedBinary = {
          bin: found,
          source: 'login-shell',
          probe: `${shell} ${flags}`,
        };
        cache.set(key, resolved);
        return resolved;
      }
    }
  }

  const bare: ResolvedBinary = { bin: name, source: 'bare' };
  return bare;
}
