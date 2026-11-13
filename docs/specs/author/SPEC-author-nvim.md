# SPEC-author-nvim — the Neovim plugin wrapper over the `s2s` binary

> **Parent:** [SPEC-author](SPEC-author.md) — the authoring front door. Host sibling:
> [SPEC-author-cli](SPEC-author-cli.md) (the binary this plugin spawns).
>
> **Type:** host specification — describes the `nvim-s2s/` package, the *editor* host that drives
> the headless binary from [SPEC-author-cli](SPEC-author-cli.md). Nothing is built yet.
>
> **Status:** DESIGN — decisions taken 2026-10-22 (see [Decisions](#decisions)). Next gate is the
> scaffold + the fake-binary test harness; no Lua exists in the repo yet.
>
> **Companion:** [SPEC-author-cli](SPEC-author-cli.md) — the **Binary API reference** section is
> the fixed contract this plugin is built against. Where the two disagree, the binary wins.

---

## The one-paragraph model

`nvim-s2s` is a **thin wrapper**: it spawns `s2s`, passes an absolute note path plus flags, reads
the single JSON document on stdout, and formats it for the editor. It is deliberately **dumb about
s2s semantics** — it never parses markdown or frontmatter, never resolves publications, never
derives or reads a CID, never reads `s2s` config. Every domain question is answered by the binary
(including "what is the CID of this note" — the answer lives in the note's frontmatter, written
there by `upload`, and the plugin just asks the binary to act on it). The only state the plugin
holds is UI state: the last result per buffer, busy flags, and the buffer↔disk sync decision.

## Decisions

Locked 2026-10-22 (the handoff's open §0 questions):

| # | Question | Decision |
|---|---|---|
| 1 | `--cid`: explicit flag vs. frontmatter | **Frontmatter.** `upload` writes `cid` back; `offer` falls back to it, `--cid` overrides. The plugin holds **no** CID state. |
| 2 | Neovim runtime floor | **0.10** (`vim.system`, `vim.ui.open`, `vim.notify` with replaceable id). No `jobstart` fallback. The dev VM runs **0.12.6**. |
| 3 | Where the plugin lives | **`nvim-s2s/` at the s2s repo root**, pure Lua, no build step, `dir`-installable. Not a pnpm workspace package. |
| 4 | CID prefill UX | Moot — there is no prefill. `:S2sPropose` needs no prompt after `:S2sUpload`. |
| 5 | Who reads the `.md` | **Only the binary.** Lua hands over an absolute path. Non-negotiable — see [Hard rules](#hard-rules). |
| 6 | Result-shape tolerance | Results are an **open shape**: format known fields, pass unknown scalars through, never reject extras. |
| 7 | `schema: 1` in the JSON envelope | **Deferred** (not built). Version check is `s2s --version` only, for now. |

Decision 1 detail: `cid` is *ephemeral* — it names one upload of one revision, is overwritten
by the next upload, and describes the note as of that upload. That staleness is only detectable by
the binary, which is why the value lives in the note it belongs to rather than in an editor
session. Consequence for the plugin: **no `changedtick` guard, no buffer cache** — a stale upload
is the user's business, and the fix is `:S2sUpload`, not a plugin heuristic.

## Package layout

```
nvim-s2s/
  README.md
  plugin/s2s.vim            # command stubs; :S2s* dispatch via require() (lazy, no startup cost)
  lua/s2s/init.lua          # public API: setup(opts), upload/propose/preview/publish/revoke/new,
                            #   config {get,set,unset,list,path}, last(buf)
  lua/s2s/spawn.lua         # the ONLY place that touches the binary
  lua/s2s/state.lua         # per-buffer last result + busy flags (UI state only)
  lua/s2s/format.lua        # pure: result table → lines/segments (unit-tested)
  lua/s2s/commands.lua      # :S2s* definitions, <Plug> mappings, flag completion
  lua/s2s/ui.lua            # notify wrappers, busy spinner (replaceable id), floats, quickfix
  lua/s2s/health.lua        # :checkhealth s2s
```

Module boundary rule: `format.lua` is **pure** (no `vim.*` beyond nothing — plain Lua tables in,
strings out). `spawn.lua` is the only module that knows a binary exists. `commands.lua` is the only
module that knows about `vim.api` keymaps/commands. Everything else is glue.

## Invocation contract

One action = one process:

1. **Resolve cwd** — walk up from the buffer's file for `.s2sconfig.json`, then `.git`, then
   `package.json`; fall back to `vim.fn.getcwd()`. `setup({ cwd = "auto" | <path> })` overrides.
   The note path is still passed **absolute** — cwd only anchors config/project resolution.
2. **Build argv** — `{ bin, group, action, <abs note>, flags..., "--json" }`. `--json` on every
   invocation, always last. Never construct a command that omits it.
3. **Spawn** — `vim.system(argv, { text = true, cwd = cwd, timeout = <opts.timeout> }, cb)`.
   `text = true` (no manual chunk stitching). Long-running (upload/publish can take a minute):
   no artificial timeout by default; the busy indicator is the timeout.
4. **Parse** — `stdout` is exactly one JSON document. Parse it; on parse failure surface a
   plugin-level error that includes the **first line of stderr** and says "not a JSON result — is
   `bin` the s2s binary?" rather than dumping raw stdout.
5. **Map exit code**:

| exit | meaning | UI |
|---|---|---|
| `0` | result on stdout | `format.lua` → notify INFO (+ store in `state.lua`) |
| `1` | runtime failure | envelope `error` → notify ERROR (+ `vim.diagnostic` on the note if the message names a frontmatter field) |
| `2` | usage error | notify WARN, message points at `:S2sHelp` / the binary's own `-h` |
| other | killed / crash | notify ERROR with the signal and stderr tail |

stderr is **never** logged raw and never parsed — it is human progress. The one exception is
surfacing a *single* line of it in a failure message when stdout was not JSON.

## Result handling

The binary's result types (see SPEC-author-cli) are the contract. The plugin consumes exactly
these fields and treats everything else as decoration:

| Field | Used for |
|---|---|
| `action` | routing to the formatter; sanity check that the binary did what we asked |
| `objectId` | identity line + clipboard |
| `cid` | identity line + clipboard (`upload` → `+` register, opt-in) |
| `txHash` | "on-chain" line, copyable |
| `render.previewUrl` / `render.prodUrl` / `render.path` | openable target (`vim.ui.open`, `opts.open`) / quickfix entry |
| `frontmatterWritten` | buffer↔disk sync (below) |
| `publication`, `subdomain` | context line |
| `error` | failure envelope (`ok == false`) |

**Open-shape rule.** `format.lua` renders the known set and then appends any *additional* scalar
string/number fields it finds as generic `key: value` lines (sorted, in the detail float and the
notify body — not in the one-line summary). Unknown **nested** fields are ignored. No schema
validation, no whitelist that errors on extras. This is what lets `upload` grow an author-contract
record and an author-level genesis without a plugin release.

**Buffer↔disk sync.** `upload`/`publish`/`preview` may rewrite the note's frontmatter. When the
result says `frontmatterWritten`:

- buffer unmodified (`vim.bo.modified == false`) → silent `:edit` (reload), notify nothing.
- buffer modified → do **not** reload; notify WARN "s2s updated the note's frontmatter on disk —
  `:e!` to take it, or `:w` will clobber it". One notify per buffer, not per action.

This is the only place the plugin cares that the note is also a file on disk.

## UI contract

- **Busy**: one `vim.notify` with `{ id = <stable per-buffer id>, replace = ... }` — "s2s: uploading…"
  replaced in place by the result. No float spinners; no timers. The notify id is derived from
  buffer number + action so two actions on two buffers don't fight.
- **Success**: one notify, ≤4 lines. Line 1 verb + note basename + human duration. Then the identity
  fields that matter for the action. Never the whole result.
- **Detail float** (`:S2sLast` / `<Plug>(s2s_detail)`): full known set + pass-through extras, one
  `key: value` per line, `q` to close. This is where "everything else" goes so the notify stays small.
- **Open**: `preview` → open `previewUrl` when `opts.open`; `publish` → open `prodUrl`. `upload`
  and `offer` have nothing to open. **No URLs are invented** — only `render.*` fields the binary
  returned are ever opened or printed.
- **Errors**: notify ERROR with the envelope `error` verbatim (it's written for humans and already
  points at the fix). No Lua stack traces, no "something went wrong".
- **Clipboard**: `objectId`/`cid`/`txHash` copyable via the detail float keys; `upload` also
  offers the CID in `+` when `opts.copy_cid = true` (default `false` — silently mutating a register
  on every upload is rude).

## Commands

| Command | Binary call |
|---|---|
| `:S2sUpload` | `author upload <note> --json` |
| `:S2sPropose` | `author offer <note> --json` (CID from frontmatter) |
| `:S2sPreview` | `author preview <note> --json` |
| `:S2sPublish` | `author publish <note> --json` |
| `:S2sRevoke` | `author revoke <note> --json` (confirms first — it retracts on-chain) |
| `:S2sNew <name> --repo <o/r> …` | `publication new <name> --repo … --json` |
| `:S2sConfig` | `config <set\|get\|unset\|list\|path> … --json` |
| `:S2sLast` | no spawn — formats `state.last[buf]` |
| `:S2sHealth` | no spawn — `health.lua` |
| `:S2sHelp` | no spawn — prints `setup` opts + command list |

- `:S2sNew` and `:S2sConfig*` pass trailing args through to the binary verbatim (no flag
  re-implementation, no validation); `flag completion` is read from the binary's `-h` output once
  per session and cached in memory.
- `<Plug>` mappings for all of the above; **no default keymaps** (users pick their leader).
- `:S2sRevoke` is the only destructive command and the only one with a confirmation
  (`vim.ui.select`), because the binary-side arg `--publication` is easy to get wrong silently.
- Commands error clearly when the current buffer has no file (`:S2sUpload` on a scratch buffer).

## setup()

```lua
require('s2s').setup({
  bin = 's2s',            -- or absolute path; resolved via vim.fn.exepath when relative
  cwd = 'auto',           -- 'auto' | absolute path
  notify = true,          -- false → silent successes, errors still notify
  open = true,            -- open render URLs on preview/publish
  copy_cid = false,       -- put upload's cid in the + register
  confirm_revoke = true,
  timeout = nil,          -- ms; nil = no timeout
})
```

Every option maps onto an invocation or a notify decision. **None of them change s2s behavior** —
anything that would (publication, keys, RPC) is `s2s config`'s job and stays there.

## :checkhealth s2s

- `bin` resolves → `s2s --version` (report version; WARN below `0.1.0`).
- `s2s config path` exists / `s2s config list --json` parses → report **which keys are set only**
  (names, never values — they include secrets; the binary masks them, and the plugin still only
  prints presence).
- Note the Neovim version against the 0.10 floor.
- On failure, print the binary's own `s2s config` guidance verbatim rather than inventing setup
  steps.

## Testing

| Layer | How |
|---|---|
| `format.lua` | Pure table-in/strings-out tests. Fixtures: one canned result per action (`upload`, `offer`, `preview`, `publish`, `revoke`, `publication new`), the failure envelope, an empty `{}`, and a **future-shaped** result with unknown scalars + an unknown nested object (must not error, must pass the scalars through, must drop the nested one). |
| `spawn.lua` | Integration against a **fake `s2s`** shell script on `PATH` (or `bin = <script>`): ok / exit 1 / exit 2 / exit 3 / non-JSON stdout / empty stdout / huge stdout. Assert argv shape (note is absolute, `--json` present, trailing args in order) and cwd. No live chain, no real binary. |
| `state.lua` | last-result-per-buffer + busy flag lifecycle (set on spawn, cleared on exit, survives buffer switch, dropped on `BufWipeout`). |
| manual smoke | `:S2sUpload` on a fixture note against the real binary, to the point it fails on missing env (exit 1) → clean ERROR notify, no stack trace. Then `:S2sPropose` / `:S2sPreview` the same way. |

Test runner: `plenary.nvim`'s busted shim, invoked as `nvim --headless -l test/run.lua`
(`-l` needs 0.9+, fine at the 0.10 floor); no external test dependency in the plugin's own runtime
path. CI is out of scope for now — the gate is "runs in this VM's 0.12.6".

## Hard rules

1. **The plugin never opens the note.** No markdown parsing, no frontmatter parsing, no YAML, no
   reading `cid`/`genesis` out of the file, no writing to it. Path in, JSON out.
2. **The plugin never re-implements config precedence.** It asks the binary (`config get/list`).
3. **`--json` on every invocation**, and only the parsed result is ever formatted — stdout is never
   logged raw, only surfaced as a one-line "not JSON" diagnostic.
4. **No invented URLs.** Only `render.*` fields returned by the binary are opened/printed.
5. **No result validation.** Open shapes; unknown fields are passed through or ignored, never fatal.
6. **No re-derivation.** If the plugin finds itself computing a CID, resolving a publication,
   defaulting a flag, or guessing a cwd from a filename, it should be asking the binary instead.

## Non-goals

- Editing s2s content inside Neovim beyond the note buffer the user already has open.
- A publication/chain browser, CID viewer, or deal ledger (that is `cid-mirror` / `0xobsidian`).
- Rendering markdown, previewing HTML inside Neovim, or managing IPFS pins.
- Any s2s state machine (upload→propose orchestration prompts). `:S2sUpload` then `:S2sPropose`
  is two commands; the binary already made them two steps on purpose.
- Windows. (No `spawn` abstraction beyond `vim.system`.)

## Open / pending

- **Author-contract identity (upstream, unscoped).** `upload` may grow a record on an author smart
  contract plus an author-level genesis-equivalent. Nothing in this spec assumes otherwise: the
  plugin's resize of the contract is the open-shape rule above. Re-read SPEC-author-cli when that
  lands; the plugin should need no change.
- **`schema: 1` envelope field** — deferred. If the binary ever returns a shape the plugin cannot
  interpret at all, this is what should be added first (then `format.lua` gets exactly one strict
  check: `schema == 1`).
- **`:S2sNew` UX** — the flag surface (`--repo`, `--branch`, `--author`, `--owner`) is wide. Current
  answer is raw pass-through; a `vim.ui.input` sequence is a later nicety, and it would need the
  binary's validation messages to be good enough to drive it.

## Verification gates

- `format.lua` tests pass for all six result shapes + failure envelope + open-shape case.
- `spawn.lua` tests pass for ok / 1 / 2 / other / non-JSON / empty / large stdout.
- `:checkhealth s2s` runs clean on this VM (0.12.6, real binary present).
- Manual smoke: `:S2sUpload` surfaces the missing-env failure as a single clean ERROR notify; no
  Lua stack trace, no raw stdout, no hung busy notify.
- `pnpm test` in `author-cli` and the plugin's own tests both green; no change to the binary's gates.
