/**
 * Tests for contenthash → CID decode.
 */
import { describe, it, expect } from 'vitest';
import { decodeContenthashWrapped, parseCID, encodeContenthashWrapped, toPreviewLabel } from '../src/ipfs/contenthash.js';

describe('decodeContenthashWrapped', () => {
  it('decodes a known contenthash to a CID string', () => {
    // This is a test vector: 0xe3 0x01 <CID bytes for QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv>
    // The contenthash is the actual contenthash of that CID.
    // We'll encode a known CID and verify the roundtrip.
    const cidStr = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    const cid = parseCID(cidStr);
    const encoded = encodeContenthashWrapped(cid);
    // The encoded string should start with 0xe301
    expect(encoded).toMatch(/^0xe301/);

    // Now decode it back
    const decoded = decodeContenthashWrapped(encoded);
    expect(decoded.toString()).toBe(cidStr);
  });

  it('decodes a CIDv0 contenthash', () => {
    const cidStr = 'QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv';
    const cid = parseCID(cidStr);
    const encoded = encodeContenthashWrapped(cid);
    expect(encoded).toMatch(/^0xe301/);

    const decoded = decodeContenthashWrapped(encoded);
    // toV1() converts to base32
    expect(decoded.toV1().toString()).toMatch(/^b/);
  });

  it('throws on invalid contenthash (wrong prefix)', () => {
    expect(() => decodeContenthashWrapped('0x000102')).toThrow('expected first byte');
  });

  it('throws on empty hex string', () => {
    expect(() => decodeContenthashWrapped('0x')).toThrow();
  });

  it('throws on odd-length hex string (no 0x)', () => {
    expect(() => decodeContenthashWrapped('e3010')).toThrow('invalid hex length');
  });
});

describe('parseCID', () => {
  it('parses CIDv0 (Qm prefix)', () => {
    const cid = parseCID('QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv');
    expect(cid.version).toBe(0);
    expect(cid.code).toBe(0x70); // dag-pb
  });

  it('parses CIDv1 (bafy prefix)', () => {
    const cid = parseCID('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    expect(cid.version).toBe(1);
  });

  it('round-trips CID through toString', () => {
    const original = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    const cid = parseCID(original);
    expect(cid.toString()).toBe(original);
  });
});

describe('toPreviewLabel', () => {
  it('converts CIDv0 to base32 preview label', () => {
    const label = toPreviewLabel('QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv');
    expect(label).toMatch(/^b/);
  });

  it('passes CIDv1 through unchanged', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    expect(toPreviewLabel(cid)).toBe(cid);
  });
});
