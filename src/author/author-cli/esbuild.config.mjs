import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { buildPaths } from './esbuild.paths.mjs';

const production = process.argv[2] === 'production';

const here = dirname(fileURLToPath(import.meta.url));
const sharedRoot = resolve(here, '../../shared');
const paths = buildPaths(here);

/**
 * Bundle `@s2s/soul2soul-shared` from SOURCE, not from its built `dist/`.
 *
 * Without this, every CLI build silently depends on `shared` having been
 * `tsc`-built first: esbuild resolves the package to `dist/index.js`, so a
 * source edit in `shared/src` produces a stale bundle (2026-11-05: the
 * `maintain-cache` log change was missing from dist until shared was rebuilt).
 * The build now reads the subpath map straight from shared's package.json and
 * redirects each export to its `src/*.ts` twin, so a CLI build is a pure
 * function of the working tree.
 *
 * Type-checking still uses shared's emitted `.d.ts` (`tsc -noEmit` in the build
 * script) — this only changes what the bundle reads.
 */
const sharedEntrypoints = (() => {
  const pkg = JSON.parse(readFileSync(join(sharedRoot, 'package.json'), 'utf8'));
  const map = new Map();
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof target === 'string' ? target : target?.default;
    if (typeof entry !== 'string') continue;
    // ./dist/foo/bar.js → ./src/foo/bar.ts
    const source = entry
      .replace(/^\.\/dist\//, 'src/')
      .replace(/\.js$/, '.ts');
    const abs = join(sharedRoot, source);
    if (!existsSync(abs)) continue;
    map.set(subpath === '.' ? '@s2s/soul2soul-shared' : `@s2s/soul2soul-shared/${subpath.slice(2)}`, abs);
  }
  return map;
})();

/** Resolve the package + its subpaths to shared's TypeScript sources. */
const sharedFromSource = {
  name: 'shared-from-source',
  setup(build) {
    build.onResolve({ filter: /^@s2s\/soul2soul-shared(\/.*)?$/ }, (args) => {
      const target = sharedEntrypoints.get(args.path);
      // Unknown subpath: fall back to package resolution rather than a silent miss.
      return target ? { path: target } : null;
    });

    // shared uses nodenext-style `./x.js` specifiers for relative imports;
    // esbuild does not map those to `./x.ts`, so do it here — shared's own
    // files only, never inside node_modules.
    build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      if (!args.resolveDir.startsWith(sharedRoot)) return null;
      if (args.resolveDir.includes('node_modules')) return null;
      const candidate = resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts');
      return existsSync(candidate) ? { path: candidate } : null;
    });
  },
};

/**
 * Copy `defaults.json` next to the bundle.
 *
 * The defaults are a config LAYER, not code: shipping them as a file keeps them
 * editable by the operator and swappable for a fetched copy later. The bundle
 * looks them up beside itself (`core/defaults.ts`), so the build has to put them
 * there — a missing file is tolerated at runtime (builtin constants take over),
 * which is exactly why the copy must not be silently forgotten.
 */
function copyDefaults() {
  // From the script directory, never cwd: the build must produce the same
  // output whether it is run from the package root or anywhere else.
  mkdirSync(paths.dist, { recursive: true });
  if (!existsSync(paths.defaults)) {
    throw new Error(`esbuild: ${paths.defaults} is missing — the defaults layer would not ship`);
  }
  copyFileSync(paths.defaults, paths.defaultsCopy);
}

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: [paths.entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: paths.outfile,
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  treeShaking: true,
  conditions: ['import'],
  plugins: [sharedFromSource],
};

if (production) {
  await esbuild.build(options);
  copyDefaults();
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  // The dev bundle reads the same `dist/defaults.json`; re-copying on every run
  // is what keeps `node dist/cli.cjs` honest after an edit to the file.
  copyDefaults();
}
