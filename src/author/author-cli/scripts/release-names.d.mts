export interface ReleaseNames {
  name: string;
  tarball: string;
  checksum: string;
}

export function releaseNames(version: string): ReleaseNames;

export const RELEASE_REPO: string;
