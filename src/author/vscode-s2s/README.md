# vscode-s2s

Upload, offer, preview and publish soul2soul manuscripts from a VS Code window — a **thin
wrapper** over the `s2s` binary (`src/author/author-cli`).

The extension is dumb about s2s: it spawns the binary, passes an absolute note path plus flags,
reads the one JSON document on stdout, and formats it. It never parses your markdown or
frontmatter, never derives a CID, never resolves a publication, never reads `s2s` config. Every
domain question goes to the binary, and `--json` is on every invocation.

Spec: [`brain/specs/author/SPEC-author-vscode.md`](../../../brain/specs/author/SPEC-author-vscode.md).
Binary contract: `SPEC-author-cli` §Binary API reference.

## Remote workspaces

This extension is written for **remote** windows (SSH, WSL, dev container) and declares
`"extensionKind": ["workspace"]`, so it runs on the remote extension host next to your files and
keys, and spawns `s2s` there.

Two consequences worth knowing before you file a bug:

1. **The binary must be installed on the remote host.** Not on your laptop. A dev container needs
   it in the image or on a persisted mount. If `s2s` is missing, `s2s.doctor` says so explicitly
   rather than failing with `ENOENT`.
2. **`s2s.bin` must be set in a scope this window reads** — workspace `.vscode/settings.json` or
   the _remote_ user settings ("Remote [SSH: <host>]"). A value in your local user settings is
   never read here. Leave it empty to use the login-shell probe.

Every UI call is proxied by VS Code, so a preview URL opens in your local browser and a CID lands
in your local clipboard.

## Install

Unpublished — build a `.vsix` and install it into the remote:

```sh
pnpm --filter vscode-s2s run package        # → vscode-s2s-0.1.0.vsix
```

Then, from the window that is already connected to the remote: Extensions view → `…` →
**Install from VSIX…** (it installs into the remote when the window is remote), or from a terminal
inside the remote:

```sh
code --install-extension vscode-s2s-0.1.0.vsix
```

A local install of a workspace-only extension is inert.

## Commands

| Command                   | Binary call                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `s2s: Upload`             | `author upload <note> --json`                                    |
| `s2s: Offer`              | `author offer <note> --json` (CID from the note's frontmatter)   |
| `s2s: Preview`            | `author preview <note> --json`                                   |
| `s2s: Publish`            | `author publish <note> --json`                                   |
| `s2s: Revoke`             | `author revoke <note> --json` (confirmed — it retracts on-chain) |
| `s2s: Show Author Safe`   | `author address --json`                                          |
| `s2s: Deploy Author Safe` | `author init --json`                                             |
| `s2s: New Publication…`   | `publication new … --json`                                       |
| `s2s: Config…`            | `config <verb> … --json`                                         |
| `s2s: Run Action…`        | QuickPick over the above                                         |
| `s2s: Show Last Result`   | no spawn — the full result of the last run for this file         |
| `s2s: Doctor`             | no spawn — environment report in the `s2s` output channel        |
| `s2s: Select Binary…`     | no spawn — probe + write `s2s.bin`                               |

**No default keybindings.** Bind `s2s.upload`, `s2s.offer`, … to whatever you like; the command
ids are stable.

## Settings

| Setting             | Default  | Meaning                                                                  |
| ------------------- | -------- | ------------------------------------------------------------------------ |
| `s2s.bin`           | `""`     | `""` = login-shell probe (`bash -lc 'command -v s2s'`); otherwise a path |
| `s2s.cwd`           | `"auto"` | `"auto"` = the workspace folder holding the note; or an absolute path    |
| `s2s.notify`        | `true`   | message on success (errors always show)                                  |
| `s2s.open`          | `true`   | open the preview/prod URL the binary returned                            |
| `s2s.copyCid`       | `false`  | put the upload's CID on the clipboard                                    |
| `s2s.confirmRevoke` | `true`   | confirm before revoking                                                  |
| `s2s.timeout`       | `0`      | kill after N ms; `0` = no timeout                                        |
| `s2s.verboseStderr` | `false`  | failure message stderr: `false` = one line, `true` = last 20 lines       |

stderr always streams into the `s2s` output channel, whatever `s2s.verboseStderr` says — that
channel is how a run stays diagnosable after a dropped connection. The setting only decides how
much of it a _failure message_ repeats.

None of these change s2s behaviour. Publication, keys and RPC are `s2s config`'s job — use
`s2s: Config…` and the binary's own `-h`.

## Notes

- The binary reads the **saved file**, so unsaved changes are invisible to it. Upload/offer/
  preview/publish/revoke ask before running on a dirty buffer; the extension never saves for you.
  If "Save and run" cannot save (a read-only mount, a failed write) you get an error, not silence.
- `upload`, `preview` and `publish` rewrite the note's frontmatter on disk (`genesis`, `author`,
  `kubo_cid`, `modified_date`) — they all go through the binary's `authorWrite`. Only `upload`
  reports `frontmatterWritten`, so the extension keys the reload on the action instead of the flag.
  If the buffer is clean **and** still the active editor, it is reloaded from disk (and verified
  against disk); if it is dirty, or you switched to another file during the run, you get **one**
  warning and nothing is reverted — saving then would discard the update, and the next
  `s2s: Offer` reads identity from the file.
- Progress goes to stderr and streams into the `s2s` output channel (the notification shows the
  last line, throttled) — that is how a long publish is diagnosable if your connection drops.

## Development

```sh
pnpm --filter vscode-s2s run build       # esbuild → dist/extension.js
pnpm --filter vscode-s2s run typecheck   # needs @types/vscode (pnpm install)
pnpm --filter vscode-s2s run test        # vitest: parse / argv / format + fake-binary spawn
```

The pure modules (`parse.ts`, `argv.ts`, `format.ts`) and the node-only `spawn.ts` / `state.ts`
carry all the logic and are tested in plain node against a fake `s2s` script. The extension host
is verified by hand: `s2s: Doctor`, then an action against the real binary.
