# nvim-s2s — Soul2Soul from Neovim

A **thin wrapper** over the `s2s` binary ([`author-cli`](../author-cli)). It spawns the
binary with an absolute note path plus flags, reads the single JSON document it prints on
stdout, and formats that for the editor.

It is deliberately dumb about s2s: **it never reads the note**, never parses frontmatter,
never resolves a publication, never computes or caches a CID, and never re-reads `s2s`
config. Every domain question is answered by the binary.

- Spec: [`brain/specs/SPEC-nvim-s2s.md`](../brain/specs/SPEC-nvim-s2s.md)
- Contract it is built against: [`brain/specs/SPEC-author-cli.md`](../brain/specs/SPEC-author-cli.md)
  ("Binary API reference")

## Requirements

- Neovim **0.10+** (`vim.system`, `vim.ui.open`, replaceable `vim.notify` ids). Built and
  tested on 0.12.6.
- The `s2s` binary on `PATH`, or an absolute path in `setup({ bin = … })`.
  Check with `:S2S health` / `:checkhealth s2s`.

## Install

Pure Lua, no build step. With lazy.nvim, point it at the directory:

```lua
{
  dir = vim.fn.expand('~/code/s2s/nvim-s2s'),
  name = 'nvim-s2s',
  lazy = false, -- see the note below
  config = function()
    require('s2s').setup()
  end,
}
```

**`lazy = false` is not optional if your config sets `defaults = { lazy = true }`** (NvChad
does). Otherwise the spec has no trigger, lazy defers it, `config` never runs, and every
`:S2s*` command is `E492` — the plugin is installed, just never loaded. Confirm with
`:Lazy` (the plugin should show as loaded) or `:S2S health`.

Or without a plugin manager:

```lua
vim.opt.runtimepath:prepend(vim.fn.expand('~/code/s2s/nvim-s2s'))
require('s2s').setup()
```

`setup()` is optional if `s2s` is on `PATH` — the commands work with the defaults.

### Trying it without touching your config

```sh
nvim -u /home/joera/code/wt-nvim-core/nvim-s2s/dev/init.lua some-note.md
```

`dev/init.lua` prepends this checkout to the runtimepath and calls `setup()`, nothing else.

**Do not use `--cmd "set rtp+=…"` if you run a plugin manager.** lazy.nvim rebuilds the
runtimepath during startup, so the entry is gone by the time plugins are sourced and every
`:S2s*` command is `E492`. A `-u` config is read before plugins load, which is why it works;
alternatively install properly with the `dir` spec above.

Three commands that exercise a full round-trip and change nothing:

