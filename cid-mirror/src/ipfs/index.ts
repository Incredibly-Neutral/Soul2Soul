// ===========================================================================
// IPFS helpers — re-exports contenthash module and provides contenthashToIPFS
//
// Built on the vendored contenthash module (which handles base58/base32/CID math).
// Mirrors the same function from protocol/actions/src/libs/ipfs.factory.ts.
// ===========================================================================
import type { CIDLike as _CIDLike } from './contenthash.js';
export { decodeContenthashWrapped, parseCID, encodeContenthashWrapped, toPreviewLabel } from './contenthash.js';
export type { CIDLike } from './contenthash.js';

// Type alias for use in this module (re-exports don't create local bindings)
type CIDLike = _CIDLike;

/**
 * Decode an EIP-1577 ipfs-ns contenthash hex string (`0xe3 0x01 <CID bytes>`)
 * into a plain CID string (base58 for CIDv0, base32 for CIDv1) that
 * `/api/v0/cat?arg=<cid>` etc. accept.
 *
 * Since re-exports (`export { foo } from './bar'`) do NOT create local
 * bindings in the current scope, we use a lazy import.
 */
let _decodeOnce: ((hex: string) => CIDLike) | null = null;
async function getDecoder(): Promise<(hex: string) => CIDLike> {
  if (!_decodeOnce) {
    const mod = await import('./contenthash.js');
    _decodeOnce = mod.decodeContenthashWrapped;
  }
  return _decodeOnce!;
}

export async function contenthashToIPFS(hexString: string): Promise<string> {
  const decode = await getDecoder();
  return decode(hexString).toString();
}
