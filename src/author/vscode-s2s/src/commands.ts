/**
 * Command handlers. This is the glue: resolve a note, resolve a cwd, resolve a binary, invoke,
 * parse, format, report. No domain logic lives here and none may be added (hard rules 1–6).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  UsageError,
  authorArgs,
  authorIdentityArgs,
  configArgs,
  publicationNewArgs,
  type AuthorAction,
  type AuthorFlags,
  type ConfigVerb,
} from './argv';
import { formatResult } from './format';
import { parseResult } from './parse';
import { resolveBinary, run, type ResolvedBinary, type RunResult } from './spawn';
import type { State } from './state';
import * as ui from './ui';

const MARKERS = ['.s2sconfig.json', '.git', 'package.json'];

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('s2s');
}

let state: State;
let detailProvider: ui.DetailProvider;

/** The active document, but only when it is a real file — the binary needs a path on disk. */
function requireNoteDocument(): vscode.TextDocument | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined) {
    void vscode.window.showErrorMessage('s2s: no active editor.');
    return undefined;
  }
  if (document.uri.scheme !== 'file') {
    void vscode.window.showErrorMessage(
      `s2s needs a file on disk — this document is "${document.uri.scheme}".`,
    );
    return undefined;
  }
  return document;
}

function hasMarker(dir: string): boolean {
  return MARKERS.some((marker) => {
    try {
      return fs.existsSync(path.join(dir, marker));
    } catch {
      return false;
    }
  });
}

/**
 * The cwd the binary runs in. Never `process.cwd()` — meaningless in a multi-root window.
 * `s2s.cwd` overrides; otherwise the nearest marker at or above the note, bounded by the
 * workspace folder.
 */
