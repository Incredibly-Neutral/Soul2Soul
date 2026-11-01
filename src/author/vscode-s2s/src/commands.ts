/**
 * Command handlers. This is the glue: resolve a note, resolve a cwd, resolve a binary, invoke,
 * parse, format, report. No domain logic lives here and none may be added (hard rules 1–6).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  authorArgs,
  authorIdentityArgs,
  configArgs,
  publicationNewArgs,
  type AuthorAction,
  type ConfigVerb,
} from './argv';
import { basename, formatResult } from './format';
import { parseResult } from './parse';
import { createLineThrottle } from './progress';
import { config } from './settings';
import { resolveBinary, run, type ResolvedBinary, type RunResult } from './spawn';
import type { State } from './state';
import * as ui from './ui';

const MARKERS = ['.s2sconfig.json', '.git', 'package.json'];

/** How many stderr lines a verbose failure report carries. */
const STDERR_TAIL_LINES = 20;

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
  const configured = config(vscode.Uri.file(notePath)).get<string>('cwd') ?? 'auto';
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

  if (picked === save) {
    // `save()` resolves false on a read-only mount or a failed write. Say so: silently doing
    // nothing is the worst possible answer to "Save and run".
    const saved = await document.save();
    if (!saved) {
      await vscode.window.showErrorMessage(
        `s2s: could not save ${basename(document.uri.fsPath)} — is it read-only? Nothing was run.`,
      );
      return false;
    }
    return true;
  }
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
  /** The note this run acts on, when there is one — frontmatter reconciliation needs it. */
  document?: vscode.TextDocument;
}

/**
 * One action = one process. Exit codes map as SPEC-author-vscode §Invocation contract; stderr is
 * never parsed, only surfaced.
 *
 * The mutex is released in `finally` **as soon as the child is gone**, before any UI: both
 * `showInformationMessage` and `withProgress` resolve on dismiss, not on display, so awaiting them
 * inside the guarded region refused a re-run for seconds after the process had already exited.
 */
