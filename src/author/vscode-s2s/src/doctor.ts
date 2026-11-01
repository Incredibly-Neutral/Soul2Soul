/**
 * `s2s.doctor` — the primary UX for a remote-only extension.
 *
 * A remote window fails in ways a local one does not: the binary may be installed and still
 * invisible (extension host PATH ≠ login PATH), and `s2s.bin` may be set in a scope this window
 * never reads. Doctor reports facts and the binary's own guidance; it never invents setup steps
 * and it never prints a config *value* (the keys include secrets).
 */

import * as os from 'node:os';

import * as vscode from 'vscode';

import { configArgs, versionArgs } from './argv';
import { projectRoot } from './commands';
import { parseResult } from './parse';
import { config as settingsConfig, describeScope, settingsScope } from './settings';
import { resolveBinary, run, BinaryNotFoundError } from './spawn';
import type { State } from './state';
import * as ui from './ui';

/** Version probe timeout — the binary answers `--version` locally, no network. */
const VERSION_TIMEOUT_MS = 5000;

function describeRemote(remote: string | undefined): string[] {
  if (remote === undefined)
    return ['window: local (this extension is designed for remote windows)'];

  const hint: Record<string, string> = {
    'ssh-remote': 'the binary must be installed on the SSH host, not on your laptop',
    wsl: 'the binary must be installed inside the WSL distribution',
    'dev-container': 'the binary must be in the container image or on a persisted mount',
    'attached-container': 'the binary must be in the attached container',
  };

  return [
    `window: remote (${remote})`,
    `  ${hint[remote] ?? 'the binary must be installed on this host, not locally'}`,
  ];
}

function settingScope(scope: vscode.Uri | undefined): string {
  const inspected = settingsConfig(scope).inspect<string>('bin');
  if (inspected === undefined) return 'unknown';
  // Real precedence: folder > workspace > user. The old code reported a workspace value first
  // even when a folder value was the one in force.
  if (inspected.workspaceFolderValue !== undefined) return 'workspace folder settings';
  if (inspected.workspaceValue !== undefined) return 'workspace settings';
  if (inspected.globalValue !== undefined) return 'user settings (this machine/remote only)';
  return 'unset — using the login-shell probe';
}

/**
 * The directory the config-file / env / key report describes. SPEC §s2s.doctor forbids describing
 * the wrong project: the open note's project root → the first workspace folder → `os.homedir()`.
 * Never `vscode.env.appRoot` (a `~/.vscode-server/bin/<commit>` path) and never `process.cwd()`
 * (the extension host's cwd, which is the same wrong answer for every project).
 */
function doctorCwd(): string {
  const active = vscode.window.activeTextEditor?.document;
  if (active !== undefined && active.uri.scheme === 'file') return projectRoot(active.uri.fsPath);

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ?? os.homedir();
}

export async function runDoctor(state: State): Promise<void> {
  const scope = settingsScope();
  const config = settingsConfig(scope);
  const cwd = doctorCwd();

  const lines: string[] = [...describeRemote(vscode.env.remoteName), ''];

  const setting = config.get<string>('bin') ?? '';
  const resolved = await resolveBinary({ setting });

  lines.push(
    `binary: ${resolved.bin}`,
    `  resolved via: ${resolved.source}${resolved.probe === undefined ? '' : ` (${resolved.probe})`}`,
    `  s2s.bin is set in: ${settingScope(scope)}`,
    `  settings scope: ${describeScope(scope)}`,
    `  cwd (describes this project): ${cwd}`,
  );

  try {
    const version = await run({
      bin: resolved.bin,
      args: versionArgs(),
      cwd,
      timeoutMs: VERSION_TIMEOUT_MS,
    });

    if (version.timedOut) {
      lines.push(`version: FAILED — --version timed out after ${VERSION_TIMEOUT_MS}ms`);
    } else {
      const parsed = parseResult(version.stdout);

      if (parsed.kind === 'result') {
        const name = parsed.result['name'];
        const value = parsed.result['version'];
        lines.push(`version: ${String(name ?? 's2s')} ${String(value ?? '(unnamed)')}`);
      } else {
        lines.push(`version: unreadable — ${parsed.message}`);
      }
    }
  } catch (error) {
    if (error instanceof BinaryNotFoundError) {
      lines.push(
        `version: FAILED — not found (${
          vscode.env.remoteName === undefined ? 'this machine' : `remote "${vscode.env.remoteName}"`
        })`,
        '  install s2s on this host, or run "s2s: Select Binary…"',
      );
    } else {
      lines.push(`version: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const pathResult = await run({
      bin: resolved.bin,
      args: configArgs('path'),
      cwd,
      timeoutMs: 5000,
    });
    const parsed = parseResult(pathResult.stdout);
    if (pathResult.timedOut) {
      lines.push('', `config file: FAILED — config path timed out after 5000ms`);
    } else if (parsed.kind === 'result' && typeof parsed.result['path'] === 'string') {
      lines.push('', `config file: ${parsed.result['path']}`);
      const env = parsed.result['env'];
      if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
        const record = env as Record<string, unknown>;
        lines.push(
          `  user env:    ${String(record['user'])} (${record['userExists'] === true ? 'present' : 'missing'})`,
        );
        lines.push(`  project env: ${String(record['project'] ?? '(none)')}`);
      }
    } else {
      // Same rule as the version block: never print nothing and leave the reason unstated.
      lines.push('', `config file: unreadable — ${parsed.message}`);
    }
  } catch {
    lines.push('', 'config file: unreadable (binary not runnable yet)');
  }

  try {
    const list = await run({ bin: resolved.bin, args: configArgs('list'), cwd, timeoutMs: 10000 });
    const parsed = parseResult(list.stdout);
    if (list.timedOut) {
      lines.push('', 'config keys: FAILED — config list timed out after 10000ms');
    } else if (parsed.kind === 'result' && typeof parsed.result['config'] === 'object') {
      const values = parsed.result['config'] as Record<string, unknown>;
      const names = Object.keys(values).sort();
      lines.push(
        '',
        `config keys set (${names.length}, names only):`,
        ...names.map((name) => `  ${name}`),
      );
    } else {
      lines.push('', `config keys: unreadable — ${parsed.message}`);
    }
  } catch {
    lines.push('', 'config keys: unreadable');
  }

  lines.push(
    '',
    `stdout recoveries this session: ${state.stats.contaminated} (${state.stats.runs} results)`,
    `failed runs this session: ${state.stats.failures}`,
  );

  if (vscode.env.remoteName !== undefined) {
    lines.push(
      '',
      'reminder: in a remote window, `s2s.bin` must be in workspace settings or the remote user',
      'settings. A value in local user settings is never read here.',
    );
  }

  for (const line of lines) ui.log(line);
  ui.output().show(true);
}
