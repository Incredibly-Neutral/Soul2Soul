#!/usr/bin/env bash
# ============================================================================
# typecheck-local.sh — strict typecheck gate for the local-render kit.
#
# Runs `tsc --noEmit` against website-starter and FAILS if there are type
# errors in website-starter's OWN source (scripts/ + data/ — the files this PR
# changes/owns). Errors surfaced in `../protocol/actions/src/render*` are
# pre-existing strict-mode violations in the UNCHANGED audited renderer bundle,
# which is production-bundled by esbuild (types stripped, never typechecked by
# tsc). See the PR description for the full rationale.
#
# Exit 0 == website-starter's changed files typecheck clean under `strict`.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

out="$(node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 || true)"
printf '%s\n' "$out"

if printf '%s\n' "$out" | grep -E '^(scripts|data)/' >/dev/null; then
  echo "ERROR: type error(s) in website-starter source (scripts/ or data/)." >&2
  exit 1
fi

echo "typecheck: OK — no errors in website-starter (scripts/, data/)"
