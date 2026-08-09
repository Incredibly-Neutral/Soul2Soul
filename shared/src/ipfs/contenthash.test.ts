import { describe, it, expect } from 'vitest';
import {
  decodeContenthashWrapped,
  encodeContenthashWrapped,
  toPreviewLabel,
  parseCID,
} from './contenthash';

const TEST_V0 = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
const TEST_V1 = 'bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq';

describe('decodeContenthashWrapped', () => {
  it('decodes a valid 0x-prefixed contenthash', () => {
    const cid = parseCID(TEST_V0);
    const encoded = encodeContenthashWrapped(cid);
    const decoded = decodeContenthashWrapped(encoded);
    expect(decoded.version).toBe(0);
    expect(decoded.code).toBe(0x70);
    expect(decoded.digest.length).toBeGreaterThan(0);
  });

  it('round-trips encode → decode → same bytes', () => {
    const cid = parseCID(TEST_V0);
    const hex = encodeContenthashWrapped(cid);
    const decoded = decodeContenthashWrapped(hex);
    expect([...decoded.bytes]).toEqual([...cid.bytes]);
  });

  it('decodes hex without 0x prefix', () => {
    const cid = parseCID(TEST_V0);
    const hex = encodeContenthashWrapped(cid).replace('0x', '');
    const decoded = decodeContenthashWrapped(hex);
    expect([...decoded.bytes]).toEqual([...cid.bytes]);
  });

  it('throws on non-ipfs-ns first byte', () => {
    const cid = parseCID(TEST_V0);
    const good = encodeContenthashWrapped(cid);
    const bad = '0xe4' + good.slice(4);
    expect(() => decodeContenthashWrapped(bad)).toThrow('0xe3');
  });

  it('throws on odd-length hex', () => {
    expect(() => decodeContenthashWrapped('0xe3a')).toThrow('invalid hex length');
  });

  it('throws on empty hex', () => {
    expect(() => decodeContenthashWrapped('0x')).toThrow('invalid hex length');
  });
});

describe('encodeContenthashWrapped', () => {
  it('prefixes with 0xe301', () => {
    const hex = encodeContenthashWrapped(parseCID(TEST_V0));
    expect(hex).toMatch(/^0x/);
    expect(hex.slice(2, 4)).toBe('e3');
    expect(hex.slice(4, 6)).toBe('01');
  });

  it('round-trips decode → encode', () => {
    const cid = parseCID(TEST_V0);
    const encoded = encodeContenthashWrapped(cid);
    const decoded = decodeContenthashWrapped(encoded);
    const reEncoded = encodeContenthashWrapped(decoded);
    expect(reEncoded).toBe(encoded);
  });
});

describe('toPreviewLabel', () => {
  it('converts CIDv0 string to CIDv1 base32', () => {
    const label = toPreviewLabel(TEST_V0);
    expect(label).toMatch(/^bafy/);
    expect(label).not.toMatch(/^Qm/);
  });

  it('converts CIDLike object to CIDv1 base32', () => {
    const label = toPreviewLabel(parseCID(TEST_V0));
    expect(label).toBe(TEST_V1);
  });

  it('passes through CIDv1 unchanged', () => {
    const label = toPreviewLabel(TEST_V1);
    expect(label).toBe(TEST_V1);
  });

  it('decode → toPreviewLabel matches original toPreviewLabel', () => {
    const cid = parseCID(TEST_V0);
    const hex = encodeContenthashWrapped(cid);
    const decoded = decodeContenthashWrapped(hex);
    expect(toPreviewLabel(decoded)).toBe(toPreviewLabel(cid));
  });
});

describe('parseCID', () => {
  it('parses CIDv0', () => {
    const cid = parseCID(TEST_V0);
    expect(cid.version).toBe(0);
    expect(cid.code).toBe(0x70);
  });

  it('parses CIDv1', () => {
    const cid = parseCID(TEST_V1);
    expect(cid.version).toBe(1);
  });

  it('generates correct toString for v0', () => {
    const cid = parseCID(TEST_V0);
    expect(cid.toString()).toBe(TEST_V0);
  });

  it('generates correct toString for v1', () => {
    const cid = parseCID(TEST_V1);
    expect(cid.toString()).toBe(TEST_V1);
  });

  it('v0.toV1() produces correct v1 string', () => {
    const cid = parseCID(TEST_V0);
    expect(cid.toV1().toString()).toBe(TEST_V1);
  });
});
