// ============================================================================
// contentUrl — turn a content identifier into an `ipfs://` URL, or nothing.
//
// The on-chain publication module records a real IPFS deal CID, but older
// render paths passed the document's bytes32 genesis ("0x…") through the same
// field. Blindly prefixing `ipfs://` over that produces a URL that resolves
// nowhere, so anything that is not a plausible IPFS CID is omitted instead.
//
// Accepted shapes (per the specVersion-1 contract):
//   - CIDv0            base58btc, "Qm…"
//   - CIDv1            base32 multibase, "bafy…" (dag-pb) / "bafk…" (raw)
//   - libp2p peer id   base58btc, "12D3…"
// ============================================================================

const BASE58BTC_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE32_LOWER_RE = /^[a-z2-7]+$/;

/** True when `value` looks like a real IPFS CID (base58btc or base32 multibase). */
export function isIpfsCid(value: string | undefined | null): value is string {
  if (!value) return false;
  // CIDv0 — base58btc, fixed 46 characters.
  if (value.startsWith('Qm')) return value.length === 46 && BASE58BTC_RE.test(value);
  // libp2p peer id / CIDv1 in base58btc.
  if (value.startsWith('12D3')) return value.length > 46 && BASE58BTC_RE.test(value);
  // CIDv1 in base32 multibase.
  if (value.startsWith('bafy') || value.startsWith('bafk')) {
    return value.length >= 50 && BASE32_LOWER_RE.test(value);
  }
  return false;
}

/**
 * `ipfs://<cid>` for a real CID, otherwise `undefined`.
 * Never returns `ipfs://0x…`.
 */
export function ipfsContentUrl(contentCid: string | undefined | null): string | undefined {
  return isIpfsCid(contentCid) ? `ipfs://${contentCid}` : undefined;
}
