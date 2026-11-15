// The build must land its output in this package's `dist/`, whatever directory
// the script is started from. esbuild resolves relative paths against cwd, so
// every path is derived from the script's own directory instead.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPaths } from '../esbuild.paths.mjs';

let elsewhere = '';

afterEach(() => {
  if (elsewhere) rmSync(elsewhere, { recursive: true, force: true });
  elsewhere = '';
});

describe('esbuild paths', () => {
  it('resolves every path from the script directory, not the cwd', () => {
    const here = '/packages/author-cli';
    const original = process.cwd();
    elsewhere = mkdtempSync(join(tmpdir(), 's2s-build-'));
    process.chdir(elsewhere);
    try {
      const paths = buildPaths(here);
      expect(paths.outfile).toBe(join(here, 'dist', 'cli.cjs'));
      expect(paths.entry).toBe(join(here, 'src', 'cli.ts'));
      expect(paths.defaultsCopy).toBe(join(here, 'dist', 'defaults.json'));
      for (const path of Object.values(paths)) {
        expect(path.startsWith(elsewhere)).toBe(false);
      }
      for (const path of [paths.dist, paths.outfile, paths.entry, paths.defaults, paths.defaultsCopy]) {
        expect(path.startsWith(here)).toBe(true);
      }
    } finally {
      process.chdir(original);
    }
  });
});

describe('repo dist mirror', () => {
  it('puts the second copy at the repo-root dist/cli, beside dist/safe-app', () => {
    const here = '/repo/src/author/author-cli';
    const paths = buildPaths(here);
    expect(paths.repoDist).toBe(join('/repo', 'dist', 'cli'));
    expect(paths.repoCli).toBe(join(paths.repoDist, 'cli.cjs'));
    expect(paths.repoDefaults).toBe(join(paths.repoDist, 'defaults.json'));
  });
});
