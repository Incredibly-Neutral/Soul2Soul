# SPEC-author-vscode — the VS Code extension wrapper over the `s2s` binary

> **Parent:** [SPEC-author](SPEC-author.md) — the authoring front door. Host siblings:
> [SPEC-author-cli](SPEC-author-cli.md) (the binary this extension spawns),
> [SPEC-author-nvim](SPEC-author-nvim.md) (the same wrapper for the other editor).
>
> **Type:** host specification — describes the `vscode-s2s` package, the VS Code *editor* host that
> drives the headless binary from [SPEC-author-cli](SPEC-author-cli.md).
>
> **Status:** SCAFFOLDED — decisions taken 2026-11-01 (see [Decisions](#decisions)), then built the
> same day: `parse`/`argv`/`format`/`spawn`/`state`/`settings`/`progress` plus the `vscode`
> adapters, 100 tests green against a fake binary, bundle builds, two review rounds closed. Not yet
> typechecked against `@types/vscode`, never run in an extension host. See
> [Current state](#current-state).
>
> **Companion:** [SPEC-author-cli](SPEC-author-cli.md) — its **Binary API reference** is the fixed
> contract this extension is built against. Where the two disagree, the binary wins.
>
> **Constraint that shaped this spec:** the primary (only, for now) target is the **remote
> workspace** — SSH, WSL, dev container. See [Remote workspaces](#remote-workspaces).

---

## The one-paragraph model

`vscode-s2s` is a **thin wrapper**: it spawns `s2s` on the **remote** extension host, passes an
absolute note path plus flags, reads the JSON result on stdout, and formats it for the editor. It is
deliberately **dumb about s2s semantics** — it never parses markdown or frontmatter, never resolves
publications, never derives or reads a CID, never reads `s2s` config, never touches the note's bytes.
Every domain question is answered by the binary. The only state it holds is UI state: last result
per document, busy flags, and the buffer↔disk sync decision. Everything the editor needs from the
local machine (open a URL, write the clipboard, show a notification) is proxied across the remote
boundary by VS Code itself and needs no code here.

## Decisions

Locked 2026-11-01:

| # | Question | Decision |
|---|---|---|
| 1 | `--cid`: explicit flag vs. frontmatter | **Frontmatter**, as in [SPEC-author-nvim](SPEC-author-nvim.md) decision 1. `upload` writes `cid`; `offer` falls back to it, `--cid` overrides. The extension holds **no** CID state. |
| 2 | Where it lives | **`src/author/vscode-s2s/`** — it is TypeScript with a build, unlike the build-free root-level `nvim-s2s/`, and `pnpm-workspace.yaml`'s `src/author/*` glob picks it up unchanged. |
| 3 | Extension kind | **`"extensionKind": ["workspace"]`** — the extension host is the remote one, so `child_process` spawns the binary where the files and keys live. No UI-side half, no companion extension. |
| 4 | Runtime floor | **VS Code `^1.90`**, `@types/node@20`. Nothing here needs newer; the floor exists so the `engines` value is honest rather than aspirational. |
| 5 | `action` vocabulary | `offer`, not `propose` — the rename landed in `c58a197`; the formatter is born without the old word. |
| 6 | Command surface | **Per-action commands** (`s2s.upload`, `s2s.offer`, …) *plus* a `s2s.run` QuickPick. Deliberate divergence from the nvim implementation's single `:S2S <action>`: in VS Code the Keybindings and context-menu contributions need discrete command ids, so the per-action set is mandatory and the QuickPick is the discoverability layer. |
| 7 | stdout parsing | **Strict first, locate second** — see [Result handling](#result-handling). The nvim wrapper already had to scan for the result object; this is the accepted bridge, not a precedent. |
| 8 | Packaging | **`.vsix` only** (`vsce package`, private/`UNLICENSED`). Not published to any marketplace; installs into the remote. |
| 9 | Long-op robustness | Keep `spawn` + `withProgress`. Child stderr streams into the `s2s` output channel; a dropped connection loses the run and the extension says so rather than pretending otherwise. |

## Package layout

```
src/author/vscode-s2s/
  package.json          # manifest: engines, extensionKind, contributes.*
  esbuild.config.mjs    # bundle → dist/extension.js (mirrors author-cli)
  tsconfig.json
  README.md             # install-into-the-remote, settings, doctor — the remote story lives here
  src/extension.ts      # activate/deactivate only: wire modules, register disposables
  src/argv.ts           # pure: action + note + flags → argv (unit-tested)
  src/format.ts         # pure: result object → summary lines + detail rows (unit-tested)
  src/parse.ts          # pure: stdout text → result object | parse error (unit-tested)
  src/spawn.ts          # the ONLY module that touches a binary; resolver + child lifecycle
  src/state.ts          # per-document last result + in-flight mutex
  src/settings.ts       # resolves s2s.* against a configuration scope (folder-aware, remote)
  src/progress.ts       # pure: throttled last-stderr-line message (no vscode import)
  src/ui.ts             # withProgress, output channel, clipboard, open, diagnostics, detail doc
  src/commands.ts       # the s2s.* command ids and their handlers
  src/doctor.ts         # the :checkhealth equivalent
  test/                 # vitest: parse/argv/format/progress fixtures + fake-binary spawn harness
```

Module boundary rule, same as the nvim spec: `format.ts`, `parse.ts` and `argv.ts` are **pure**
(plain values in, plain values out — no `vscode` import). `spawn.ts` is the only module that knows a
binary exists. `parse.ts`, `argv.ts`, `format.ts`, `spawn.ts`, `state.ts` and `progress.ts` import
no `vscode` at all; `ui.ts`, `commands.ts`, `doctor.ts`, `settings.ts` and `extension.ts` do, and of
those only `ui.ts` and `commands.ts` talk to `vscode.window`. Keeping the six `vscode`-free modules
free is what makes them testable in plain vitest under node, without an extension host.

## Remote workspaces

The axis that makes this materially different from the Neovim plugin.

### Where the extension runs

`"extensionKind": ["workspace"]` puts the extension host on the remote. Therefore:

- `child_process` executes on the remote — the binary, the workspace, `~/.config/s2s/`, and the
  project `.env` are all co-located. Nothing needs syncing.
- `window.*` notifications, `env.clipboard`, and `env.openExternal` are **proxied by VS Code** to the
  client, so a preview URL opens in the local browser and the CID lands in the local clipboard with
  no remote-specific code.
- The `s2s` output channel is remote-hosted. It survives a reconnecting window as long as the VS
  Code server process does; it does not survive the server being recreated. Do not promise more.

### Binary discovery (the load-bearing part)

The extension host's `PATH` is **not** the login shell's `PATH` — no `.bashrc`, no `nvm`, no
profile-injected `~/.local/bin`. A binary that is "installed" is routinely invisible. Resolution
order, cached for the session in `spawn.ts`:

1. `s2s.bin`, if set — used verbatim, **no probing** (a user who sets an absolute path means it).
2. Login-shell probe: `bash -lc 'command -v s2s'`, then `bash -ilc …` (profile-only setups), then
   `/bin/sh -lc …` if no bash. `$SHELL` from the environment is preferred over the hardcoded list.
   Non-zero exit or empty output falls through.
3. Bare `'s2s'`, and let the spawn fail with a doctor-shaped message.

`s2s.selectBinary` exists because typing an absolute remote path into JSON is the friction that
kills an extension: a QuickPick of the probe candidates (`command -v` results from each shell) plus
a file picker, writing the chosen value to **workspace** settings.

**Settings scope gotcha, documented in the README and surfaced by doctor:** for a remote window,
`s2s.bin` must be in workspace `.vscode/settings.json` or the *remote* user settings
("Remote [SSH: <host>]"). A value set in local user settings is never read — the extension reading
it is remote.

### Failure mode: the connection drops

A dropped SSH link or container restart tears down the extension host and the in-flight
`upload`/`publish` with it. Decisions:

- The invocation start line (action, note, argv, timestamp) and every stderr line go to the `s2s`
  output channel, so a long run is at least diagnosable after a reconnect.
- `withProgress`'s token is wired to an `AbortController` → `SIGTERM`, so cancelling is a real kill
  and the in-flight mutex is released in the exit path, not the happy path.
- No artificial timeout by default (`s2s.timeout` = 0 = none). Upload and publish legitimately take
  minutes; the progress notification is the timeout.
- When `env.remoteName` is defined and the binary is missing, the error names the host and the rule
  that failed — "`s2s` not found on this remote (`ssh-remote`) — install it here, or set `s2s.bin` in
  workspace settings" — never a bare `ENOENT`.

### Dev containers

The binary has to be in the image (or on a mounted volume/persisted home). The extension cannot
install it and will not try. Doctor reports containers distinctly from SSH/WSL since the fix differs
(rebuild the image vs. install on the host).

## Invocation contract

One action = one process, same five steps as the nvim spec, with VS Code primitives:

1. **Resolve cwd** — the note's workspace folder (`getWorkspaceFolder(noteUri)`), then walk up for
   `.s2sconfig.json`, then `.git`, then `package.json`; fall back to the first workspace folder, then
   `os.homedir()`. Never `process.cwd()` — it is meaningless in a multi-root window. The note path is
   always passed **absolute**; cwd only anchors config/project resolution.
2. **Build argv** — `[bin, group, action, <abs note>, ...flags, '--json']`. `--json` on every
   invocation, always last. `argv.ts` is the only place that knows the flag surface, and it never
   validates flags the binary owns.
3. **Spawn** — `spawn(bin, argv.slice(1), { cwd, signal, env })`, stdout and stderr collected as
   strings, stderr lines also mirrored into the output channel. `text`-mode equivalent: no encoding
   surprises, `utf8` explicitly.
4. **Parse** — `parse.ts`, see below.
5. **Map exit code** — identical table to [SPEC-author-nvim](SPEC-author-nvim.md#invocation-contract):

| exit | meaning | UI |
|---|---|---|
| `0` | result on stdout | formatted summary + stored in `state.ts` |
| `1` | runtime failure | envelope `error` verbatim, `showErrorMessage`; `Diagnostic` on the note when the message names a frontmatter field |
| `2` | usage error | warning, message points at `s2s.help` / the binary's `-h` |
| killed | cancel or crash | info on cancel; error with signal + stderr tail otherwise |
| other | crash | error with exit code + stderr tail |

stderr is never parsed. It is surfaced live in the output channel, and exactly one line of it may
appear inside a failure message when stdout was not JSON at all ("is `s2s.bin` really the s2s
binary?").

## Result handling

### Parsing (decision 7)

The stdout-purity promise in [SPEC-author-cli](SPEC-author-cli.md) is **contradicted in practice**:
the durability legs can leak human progress onto stdout, which is why the nvim wrapper scans rather
than requiring a clean document (`SPEC-author.md` §Known drift). `parse.ts` therefore:

1. `JSON.parse(stdout.trim())` — the contract path.
2. On failure, scan for the first balanced `{…}` region that parses to an object carrying `action`
   or `ok === false`. Bounded: stop after the first success, cap input at a sane size, never
   backtrack. Success here sets `contaminated = true`.
3. On total failure, a named parse error including the first stderr line — never raw stdout.

`contaminated` is not fatal: the result is used, and the output channel gets one line ("stdout was
not a clean document (N bytes) — the binary leaked progress; result recovered"). Doctor counts these
per session. **The scan is a bridge, not a licence** — a clean document stays the target, and if the
leak is fixed in the binary this fallback becomes dead code that can be deleted.

### Fields

Exactly the nvim set: `action`, `objectId`, `cid`, `txHash`, `render.*`, `frontmatterWritten`,
`publication`, `subdomain`, `error`. Open-shape rule unchanged — known fields formatted, extra
scalars appended as `key: value` in the detail view, unknown nested objects ignored, never fatal.
That is what lets `upload` grow an author-contract record without an extension release.

### Document ↔ disk sync

`upload` / `preview` / `publish` rewrite the note's frontmatter, and the binary reads the **saved
file** — so an editor with unsaved changes and the binary disagree about the note.

The signal is the **action**, not `frontmatterWritten`:
`author-cli/src/core/author.ts` (`authorWrite`) writes the frontmatter for all three actions, while
only `upload` reports `frontmatterWritten` in its result. Keying on the flag alone leaves `publish`
silently clobberable, so reconciliation keys on `action ∈ {upload, preview, publish}`, and
`frontmatterWritten === true` is honoured as an extra trigger if a future action starts reporting it.

- clean buffer → reload from disk (`workbench.action.files.revert`), and only when the note is still
  the active editor — the command may fall back to the active editor, and a run can outlive the
  user's attention. A failed revert is reported, never logged as success.
- dirty buffer → **never revert**. One warning per document per session: the note changed on disk,
  and saving will clobber it.
- Before upload/offer/preview/publish/revoke on a dirty document → warn once and require an explicit
  "Run anyway" / "Save and run" choice. The extension never saves the buffer itself, and a failed
  save is reported rather than silently doing nothing.

This is materially more acute than in Neovim: auto-save and dirty editors are the norm, and the
binary hands back a *stale* note if the buffer was never written.

## UI contract

- **Busy**: one `withProgress({ location: ProgressLocation.Notification, cancellable: true, title })`,
  message updated from stderr's last line (throttled), replaced in place by the result. No spinners,
  no timers.
- **Success**: `setStatusBarMessage` with a one-line summary (≤4s) **plus** one information message
  only when there is something to act on (a `render.*` URL, a `txHash`). Silent successes for the
  chatty case, per `s2s.notify`.
- **Detail** (`s2s.last`): known set + pass-through extras, one `key: value` per line, in a
  read-only virtual document (`TextDocumentContentProvider`) opened beside the note. This is where
  "everything else" goes so notifications stay small.
- **Open**: `preview` → `render.previewUrl` when `s2s.open`; `publish` → `render.prodUrl`.
  `upload`/`offer` have nothing to open. **No URLs are invented** — only `render.*` values the binary
  returned are ever opened or printed.
- **Errors**: the envelope `error` verbatim (it is written for humans and points at the fix) in
  `showErrorMessage`, and the long form in the output channel. No stack traces, no "something went
  wrong".
- **Clipboard**: `objectId`/`cid`/`txHash` copyable from the detail document; `upload` also puts
  the CID in the clipboard when `s2s.copyCid` (default `false`).

## Commands

| Command | Binary call |
|---|---|
| `s2s.upload` | `author upload <note> --json` |
| `s2s.offer` | `author offer <note> --json` (CID from frontmatter) |
| `s2s.preview` | `author preview <note> --json` |
| `s2s.publish` | `author publish <note> --json` |
| `s2s.revoke` | `author revoke <note> --json` (modal confirm — it retracts on-chain) |
| `s2s.newPublication` | `publication new <name> --repo … --json` via `showInputBox` sequence |
| `s2s.config` | `config <set\|get\|unset\|list\|path> … --json` — QuickPick for the verb, raw value pass-through. The user/project scope pick is offered only for `set`/`unset`/`path`; the binary's `get`/`list` ignore `--local` |
| `s2s.address` / `s2s.init` | `author address` / `author init --json` |
| `s2s.run` | QuickPick over the above |
| `s2s.last` | no spawn — formats `state.last[doc]` into a virtual document |
| `s2s.doctor` | `--version`, `config path`, `config list` (3 spawns) + a static environment report |
| `s2s.selectBinary` | login-shell probe + input box → `s2s.bin` at the scope that will actually win |

- `commands` are declared in `contributes.commands` with titles under an `s2s` category; activation is
  implicit (`VS Code ≥1.74` auto-activates on command), so `activationEvents` stays empty.
- `contributes.menus.editor/context` adds a submenu, `when: resourceScheme == file && resourceExtname == .md`.
- **No keybindings are contributed at all.** A `contributes.keybindings` entry requires a `key`, so
  "declared but unbound" is not expressible — the command ids are the stable surface and users bind
  them in `keybindings.json`. (The nvim plugin's "no default keymaps" decision, realised the only
  way VS Code allows.)
- `s2s.newPublication` and `s2s.config` prompt with `showInputBox`/`showQuickPick` but pass values
  through unvalidated; the binary's messages drive any correction. No flag re-implementation.
- Commands on a non-`file` document (untitled, diff view, settings, virtual) fail immediately with a
  clear message — the binary needs a path on disk.

## Settings

```jsonc
{
  "s2s.bin": "",              // "" = login-shell probe; "s2s" | absolute path otherwise
  "s2s.cwd": "auto",          // "auto" (workspace folder of the note) | absolute path
  "s2s.notify": true,         // false → silent successes; errors still notify
  "s2s.open": true,           // open render URLs on preview/publish
  "s2s.copyCid": false,       // put upload's cid in the clipboard
  "s2s.confirmRevoke": true,
  "s2s.timeout": 0,           // ms; 0 = none
  "s2s.verboseStderr": false  // stderr is ALWAYS mirrored to the channel; true widens the
                              // failure message from the first stderr line to the last ~20
}
```

Every option maps onto an invocation or a notify decision. **None change s2s behaviour** — anything
that would (publication, keys, RPC) is `s2s config`'s job and stays there.

## s2s.doctor

Promoted from nicety to primary UX, because a remote-only extension fails in ways a local one does
not. Answers, in order, in the `s2s` output channel:

1. `env.remoteName` — `ssh-remote` / `wsl` / `dev-container` / `undefined`, and the note that a
   remote window means the binary must live on that host.
2. Which binary resolved, **by which rule** (setting / login-shell probe / bare name), and the
   absolute path.
3. `s2s --version` parses and reports. There is no API-version field in the binary, so no
   compatibility comparison is attempted — do not invent one.
4. `s2s config path` + `config list --json` — report **which keys are set, names only, never values**
   (they include secrets; the binary masks them and the extension still prints presence only).
5. Is `~/.config/s2s/` present on this host, and is there a project `.env` / `.s2sconfig.json` in the
   workspace folder.
6. The `contaminated` counter from `parse.ts` this session.
7. Where `s2s.bin` is currently set (workspace vs remote-user vs unset) — the scope gotcha, stated
   as a fact about this window.

On any failure it prints the binary's own `s2s config` guidance verbatim rather than inventing setup
steps. It never writes anything outside the remote's `$HOME`, and it writes nothing at all.

## Testing

| Layer | How |
|---|---|
| `parse.ts` | Clean document; leaked-progress document (progress line before JSON); JSON with trailing junk; truncated JSON; empty stdout; huge stdout; failure envelope. Must never throw, must set `contaminated` correctly. |
| `argv.ts` | Per action: note is absolute, `--json` last, flags in order, no invented flags, `offer` not `propose`. |
| `format.ts` | One canned result per action (`upload`, `offer`, `preview`, `publish`, `revoke`, `publication new`, `author address/init`, `config.*`), the failure envelope, `{}`, and a **future-shaped** result with unknown scalars + an unknown nested object (must not error, must pass scalars through, must drop the nested one). |
| `spawn.ts` | Integration against a **fake `s2s`** script (chmod +x, `s2s.bin` points at it): ok / exit 1 / exit 2 / other / non-JSON / empty / huge stdout / SIGTERM on abort. Assert argv, cwd, and that the mutex releases on the *abort* path. No live chain, no real binary. |
| manual smoke (remote) | On the SSH/WSL host: `s2s.doctor` clean; `s2s.upload` on a fixture note down to the missing-env exit-1 → clean ERROR message, no stack trace, no stuck progress, mutex released; then `s2s.offer` / `s2s.preview` the same way. |

Runner: **vitest** for the pure + fake-binary layers (Node, no display), reusing the repo's
`vitest.config.base.ts`. `@vscode/test-electron` is deliberately **out of scope** — it needs a VS
Code download and a display, and it would test the wiring rather than the logic. The extension host
is verified by the manual smoke above.

## Hard rules

1. **The extension never opens the note.** No markdown/frontmatter/YAML parsing, no reading
   `cid`/`genesis`, no writes to it. Path in, JSON out.
2. **The extension never re-implements config precedence.** It asks the binary (`config get/list`).
3. **`--json` on every invocation**, and only the parsed result is ever formatted. Raw stdout is
   never logged — at most a byte count and "not a clean document" line.
4. **No invented URLs.** Only `render.*` fields the binary returned are opened or printed.
5. **No result validation.** Open shapes; unknown fields pass through or are ignored, never fatal.
6. **No re-derivation.** If the extension finds itself computing a CID, resolving a publication,
   defaulting a flag, or guessing a cwd from a filename, it should be asking the binary instead.
7. **Nothing outside the remote `$HOME`.** No file writes at all except what the binary does; the
   extension's own state is in memory.
8. **The pure three stay pure.** `parse.ts`, `argv.ts`, `format.ts` never import `vscode` — that is
   what keeps the logic testable without an editor.

## Non-goals

- Windows-native (non-WSL) workspaces. `spawn` + POSIX shell probing assume a POSIX host.
- Local-only workspaces as a supported target: they work by construction, but they are untested and
  not the design case.
- A frontmatter schema, YAML completion, or `--s2s` tag IntelliSense — that is parsing the note.
- Rendering markdown or previewing HTML inside VS Code, managing IPFS pins, browsing deals/CIDs.
- Any s2s state machine. `s2s.upload` then `s2s.offer` is two commands; the binary made them two
  steps on purpose.
- Syncing config/keys from the local machine to the remote. The remote is where the keys live.
- `@vscode/test-electron` CI, and any CI at all for now.

## Open / pending

- **The stdout leak** (inherited). Decision 7 bridges it. The proper fix is binary-side; if it lands,
  delete the scan and the `contaminated` counter.
- **Connection-loss durability** — decision 9 accepts losing an in-flight run. If a publish is ever
  lost for real, the next step is teeing child stderr to a per-run file in the remote's temp dir.
  Not built.
- **`s2s.newPublication` UX** — the flag surface (`--repo`, `--branch`, `--author`, `--owner`) is
  wide. Current answer is a prompt sequence; a proper multi-input form is a later nicety and needs
  the binary's validation messages to be good enough to drive it.
- **Dev-container recipe** — a documented Dockerfile line / feature for installing the binary is a
  README deliverable, not code. Not written.
- **Install docs** — `.vsix` into the remote via the Extensions view's "Install in SSH/WSL" or
  `code --install-extension` from a remote terminal; a local install is inert. Belongs in the README
  with the settings-scope gotcha.

## Current state

Built 2026-11-01, package `src/author/vscode-s2s/`:

| piece | state |
|---|---|
| `parse.ts` (strict → locate, `contaminated`) | done, 14 tests |
| `argv.ts` (`offer`, not `propose`) | done, 26 tests |
| `format.ts` (per-action summary, detail rows, open-shape, `config.*`/`env.*` flatten) | done, 29 tests |
| `spawn.ts` (process-group kill, no negative caching, last-line probe, post-KILL settle) | done, 24 tests |
| `state.ts` (last result + per-document mutex) | done |
| `settings.ts` (scope-aware `s2s.*`, folder wins over workspace) | done |
| `progress.ts` (throttled trailing message) | done, 7 tests |
| `ui.ts` / `commands.ts` / `doctor.ts` / `extension.ts` | bundled by esbuild, reviewed by two independent reviewers in two rounds (**single-model — pi reviewed pi; no second harness is installed here**), **not yet typechecked** (needs `@types/vscode`) and never run in an extension host |
| `esbuild` bundle | `dist/extension.js`, `vscode` external |
| fake-binary harness | done — scripts in a temp dir, `s2s.bin` points at them, no chain and no real binary |
| review gate | two independent same-model reviews found 25+ defects (including a load-fatal `type: module` vs CJS bundle, an unimplemented frontmatter reconciliation that the README already claimed, and a mutex held across an awaited toast); all confirmed items fixed, both reviewers re-approved |
| `.vsix` packaging | `pnpm --filter vscode-s2s run package`; not run yet |

## Verification gates

- `parse.ts` / `argv.ts` / `format.ts` tests green, including the leaked-progress and future-shaped
  fixtures.
- `spawn.ts` fake-binary tests green for ok / 1 / 2 / other / non-JSON / empty / large / abort.
- `pnpm test` and `pnpm typecheck` for the package green; `esbuild` bundle produces a `dist/extension.js`
  with no `vscode` inlined and no unused deps.
- Manual smoke over SSH by joera (cannot be run from the dev VM — no outbound reach): doctor clean on
  a remote host, then upload/offer/preview to the missing-env exit-1 with a clean message and no
  leaked stack trace.
- No change to the binary's own gates; no change to any other package.
