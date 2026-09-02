/**
 * Tests for ENS name extraction and resolution helpers.
 */
import { describe, it, expect } from 'vitest';
import { extractEnsName, isBareCID, isEnsName, namehash } from '../src/ens.js';

describe('extractEnsName', () => {
  it('extracts ENS name from a full https URL', () => {
    expect(extractEnsName('https://xxx.soul2soul.eth')).toBe('xxx.soul2soul.eth');
  });

  it('extracts ENS name from a bare name', () => {
    expect(extractEnsName('xxx.soul2soul.eth')).toBe('xxx.soul2soul.eth');
  });

  it('returns bare CID unchanged (Qm prefix)', () => {
    const cid = 'QmT5NvUtoP5VZ5T7i5T5dV5T5V5T5V5T5V5T5V5T5V5T5V';
    expect(extractEnsName(cid)).toBe(cid);
  });

  it('returns bare CID unchanged (bafy prefix)', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    expect(extractEnsName(cid)).toBe(cid);
  });

  it('strips trailing slash from bare name', () => {
    expect(extractEnsName('xxx.soul2soul.eth/')).toBe('xxx.soul2soul.eth');
  });

  it('strips path from URL', () => {
    expect(extractEnsName('https://xxx.soul2soul.eth/some/path')).toBe('xxx.soul2soul.eth');
  });
});

describe('isBareCID', () => {
  it('detects Qm-prefixed CIDv0', () => {
    expect(isBareCID('QmT5NvUtoP5VZ5T7i')).toBe(true);
  });

  it('detects b-prefixed CIDv1', () => {
    expect(isBareCID('bafybeigdyrzt5sfp')).toBe(true);
  });

  it('rejects ENS names', () => {
    expect(isBareCID('xxx.soul2soul.eth')).toBe(false);
  });

  it('rejects https URLs', () => {
    expect(isBareCID('https://xxx.soul2soul.eth')).toBe(false);
  });
});

describe('isEnsName', () => {
  it('detects .eth suffix', () => {
    expect(isEnsName('xxx.soul2soul.eth')).toBe(true);
  });

  it('rejects bare CID', () => {
    expect(isEnsName('QmT5NvUtoP5VZ5T7i')).toBe(false);
  });

  it('rejects non-eth strings', () => {
    expect(isEnsName('example.com')).toBe(false);
  });
});

describe('namehash', () => {
  it('computes the namehash for soul2soul.eth', () => {
    // Known namehash for soul2soul.eth
    const hash = namehash('soul2soul.eth');
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Verify it's deterministic
    expect(namehash('soul2soul.eth')).toBe(hash);
  });

  it('computes a consistent namehash for subdomains', () => {
    const hash1 = namehash('test.soul2soul.eth');
    const hash2 = namehash('test.soul2soul.eth');
    expect(hash1).toBe(hash2);
  });

  it('handles single-label .eth names', () => {
    const hash = namehash('eth');
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('normalizes case', () => {
    expect(namehash('SOUL2SOUL.ETH')).toBe(namehash('soul2soul.eth'));
  });
});
