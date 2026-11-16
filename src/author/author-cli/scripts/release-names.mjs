// The one thing the pack script and the test both need: what the release files
// are called. Kept separate so importing it does not run the pack.

/** @param {string} version */
export function releaseNames(version) {
  const name = `s2s-${version}-node`;
  return { name, tarball: `${name}.tar.gz`, checksum: `${name}.tar.gz.sha256` };
}

/** Owners of the release: the download URL is derived from these. */
export const RELEASE_REPO = 'Incredibly-Neutral/Soul2Soul';
