// lastmile — CID decode helpers over the vendored contenthash module.
//
// Re-exports the shared contenthash encode/decode primitives plus two thin
// wrappers: contenthashToCid (EIP-1577 contenthash -> CID string) and
// isIpnsContenthash (detect ipns-ns contenthashes). The CID/base58/base32 math
// lives in src/ipfs/contenthash.ts (vendored verbatim from s2s shared) — do
// NOT reimplement it here.

import { decodeContenthashWrapped } from "./ipfs/contenthash.js";

export {
  decodeContenthashWrapped,
  parseCID,
  encodeContenthashWrapped,
  toPreviewLabel,
} from "./ipfs/contenthash.js";
export type { CIDLike } from "./ipfs/contenthash.js";

/**
 * Decode a 0x-prefixed ENS contenthash (EIP-1577: first byte 0xe3 ipfs-ns,
 * second byte 0x01) into a CID string (base58 for CIDv0, base32 for CIDv1).
 *
 * Throws Error if: the input is not hex, is empty, the first byte is not
 * 0xe3 (e.g. an ipns 0xe5 contenthash), or the inner CID bytes fail to decode.
 */
export function contenthashToCid(hex: string): string {
  if (typeof hex !== "string") {
    throw new Error("contenthashToCid: expected a hex string");
  }
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length === 0) {
    throw new Error("contenthashToCid: empty contenthash");
  }
  if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(`contenthashToCid: invalid hex (${hex})`);
  }
  // decodeContenthashWrapped throws on a non-0xe3 first byte (e.g. ipns
  // 0xe5) and on malformed inner CID bytes.
  return decodeContenthashWrapped(hex).toString();
}

/**
 * True iff the given contenthash hex starts with byte 0xe5 (ipns-ns), i.e. it
 * points at an IPNS name rather than an IPFS CID.
 */
export function isIpnsContenthash(hex: string): boolean {
  if (typeof hex !== "string") return false;
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length < 2) return false;
  const first = parseInt(raw.slice(0, 2), 16);
  return Number.isInteger(first) && first === 0xe5;
}
