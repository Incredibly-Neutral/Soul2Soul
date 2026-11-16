// Pack the CLI for download: one tarball, one checksum, no registry.
//
// The bundle is a single CJS file plus `defaults.json`, so "release" is a copy
// and a `tar`. Keeping it here rather than in a publishing pipeline means the
// artefact is reproducible from a clean checkout with `pnpm pack:cli`.
//
//   pnpm pack:cli                  build, then pack
//   pnpm pack:cli -- --no-build    pack whatever `dist/` already holds
//
// Output lands in the repo-root `dist/cli/`, beside the bundle it was packed from:
//   s2s-<version>-node.tar.gz          cli.cjs + defaults.json at the archive root
//   s2s-<version>-node.tar.gz.sha256   `<hash>  <file>`, the `sha256sum -c` shape
//
// That directory is the one a person copies from (`dist/cli/cli.cjs` runs in
// place), so the packed archive is never somewhere else than its own source.
//
// The archive is platform-neutral on purpose: it needs node 20 or newer and
// nothing else, which is why the name says `-node` rather than an OS. Upload
// both files to the release tagged `v<version>`; `install.sh` fetches by that
// tag and verifies the checksum before unpacking.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPaths } from '../esbuild.paths.mjs';

import { releaseNames } from './release-names.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const paths = buildPaths(packageRoot);
const dist = paths.dist;
const outDir = paths.repoDist;

const skipBuild = process.argv.slice(2).includes('--no-build');

const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || version.trim() === '') {
  throw new Error('pack: package.json has no version to name the artefact after');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`pack: ${command} ${args.join(' ')} failed (exit ${result.status ?? 'signal'})`);
  }
}

if (!skipBuild) {
  run('node', [join(here, '..', 'esbuild.config.mjs'), 'production']);
}

const names = releaseNames(version);
mkdirSync(outDir, { recursive: true });

// Staging lives in the temp dir: the output directory also holds the bundle
// this archive is built from, so it is cleaned file by file, never wholesale.
const staged = mkdtempSync(join(tmpdir(), 's2s-pack-'));
for (const stale of [names.tarball, names.checksum]) {
  rmSync(join(outDir, stale), { force: true });
}

// `defaults.json` must sit beside the bundle at run time (`core/defaults.ts`),
// so the archive root is flat: unpacking into the install directory is the
// whole install.
for (const file of ['cli.cjs', 'defaults.json']) {
  const source = join(dist, file);
  try {
    copyFileSync(source, join(staged, file));
  } catch {
    throw new Error(`pack: ${source} is missing — run the build first (drop --no-build)`);
  }
}
// Installed as a symlink target, so it has to be executable even before the
// installer touches the mode.
chmodSync(join(staged, 'cli.cjs'), 0o755);

try {
  run('tar', ['-czf', join(outDir, names.tarball), '-C', staged, 'cli.cjs', 'defaults.json']);
} finally {
  rmSync(staged, { recursive: true, force: true });
}

const hash = createHash('sha256').update(readFileSync(join(outDir, names.tarball))).digest('hex');
writeFileSync(join(outDir, names.checksum), `${hash}  ${names.tarball}\n`);

const bytes = readFileSync(join(outDir, names.tarball)).length;
process.stdout.write(
  [
    `packed ${names.tarball}  (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
    `       ${names.checksum}  sha256 ${hash.slice(0, 16)}…`,
    '',
    `upload both to the release tagged v${version}:`,
    `  gh release create v${version} ${join(outDir, names.tarball)} ${join(outDir, names.checksum)} --title v${version}`,
    '',
  ].join('\n'),
);