export function projectRoot(notePath: string): string {
  const configured = config().get<string>('cwd') ?? 'auto';
  if (configured !== 'auto' && configured.length > 0) return configured;

  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(notePath))?.uri.fsPath;
  const fallback = folder ?? path.dirname(notePath);
  let dir = path.dirname(notePath);
  const stopAt = folder ?? path.parse(dir).root;

  for (;;) {
    if (hasMarker(dir)) return dir;
    if (dir === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return fallback;
}

/**
 * The binary reads the saved file, so unsaved buffer content is invisible to it. Never save on
 * the user's behalf; ask.
 */
async function confirmDirty(document: vscode.TextDocument): Promise<boolean> {
  if (!document.isDirty) return true;

  const save = 'Save and run';
  const anyway = 'Run anyway';
  const picked = await vscode.window.showWarningMessage(
    `s2s reads the saved file — ${path.basename(document.uri.fsPath)} has unsaved changes.`,
    { modal: true },
    save,
    anyway,
  );

  if (picked === save) return document.save();
  return picked === anyway;
}

async function binary(): Promise<ResolvedBinary> {
  return resolveBinary({ setting: config().get<string>('bin') ?? '' });
}

interface Invocation {
  args: string[];
  cwd: string;
  label: string;
  key: string;
}

/**
 * One action = one process. Exit codes map as SPEC-author-vscode §Invocation contract; stderr is
 * never parsed, only surfaced.
 */
async function invoke({ args, cwd, label, key }: Invocation): Promise<void> {
  if (!state.begin(key)) {
    void vscode.window.showInformationMessage(`s2s: ${label} is already running for this file.`);
    return;
  }

  const abort = new AbortController();
  const verbose = config().get<boolean>('verboseStderr') ?? false;
  const timeoutMs = config().get<number>('timeout') ?? 0;

  try {
    const resolved = await binary();
    ui.log(`$ ${resolved.bin} ${args.join(' ')}  (cwd ${cwd})`);

    const result = await ui.withProgress(`s2s: ${label}`, async (progress, token) => {
      const subscription = token.onCancellationRequested(() => abort.abort());
      try {
        return await run({
          bin: resolved.bin,
          args,
          cwd,
          signal: abort.signal,
          timeoutMs,
          onStderr: (line) => {
            if (verbose) ui.log(`  ${line}`);
            progress.report({ message: line.slice(0, 80) });
          },
        });
      } finally {
        subscription.dispose();
      }
    });

    await handleOutcome({ label, key, result });
  } catch (error) {
    const message =
      error instanceof UsageError || error instanceof Error ? error.message : String(error);
    await ui.reportFailure(message);
  } finally {
    state.end(key);
  }
}

async function handleOutcome({
  label,
  key,
  result,
}: {
  label: string;
  key: string;
  result: RunResult;
}): Promise<void> {
  if (result.aborted) {
    ui.log(`${label}: cancelled after ${result.durationMs}ms`);
    return;
  }

  const firstStderrLine = result.stderr.split('\n').find((line) => line.trim().length > 0);
  const outcome = parseResult(result.stdout);

  if (outcome.kind === 'failure') {
    state.stats.failures += 1;
    await ui.reportFailure(
      firstStderrLine === undefined ? outcome.message : `${outcome.message}\n${firstStderrLine}`,
    );
    return;
  }

  const reportedAction = outcome.result['action'];

  state.setLast(key, {
    result: outcome.result,
    action: typeof reportedAction === 'string' ? reportedAction : undefined,
    contaminated: outcome.contaminated,
    finishedAt: Date.now(),
    durationMs: result.durationMs,
  });

  if (outcome.contaminated) {
    ui.log(
      `stdout was not a clean document (${result.stdout.length} bytes) — result recovered; the binary leaked progress`,
    );
  }

  const summary = formatResult(outcome.result, { durationMs: result.durationMs });
  const failed = result.code !== 0 || outcome.result['ok'] === false;

  if (failed) {
    state.stats.failures += 1;
    if (result.code === 2) await ui.reportUsage(summary.title);
    else await ui.reportFailure(summary.title);
    return;
  }

  await ui.reportSuccess(summary, {
    notify: config().get<boolean>('notify') ?? true,
    copyCid: config().get<boolean>('copyCid') ?? false,
    open: config().get<boolean>('open') ?? true,
  });
}

/** Run one author action on the active note. */
async function authorAction(action: AuthorAction): Promise<void> {
  const document = requireNoteDocument();
  if (document === undefined) return;
  if (!(await confirmDirty(document))) return;

  if (action === 'revoke' && (config().get<boolean>('confirmRevoke') ?? true)) {
    const picked = await vscode.window.showWarningMessage(
      `Revoke ${path.basename(document.uri.fsPath)}? This retracts it on-chain.`,
      { modal: true },
      'Revoke',
    );
    if (picked !== 'Revoke') return;
  }

  const notePath = document.uri.fsPath;
  const args = authorArgs(action, notePath);
  await invoke({
    args,
    cwd: projectRoot(notePath),
    label: action,
    key: document.uri.toString(),
  });
}

async function runRaw(label: string, args: string[], cwd: string): Promise<void> {
  await invoke({ args, cwd, label, key: `s2s:${label}` });
}

function workspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ?? path.dirname(vscode.window.activeTextEditor?.document.uri.fsPath ?? '.');
}

async function newPublication(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 's2s: new publication',
    prompt: 'Publication name (the ENS subdomain label)',
    ignoreFocusOut: true,
  });
  if (name === undefined || name.length === 0) return;

  const repo = await vscode.window.showInputBox({
    title: 's2s: new publication',
    prompt: 'Dev repository (<owner>/<repo>)',
    ignoreFocusOut: true,
  });
  if (repo === undefined || repo.length === 0) return;

  const branch = await vscode.window.showInputBox({
    title: 's2s: new publication',
    prompt: 'Default render branch (optional)',
    ignoreFocusOut: true,
  });

  const flags = branch !== undefined && branch.length > 0 ? { repo, branch } : { repo };
  await runRaw('publication new', publicationNewArgs(name, flags), workspaceCwd());
}

const CONFIG_VERBS: readonly ConfigVerb[] = ['list', 'get', 'set', 'unset', 'path'];

