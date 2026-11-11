/// <reference path="../action_globals.ts" />

import { fetchWithTimeout } from '../libs/helpers';
import {
  canonicalizeProofPayload,
  canonicalizeProofPayloadLegacy,
  extractHashableHtml,
  hasSpecV1Terms,
  proofCanonicalizationOf,
  type ProofCanonicalization,
  PROOF_CANONICALIZATION_JCS,
} from '@s2s/soul2soul-shared/lit-actions';
import { addressOf } from '../libs/address';

// Tree-mutation integrity gate — PKP provenance verification
// Canonicalisation + HTML extraction are shared with render/metadata.ts
// (shared/src/metadata/proof-canonicalization.ts, .../html-block.ts), so signer
// and verifier can never drift.
//
// NOTE (pre-existing, out of scope here): the page proof is not a conformant
// W3C Data Integrity proof — `cryptosuite: ecdsa-secp256k1-2019` is not a
// registered suite, the digest is keccak256 rather than the suite's SHA-256, and
// `proofValue` is not multibase-encoded. Likewise the specVersion-1 JSON-LD
// terms (sdContent, author.proof) have no @context definitions, and `proof` on a
// Person node collides with the DI term — sdPublisher already had the same
// shape, so a context redesign is a separate decision.
//
// Verify three invariants before any tree mutation:
//   1. Sig — recover address from `proof.proofValue` over
//      canonicalize(schema)+canonicalize(proofOptions); assert == protocolInfo.pkp
//      (canonicalisation chosen per-page via proof.canonicalization: JCS-RFC8785
//      for specVersion "1" pages, LEGACY for everything already published)
//   2. Bytes — recompute sha256(html body); assert == schema.encoding.sha256
//   3. Genesis — read schema identifier; assert == expected job.id
/**
 * Extract and parse the first `<script type="application/ld+json">` from HTML.
 */
function extractSchema(html: string): any {
  const match = /<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/i.exec(html);
  if (!match) throw 'No JSON-LD schema found in HTML';
  return JSON.parse(match[1]);
}

/**
 * What a rendered page says about itself, as far as the tree gate can trust it.
 *
 *  - `signed`          — the page carries `proof.proofValue`, i.e. it is (or
 *                        claims to be) a PKP-signed page. A page with no
 *                        signature can never have been produced by the
 *                        renderer, and — crucially — cannot be *reused* as a
 *                        carrier (see verifyPathAvailable's LEGACY rule).
 *  - `canonicalization` — which scheme the signature covers. `LEGACY` pages
 *                        sign a SKELETON of the document (see
 *                        shared/src/metadata/proof-canonicalization.ts), so
 *                        `encoding.sha256` (the body) and
 *                        `author.identifier.value` (the claimed author) are
 *                        OUTSIDE the signed bytes.
 *  - `identifier`      — schema.identifier (the genesis the page claims).
 *  - `authorDid`       — the claimed author, as an ADDRESS: read from whichever
 *                        PropertyValue on the author node holds one, through
 *                        shared's `authorAddress()` (via `addressOf`). A page
 *                        pinned before the author became bare names the same
 *                        address under the earlier term, so the reader selects
 *                        by value shape and never by term: the identity is the
 *                        address, not the term or the form the value was pinned
 *                        in. (Unsigned on a LEGACY page.)
 *  - `sha256`          — the claimed digest of the hashed body region
 *                        (unsigned on a LEGACY page).
 */
export interface PageIdentity {
  identifier: string | null;
  authorDid: string | null;
  canonicalization: ProofCanonicalization;
  signed: boolean;
  sha256: string | null;
}

/**
 * The bare address an author node's `identifier` holds, whichever PropertyValue
 * carries it. Selection is by value shape, not by term: a page pinned before the
 * author became bare holds the address under the earlier term.
 */
const authorAddressOf = (author: any): string | null => {
  const identifiers = Array.isArray(author?.identifier) ? author.identifier : [author?.identifier];
  for (const identifier of identifiers) {
    const value = typeof identifier === 'string' ? identifier : identifier?.value;
    const address = addressOf(value);
    if (address !== null) return address;
  }
  return null;
};

/** Read a page's self-description out of its JSON-LD schema (pure). */
export const pageIdentityOf = (schema: any): PageIdentity => {
  const proof = schema?.proof;
  return {
    identifier: typeof schema?.identifier === 'string' ? schema.identifier : null,
    authorDid: authorAddressOf(schema?.author),
    canonicalization: proofCanonicalizationOf(proof ?? {}),
    signed: typeof proof?.proofValue === 'string' && proof.proofValue !== '',
    sha256: typeof schema?.encoding?.sha256 === 'string' ? schema.encoding.sha256 : null,
  };
};

