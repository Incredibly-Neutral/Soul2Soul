/**
 * `s2s.doctor` — the primary UX for a remote-only extension.
 *
 * A remote window fails in ways a local one does not: the binary may be installed and still
 * invisible (extension host PATH ≠ login PATH), and `s2s.bin` may be set in a scope this window
 * never reads. Doctor reports facts and the binary's own guidance; it never invents setup steps
 * and it never prints a config *value* (the keys include secrets).
 */

import * as vscode from 'vscode';

import { configArgs, versionArgs } from './argv';
import { parseResult } from './parse';
import { resolveBinary, run, BinaryNotFoundError } from './spawn';
import type { State } from './state';
import * as ui from './ui';

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

function settingScope(): string {
  const inspected = vscode.workspace.getConfiguration('s2s').inspect<string>('bin');
  if (inspected === undefined) return 'unknown';
  if (inspected.workspaceValue !== undefined) return 'workspace settings';
  if (inspected.workspaceFolderValue !== undefined) return 'workspace folder settings';
  if (inspected.globalValue !== undefined) return 'user settings (this machine/remote only)';
  return 'unset — using the login-shell probe';
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n')[0]?.trim();
  return line === undefined || line.length === 0 ? undefined : line;
}

export async function runDoctor(state: State): Promise<void> {
  const config = vscode.workspace.getConfiguration('s2s');
  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? vscode.env.appRoot ?? process.cwd();

  const lines: string[] = [...describeRemote(vscode.env.remoteName), ''];

  const setting = config.get<string>('bin') ?? '';
  const resolved = await resolveBinary({ setting });

  lines.push(
    `binary: ${resolved.bin}`,
    `  resolved via: ${resolved.source}${resolved.probe === undefined ? '' : ` (${resolved.probe})`}`,
    `  s2s.bin is set in: ${settingScope()}`,
  );

  try {
    const version = await run({ bin: resolved.bin, args: versionArgs(), cwd, timeoutMs: 5000 });
    const parsed = parseResult(version.stdout);

    if (parsed.kind === 'result') {
      const name = parsed.result['name'];
      const value = parsed.result['version'];
      lines.push(`version: ${String(name ?? 's2s')} ${String(value ?? '(unnamed)')}`);
    } else {
      lines.push(`version: unreadable — ${parsed.message}`);
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
    if (parsed.kind === 'result' && typeof parsed.result['path'] === 'string') {
      lines.push('', `config file: ${parsed.result['path']}`);
      const env = parsed.result['env'];
      if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
        const record = env as Record<string, unknown>;
        lines.push(
          `  user env:    ${String(record['user'])} (${record['userExists'] === true ? 'present' : 'missing'})`,
        );
        lines.push(`  project env: ${String(record['project'] ?? '(none)')}`);
      }
    }
  } catch {
    lines.push('', 'config file: unreadable (binary not runnable yet)');
  }

  try {
    const list = await run({ bin: resolved.bin, args: configArgs('list'), cwd, timeoutMs: 10000 });
    const parsed = parseResult(list.stdout);
    if (parsed.kind === 'result' && typeof parsed.result['config'] === 'object') {
      const values = parsed.result['config'] as Record<string, unknown>;
      const names = Object.keys(values).sort();
      lines.push(
        '',
        `config keys set (${names.length}, names only):`,
        ...names.map((name) => `  ${name}`),
      );
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
