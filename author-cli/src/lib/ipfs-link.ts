// ============================================================================
// Public IPFS links for a bare CID (the `upload` result).
//
// `upload` reports off-chain content by CID alone; a human needs something
// clickable and the JSON needs the URI form the specs use.
//
// `ipfs.io` is a DELIBERATE choice, not the configured gateway: it is the
// public, credentialless gateway every reader of the printed link can open,
// whereas `ctx.config.kuboGateway` (repo default ipfs.transport-union.dev) is
// this project's own deployment and may require tokens or move. The base is
// defined once so serving links from the configured gateway later is one line:
// `export const IPFS_GATEWAY_BASE = ctx.config.kuboGateway`-shaped wiring (pass
// it in) or just edit the constant below — no call site changes.
// ============================================================================

/** Public HTTP gateway base for a bare CID. No trailing slash. */
export const IPFS_GATEWAY_BASE = 'https://ipfs.io/ipfs';

/** `ipfs://<cid>` — gateway-agnostic URI. */
export function ipfsUri(cid: string): string {
  return `ipfs://${cid}`;
}

/** `<gateway>/<cid>` — a link a browser can open. */
export function ipfsGatewayUrl(cid: string): string {
  return `${IPFS_GATEWAY_BASE}/${cid}`;
}
