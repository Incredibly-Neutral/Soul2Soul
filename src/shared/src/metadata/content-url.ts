// ============================================================================
// contentUrl — turn a content identifier into an `ipfs://` URL, or nothing.
//
// The on-chain publication module records a real IPFS deal CID, but older
// render paths passed the document's bytes32 genesis ("0x…") through the same
// field. Blindly prefixing `ipfs://` over that produces a URL that resolves
// nowhere, so anything that is not a retrievable CID is omitted instead.
//
// This is a real structural parse, not a prefix heuristic: `parseCID` (shared
// with the contenthash codec, dependency-free, Lit-Action safe) decodes the
// multibase string, the version/codec varints and the multihash, and the CID is
// only accepted if it re-encodes to exactly the input. `multiformats` itself is
// ESM-only and not resolvable from the CJS Lit bundles (see contenthash.ts), so
// reusing that inline parser is the way to get a genuine parse here.
//
// Notably this rejects libp2p peer ids ("12D3Koo…"): they are multihashes, not
// content addresses, and `ipfs://12D3…` is not retrievable content.
// ============================================================================

import { parseCID } from '../ipfs/contenthash';

/** dag-pb (CIDv1 codec of "bafy…" / CIDv0) */
const DAG_PB = 0x70;
/** raw (CIDv1 codec of "bafk…") */
const RAW = 0x55;

/**
 * True when `value` is a retrievable IPFS CID:
 *   - CIDv0: base58btc "Qm…", sha2-256 multihash (0x12 0x20 + 32 bytes)
 *   - CIDv1: multibase base32 "b…", codec dag-pb or raw
 */
export function isIpfsCid(value: string | undefined | null): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  // Cheap rejects before touching the decoder. "Qm" = CIDv0, "b" = base32
  // multibase; anything else (0x…, http…, 12D3…) cannot be one of these.
  if (!value.startsWith('Qm') && !value.startsWith('b')) return false;
  try {
    const cid = parseCID(value);
    // Round-trip: rejects non-canonical base32/varints and trailing junk.
    if (cid.toString() !== value) return false;
    if (cid.version === 0) {
      return cid.code === DAG_PB && cid.digest.length === 34;
    }
    return cid.version === 1 && (cid.code === DAG_PB || cid.code === RAW) && cid.digest.length > 0;
  } catch {
    return false;
  }
}

/**
 * `ipfs://<cid>` for a real CID, otherwise `undefined`.
 * Never returns `ipfs://0x…`.
 */
export function ipfsContentUrl(contentCid: string | undefined | null): string | undefined {
  return isIpfsCid(contentCid) ? `ipfs://${contentCid}` : undefined;
}
