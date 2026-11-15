// Paths for the CLI bundle, always resolved from the package directory.
//
// esbuild resolves relative paths against the process cwd, so `entryPoints:
// ['src/cli.ts']` silently builds nothing (or the wrong tree) when the script
// is invoked from anywhere but the package root. Every path here derives from
// `here` — the directory this script lives in — so the output lands in the
// package's own `dist/` regardless of where the build was started.
//
// `repoDist` is the second copy: the repo-root `dist/cli/`, beside
// `dist/safe-app/`, where deploy and manual copying look for built artefacts.

import { join } from 'node:path';

/**
 * @param {string} here absolute path of the package (the script's directory)
 */
export function buildPaths(here) {
  const dist = join(here, 'dist');
  return {
    dist,
    outfile: join(dist, 'cli.cjs'),
    entry: join(here, 'src', 'cli.ts'),
    defaults: join(here, 'defaults.json'),
    defaultsCopy: join(dist, 'defaults.json'),
    repoDist: join(here, '..', '..', '..', 'dist', 'cli'),
    repoCli: join(here, '..', '..', '..', 'dist', 'cli', 'cli.cjs'),
    repoDefaults: join(here, '..', '..', '..', 'dist', 'cli', 'defaults.json'),
    repoInstall: join(here, '..', '..', '..', 'dist', 'cli', 'install.sh'),
  };
}
