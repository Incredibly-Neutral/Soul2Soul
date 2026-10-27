/**
 * verifyBodyHash — keccak256 of a plaintext body against an expected digest.
 *
 * The contract is "hash these exact bytes". The stored body of an item IS the
 * JCS string: sign-content.ts sets `bodyContent = jcs(body)` and keccak256s
 * precisely those bytes. So the fixture hashes `jcs(body)` too — feeding
 * `JSON.stringify` here would be pinning a test artifact, not the contract.
 *
 * Never throws; any non-match (including malformed hex) is `false`.
 */
import { describe, it, expect } from 'vitest';
import { utils } from 'ethers';
import { jcs } from './jcs';
import { verifyBodyHash } from './verify-content';

const BODY = { text: 'hello', tags: ['a', 'b'], n: 1 };
// Exactly what sign-content.ts stores and hashes.
const BODY_JSON = jcs(BODY);
const HASH = utils.keccak256(utils.toUtf8Bytes(BODY_JSON));

describe('verifyBodyHash', () => {
  it('accepts the stored (JCS) body string', () => {
    expect(verifyBodyHash(BODY_JSON, HASH)).toBe(true);
  });

  it('accepts the upper-cased digest (case-insensitive)', () => {
    expect(verifyBodyHash(BODY_JSON, '0x' + HASH.slice(2).toUpperCase())).toBe(true);
  });

  it('rejects a different body', () => {
    expect(verifyBodyHash(BODY_JSON + ' ', HASH)).toBe(false);
    expect(verifyBodyHash(jcs({ text: 'hello' }), HASH)).toBe(false);
  });

  it('returns false instead of throwing on malformed input', () => {
    expect(verifyBodyHash(BODY_JSON, 'not-hex')).toBe(false);
    expect(verifyBodyHash(BODY_JSON, '')).toBe(false);
    expect(verifyBodyHash(BODY_JSON, '0x1234')).toBe(false);
    expect(verifyBodyHash(BODY_JSON, undefined as unknown as string)).toBe(false);
    expect(verifyBodyHash(undefined as unknown as string, HASH)).toBe(false);
  });

  it('does not re-serialise: a non-canonical rendering of the same object fails', () => {
    // The documented trap — callers must pass the stored string, not
    // JSON.stringify of a parsed object (different key order / spacing).
    const pretty = JSON.stringify(BODY, null, 2);
    expect(pretty).not.toBe(BODY_JSON);
    expect(verifyBodyHash(pretty, HASH)).toBe(false);
    // Same object, insertion order ≠ JCS order (n, tags, text).
    const reordered = JSON.stringify({ text: 'hello', n: 1, tags: ['a', 'b'] });
    expect(reordered).not.toBe(BODY_JSON);
    expect(verifyBodyHash(reordered, HASH)).toBe(false);
  });
});
