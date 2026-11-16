import { describe, expect, it } from 'vitest';

import { RELEASE_REPO, releaseNames } from '../scripts/release-names.mjs';

describe('release artefacts', () => {
  it('names the tarball and its checksum from the version', () => {
    const names = releaseNames('0.1.0');
    expect(names.tarball).toBe('s2s-0.1.0-node.tar.gz');
    expect(names.checksum).toBe('s2s-0.1.0-node.tar.gz.sha256');
    // The installer rebuilds the file name from the tag, so the two must agree.
    expect(names.checksum.startsWith(names.tarball)).toBe(true);
  });

  it('carries no OS or architecture in the name: the bundle needs only node', () => {
    expect(releaseNames('1.2.3').name).not.toMatch(/linux|darwin|win|arm64|x64/);
  });

  it('points at a repository with an owner and a name', () => {
    expect(RELEASE_REPO).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });
});