/**
 * Verify that the HTML at `htmlCid` carries a valid PKP provenance signature.
 *
 * 1. Cat the HTML from IPFS.
 * 2. Extract JSON-LD schema, separate proof, canonicalize both, recover address.
 * 3. Verify recovered address matches expected PKP.
 * 4. Verify sha256 of HTML body matches schema claim.
 * 5. Verify schema.identifier matches expected genesis.
 *
 * Throws on any failure — the caller should reject the job.
 */
export async function verifyProvenance(
  htmlCid: string,
  expectedGenesis: string,
  pkpEthAddress: string,
  gateway: string,
  trace?: any[],
): Promise<PageIdentity> {
  // Fetch the HTML content from IPFS
  const resp = await fetchWithTimeout(
    `${gateway}/api/v0/cat?arg=${htmlCid}`,
    { method: 'POST' },
    30_000,
  );
  if (!resp.ok) {
    throw `Failed to fetch HTML ${htmlCid.slice(0, 12)}… for verify: ${resp.status}`;
  }
  const html = await resp.text();

  const schema = extractSchema(html);

  // 1. Sig check — separate proof from data, canonicalize, recover
  const proof = schema.proof;
  if (!proof?.proofValue) throw 'Missing proof.proofValue in schema';

  // Separate proof from data (mirrors render/metadata.ts proof construction)
  const { proof: _removed, ...dataSchema } = schema;

  // Build proofOptions from all proof fields except proofValue
  const proofOptions: Record<string, string> = {};
  for (const key of Object.keys(proof)) {
    if (key !== 'proofValue') {
      proofOptions[key] = String(proof[key]);
    }
  }

  // Old pages carry no `canonicalization` marker and MUST verify under the
  // legacy (recursive key-whitelist) canonicaliser, byte-identically.
  //
  // Fail closed on the marker: the legacy scheme signs a *skeleton* of nested
  // objects, so a page carrying specVersion-1 terms without the JCS marker could
  // have anything inside `author.proof` / `sdContent` blessed by a signature
  // that never covered it. Marker-less pages are therefore only accepted while
  // they also carry neither term; anything else is rejected, never downgraded.
  const canonicalization = proofCanonicalizationOf(proofOptions);
  if (canonicalization !== PROOF_CANONICALIZATION_JCS && hasSpecV1Terms(dataSchema)) {
    throw (
      'Refusing page carrying specVersion-1 terms (sdContent/author.proof) ' +
      'without proof.canonicalization = "' +
      PROOF_CANONICALIZATION_JCS +
      '" — those terms cannot be covered by the legacy canonicalisation'
    );
  }
  const toSign =
    canonicalization === PROOF_CANONICALIZATION_JCS
      ? canonicalizeProofPayload(dataSchema, proofOptions)
      : canonicalizeProofPayloadLegacy(dataSchema, proofOptions);
  const toSignHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(toSign));

  const recoveredAddress = ethers.utils.recoverAddress(
    ethers.utils.arrayify(toSignHash),
    proof.proofValue,
  );

  if (recoveredAddress.toLowerCase() !== pkpEthAddress.toLowerCase()) {
    throw (
      `Provenance sig mismatch: recovered ${recoveredAddress}, ` + `expected PKP ${pkpEthAddress}`
    );
  }

  // 2. Sha256 check — recompute over HTML body (the region shared with
  //    render/metadata.ts, so signer and verifier agree by construction)
  const htmlBody = extractHashableHtml(html);
  const htmlBytes = ethers.utils.toUtf8Bytes(htmlBody);
  const computedSha256 = ethers.utils.sha256(htmlBytes).replace('0x', '');
  if (computedSha256 !== (schema.encoding?.sha256 || '')) {
    if (trace) {
      trace.push(
        `[verify-debug] sha256 mismatch for ${htmlCid.slice(0, 12)}… ` +
          `computed=${computedSha256} schema=${schema.encoding?.sha256}`,
      );
      trace.push(
        `[verify-debug] htmlBody length=${htmlBody.length} first300=${htmlBody.slice(0, 300)}`,
      );
      trace.push(`[verify-debug] htmlBody last300=${htmlBody.slice(-300)}`);
    }
    throw (
      `Sha256 mismatch: computed ${computedSha256}, ` +
      `schema has ${schema.encoding?.sha256 || '(missing)'}`
    );
  }

  // 3. Genesis check
  if (schema.identifier !== expectedGenesis) {
    throw (
      `Genesis mismatch: schema.identifier ${schema.identifier}, ` + `expected ${expectedGenesis}`
    );
  }

  // The parsed identity is returned so the caller (update/main.ts) does not have
  // to cat the page a second time to know WHICH canonicalisation signed it, what
  // identifier/author it claims, or what digest it asserts. The tree gate needs
  // all of that (see verifyPathAvailable).
  return pageIdentityOf(schema);
}