async function invoke({ args, cwd, label, key, document }: Invocation): Promise<void> {
  if (!state.begin(key)) {
    void vscode.window.showInformationMessage(`s2s: ${label} is already running for this file.`);
    return;
  }

  const abort = new AbortController();
  const verbose = config().get<boolean>('verboseStderr') ?? false;
  const timeoutMs = config().get<number>('timeout') ?? 0;

  let result: RunResult | undefined;
  let failure: Error | undefined;

  try {
    const resolved = await binary();
    ui.log(`$ ${resolved.bin} ${args.join(' ')}  (cwd ${cwd})`);

    result = await ui.withProgress(`s2s: ${label}`, async (progress, token) => {
      const subscription = token.onCancellationRequested(() => abort.abort());
      // stderr can be a firehose; the notification wants the last line, ~10 times a second.
      const reportProgress = createLineThrottle((line) =>
        progress.report({ message: line.slice(0, 80) }),
      );

      try {
        return await run({
          bin: resolved.bin,
          args,
          cwd,
          signal: abort.signal,
          timeoutMs,
          onStderr: (line) => {
            // Always mirrored, no setting (SPEC decision 9): after a dropped connection this
            // channel is the only evidence of what the run was doing.
            ui.log(`  ${line}`);
            reportProgress(line);
          },
        });
      } finally {
        subscription.dispose();
      }
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    state.end(key);
  }

  if (failure !== undefined) {
    await ui.reportFailure(failure.message);
    return;
  }
  if (result === undefined) return;

  await handleOutcome({ label, key, result, document, verbose, timeoutMs });
}

function stderrLines(result: RunResult): string[] {
  return result.stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

/** One line by default (`s2s.verboseStderr` = false); the last ~20 when it is on. */
function stderrSnippet(result: RunResult, verbose: boolean): string | undefined {
  const lines = stderrLines(result);
  if (lines.length === 0) return undefined;
  return (verbose ? lines.slice(-STDERR_TAIL_LINES) : lines.slice(0, 1)).join('\n');
}

/** One warning per document per session — SPEC §Document ↔ disk sync says "one warning". */
const warnedStale = new Set<string>();

/**
 * SPEC §Document ↔ disk sync. `upload` rewrites the note's frontmatter on disk, and the binary is
 * the only writer (the extension never touches the note's bytes) — so a clean buffer is reloaded
 * from disk, and a **dirty** buffer is never reverted: the user's edits win, with one warning that
 * saving will clobber the update.
 *
 * Keyed on the reported `frontmatterWritten`, which only `upload` emits
 * (src/author/author-cli/src/commands/upload.ts). `preview`/`publish` also write the frontmatter on
 * disk but do not say so, so there is nothing to key on for them — no guessing here.
 */
async function reconcileFrontmatter(
  result: Record<string, unknown>,
  document: vscode.TextDocument | undefined,
  key: string,
): Promise<void> {
  if (document === undefined || result['frontmatterWritten'] !== true) return;
  if (!vscode.workspace.textDocuments.includes(document)) return;

  if (document.isDirty) {
    if (warnedStale.has(key)) return;
    warnedStale.add(key);
    await ui.warnChangedOnDisk(basename(document.uri.fsPath));
    return;
  }

  await ui.revertFile(document.uri);
  // A clean buffer is current again, so a future dirty run deserves a fresh warning.
  warnedStale.delete(key);
}

async function handleOutcome({
  label,
  key,
  result,
  document,
  verbose,
  timeoutMs,
}: {
  label: string;
  key: string;
  result: RunResult;
  document: vscode.TextDocument | undefined;
  verbose: boolean;
  timeoutMs: number;
}): Promise<void> {
  const snippet = stderrSnippet(result, verbose);
  const withSnippet = (message: string): string =>
    snippet === undefined ? message : `${message}\n${snippet}`;

  if (result.aborted) {
    ui.log(`${label}: cancelled by the user after ${result.durationMs}ms`);
    return;
  }

  // A timeout is not a cancel and not a crash: name it, instead of "printed nothing on stdout".
  if (result.timedOut) {
    state.stats.failures += 1;
    await ui.reportFailure(
      withSnippet(
        `timed out after ${timeoutMs}ms — killed with SIGTERM (raise s2s.timeout, or 0 for no timeout)`,
      ),
    );
    return;
  }

  // Signal without an exit code and without our cancel: a real crash (OOM, external SIGKILL).
  if (result.code === null) {
    state.stats.failures += 1;
    await ui.reportFailure(
      withSnippet(
        `killed by ${result.signal ?? 'a signal'} after ${result.durationMs}ms — it never produced a result`,
      ),
    );
    return;
  }

  const outcome = parseResult(result.stdout);

  if (outcome.kind === 'failure') {
    state.stats.failures += 1;
    await ui.reportFailure(withSnippet(outcome.message));
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

  const summary = formatResult(outcome.result, { durationMs: result.durationMs, label });
  const failed = result.code !== 0 || outcome.result['ok'] === false;

  if (failed) {
    state.stats.failures += 1;
    if (result.code === 2) await ui.reportUsage(summary.title);
    else await ui.reportFailure(summary.title);
    return;
  }

  // Before the toast: the buffer must be current before the user reacts to a success message.
  await reconcileFrontmatter(outcome.result, document, key);

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
    document,
  });
}

async function runRaw(label: string, args: string[], cwd: string): Promise<void> {
  await invoke({ args, cwd, label, key: `s2s:${label}` });
}

/**
 * cwd for the commands that are not tied to a single note (`publication new`, `config`, `address`,
 * `init`). SPEC §Invocation contract: the note's project root when a note is open → the first
 * workspace folder → `os.homedir()`. Never `process.cwd()`, and never `'.'` (which *is* the
 * extension host's cwd, so doctor and the binary would describe the wrong project).
 */
function workspaceCwd(): string {
  const active = vscode.window.activeTextEditor?.document;
  if (active !== undefined && active.uri.scheme === 'file') return projectRoot(active.uri.fsPath);

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ?? os.homedir();
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

  // Where to write: workspace settings when a folder is open, else the (remote) user settings.
  // `ConfigurationTarget.Workspace` throws when no folder is open — exactly the remote window
  // with no folder where doctor recommends this command — and the old code swallowed it.
  const target =
    (vscode.workspace.workspaceFolders?.length ?? 0) > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

  try {
    await config().update('bin', value, target);
  } catch (error) {
    const where = target === vscode.ConfigurationTarget.Global ? 'user' : 'workspace';
    await ui.reportFailure(
      `could not write s2s.bin to ${where} settings: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

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
