/**
 * verifyBodyHash — keccak256 of a plaintext body against an expected digest.
 * Never throws; any non-match (including malformed hex) is `false`.
 */
import { describe, it, expect } from 'vitest';
import { utils } from 'ethers';
import { verifyBodyHash } from './verify-content';

const BODY = JSON.stringify({ text: 'hello', tags: ['a', 'b'], n: 1 });
const HASH = utils.keccak256(utils.toUtf8Bytes(BODY));

describe('verifyBodyHash', () => {
  it('accepts the matching body', () => {
    expect(verifyBodyHash(BODY, HASH)).toBe(true);
  });

  it('compares case-insensitively', () => {
    expect(verifyBodyHash(BODY, HASH.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(verifyBodyHash(BODY, '0x' + HASH.slice(2).toUpperCase())).toBe(true);
  });

  it('rejects a different body', () => {
    expect(verifyBodyHash(BODY + ' ', HASH)).toBe(false);
    expect(verifyBodyHash(JSON.stringify({ text: 'hello' }), HASH)).toBe(false);
  });

  it('returns false instead of throwing on malformed input', () => {
    expect(verifyBodyHash(BODY, 'not-hex')).toBe(false);
    expect(verifyBodyHash(BODY, '')).toBe(false);
    expect(verifyBodyHash(BODY, '0x1234')).toBe(false);
    expect(verifyBodyHash(BODY, undefined as unknown as string)).toBe(false);
    expect(verifyBodyHash(undefined as unknown as string, HASH)).toBe(false);
  });

  it('hashes the exact bytes — re-serialised JSON does not match', () => {
    const reordered = JSON.stringify({ n: 1, tags: ['a', 'b'], text: 'hello' });
    expect(verifyBodyHash(reordered, HASH)).toBe(false);
    expect(verifyBodyHash(JSON.stringify(JSON.parse(BODY), null, 2), HASH)).toBe(false);
  });
});