/** Path-level helpers for the remove loop. */

const RESERVED_ROOTS = new Set(['', 'index.html', 'assets']);

/**
 * Assert a remove entry path is safe to operate on.
 * - Rejects `..` path traversal segments
 * - Rejects reserved roots (assets, index.html, empty)
 * Returns the cleaned path (no leading/trailing slash) or throws.
 */
export function sanitizeRemovePath(path: string): string {
  // Remove leading/trailing slashes (avoid // in regex — build script comment stripper destroys it)
  let cleanPath = path;
  while (cleanPath.startsWith('/')) cleanPath = cleanPath.slice(1);
  while (cleanPath.endsWith('/')) cleanPath = cleanPath.slice(0, -1);
  if (!cleanPath) cleanPath = '';

  if (RESERVED_ROOTS.has(cleanPath)) {
    throw `Refusing to remove reserved root: ${path}`;
  }

  // Reject path traversal: split on / and check for .. segments
  const segments = cleanPath.split('/');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '..') {
      throw `Path traversal denied: ${path}`;
    }
  }

  return cleanPath;
}

/**
 * Read the genesis (schema.identifier) from the HTML at an MFS path.
 */
export async function readGenesisAtMfsPath(gateway: string, mfsPath: string): Promise<string> {
  const resp = await fetchWithTimeout(
    `${gateway}/api/v0/files/read?arg=${encodeURIComponent(mfsPath)}`,
    { method: 'POST' },
    30_000,
  );
  if (!resp.ok) {
    throw `Failed to read MFS path ${mfsPath}: ${resp.status}`;
  }
  const html = await resp.text();
  const schema = extractSchema(html);
  if (!schema.identifier) {
    throw `No identifier in schema at ${mfsPath}`;
  }
  return schema.identifier;
}

/** ABI fragment for hasDeal. */
const HAS_DEAL_ABI = ['function hasDeal(bytes32 genesis) view returns (bool)'];

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Verify that content at an MFS path is revocable:
 *  - Extract genesis from the existing HTML at ${mfsRoot}/${cleanPath}/index.html
 *  - Convert to bytes32 (keccak256 if not already)
 *  - Check on-chain that no deal exists for it
 *
 * Throws if a deal is active (content cannot be removed).
 */
export async function verifyRevocable(
  gateway: string,
  mfsRoot: string,
  cleanPath: string,
  publicationModule: string,
  rpcs: string[] | undefined,
): Promise<void> {
  // Tree entries are directory nodes containing index.html files
  const filePath = `${mfsRoot}/${cleanPath}/index.html`;
  const genesis = await readGenesisAtMfsPath(gateway, filePath);

  // Normalise to bytes32 (pass-through if already hex32, otherwise keccak256)
  const bytes32Genesis = HEX32_RE.test(genesis)
    ? genesis.toLowerCase()
    : ethers.utils.keccak256(ethers.utils.toUtf8Bytes(genesis));

  // NOTE: destructuring `{ provider }` off a StaticJsonRpcProvider INSTANCE yields
  // undefined (the instance has no `provider` property), so the Contract would be
  // constructed with an undefined provider and ethers v5 sets contract.provider =
  // null — `contract.hasDeal(...)` then reads this.provider.call(...) and throws
  // "TypeError: Cannot read properties of null (reading 'call')". Construct the
  // provider directly (mirrors libs/evm.ts evmSetup).
  const provider = new ethers.providers.StaticJsonRpcProvider(rpcs?.[0] || '', {
    chainId: 8453,
    name: 'base',
  });
  const contract = new ethers.Contract(publicationModule, HAS_DEAL_ABI, provider);
  const hasDeal: boolean = await contract.hasDeal(bytes32Genesis);

  if (hasDeal) {
    throw `Refusing to remove: genesis ${bytes32Genesis.slice(0, 12)}… has an active deal`;
  }
}

/**
 * Parse the page at an MFS path into a {@link PageIdentity}, or null when there
 * is no page there / it has no parseable JSON-LD schema (a free path).
 */