async function runConfig(): Promise<void> {
  const verb = await vscode.window.showQuickPick([...CONFIG_VERBS], {
    title: 's2s: config',
    placeHolder: 'verb',
  });
  if (verb === undefined) return;
  if (!CONFIG_VERBS.includes(verb as ConfigVerb)) return;

  const rest: string[] = [];
  const typed = verb as ConfigVerb;

  if (typed === 'set' || typed === 'get' || typed === 'unset') {
    const key = await vscode.window.showInputBox({
      title: `s2s config ${typed}`,
      prompt: 'key (e.g. rpcL2, kuboGateway, privateKey)',
      ignoreFocusOut: true,
    });
    if (key === undefined || key.length === 0) return;
    rest.push(key);

    if (typed === 'set') {
      const value = await vscode.window.showInputBox({
        title: 's2s config set',
        prompt: `value for ${key}`,
        ignoreFocusOut: true,
        password: key.toLowerCase().includes('key'),
      });
      if (value === undefined) return;
      rest.push(value);
    }
  }

  const local = await vscode.window.showQuickPick(['User config', 'Project config (--local)'], {
    title: `s2s config ${typed}`,
  });
  if (local === undefined) return;

  await runRaw(
    `config ${typed}`,
    configArgs(typed, rest, { local: local.startsWith('Project') }),
    workspaceCwd(),
  );
}

async function selectBinary(): Promise<void> {
  const resolved = await binary();
  const detected = await resolveBinary({});
  const items: vscode.QuickPickItem[] = [
    {
      label: 'Detect with login shell',
      description: detected.source === 'login-shell' ? detected.bin : 'not found on PATH',
    },
    { label: 'Enter a path…' },
    { label: 'Clear the setting' },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 's2s: select binary',
    placeHolder: `current: ${resolved.bin} (via ${resolved.source})`,
  });
  if (picked === undefined) return;

  let value = '';
  if (picked.label === 'Detect with login shell') {
    if (detected.source !== 'login-shell') {
      await ui.reportFailure(
        'login-shell probe found no s2s — install it on this host, or enter an absolute path',
      );
      return;
    }
    value = detected.bin;
  } else if (picked.label === 'Enter a path…') {
    const typed = await vscode.window.showInputBox({
      title: 's2s: select binary',
      prompt: 'Absolute path to s2s',
      ignoreFocusOut: true,
    });
    if (typed === undefined) return;
    value = typed;
  }

  await vscode.workspace
    .getConfiguration('s2s')
    .update('bin', value, vscode.ConfigurationTarget.Workspace);
  void vscode.window.showInformationMessage(
    value.length === 0 ? 's2s: binary setting cleared' : `s2s: binary set to ${value}`,
  );
}

async function showLast(): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined) {
    void vscode.window.showErrorMessage('s2s: no active editor.');
    return;
  }
  const last = state.getLast(document.uri.toString());
  if (last === undefined) {
    void vscode.window.showInformationMessage('s2s: no result for this file in this session.');
    return;
  }
  await detailProvider.show(last, last.action ?? 'result');
}

const QUICK_ACTIONS: readonly { label: string; command: string }[] = [
  { label: 'Upload', command: 's2s.upload' },
  { label: 'Offer', command: 's2s.offer' },
  { label: 'Preview', command: 's2s.preview' },
  { label: 'Publish', command: 's2s.publish' },
  { label: 'Revoke…', command: 's2s.revoke' },
  { label: 'Show last result', command: 's2s.last' },
  { label: 'Doctor', command: 's2s.doctor' },
];

async function runQuickPick(): Promise<void> {
  const picked = await vscode.window.showQuickPick([...QUICK_ACTIONS], { title: 's2s' });
  if (picked === undefined) return;
  await vscode.commands.executeCommand(picked.command);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  state_: State,
  detail: ui.DetailProvider,
): void {
  state = state_;
  detailProvider = detail;

  const register = (id: string, handler: () => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        void Promise.resolve(handler()).catch((error: unknown) => {
          ui.log(`unhandled: ${String(error)}`);
        });
      }),
    );
  };

  register('s2s.upload', () => authorAction('upload'));
  register('s2s.offer', () => authorAction('offer'));
  register('s2s.preview', () => authorAction('preview'));
  register('s2s.publish', () => authorAction('publish'));
  register('s2s.revoke', () => authorAction('revoke'));
  register('s2s.address', () =>
    runRaw('author address', authorIdentityArgs('address'), workspaceCwd()),
  );
  register('s2s.init', () => runRaw('author init', authorIdentityArgs('init'), workspaceCwd()));
  register('s2s.newPublication', newPublication);
  register('s2s.config', runConfig);
  register('s2s.selectBinary', selectBinary);
  register('s2s.last', showLast);
  register('s2s.run', runQuickPick);
}
