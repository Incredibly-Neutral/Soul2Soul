// ===========================================================================
// IPFS helpers — re-exports contenthash module and provides contenthashToIPFS
//
// Built on the vendored contenthash module (which handles base58/base32/CID math).
// Mirrors the same function from protocol/actions/src/libs/ipfs.factory.ts.
// ===========================================================================
export { decodeContenthashWrapped, parseCID, encodeContenthashWrapped, toPreviewLabel } from './contenthash.js';
export type { CIDLike } from './contenthash.js';

import { decodeContenthashWrapped } from './contenthash.js';

/**
 * Decode an EIP-1577 ipfs-ns contenthash hex string (`0xe3 0x01 <CID bytes>`)
 * into a plain CID string (base58 for CIDv0, base32 for CIDv1) that
 * `/api/v0/cat?arg=<cid>` etc. accept.
 */
export function contenthashToIPFS(hexString: string): string {
  return decodeContenthashWrapped(hexString).toString();
}
