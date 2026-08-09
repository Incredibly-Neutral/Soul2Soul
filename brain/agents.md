# S2S Agent Registry & Topology

> Single source of truth for s2s agent registrations. Avoids the stale-duplicate-id
> problem (8 dead `s2s-builder` agent_ids accumulated from machine-local re-uploads —
> see "Stale ids" below). Reuse the CANONICAL id via `sys_session_create(agent_id=...)`;
> re-upload via `config_path` only on intentional revision, then update this file.
>
> Aligns with AGENTS.md: agent configs are project state → live in the repo
> (`.omnigent/agent-configs/`), not machine-local files.

## Topology

```
s2s-prof  (orchestrator)  ──spawns──▶  s2s-builder  (leaf implementer)
   │                                        │
   │ plans, delegates, reviews              │ implements from handoffs,
   │ (modeled on polly — see below)         │ worktree-isolated, no spawning
   ▼                                        ▼
brain/handoffs/  ──────────────────▶  git worktree on feat/<slug>
```

- **s2s-prof** — the dispatcher. Reads/author handoffs, decomposes goals, spawns
  builders in worktrees, reviews branch diffs, merges (or hands to human). Future
  direction: model after **polly** (full orchestrator config — see "s2s-prof as
  polly" below).
- **s2s-builder** — the leaf. Implements code from handoffs. Does NOT spawn. Always
  works in a worktree (worktree-session skill). Pinned to `deepseek-v4-flash-0731`.

## Canonical registrations

### s2s-builder
- **Config:** `.omnigent/agent-configs/s2s-builder/config.yaml` (versioned in repo;
  agent-directory form — the bundle loader requires the file named `config.yaml`)
- **agent_id (CANONICAL):** `155255a6ab9a45228112cadea587d8c7` — registered
  2026-08-08 from the repo config via
  `sys_session_create(config_path="code/s2s/.omnigent/agent-configs/s2s-builder", model="deepseek-v4-flash-0731", ...)`. Reuse THIS id for every spawn; re-upload via config_path only on intentional revision, then update this line.
- **Model:** `deepseek-v4-flash-0731` — **always pin at spawn** (`args.model`).
  The hermes_profile default proved unreliable (corruption on unpinned spawn,
  2026-08-08: DeepSeek special-token leakage). Pinning is load-bearing.
- **Harness:** `hermes-native`, profile `s2s-builder`.
- **Spawn contract:** every spawn uses the worktree-session skill
  (`.omnigent/skills/worktree-session/`) — make worktree, bake path into message,
  verify `pwd`+`branch` first, track in `brain/worktrees.md`.

### s2s-prof
- **agent_id:** `cc3c9d2b9d9e49269d52d7c0860fe071` (registered once, reused — the
  clean pattern; do NOT re-upload unless intentionally revising).
- **Future:** formalize as a polly-style orchestrator config (see below).

## Stale s2s-builder ids — DO NOT REUSE

Each was a machine-local re-upload of an iterated builder config (pre-repo-config
era). All backing sessions are `failed`. They are inert corpses — the registry
accumulates them with no GC — but launching from one runs a stale/unknown config
revision. The canonical id above (once registered) supersedes all of these:

- `1c99df88b14c41199402223982cc62d2` — "implements code" (generic; used in the
  2026-08-08 corruption incident)
- `fb4e35f7c8e0461f80096427d09f1c02` — "implements code from handoff documents;
  uses deepseek/deepseek-v4-flash" (richest desc; likely the latest pre-repo rev)
- `7dc96f3b44c3478280616d3d7deb5960`
- `ae1dcfc53ae9423b97fb57ee683a2d81`
- `182d3471074f49dcb3097015f1d28ceb`
- `deb9e89cf26446bf8f2be02a86e9f930`
- `0050e254be174935a298bad7bab111c3`
- `6bad9d80a6ed4ae688e1c0991423e5b5`

If `sys_agent_list` shows a NEW unlisted `s2s-builder` id, it means someone
re-uploaded ad-hoc — re-register from the repo config and update this file.

## s2s-prof as polly — direction (future workstream)

Model s2s-prof after **polly** (the omnigent orchestrator template). Prof becomes
the dispatcher; s2s-builder is its leaf implementer. Adopt from polly's config:

- `spawn: true` (prof spawns builders) + `tools.agents: [s2s-builder]` roster.
- The `implement` / `review` / `explore` / `search` `args.purpose` taxonomy on
  every `sys_session_send`.
- `headless_subagent_purpose_guard` + `spawn_bounds` (`max_dispatches_per_turn`,
  `dispatch_tools: [sys_session_send, sys_session_create]`).
- Cross-vendor review (different model reviews the implementer's diff) — once a
  second coder model/vendor is available.
- "Act in the same turn you announce"; supervise via inbox, never busy-poll.
- `ask_timeout: 86400`; `os_env`/`terminals` with `allow_cwd_override` (already
  in s2s-builder; prof needs it too for worktree management).

Skip for prof until ready: the 7-CLI roster preflight (polly's is multi-vendor;
s2s has one builder harness). Prof's "roster" is just s2s-builder (single worker)
until a second implementer is added.

Deliverable shape: `.omnigent/agent-configs/s2s-prof.yaml`, registered once,
agent_id recorded above replacing the current ad-hoc one. This is a separate,
larger lift — not started yet.

## Related
- `brain/worktrees.md` — (session → worktree → branch) tracking index.
- `.omnigent/skills/worktree-session/SKILL.md` — the delegation-isolation protocol.
- AGENTS.md — production-repo statement, persistence rules.
