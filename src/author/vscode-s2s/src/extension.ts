/**
 * Activation. Wiring only: build the state and the detail provider, register the output channel
 * and the commands, drop per-document state when a document closes.
 *
 * `extensionKind: ["workspace"]` means this runs on the *remote* extension host, which is the
 * whole point: `child_process` then spawns `s2s` next to the files and the keys.
 */

import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { runDoctor } from './doctor';
import { createState } from './state';
import * as ui from './ui';

export function activate(context: vscode.ExtensionContext): void {
  const state = createState();
  const detail = new ui.DetailProvider();

  context.subscriptions.push(
    ui.output(),
    vscode.workspace.registerTextDocumentContentProvider(ui.DETAIL_SCHEME, detail),
    vscode.commands.registerCommand('s2s.doctor', () => runDoctor(state)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === 'file') state.clear(document.uri.toString());
    }),
  );

  registerCommands(context, state, detail);

  ui.log('s2s extension activated');
  ui.log(`  remote: ${vscode.env.remoteName ?? 'none'}`);
  ui.log(`  workspace folders: ${(vscode.workspace.workspaceFolders ?? []).length}`);
}

export function deactivate(): void {
  ui.disposeOutput();
}
