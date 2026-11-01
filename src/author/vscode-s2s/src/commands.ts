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
import { config, settingsScope } from './settings';
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

async function binary(scope: vscode.Uri | undefined): Promise<ResolvedBinary> {
  return resolveBinary({ setting: config(scope).get<string>('bin') ?? '' });
}

interface Invocation {
  args: string[];
  cwd: string;
  label: string;
  key: string;
  /**
   * The settings scope, resolved **once** by the caller. `config(scope)` is folder-aware, so
   * re-resolving mid-run would read another folder's settings as soon as the user clicks another
   * file while a publish is in flight.
   */
  scope: vscode.Uri | undefined;
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
async function invoke({ args, cwd, label, key, scope, document }: Invocation): Promise<void> {
  if (!state.begin(key)) {
    void vscode.window.showInformationMessage(`s2s: ${label} is already running for this file.`);
    return;
  }

  const abort = new AbortController();
  const verbose = config(scope).get<boolean>('verboseStderr') ?? false;
  const timeoutMs = config(scope).get<number>('timeout') ?? 0;

  let result: RunResult | undefined;
  let failure: Error | undefined;

  try {
    const resolved = await binary(scope);
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
        // The spec asks for the LAST stderr line; a leading-edge throttle drops it.
        reportProgress.flush();
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

  await handleOutcome({ label, key, result, document, scope, verbose, timeoutMs });
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
/**
 * SPEC §Document ↔ disk sync. The binary is the only writer of the note's frontmatter — on disk,
 * not in the buffer — so a clean buffer is reloaded and a **dirty** buffer is never reverted: the
 * user's edits win, with one warning that saving will clobber the update.
 *
 * The ground truth is src/author/author-cli/src/core/author.ts:203 — `authorWrite` writes the
 * frontmatter for `upload`, `preview` **and** `publish` (only upload reports
 * `frontmatterWritten`; preview.ts:21 and publish.ts:22 report nothing). Keying on the flag alone
 * left the clobber path open for publish, so the action is the signal and `note` is the guard.
 */
const WRITES_FRONTMATTER = new Set(['upload', 'preview', 'publish']);

async function reconcileFrontmatter(
  result: Record<string, unknown>,
  document: vscode.TextDocument | undefined,
  key: string,
): Promise<void> {
  if (document === undefined) return;
  if (!vscode.workspace.textDocuments.includes(document)) return;

  const action = result['action'];
  const reported = result['frontmatterWritten'] === true;
  const writes = typeof action === 'string' && WRITES_FRONTMATTER.has(action);
  if (!reported && !writes) return;

  // Never reconcile a document the result is not about.
  const note = result['note'];
  if (typeof note === 'string' && path.resolve(note) !== path.resolve(document.uri.fsPath)) return;

  /** One warning per document per session — SPEC says "one warning", not one per run. */
  const warnOnce = async (): Promise<void> => {
    if (warnedStale.has(key)) return;
    warnedStale.add(key);
    await ui.warnChangedOnDisk(basename(document.uri.fsPath));
  };

  if (document.isDirty) {
    await warnOnce();
    return;
  }

  if (await ui.revertFile(document)) {
    // A clean buffer is current again, so a future dirty run deserves a fresh warning.
    warnedStale.delete(key);
    return;
  }

  await warnOnce();
}

async function handleOutcome({
  label,
  key,
  result,
  document,
  scope,
  verbose,
  timeoutMs,
}: {
  label: string;
  key: string;
  result: RunResult;
  document: vscode.TextDocument | undefined;
  scope: vscode.Uri | undefined;
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

  const outcome = parseResult(result.stdout);

  /**
   * A timeout is only a timeout when it cost us the result. A run that finishes *at* the deadline
   * exits 0 with a complete document — reporting "timed out" there threw away a valid CID, and for
   * publish the offer tx may already be mined.
   */
  if (result.timedOut && (result.code !== 0 || outcome.kind !== 'result')) {
    state.stats.failures += 1;
    await ui.reportFailure(
      withSnippet(
        `timed out after ${timeoutMs}ms — killed with SIGTERM (raise s2s.timeout, or 0 for no timeout)`,
      ),
    );
    return;
  }

  if (result.timedOut) {
    ui.log(`${label}: finished at the ${timeoutMs}ms deadline — keeping its result`);
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
    notify: config(scope).get<boolean>('notify') ?? true,
    copyCid: config(scope).get<boolean>('copyCid') ?? false,
    open: config(scope).get<boolean>('open') ?? true,
  });
}

/** Run one author action on the active note. */
async function authorAction(action: AuthorAction): Promise<void> {
  const document = requireNoteDocument();
  if (document === undefined) return;
  // Snapshot the scope before the first await: prompts can sit on screen for minutes, and
  // `config()` without a scope would then read whatever file the user clicked in the meantime.
  const scope = settingsScope();
  if (!(await confirmDirty(document))) return;

  if (action === 'revoke' && (config(scope).get<boolean>('confirmRevoke') ?? true)) {
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
    scope,
    document,
  });
}

async function runRaw(label: string, args: string[], cwd: string): Promise<void> {
  await invoke({ args, cwd, label, key: `s2s:${label}`, scope: settingsScope() });
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

  // `--local` is a set/unset/path flag (src/author/author-cli/src/commands/config.ts:192,204,216):
  // get and list resolve the merged config and have no scope to pick, so do not offer one.
  const takesScope = typed === 'set' || typed === 'unset' || typed === 'path';
  let local = false;

  if (takesScope) {
    const picked = await vscode.window.showQuickPick(['User config', 'Project config (--local)'], {
      title: `s2s config ${typed}`,
    });
    if (picked === undefined) return;
    local = picked.startsWith('Project');
  }

  await runRaw(`config ${typed}`, configArgs(typed, rest, { local }), workspaceCwd());
}

async function selectBinary(): Promise<void> {
  const scope = settingsScope();
  const resolved = await binary(scope);
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

  // Where to write, in the same precedence the reader uses (settings.ts): the scope's own
  // workspace FOLDER first — a workspace value would be outranked by a folder value in
  // `.vscode/settings.json`, so writing it there would be a no-op announced as success — then the
  // workspace, then the (remote) user settings. `Workspace`/`WorkspaceFolder` throw with nothing
  // open, which is exactly the remote window where doctor recommends this command.
  const folder = scope === undefined ? undefined : vscode.workspace.getWorkspaceFolder(scope);
  const target =
    folder !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

  const where =
    folder !== undefined
      ? `${folder.name}'s folder settings`
      : target === vscode.ConfigurationTarget.Workspace
        ? 'workspace settings'
        : 'user settings';

  try {
    await config(scope).update('bin', value, target);
  } catch (error) {
    await ui.reportFailure(
      `could not write s2s.bin to ${where}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  void vscode.window.showInformationMessage(
    value.length === 0
      ? `s2s: binary setting cleared (${where})`
      : `s2s: binary set to ${value} (${where})`,
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
