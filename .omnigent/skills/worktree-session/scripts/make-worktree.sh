#!/usr/bin/env bash
# make-worktree.sh — create a git worktree on a feature branch for an isolated builder session.
# Usage: make-worktree.sh <slug>
#   slug  e.g. "avail-measurement"  →  branch feat/avail-measurement, path ~/code/s2s-avail-measurement
# Prints: WORKTREE=<abs-path>  BRANCH=<branch>   (for the orchestrator to bake into the spawn message)
# Exits non-zero on error. Idempotent-ish: if the worktree+branch already exist, re-prints and exits 0.
set -euo pipefail

slug="${1:-}"
if [[ -z "$slug" ]]; then
  echo "usage: $0 <slug>" >&2
  exit 2
fi

# sanitize slug: loweralnum + hyphens
slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -c '[:alnum:]-' '-' | sed 's:^-*::; s:-*$::; s:-\{2,\}:-:g')"
if [[ -z "$slug" ]]; then
  echo "error: slug sanitized to empty" >&2
  exit 2
fi

main_repo="$HOME/code/s2s"
branch="feat/$slug"
worktree="$HOME/code/s2s-$slug"

cd "$main_repo"

# If worktree already exists, assume prior setup and just report.
if [[ -d "$worktree" ]]; then
  echo "WORKTREE=$worktree  BRANCH=$branch  (already exists)" >&2
  echo "WORKTREE=$worktree  BRANCH=$branch"
  exit 0
fi

# Create the worktree on a new branch. -b creates the branch; fails if it already exists
# (use -B to force-reset, not wanted here — a pre-existing feat/ branch should be inspected first).
if ! git worktree add "$worktree" -b "$branch"; then
  echo "error: git worktree add failed for $worktree on $branch" >&2
  echo "check: git worktree list ; git branch | grep $branch" >&2
  exit 1
fi

echo "WORKTREE=$worktree  BRANCH=$branch"
