/**
 * Contenthash helpers — single-sourced encode/decode/display for on-chain
 * contenthash_wrapped (EIP-1577 ENS contenthash with ipfs-ns codec).
 *
 * Pure functions, no zod, no node built-ins, no external dependencies.
 * CID encoding/decoding is done inline with basic JS types to avoid the
 * ESM-only `multiformats` package (not resolvable from CJS bundles).
 * This keeps the module safe for Lit Actions (INV-7).
 *
 * ---
 * Vendored verbatim from s2s monorepo (shared/src/ipfs/contenthash.ts).
 * Keep this header; do NOT reimplement the CID/base58/base32 math.
 * ---
 */

// ===========================================================================
// Exported interface
// ===========================================================================

/** Minimal CID — only the subset our helpers need. */
export interface CIDLike {
  bytes: Uint8Array;
  version: number;
  code: number;
  digest: Uint8Array;
  toString(): string;
  toV1(): CIDLike;
}

// ===========================================================================
// Constants
// ===========================================================================

const IPFS_NS = 0xe3;
const CH_VERSION = 0x01;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_LOOKUP[BASE58_ALPHABET[i]] = i;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE32_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) BASE32_LOOKUP[BASE32_ALPHABET[i]] = i;

// ===========================================================================
// Varint
// ===========================================================================

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

function decodeVarint(bytes: Uint8Array, offset = 0): [number, number] {
  let value = 0;
  let shift = 0;
  let consumed = 0;
  while (consumed + offset < bytes.length) {
    const byte = bytes[offset + consumed];
    value |= (byte & 0x7f) << shift;
    consumed++;
    if (!(byte & 0x80)) break;
    shift += 7;
    if (shift > 28) throw new Error('varint too long');
  }
  return [value, consumed];
}

// ===========================================================================
// Hex
// ===========================================================================

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

// ===========================================================================
// Base58-btc (CIDv0 multihash encoding)
// ===========================================================================

function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let result = '';
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = '1' + result;
  }
  return result;
}

function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const digit = BASE58_LOOKUP[char];
    if (digit === undefined) throw new Error(`invalid base58 character: ${char}`);
    num = num * 58n + BigInt(digit);
  }
  let leadingZeros = 0;
  for (const char of str) {
    if (char !== '1') break;
    leadingZeros++;
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num /= 256n;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) result[leadingZeros + i] = bytes[i];
  return result;
}

// ===========================================================================
// Base32-lower (CIDv1)
// ===========================================================================

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let result = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return result;
}

function base32Decode(str: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of str) {
    const val = BASE32_LOOKUP[char];
    if (val === undefined) throw new Error(`invalid base32 character: ${char}`);
    buffer = (buffer << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

// ===========================================================================
// CID construction
// ===========================================================================

function makeCID(bytes: Uint8Array, version: number, code: number, digest: Uint8Array): CIDLike {
  return {
    bytes,
    version,
    code,
    digest,
    toString(): string {
      return version === 0
        ? base58Encode(digest)
        : 'b' +
            base32Encode(
              new Uint8Array([...encodeVarint(version), ...encodeVarint(code), ...digest]),
            );
    },
    toV1(): CIDLike {
      if (version === 1) return this;
      const vBytes = encodeVarint(1);
      const cBytes = encodeVarint(code);
      return makeCID(new Uint8Array([...vBytes, ...cBytes, ...digest]), 1, code, digest);
    },
  };
}

// ===========================================================================
// Public API — parse a CID string into a CIDLike
// ===========================================================================

/**
 * Parse a CIDv0 (Qm...) or CIDv1 (bafy...) string into a CIDLike.
 */
export function parseCID(str: string): CIDLike {
  if (str.startsWith('Qm') || str.startsWith('1')) {
    const digest = base58Decode(str);
    return makeCID(
      new Uint8Array([...encodeVarint(0), ...encodeVarint(0x70), ...digest]),
      0,
      0x70,
      digest,
    );
  }
  const rawBytes = base32Decode(str.startsWith('b') ? str.slice(1) : str);
  const [version, vc] = decodeVarint(rawBytes, 0);
  const [code, cc] = decodeVarint(rawBytes, vc);
  const digest = rawBytes.slice(vc + cc);
  return makeCID(rawBytes, version, code, digest);
}

// ===========================================================================
// Decode: on-chain hex → CIDLike
// ===========================================================================

/**
 * Decode an ENS contenthash_wrapped hex string into a CIDLike.
 *
 * Expects a `0x`-prefixed hex string whose first byte is `0xe3` (ipfs-ns)
 * followed by `0x01` (contenthash version). The remaining bytes are the raw
 * CID bytes.
 */
export function decodeContenthashWrapped(hex: string): CIDLike {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (raw.length === 0 || raw.length % 2 !== 0) {
    throw new Error(`decodeContenthashWrapped: invalid hex length (${raw.length})`);
  }
  const bytes = hexToBytes(raw);
  if (bytes[0] !== IPFS_NS) {
    throw new Error(
      `decodeContenthashWrapped: expected first byte 0x${IPFS_NS.toString(16)} (ipfs-ns), got 0x${bytes[0]?.toString(16).padStart(2, '0')}`,
    );
  }
  const cidBytes = bytes.slice(2);
  const [version, vc] = decodeVarint(cidBytes, 0);
  const [code, cc] = decodeVarint(cidBytes, vc);
  return makeCID(cidBytes, version, code, cidBytes.slice(vc + cc));
}

// ===========================================================================
// Encode: CIDLike → on-chain hex
// ===========================================================================

/**
 * Encode a CIDLike into an ENS contenthash_wrapped hex string.
 * Prepends `0xe3` (ipfs-ns) and `0x01` (contenthash version).
 */
export function encodeContenthashWrapped(cid: CIDLike): string {
  return '0x' + bytesToHex(new Uint8Array([IPFS_NS, CH_VERSION, ...cid.bytes]));
}

// ===========================================================================
// Display: CID → preview-subdomain label (CIDv1 base32)
// ===========================================================================

/**
 * Convert a CIDLike (or CID string) to its CIDv1 base32 representation,
 * suitable for use as a subdomain label in preview URLs.
 */
export function toPreviewLabel(cid: CIDLike | string): string {
  if (typeof cid === 'string') cid = parseCID(cid);
  return cid.toV1().toString();
}
