# Handoff: Neovim plugin wrapper for the `s2s` binary (`nvim-s2s`)

**Date:** 2026-10-22
**Scope:** Build a Neovim plugin that is a **thin wrapper** over the `s2s` binary
(`author-cli`): spawn the binary, parse its `--json` stdout, format the result for the
buffer/UI, and drive the flows from normal-mode commands. **No reimplementation of s2s
logic in Lua.**
**Status:** Architecture proposed below; **nothing built yet**. The binary (author-cli)
and its `config` group are committed and green — the plugin is the next work item.
**Consumes:** `brain/specs/SPEC-author-cli.md` — especially the **Binary API reference
(machine contract)** section, which is the fixed interface this plugin is built against.

---

## 0. Open questions to resolve FIRST (lead the next session)

1. **`--cid` design choice (carried over from the upload↔propose split, still
   unconfirmed).** `s2s author propose <note> --cid <kuboCid>` takes the CID
   explicitly. joera was asked (2026-10-21 session) whether a **frontmatter-stored
   CID** is preferred (upload writes a key, propose reads it, `--cid` overrides). This
   determines the plugin flow: `:S2sPropose` either (a) asks for a CID / auto-fills it
   from plugin-held state (last `upload` result per buffer), or (b) relies on the note
   itself. **Get joera's answer before wiring `:S2sPropose`.**
2. **Runtime floor.** `nvim v0.9.5` is installed in this VM — **no `vim.system`** (that
   is 0.10+). Recommend Neovim **0.10** as the floor (`vim.system`, `vim.ui.open`,
   `vim.notify` with replaceable id) with no fallback; if 0.9 support is wanted, use
   `vim.fn.jobstart` instead. **Decision needed — it changes the spawn layer.**
3. **Where it lives.** Recommend an in-repo **`nvim-s2s/`** package (pure Lua, no build
   step, `lua/s2s/*.lua` tree), lazy.nvim `dir`-installable; not an npm workspace
   package (no node toolchain needed). Alternative: separate repo. **Confirm.**
4. **CID prefill UX.** Plugin remembers the last `kuboCid` from `upload`/`preview`/
   `publish` per buffer, so `:S2sPropose` runs with `--cid` without prompting. OK?

## 1. Why

The binary is the single source of truth for all domain logic (config resolution, chain
calls, ipfs, rendering, JSON contracts, exit codes). A plugin that re-parses
frontmatter, re-resolves publications, or re-derives CIDs in Lua would drift from the
binary (the SPEC-hosts lesson). The plugin should therefore be **dumb about s2s
semantics**: pass file paths + flags, read the JSON result, format and present it. The
only state it holds is **UI/UX state** (last result per buffer, busy indicators).

## 2. Current state of the binary (committed)

- Branch `feat/author-cli-scaffold`; relevant commits: `9dffd1d` (scaffold), `88c0e99`
  (upload↔propose split + `publication` group), `5704934` (**`s2s config` group** —
  bring-your-own RPC/Kubo/keys, env > project > user > defaults, secrets masked).
- Groups/actions: `s2s author` (upload/propose/preview/publish/revoke), `s2s
  publication` (new), `s2s config` (set/get/unset/list/path).
- Contract essentials (full detail in SPEC-author-cli.md):
  - `--json` → **exactly one JSON document on stdout**; stderr is human progress
    (logs/warnings) and is never parsed.
  - Failure envelope on stdout in `--json` mode: `{ "ok": false, "error": "<msg>" }`.
  - Exit codes: `0` ok · `1` runtime (missing env, RPC/render) · `2` usage.
  - Result objects are flat and typed per action (see API reference).
- No plugin exists yet; no nvim-related dirs in the repo.

## 3. The plugin architecture (proposal)

