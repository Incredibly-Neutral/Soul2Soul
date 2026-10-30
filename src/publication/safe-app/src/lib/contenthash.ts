// safe-app/src/lib/contenthash.ts
//
// Single-sourced decode + validation of the on-chain `contenthash_wrapped`
// value (EIP-1577 ipfs-ns contenthash) into a usable CIDv1 string, used by the
// Website Tree tab. Extracted from the component so the decode/validate logic
// is a pure function (no DOM) and unit-testable.
import { decodeContenthashWrapped } from '@s2s/soul2soul-shared';

// IPFS codecs we accept as a site root. dag-pb (0x70) is the usual root for a
// Kubo MFS directory; raw (0x55) covers raw-block roots; dag-cbor (0x71) covers
// DAG-put roots. Anything else (e.g. the garbage codec 0x37d5 produced by the
// old CIDv0-only toHexString) is rejected.
const ACCEPTED_CODECS = new Set<number>([0x70, 0x71, 0x55]);

// Sane upper bound for a multihash digest length (bytes). Real IPFS digests are
// 16-64 bytes (sha1, sha2-256/512, blake2b, sha3, keccak); anything larger is
// almost certainly a misparse of garbage bytes.
const MAX_DIGEST_LENGTH = 128;

/** Decode a varint at `offset`; returns [value, bytesConsumed]. Throws when the
 *  varint is unterminated or over-long. */
function decodeVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < bytes.length) {
    const byte = bytes[i];
    value |= (byte & 0x7f) << shift;
    i++;
    if (!(byte & 0x80)) return [value, i - offset];
    shift += 7;
    if (shift > 28) throw new Error('varint too long');
  }
  throw new Error('unterminated varint');
}

/** Validate that a decoded CID is a plausible IPFS content root: version 0/1,
 *  a codec in {dag-pb, dag-cbor, raw}, and a well-formed multihash whose
 *  declared digest length matches the remaining bytes and is a sane size. */
function isValidContentCid(cid: {
  version: number;
  code: number;
  digest: Uint8Array;
}): boolean {
  if (cid.version !== 0 && cid.version !== 1) return false;
  if (!ACCEPTED_CODECS.has(cid.code)) return false;
  // cid.digest holds the multihash bytes: [hash-fn varint][len varint][digest].
  const mh = cid.digest;
  if (mh.length < 2) return false;
  try {
    const [, fnLen] = decodeVarint(mh, 0);
    const [digestLen, lenLen] = decodeVarint(mh, fnLen);
    if (digestLen <= 0 || digestLen > MAX_DIGEST_LENGTH) return false;
    return fnLen + lenLen + digestLen === mh.length;
  } catch {
    return false;
  }
}

/** Decode an on-chain `contenthash_wrapped` value to a CIDv1 string.
 *  Returns null (never throws) when the value is absent or malformed, so the
 *  caller can degrade to the store root instead of blowing up the sync. */
export function decodeRootCid(onchainHash: unknown): string | null {
  if (typeof onchainHash !== 'string') return null;
  const raw = onchainHash.trim();
  // Sanity check before decoding: 0x-prefixed, even-length, ipfs-ns (0xe3)
  // + contenthash version (0x01) prefix, and long enough to carry a CID.
  // '0x' + 'e301' + at least a 34-byte CIDv0 multihash => >= 74 chars.
  if (!/^0x[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return null;
  if (!raw.toLowerCase().startsWith('0xe301')) return null;
  if (raw.length < 74) return null;
  try {
    const cid = decodeContenthashWrapped(raw);
    // NEVER return a non-null garbage CID: a contenthash that decodes to an
    // implausible codec or a malformed multihash (e.g. the garbage written by
    // the old CIDv0-only toHexString) is treated as absent so fetchRootCid
    // falls back to the store root.
    if (!isValidContentCid(cid)) return null;
    const label = cid.toV1().toString();
    return label.length > 0 ? label : null;
  } catch (e) {
    console.warn('[website-tree] contenthash decode failed:', e);
    return null;
  }
}
