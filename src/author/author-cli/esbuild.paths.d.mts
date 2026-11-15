export interface BuildPaths {
  dist: string;
  outfile: string;
  entry: string;
  defaults: string;
  defaultsCopy: string;
  /** Repo-root `dist/cli/`, mirroring the package build for deploy. */
  repoDist: string;
  repoCli: string;
  repoDefaults: string;
  repoInstall: string;
}

export function buildPaths(here: string): BuildPaths;
