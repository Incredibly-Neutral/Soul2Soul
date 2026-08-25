import { describe, it, expect } from 'vitest';
import { decodeRootCid } from '../src/lib/contenthash';
import { parseCID, encodeContenthashWrapped } from '@s2s/soul2soul-shared/lit-actions';

// The garbage contenthash written on-chain by the old CIDv0-only toHexString:
// 0xe3 0x01 + 44 bytes starting 01 d5 6f c8 ... — decodeContenthashWrapped
// parses it into a NON-NULL invalid CID (codec 0x37d5, malformed multihash)
// that decodeRootCid must reject by returning null, so fetchRootCid falls back
// to the store root instead of walking an invalid CID (tree sync 'invalid path').
const GARBAGE =
  '0xe30101d56fc8dbe3e00f824baf61cd7ffc99d98531acbdc8d7fd49db58b876db7468e9bf544c3ac3f2ae83a38438';

const TEST_V0 = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
const TEST_V1 = 'bafybeigadpvuv4m3txrx4r3wtjclnkte5mvxb2hoyyvt4jlaqdeo6qrbwm';

describe('decodeRootCid', () => {
  it('returns null for the garbage contenthash above (never a non-null invalid CID)', () => {
    expect(decodeRootCid(GARBAGE)).toBeNull();
  });

  it('returns null for non-string / absent values', () => {
    expect(decodeRootCid(undefined)).toBeNull();
    expect(decodeRootCid(null)).toBeNull();
    expect(decodeRootCid(12345)).toBeNull();
    expect(decodeRootCid('')).toBeNull();
  });

  it('returns null for a malformed prefix / short value', () => {
    expect(decodeRootCid('not-hex')).toBeNull();
    expect(decodeRootCid('0x123')).toBeNull(); // odd length
    expect(decodeRootCid('0xe4' + '01'.repeat(40))).toBeNull(); // not ipfs-ns
    expect(decodeRootCid('0xe301' + '01'.repeat(10))).toBeNull(); // too short
  });

  it('decodes a valid CIDv1 contenthash to its CIDv1 string', () => {
    const hex = encodeContenthashWrapped(parseCID(TEST_V1));
    expect(decodeRootCid(hex)).toBe(TEST_V1);
  });

  it('decodes a valid CIDv0 contenthash to its CIDv1 form', () => {
    const hex = encodeContenthashWrapped(parseCID(TEST_V0));
    expect(decodeRootCid(hex)).toBe(parseCID(TEST_V0).toV1().toString());
  });
});
