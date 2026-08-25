import { describe, it, expect } from 'vitest';
import { contenthashToIPFS } from './ipfs.factory';
import { parseCID, encodeContenthashWrapped } from '@s2s/soul2soul-shared/lit-actions';

// ============================================================================
// contenthashToIPFS — EIP-1577 contenthash decode back to a CID string.
//
// Regression context: the old implementation blindly base58-encoded the raw
// CID bytes, which produced a garbage string for any CIDv1 (bafy...) contenthash
// (the CIDv1 bytes are not a base58 big number). It now decodes the contenthash
// with decodeContenthashWrapped and returns the proper CID string — base32 for
// CIDv1, base58 for CIDv0.
// ============================================================================

const TEST_V0 = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
const TEST_V1 = 'bafybeigadpvuv4m3txrx4r3wtjclnkte5mvxb2hoyyvt4jlaqdeo6qrbwm';

describe('contenthashToIPFS', () => {
  it('round-trips a CIDv1 contenthash back to the same CID', () => {
    const hex = encodeContenthashWrapped(parseCID(TEST_V1));
    expect(contenthashToIPFS(hex)).toBe(TEST_V1);
  });

  it('round-trips a CIDv0 contenthash back to the same CID', () => {
    const hex = encodeContenthashWrapped(parseCID(TEST_V0));
    expect(contenthashToIPFS(hex)).toBe(TEST_V0);
  });

  it('accepts a hex string without the 0x prefix', () => {
    const hex = encodeContenthashWrapped(parseCID(TEST_V1)).replace('0x', '');
    expect(contenthashToIPFS(hex)).toBe(TEST_V1);
  });

  it('throws on a non-ipfs-ns contenthash', () => {
    // First byte is 0x01, not 0xe3 (ipfs-ns) — decodeContenthashWrapped rejects it.
    expect(() => contenthashToIPFS('0x' + '01'.repeat(40))).toThrow();
  });
});
