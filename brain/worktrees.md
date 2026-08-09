# Worktree session index

Source of truth for (builder session → worktree → branch) mappings. Session metadata's
`git_branch`/`workspace` slots are not settable via `sys_session_create`, so this file is the
durable record. One line per delegation; mark closed/merged when done.

<!-- format: - <ISO date> | session=<id or pending> | worktree=<path> | branch=<branch> | agent=<name> | model=<model> | task=<one-line> | status=<open|merged|abandoned> -->

- 2026-08-08 | session=f51e7575d62f440cb7c988c856a3dda8 | worktree=/home/joera/code/s2s-avail-measurement | branch=feat/avail-measurement | agent=s2s-builder | model=deepseek-v4-flash-0731 | task=publish-availability measurement instrumentation (3-listener neutralpress) | status=open
- 2026-08-08 | session=0d5ed8dfe0c14a61be442ae47eb53f2c | worktree=(none, main checkout — pre-skill) | branch=(none) | agent=s2s-builder | model=deepseek-v4-flash-0731 | task=publish-availability measurement instrumentation | status=abandoned (model output corruption — DSML/special-token leakage; killed via /exit)
- 2026-08-09 | session=(self cli) | worktree=/home/joera/code/s2s-two-indep-primary-stores | branch=feat/two-indep-primary-stores | agent=s2s-builder | model=deepseek-v4-flash-0731 | task=two independent primary stores for filecoin min-2-copies | status=open (PR https://github.com/Joera/S2S-monorepo/pull/12, not merged)