```
nvim-s2s/
  README.md
  plugin/s2s.vim            # bootstrap: define :S2s* commands lazily via require()
  lua/s2s/init.lua          # public API: setup(opts), upload(), propose(...), preview(),
                            #   publish(), revoke(), create_publication(), config.*, last(buf)
  lua/s2s/spawn.lua         # the ONLY place that touches the binary:
                            #   args → {code, stdout, stderr}; cwd resolution; --json always on
  lua/s2s/state.lua         # per-buffer last results (kuboCid, txHash), busy flags
  lua/s2s/format.lua        # pure: JSON result → notify/diagnostic/quickfix text (unit-tested)
  lua/s2s/commands.lua      # :S2sUpload/:S2sPropose/:S2sPreview/:S2sPublish/:S2sRevoke/
                            #   :S2sNew/:S2sConfig*; <Plug> mappings; argument completion
  lua/s2s/ui.lua            # vim.notify wrappers (replaceable-id busy spinner), floats,
                            #   quickfix mapping for render/errors
  lua/s2s/health.lua        # :checkhealth s2s — binary found, --version, config keys present
```

**Flow (one action):** resolve cwd (repo root: walk up for `.s2sconfig.json`/`.git`/
`package.json`; fallback `vim.fn.getcwd()`) → build argv `{bin, group, action, note,
flags..., "--json"}` with the note as an **absolute path** → `vim.system(..., {text=true,
cwd=...}, on_exit)` → parse stdout JSON → map exit code:
- `0` → `format.lua` → `vim.notify` (INFO) + store result in `state.lua`; `preview`/
  `publish` offer `vim.ui.open` on the preview/prod URL; `publish`/`revoke` show txHash.
- `1` → envelope error → `vim.notify` (ERROR) + optional `vim.diagnostic` on the note.
- `2` → usage error → `vim.notify` (WARN) + `:messages`.

**Formatting layer** (`format.lua`) is pure Lua over the API reference result shapes —
the one place with the binary's JSON types hardcoded, so it's the natural unit-test
target (busted or a tiny lua harness). Example: `upload` → one-line summary + kuboCid
copied to `+`/unnamed register? (decide), `propose` → txHash + "view on base scan"
(no URLs unless sourced), `new` → safeAddress + configCid.

**Config for the plugin:** `setup({ bin = "s2s" | "/abs/path", cwd = "auto"|path,
notify = true, open = true })` — all map to binary invocations; the plugin never
re-reads `s2s` config itself (that's what `s2s config` is for).

**Healthcheck:** run `s2s --version`; check `s2s config get` for a few keys (presence,
not values); surface the binary's own `s2s config` guidance if unconfigured.

**Testing:** unit-test `format.lua` against canned result JSON; integration-test
`spawn.lua` with a **fake `s2s` script** (echo fixture JSON + exit code) — no live
chain, no real binary needed. This mirrors how author-cli tests pure parts + smoke.

## 4. Hard rules

- The plugin **never** parses frontmatter, resolves publications, or derives CIDs — it
  only passes the note path and reads the JSON result.
- stdout is never logged raw; only the parsed result is formatted.
- No reimplementation of config precedence in Lua — if the plugin needs a value it asks
  the binary (`s2s config get ...`).
- Keep `--json` on **every** invocation (machine contract).

## 5. Next steps (in order)

1. Get joera's answers to §0 (—cid design, runtime floor, location, CID prefill).
2. Write `brain/specs/SPEC-nvim-s2s.md` (target behavior + the format/UI contract) —
   the plugin spec, per the house rule "every package needs a spec read before code".
3. Scaffold `nvim-s2s/` (init, spawn, state, format) with the fake-binary tests.
4. Wire commands + mappings + healthcheck; smoke-test in this VM's nvim (0.9.5 — so
   either use jobstart or install/verify 0.10).
5. Update SPEC-author-cli.md only if the plugin uncovers API gaps (e.g. a missing
   machine-read helper).

## 6. Verification / gates

- `format.lua` unit tests pass against canned results for all six result shapes.
- `spawn.lua` integration tests pass against a fake binary (ok / exit 1 / exit 2 / bad
  JSON / empty stdout).
- Manual smoke in nvim: `:S2sUpload` on a fixture note runs the real binary to the
  point it fails on missing env (exit 1) and surfaces the envelope as a clean notify —
  no Lua stack traces.
- The plugin repo stays green with the current author-cli gates untouched.