- `:S2S config list` — a real success envelope (17 keys, secrets masked by the binary).
- `:S2S config path` — path + env-file locations.
- `:S2S upload` on a note with no publication tag — the clean failure path (WARN with the
  binary's own message); then `:S2S last` shows the envelope in a float.

Note that `:S2S upload` / `:S2S preview` with a *resolvable* publication do real work:
real IPFS upload and real pins. Check `:checkhealth s2s` first — the environment it reports
is the one those commands will use.

## setup()

```lua
require('s2s').setup({
  bin = 's2s',            -- name on PATH or absolute path
  cwd = 'auto',           -- 'auto' walks up for .s2sconfig.json / .git / package.json
  notify = true,          -- false → silent successes; failures still notify
  open = true,            -- open render URLs after preview/publish
  copy_cid = false,       -- put upload's kuboCid in the + register
  confirm_revoke = true,  -- :S2S revoke asks first
  confirm_save = true,    -- ask before uploading when the buffer has unsaved edits
  abbrev = true,          -- `:s2s …` expands to `:S2S …`
  timeout = nil,          -- ms; nil = no timeout (uploads can take a minute)
})
```

These only change invocations or notifications. Anything that would change s2s *behaviour*
(publication, keys, RPC) is `:S2S config …`'s job — the plugin never overrides it.

## Commands

One command, one verb: `:S2S <action> [args]`. On the command line `s2s` expands to `S2S`
(a user command must start with an uppercase letter, so `:s2s` cannot be defined directly —
`:s2s upload` works because of a command-line abbreviation, on by default).

| Command | Runs |
|---|---|
| `:S2S upload [--publication <ens>]` | `s2s author upload <note> … --json` |
| `:S2S propose` | `s2s author propose <note> --json` (CID from the note's frontmatter) |
| `:S2S preview` | `s2s author preview <note> --json` |
| `:S2S publish` | `s2s author publish <note> --json` |
| `:S2S revoke` | `s2s author revoke <note> --json` (confirms first) |
| `:S2S new <name> --repo <o/r> …` | `s2s publication new … --json`, args verbatim |
| `:S2S config <set\|get\|unset\|list\|path> …` | `s2s config … --json`, args verbatim |
| `:S2S last` | no spawn — float with the last result for this buffer |
| `:S2S health` | no spawn — `:checkhealth s2s` |
| `:S2S help` | no spawn — options + command list |

Short forms resolve on unique prefix or a known alias: `up`, `prop`, `prev`, `pub`, `rev`,
`cfg`, `conf`, `result`, `check`, `?`. Ambiguous prefixes (`p`) are rejected with a notify.
Args after the verb are forwarded to the binary verbatim, so `:S2S upload --publication
polyphony.eth` uploads a note that has no `--s2s` tag.

The first cut's camelCase commands (`:S2sUpload`, `:S2sConfig`, …) still work as aliases.

`--json` is appended to every invocation, always last. `:S2S last` shows failures too, with
the exit code and the binary's `error` verbatim.

## Mappings

There are **no default keymaps**. Map your own leader at the `<Plug>`s:

```lua
vim.keymap.set('n', '<leader>su', '<Plug>(s2s_upload)')
vim.keymap.set('n', '<leader>sp', '<Plug>(s2s_propose)')
vim.keymap.set('n', '<leader>sv', '<Plug>(s2s_preview)')
vim.keymap.set('n', '<leader>sP', '<Plug>(s2s_publish)')
vim.keymap.set('n', '<leader>sl', '<Plug>(s2s_last)')
```

Full set: `s2s_upload`, `s2s_propose`, `s2s_preview`, `s2s_publish`, `s2s_revoke`,
`s2s_new`, `s2s_config`, `s2s_last`, `s2s_detail`, `s2s_health`, `s2s_help`.

Every `<Plug>` is just `<Cmd>S2S <verb><CR>`, so anything you can type you can map.

## What you see

- **Busy**: one notify per (buffer, action) — `s2s: uploading…` — replaced in place by the
  result. No floats, no timers.
- **Success**: ≤4 lines (verb + note + duration, then the fields that matter). The **detail
  float** (`:S2S last`) has everything, including fields this plugin does not know yet.
- **Failure**: the envelope `error` verbatim at WARN (exit 2, usage) or ERROR. Never raw
  stdout, never a Lua traceback.
- **Frontmatter**: when the binary rewrites the note's frontmatter, an unmodified buffer is
  silently reloaded (`:edit!`); a modified buffer gets a one-time error-level warning instead of
  the change being lost. If the binary *says* it wrote the frontmatter but the file's mtime and
  size are unchanged, you get an explicit error naming the file — that is a binary-side
  write-back failure, not a reload the plugin could have done.
- **Unsaved buffers**: `s2s` reads the note from disk, never from the buffer. A note that was
  never written gets "save it first?" instead of a confusing failure, and a dirty buffer gets
  "save before uploading?" — the on-disk version is not what's on your screen.
- **Noisy stdout**: stdout is supposed to be one JSON document, but the binary's
  fire-and-forget durability legs have leaked lines onto it. The plugin therefore locates the
  result document in stdout instead of demanding that the whole buffer be JSON. If nothing
  parses, the raw stdout and stderr of that run are written to
  `stdpath('cache')/nvim-s2s/last-failure.log` and the path appears in the `:S2S last` float.

## Testing

The plugin's own suite needs no chain, no network and no real binary (a fake `s2s` shell
script drives the spawn tests):

```sh
cd nvim-s2s
nvim --headless -l test/run.lua      # prints "ok <n> assertions, <f> failures"
```

Formatting is pure Lua (`lua/s2s/format.lua`: tables in, strings out, no `vim.*`), which is
what the fixture tests exercise. `spawn_e2e.lua` asserts the argv shape (absolute note
path, `--json` last, flag order) and every exit-code path against `test/fake-s2s`.

## Layout

```
plugin/s2s.vim        command stubs + <Plug> maps; nothing is required until used
lua/s2s/init.lua      setup(), the five author actions, config/new pass-through
lua/s2s/spawn.lua     the ONLY module that knows a binary exists (argv, cwd, JSON parse)
lua/s2s/format.lua    PURE result formatting (summary/lines/report/error_message)
lua/s2s/ui.lua        notifies, busy ids, the result float
lua/s2s/state.lua     per-buffer last result + busy flags (UI state only)
lua/s2s/commands.lua  :S2s* definitions, flag completion from the binary's --help
lua/s2s/health.lua    :checkhealth s2s
```

## Non-goals

Rendering markdown or HTML in the editor, browsing publications/CIDs/deals, managing pins,
or orchestrating upload→propose. Two commands, like the binary intends.
