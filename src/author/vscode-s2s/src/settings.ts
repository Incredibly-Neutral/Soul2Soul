/**
 * Settings resolution — one place that decides *which* scope `s2s.*` is read from.
 *
 * `getConfiguration('s2s')` without a scope URI ignores per-folder values entirely, so in a
 * multi-root window `s2s.bin` set in the note's own `.vscode/settings.json` was silently skipped
 * while doctor reported the folder scope as active. Everything now resolves against a URI: the
 * active note (its folder wins), else the first folder, else global.
 *
 * This is read-only: `s2s.bin` is written by `s2s.selectBinary`, which needs the target enum.
 */

import * as vscode from 'vscode';

/** The resource every `s2s.*` read is scoped to. `undefined` = global (no folder open). */
export function settingsScope(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active !== undefined && active.scheme === 'file') return active;
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function config(
  scope: vscode.Uri | undefined = settingsScope(),
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('s2s', scope);
}

/** Human description of the scope actually used, for doctor — never a guess. */
export function describeScope(scope: vscode.Uri | undefined): string {
  if (scope === undefined) return 'global — no folder open, user settings only';
  const folder = vscode.workspace.getWorkspaceFolder(scope);
  if (folder === undefined) return `global — ${scope.fsPath} is outside every workspace folder`;
  return `workspace folder ${folder.uri.fsPath}`;
}
