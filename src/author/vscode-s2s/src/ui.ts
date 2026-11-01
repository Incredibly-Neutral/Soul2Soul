/**
 * The only module that talks to `vscode.window` / `vscode.env` for output.
 *
 * Everything here is a *presentation* adapter: no argv, no parsing, no domain knowledge. All of
 * these calls are proxied by VS Code across a remote boundary, so a preview URL opens in the
 * user's local browser and the CID lands in their local clipboard with no remote-specific code.
 */

import * as vscode from 'vscode';

import { detailRows, type Summary } from './format';
import type { LastResult } from './state';

export const DETAIL_SCHEME = 's2s-result';

let channel: vscode.OutputChannel | undefined;

export function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('s2s');
  return channel;
}

export function log(line: string): void {
  output().appendLine(line);
}

export function disposeOutput(): void {
  channel?.dispose();
  channel = undefined;
}

export interface ReportOptions {
  notify: boolean;
  copyCid: boolean;
  open: boolean;
}

async function copy(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
}

async function openUrl(url: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * Success: a status-bar flash plus, only when there is something to act on, one information
 * message. The full result goes to the output channel; `s2s.last` shows everything.
 */
export async function reportSuccess(summary: Summary, options: ReportOptions): Promise<void> {
  log(summary.title);
  for (const line of summary.lines) log(`  ${line}`);

  vscode.window.setStatusBarMessage(`s2s: ${summary.title}`, 5000);

  if (options.copyCid && summary.copy !== undefined) await copy(summary.copy);

  // An explicit user request to open wins, even with notifications off.
  if (options.open && summary.url !== undefined) {
    await openUrl(summary.url);
    return;
  }

  if (!options.notify) return;

  const actions: string[] = [];
  if (summary.url !== undefined) actions.push('Open');
  if (summary.copy !== undefined && !options.copyCid) actions.push('Copy CID');
  if (actions.length === 0 && summary.lines.length === 0) return;

  const body = summary.lines.length > 0 ? summary.lines.join('\n') : summary.title;
  const picked = await vscode.window.showInformationMessage(body, ...actions);

  if (picked === 'Open' && summary.url !== undefined) await openUrl(summary.url);
  if (picked === 'Copy CID' && summary.copy !== undefined) await copy(summary.copy);
}

/** Runtime failure: the binary's own message, verbatim. It already points at the fix. */
export async function reportFailure(message: string): Promise<void> {
  log(`error: ${message}`);
  const picked = await vscode.window.showErrorMessage(`s2s: ${message}`, 'Show Log');
  if (picked === 'Show Log') output().show(true);
}

/** Usage error (exit 2): warn, and point at the binary's own help. */
export async function reportUsage(message: string): Promise<void> {
  log(`usage: ${message}`);
  await vscode.window.showWarningMessage(`s2s: ${message}`);
}

export interface ProgressLike {
  message?: string;
}

export function withProgress<T>(
  title: string,
  task: (progress: vscode.Progress<ProgressLike>, token: vscode.CancellationToken) => Thenable<T>,
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    task,
  );
}

/**
 * Detail view: a read-only virtual document beside the note. No webview — the content is plain
 * `key: value` rows, and a text document gives the user search, selection and copy for free.
 */
export class DetailProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  async show(last: LastResult, title: string): Promise<void> {
    const slug = title.replace(/[^\w.-]+/g, '-').slice(0, 60);
    const uri = vscode.Uri.parse(`${DETAIL_SCHEME}:${slug}.txt`);
    const header = [`s2s ${title}`, '='.repeat(`s2s ${title}`.length), ''];

    this.contents.set(uri.toString(), [...header, ...detailRows(last.result), ''].join('\n'));

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }
}
