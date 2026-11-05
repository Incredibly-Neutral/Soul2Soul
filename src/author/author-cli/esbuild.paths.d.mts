export interface BuildPaths {
  dist: string;
  outfile: string;
  entry: string;
  defaults: string;
  defaultsCopy: string;
}

export function buildPaths(here: string): BuildPaths;
