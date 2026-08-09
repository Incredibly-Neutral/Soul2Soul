---
name: worktree-session
description: When delegating implementation to a builder sub-agent (s2s-builder), isolate the work in a git worktree on a feature branch, spawn the child pinned to that path, track the session→worktree→branch mapping, review the branch diff, then clean up. Use for ANY code-touching delegation to s2s-builder — never spawn a builder directly against the main checkout. Protects the live main checkout (production repo) and enables clean branch-diff review.
---

# Worktree-session — isolate builder delegation in a git worktree

## Why (the rule this skill enforces)

s2s is a **production** repo — "breakage means publications can't be authored or read" (AGENTS.md).
The main checkout at `~/code/s2s` is the live working tree. A builder sub-agent editing files there
risks: (a) leaving the main checkout dirty mid-WIP, (b) colliding with concurrent builders, (c)
mixing WIP into the current branch, making review a mess. **Every builder delegation gets its own
worktree on its own feature branch.** The main checkout stays clean; review = `git diff main...feat`.

This is orthogonal to the builder's model choice — it isolates the *filesystem*, not the model
output. Use it regardless of which model the builder runs.

## The protocol (run every delegation)

### 1. Make the worktree + branch (parent, before spawning)

Use the helper script — it handles naming and prints the values to bake into the spawn message:

```bash
~/code/s2s/.omnigent/skills/worktree-session/scripts/make-worktree.sh <slug>
# e.g. .omnigent/skills/worktree-session/scripts/make-worktree.sh avail-measurement
# → creates ../s2s-avail-measurement on branch feat/avail-measurement
# → prints: WORKTREE=/home/joera/code/s2s-avail-measurement  BRANCH=feat/avail-measurement
```

Branch naming: `feat/<slug>`. Worktree path: `~/code/s2s-<slug>` (sibling of the main checkout).
The worktree shares `.git` with the main checkout — no second clone, no fetch.

### 2. Record the mapping (before spawning, so it's durable)

Append to `~/code/s2s/brain/worktrees.md` (create if missing) one line per delegation:

```
- <ISO date> | session=<session_id or "pending"> | worktree=<path> | branch=<branch> | agent=s2s-builder | model=<model> | task=<one-line>
```

Session metadata's `git_branch`/`workspace` slots are NOT settable via `sys_session_create` today
(they exist but stay null), so this file is the source of truth for (session → worktree → branch).
See "Gotchas" below.

### 3. Spawn the child pinned to the worktree + model

`sys_session_create(agent_id=<s2s-builder agent_id>, model=<model>, title=<slug>, message=…)`.

The message MUST bake in the worktree contract — the child has no other way to know:

> Work ONLY in `<worktree-path>` (a git worktree on branch `<branch>`). `cd` there for EVERY
> command and use absolute paths rooted there. Do NOT touch the main checkout at `~/code/s2s`.
> As your FIRST action, report `pwd` and `git branch --show-current` so I can verify the binding.
> <…task body…>

Pin the model explicitly via `args.model` (e.g. `deepseek-v4-flash-0731`) — don't rely on the
agent default when the default is uncertain or previously corrupted. If a model corrupts on a
**clean first turn** (not a continuation), it's a model/builder-config integration issue: try a
different coder model (`kimi-k2-7-code`, `qwen3-coder-480b-a35b-instruct-turbo`,
`deepseek-v4-flash` plain) or inspect the builder agent config before retrying the same one.

**Always spawn fresh for a retry — never `sys_session_send` to continue a session that produced
corrupt/garbage output.** A model fed its own broken special-token leakage can compound the
failure. Tombstone via `sys_session_close` if the session is still a tracked child; if it already
drained (completed), it's gone and a fresh `(agent, title)` send creates a new session anyway.

### 4. Monitor + verify the binding

On the child's first response, confirm it reported `pwd == <worktree-path>` and
`git branch --show-current == <branch>`. If it reports the main checkout or a different branch,
stop and re-instruct — a mis-bound builder will edit the live tree.

### 5. Review the work (parent, after child completes)

```bash
git -C <worktree-path> diff main...<branch>     # the full change, isolated
git -C <worktree-path> log main..<branch --oneline
```

Optionally run tests/build in the worktree (see Gotchas — deps are per-worktree). When satisfied:
merge or cherry-pick from the main checkout, then remove the worktree.

### 6. Clean up

```bash
git -C ~/code/s2s worktree remove <worktree-path>   # refuses if dirty; --force to override
git -C ~/code/s2s branch -d <branch>                # once merged; -D to force-delete
```

Mark the `brain/worktrees.md` line as closed/merged.

## Gotchas

- **`node_modules` is per-worktree.** Worktrees don't share installed deps. Run `pnpm install` in
  the worktree (pnpm hardlinks from the global store — fast, not a full fetch). Hardhat artifacts,
  `.env`, generated ABIs likewise don't carry over — copy or regenerate. Tell the child to install
  before build/test.
- **Session metadata won't show the branch.** `sys_session_get_info` reports `git_branch: null`
  even for a worktree-bound session — the binding lives only in the spawn message + the worktree's
  existence + `brain/worktrees.md`. Don't trust `git_branch` to verify the binding; verify via the
  child's reported `pwd`/`git branch`.
- **Child must use absolute paths or `cd` first.** If the child's harness defaults relative-path
  resolution to the parent's cwd, tools could hit `~/code/s2s` despite the instruction. The
  "report `pwd` + branch first" step catches this.
- **`sys_session_create` has no `workspace`/`git_branch` param.** The harness supports
  workspace-pinning for *scheduled* tasks (`sys_scheduled_task_create`) but not interactive child
  sessions. This skill is the convention-based workaround until that lands.
- **Concurrent isolation is the payoff.** Two builders on two worktrees = zero collision. Two
  builders on the shared main checkout = mutual stomp. This is the real reason for the skill, not
  just review hygiene.

## Reference

- s2s AGENTS.md: production-repo statement, NKS persistence rules (state in repo or NKS, not
  local agent memory).
- Pi skills doc: `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`
  (skill structure, frontmatter, discovery).
- Builder agent_id: the CANONICAL id is recorded in `~/code/s2s/brain/agents.md` (single
  source of truth — avoids the stale-duplicate-id problem). Only fall back to
  `sys_agent_list` if agents.md is missing; never reuse a stale id listed there.
- Available models: `sys_list_models` (pick a coder model; pin verbatim by `id`).
