#!/usr/bin/env bash
# Context-aware deploy: resolve this script's own directory so it works no
# matter where it is invoked from (e.g. `safe-app/deploy.sh` from the repo root,
# or `pnpm deploy:safe-app` / `pnpm -C safe-app run deploy`).
cd "$(dirname "$0")"

pnpm build
rsync -avz --delete dist/ joera:/srv/publication-module/
