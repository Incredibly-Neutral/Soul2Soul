// ============================================================================
// Link builders for rendered content — single source of truth for the
// preview/prod URLs a host surfaces after a render.
//
// Extracted from neutralpress' render.helper so the headless author-cli emits
// the same links the Obsidian plugin shows (SPEC-hosts).
// ============================================================================

import { parseCID, toPreviewLabel } from '../ipfs';

/** Default subdomain preview gateway (serves a rendered site root per CID label). */
export const DEFAULT_PREVIEW_GATEWAY = 'preview.transport-union.dev';

/** Default path gateway (serves raw IPFS paths under /ipfs/<cid>/). */
export const DEFAULT_IPFS_GATEWAY = 'ipfs.transport-union.dev';

/**
 * Strip a leading `/ipfs/<cid>` segment from a render path when it matches the
 * publish's own root CID. The `.preview` subdomain gateway — and the `.link`
 * DNSLink gateway — serve the site root at the domain itself, so that prefix
 * 404s. CIDv0 and CIDv1 share the multihash digest, so a digest-wise compare
 * only removes a matching root; a bare `/ipfs/<cid>` folds to `/`.
 */
export function pagePathFor(resPath: string, cid: string): string {
  const rest = resPath.replace(/^\/ipfs\/[^/]+/, '');
  if (rest === resPath) return resPath; // no leading /ipfs/<cid> — leave unchanged
  let matchesOwnCid = true;
  try {
    const seg = /^\/ipfs\/([^/]+)/.exec(resPath)?.[1] ?? '';
    const a = parseCID(seg).digest;
    const b = parseCID(cid).digest;
    matchesOwnCid = a.length === b.length && a.every((byte, i) => byte === b[i]);
  } catch {
    /* unparseable segment — treat it as the spurious prefix */
  }
  return matchesOwnCid ? (rest.length ? rest : '/') : resPath;
}

/**
 * Preview URL for a rendered root CID. The subdomain is the CIDv1 base label
 * (`toPreviewLabel`), so every render gets a unique, immutable preview door.
 */
export function previewLink(
  cid: string,
  path = '/',
  gateway = DEFAULT_PREVIEW_GATEWAY,
): string {
  return `https://${toPreviewLabel(cid)}.${gateway}${pagePathFor(path, cid)}`;
}

/**
 * Raw IPFS path URL for a CID under the path gateway. Used for the
 * publish-time notice (the source material / article).
 */
export function ipfsLink(cid: string, path = '', gateway = DEFAULT_IPFS_GATEWAY): string {
  return `https://${gateway}/ipfs/${cid}${path ? `/${path}` : ''}`;
}

/**
 * Production link for a publication ENS name (`acme.soul2soul.eth`). Served
 * via the DNSLink `.link` gateway at the root, so a path maps directly.
 */
export function ensLink(publication: string, path = '/', gateway = 'link'): string {
  return `https://${publication}.${gateway}${path}`;
}