export async function readPageIdentity(
  gateway: string,
  mfsPath: string,
): Promise<PageIdentity | null> {
  try {
    const resp = await fetchWithTimeout(
      `${gateway}/api/v0/files/read?arg=${encodeURIComponent(mfsPath)}`,
      { method: 'POST' },
      30_000,
    );
    if (!resp.ok) return null;
    return pageIdentityOf(extractSchema(await resp.text()));
  } catch {
    return null;
  }
}

/**
 * Before writing a job's page over an existing path, decide whether the write is
 * allowed.
 *
 * THREE RULES, in this order:
 *
 * 1. A LEGACY-signed page may never be introduced as NEW content. The legacy
 *    canonicaliser signs a recursive key whitelist, so `encoding.sha256` (the
 *    body) and `author.identifier.value` (the claimed author) are outside the
 *    signed bytes: such a page is indistinguishable from arbitrary content
 *    wearing a valid PKP signature. Rewriting the body, recomputing sha256 and
 *    pointing the author address at a victim still verifies — so the update gate
 *    must not be the thing that puts one on the tree.
 * 2. A LEGACY-signed page already AT the destination is an immutable carrier:
 *    its signature can be reused over changed content. Only a replacement that
 *    is content-bound may take its place — the same identifier (the same content
 *    item, i.e. a re-render of it) signed under JCS, which covers everything.
 *    Anything else would be new content grafted onto a carrier that cannot bind
 *    it. (An UNSIGNED page at the destination is not a carrier: no signature
 *    means no reusable signing material, and it cannot have come from the
 *    renderer at all.)
 * 3. Otherwise: the existing content must not be under an active deal with a
 *    different genesis (a deal-protected page must never be silently replaced).
 *
 * `incoming` is the identity of the page being written (what verifyProvenance
 * just parsed). Callers that omit it get rules 2 (identifier only) and 3.
 */
export async function verifyPathAvailable(
  gateway: string,
  destPath: string,
  incomingGenesis: string,
  publicationModule: string,
  rpcs: string[] | undefined,
  incoming?: PageIdentity | null,
): Promise<void> {
  const existing = await readPageIdentity(gateway, destPath);

  if (!existing || existing.identifier === null) {
    // Free path (no page, or no parseable schema on it) — rule 1.
    if (incoming?.canonicalization === 'LEGACY') {
      throw (
        `Refusing to write a legacy-signed page to ${destPath}: its signature covers ` +
        `only a skeleton of the document (not the body, not the author address), so it ` +
        `cannot vouch for the content it would publish. Re-render the content under ` +
        `specVersion 1 (JCS) and publish that instead.`
      );
    }
    return;
  }

  // Rule 2 — a signed, LEGACY-canonicalised page already at the destination.
  if (existing.signed && existing.canonicalization === 'LEGACY') {
    if (existing.identifier !== incomingGenesis) {
      throw (
        `Refusing to replace the legacy-signed page at ${destPath} ` +
        `(genesis ${existing.identifier.slice(0, 12)}…) with a different content item ` +
        `(${incomingGenesis.slice(0, 12)}…): a legacy page is an immutable carrier — its ` +
        `signature covers the document skeleton only, so the new body would be unsigned. ` +
        `Re-render the existing content under specVersion 1 (JCS) instead.`
      );
    }
    if (incoming && incoming.canonicalization === 'LEGACY') {
      throw (
        `Refusing to replace the legacy-signed page at ${destPath} with another ` +
        `legacy-signed page: neither signature covers the body or the author address, so the ` +
        `write would only graft content that no signature binds. Re-render it under ` +
        `specVersion 1 (JCS) first.`
      );
    }
  }

  // Same genesis overwriting itself (re-render of the same page) — always allowed
  if (existing.identifier === incomingGenesis) return;
  const existingGenesis = existing.identifier;

  // Different genesis — check if existing content has an active deal
  const bytes32Genesis = HEX32_RE.test(existingGenesis)
    ? existingGenesis.toLowerCase()
    : ethers.utils.keccak256(ethers.utils.toUtf8Bytes(existingGenesis));

  const provider = new ethers.providers.StaticJsonRpcProvider(rpcs?.[0] || '', {
    chainId: 8453,
    name: 'base',
  });
  const contract = new ethers.Contract(publicationModule, HAS_DEAL_ABI, provider);
  const hasDeal: boolean = await contract.hasDeal(bytes32Genesis);

  if (hasDeal) {
    throw (
      `Path occupied by genesis ${bytes32Genesis.slice(0, 12)}… ` +
      `with active deal — refusing overwrite by genesis ${incomingGenesis.slice(0, 12)}…`
    );
  }
}
