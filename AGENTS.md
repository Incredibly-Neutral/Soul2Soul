# AGENTS.md — s2s / Polyphony

Reply like a colleague giving a quick spoken update. Plain words, short. Start with anything that needs my decision or action. If nothing does, say so in one line. Skip what went fine: routine steps, files read, passing checks. Only flag problems that actually affect me, and no more than three. Bold at most one thing per reply. No headers or lists unless there are truly separate items. No recap, no offers to do more.

This file is the entry point for any agent working in this repo. It replaces `brain/agents.md`,
which is retired: `brain/` no longer exists and nothing belongs there. **Do not create a second
tree beside `docs/`.** Product material goes in `docs/`, code goes in `src/`.

## Mode — state it before you touch anything

Every task opens with one line naming the mode: `mode: team` or `mode: solo — <reason>`. No
silent choice, no drift into one or the other halfway through.

- `mode: team` runs the `orchestrate` skill in full: plan, worktrees, fan-out, review, one PR,
then teardown. The task is not finished until `git worktree list` and `herdr pane list` show no
leftovers from this run — teardown is a completion condition, not a tidy-up afterwards.
- `mode: solo` is for genuinely mechanical work: a one-line fix, a typo, a doc sentence, a
read-only question. Name the reason. Anything that changes behaviour, touches more than one
file, or needs a review is not solo.

If the run gets messy, the mode does not lapse. Either restart the team run cleanly or say
plainly that it is being abandoned, and why.

## Read before code

Read the twin for the domain you are touching, then the branch for the package. A PR that
contradicts its spec is a bug in one of them.

| if you touch | read |
|---|---|
| anything, first | `docs/specs/README.md` (the layer rule + the index), `docs/specs/SUMMARY.md` |
| the system as a whole, contracts, topology | `docs/specs/system/SPEC-system-contract.md` |
| canonical types, validation, render orchestration | `docs/specs/system/SPEC-shared.md` |
| `src/author/*` (cli, obsidian, vscode, nvim) | `docs/specs/author/SPEC-author.md` → `SPEC-author-overview.md` → the host branch |
| `src/publication/*` (contracts, ens-contracts, safe-app) | `docs/specs/publication/SPEC-publication.md` → `-overview` → the part |
| agreements, offers, deals, revoke | `docs/specs/agreement/SPEC-agreement.md` + `publication/SPEC-publication-agreements.md` |
| gates, `canPublish` / `canRead` / `canReset` | `docs/specs/gates/SPEC-gates.md` |
| `src/press/*` (actions, serverless, scripts) | `docs/specs/press/SPEC-press.md` + `SPEC-protocol-actions.md` |
| payments, payee wallets, cost split | `docs/specs/monetization/SPEC-monetization.md` |
| `src/reader/*`, name resolution, CCIP, mirror | `docs/specs/reader/SPEC-reader.md` + `publication/SPEC-contracts-ens.md` |
| what to do when a spec and the code disagree | `docs/conventions.md` |

Scratch notes for a live task go in `.work/` (gitignored). Nothing durable lives there, and no
spec, ADR or RFC may cite it — if a finding matters, it gets promoted to `docs/research/`, an RFC,
an ADR or the branch spec. A review is the PR, not a file. See `docs/conventions.md`.

The paper — the protocol's argument — lives in its own repo, `~/code/polyphony/whitepaper/`
(published: polyphony.eth.link). `docs/prototype/` is what this build is. Neither is authority
for behaviour. The twin spec is. `docs/research/` and `docs/audits/` are dated
evidence — never authority.

## Where things live

```
docs/prototype/<domain>.md    this implementation (published: about.soul2soul.eth.link)
# separate repo: ~/code/polyphony/whitepaper/<domain>.md   the paper (polyphony.eth.link)
docs/specs/<domain>/          invariants + branches (read these)
docs/adr/  docs/rfc/          decisions and proposals, numbered forever, one namespace each
docs/research/  docs/audits/  dated evidence
docs/code-map/MAP.md          where code is, and how to dump it cheaply
docs/conventions.md           the layer rule
src/                          the code, by domain: author/, press/, publication/, reader/, shared/
.work/                        gitignored scratch for a task in flight — never cited, deleted freely
```

## Agents

The team is herdr panes running `pi`, not the omnigent registry. One shape:

```
lead (you, this pane)  ──spawns──▶  one pi per subtask, own worktree, own pane
       │                                    │
       │ plans, reviews, gates the PR       │ implements; never spawns
       ▼                                    ▼
     the task  ─────────────────────▶  branch → one PR a human approves
```

- Spawn with `herdr agent start <name> --kind pi --pane <id> -- --thinking off`. Workers run with
  reasoning **off** (the lead keeps `medium`) and are always started in a fresh worktree with the
  absolute path baked into the handoff; verify `pwd` and branch before anything else.
- One writer per worktree. The lead does not edit source, and does not work in the same checkout
  as a live worker.
- The omnigent/hermes path (s2s-prof, s2s-builder, agent-id registry) is retired: no sessions
  since October. Do not reuse those ids, and do not add new registrations — the ids below are
  dead and only listed so nobody resurrects one by accident.

`s2s-builder` ids, all retired: `155255a6ab9a45228112cadea587d8c7` ·
`1c99df88b14c41199402223982cc62d2` · `fb4e35f7c8e0461f80096427d09f1c02` ·
`7dc96f3b44c3478280616d3d7deb5960` · `ae1dcfc53ae9423b97fb57ee683a2d81` ·
`182d3471074f49dcb3097015f1d28ceb` · `deb9e89cf26446bf8f2be02a86e9f930` ·
`0050e254be174935a298bad7bab111c3` · `6bad9d80a6ed4ae688e1c0991423e5b5`

## Merge & PR protocol

Every complete task ends in a PR a human approves — never a silent ff-merge into main.

- **A task == one PR.** Subtasks are commits on the feature branch. The PR is the durable record
  (diff, comments, approval, subtask commits).
- Flow: worktree + branch → per-subtask commits → review → push → `gh pr create --base main` →
  human approves/merges → `git fetch origin && git merge --ff-only origin/main` → remove the
  worktree and branch.
- PRs base on `origin/main`; keep local main equal to it before opening one.
- Trivial/mechanical one-liners may be merged directly, but only in a `mode: solo` task, and the
  record goes in the commit message.
- **Update the spec after every PR**: the branch for the package, the ADR or RFC it settles, and
  the twin's index if the record set changed. Specs are the read-before-code contract; a PR that
  drifts from its spec is how specs rot.

## Invariants

`INV-*` numbers are the whitepaper's. They name requirements the paper actually states, and
nothing else. Never mint one: not for an implementation rule, not for a nice property a component
happens to have, not "to be consistent". Most invariants live in the protocol and the gates; a
component that carries one cites the existing number.

Everything else is a note, and notes are fine — a bullet under local gotchas, a sentence in a
sequence, a line in the spec's own prose. Unnumbered. A change that is merely correct does not
become important by getting a number, and the numbering stops meaning anything if everything gets
one.
