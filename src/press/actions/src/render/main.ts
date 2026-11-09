/// <reference path="../action_globals.ts" />

import {
  S2SContentInfo,
  ActionResult,
  SingleInput,
  SingleData,
  DataAvailabilityEntry,
} from '@s2s/soul2soul-shared/lit-actions';
import { decryptRaw } from '../libs/decrypt';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { uploadFile, decodeArchiveCid } from '../libs/ipfs.factory';
import { getProtocolInfo } from '../libs/protocol.factory';
import { evmRead } from '../libs/evm';
import { fetchById, verifyDecryptedBody } from '../libs/module.factory';

import { getConfig } from './config.ctrl';
import {
  initTemplateData,
  fetchCollections,
  mergeDecrypted,
  pathsForCollections,
  shouldWriteBackCache,
} from './data.ctrlr';
import { addAndSignMetadata } from './metadata';
import { renderHTML } from '../renderer/html.ctrlr';

import { extractSignerAddress } from '../libs/gates';
import { requireFields, setRpcAuth } from '../libs/helpers';
import { toBytes32Id } from '@s2s/soul2soul-shared/lit-actions';

/**
 * On-chain revoke check: is `jobId`'s genesis currently NOT under a deal?
 *
 * Conservative by design (reviewer C/G): this returns true ONLY when hasDeal
 * is definitively false — a genuine on-chain revoke. On any RPC failure it
 * returns false (treat as still active) so a transport error can never turn a
 * live page into a revoked-and-removed one; the orchestrator's
 * runRenderActionWithRetry handles transient RPC failures. Mirrors the
 * established evmRead pattern in libs/gates.ts (canRead).
 */
export async function isRevokedByDealState(
  jobId: string,
  publicationModule: string,
  rpcs?: string[],
): Promise<boolean> {
  const genesis = toBytes32Id(jobId);
  let dealActive = true;
  try {
    dealActive = await evmRead(
      'L2',
      publicationModule,
      ['function hasDeal(bytes32 genesis) view returns (bool)'],
      'hasDeal',
      [genesis],
      rpcs,
    );
  } catch (e) {
    console.log(
      `hasDeal read failed for ${jobId.slice(0, 12)}… — not treating as revoked: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return !dealActive;
}

// ENS records contract ABI (getText only) — local mirror of update/main.ts;
// no shared ABI import. Used to READ the per-publication content archive
// pointer (`content_cache_<publication>` text record on the publication node).
// The render only reads; the dedicated maintain-cache action owns the pointer
// write (setText), so setText is intentionally not included here.
const RECORDS_CONTRACT_ABI = ['function getText(bytes32 node, string key) view returns (string)'];

type AuthorProof = NonNullable<NonNullable<S2SContentInfo['author']>['proof']>;

/**
 * Warn-once latch for decrypted plaintexts that can only be called a DOUBT.
 *
 * `verifyDecryptedBody` returns a verdict, not a boolean:
 *   'verified'    — the raw bytes hash to the author-signed plaintextHash;
 *   'mismatch'    — they do not (tampering: the item is dropped below);
 *   'weak'        — the signed digest is not a keccak hex, so it cannot be
 *                   checked with keccak (a third-party hash algorithm — the same
 *                   carve-out as inspectItemIntegrity's 'hash-malformed');
 *   'uncheckable' — there is nothing to check against (legacy item).
 * The last two are served, and this latch keeps the log to one line per verdict
 * per invocation, matching data.ctrlr's warnedNonRawPlaintext.
 */
const warnedUnverifiedDecrypted = new Set<string>();
const warnUnverifiedDecrypted = (verdict: string, genesis: string): void => {
  if (warnedUnverifiedDecrypted.has(verdict)) return;
  warnedUnverifiedDecrypted.add(verdict);
  console.log(
    `item integrity: rendering decrypted item ${genesis} unverified (${verdict} plaintext, not a mismatch)`,
  );
};

/**
 * Project an item's `proof` onto the metadata author proof, but ONLY when it is
 * a complete EIP-712 author proof (type + signer + signature). Legacy items
 * without a proof contribute nothing — a half-formed proof is not emitted.
 */
/**
 * Rebuild the author's EIP-712 attestation for the page.
 *
 * A REAL item's proof is `{type, signer, signature}` — `objectId` is a SIBLING
 * field on the item (see toBody), not a member of proof. It is threaded in
 * explicitly so the page carries the digest the author actually signed; reading
 * it off `proof.objectId` alone (as this used to) produced nothing in
 * production and only ever worked against a hand-shaped test fixture.
 */
const toAuthorProof = (proof: unknown, itemObjectId?: unknown): AuthorProof | undefined => {
  if (proof == null || typeof proof !== 'object') return undefined;
  const p = proof as {
    type?: unknown;
    objectId?: unknown;
    signer?: unknown;
    signature?: unknown;
  };
  if (p.type !== 'eip712' || typeof p.signer !== 'string' || typeof p.signature !== 'string') {
    return undefined;
  }
  const objectId =
    typeof p.objectId === 'string'
      ? p.objectId
      : typeof itemObjectId === 'string'
        ? itemObjectId
        : undefined;
  return {
    type: 'eip712',
    ...(objectId ? { objectId } : {}),
    signer: p.signer,
    signature: p.signature,
  };
};

async function main(input: SingleInput): Promise<ActionResult<SingleData>> {
  let html: string | undefined = undefined;
  let t0 = Date.now();
  console.log(`new render @ ${new Date()}`);
  let trace: any[] = [];
  let errors: string[] = [];
  // Structured availability report: every data-fetch failure classified by kind.
  let availability: DataAvailabilityEntry[] = [];
  // Cache-drift signal surfaced in the success envelope: set true when the
  // write-back would fire (shouldFire). The orchestrator uses this to launch
  // the dedicated maintain-cache action in its own fresh session.
  let maintainCachePending = false;

  try {
    requireFields(input, ['job', 'signature', 'authorSafeAddress', 'publication', 'endpoints']);
    const {
      job,
      signature,
      authorSafeAddress,
      configCid,
      publication,
      preview,
      endpoints,
      maintainCache,
      triggeredContentIds,
    } = input;
    const gateway = endpoints.ipfsGateway;
    const rpcs = endpoints.rpcs;
    // Auth for Kubo RPC on the data gateway (token-gated writes; sent on reads too).
    setRpcAuth(endpoints.ipfsGatewayAuth);

    const signerAddress = extractSignerAddress(
      ethers.utils.hashMessage('lit actions auth'),
      signature,
    );

    const protocolInfo = await getProtocolInfo(false, rpcs);
    if (!protocolInfo) throw 'Failed to fetch protocol info';

    // Per-publication content archive pointer (ENS text record). Mirrors
    // update/main.ts's namehash + getText read for contenthash_wrapped. Only
    // read when the template actually has collections (fetchCollections only
    // uses the archive then) — no collections ⇒ no pointer eth_call.
    let archiveCid = '';
    if ((job.templateConfig.collections || []).length > 0) {
      const node = ethers.utils.namehash(publication);
      try {
        archiveCid = await evmRead(
          'L2',
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'getText',
          [node, `content_cache_${publication}`],
          rpcs?.L2,
        );
        // The pointer is an EIP-1577 ipfs-ns contenthash envelope (0xe3 0x01 +
        // CID bytes, written by toHexString in the maintain-cache/update write
        // path). Convert it BACK to a raw CID for fetchCollections' catFile —
        // passing the raw envelope straight to /api/v0/cat?arg=0xe3... 500s and
        // blows the session HTTP cap; decodeArchiveCid swallows decode failures
        // (records that aren't an ipfs-ns contenthash) into '' → no-archive.
        archiveCid = decodeArchiveCid(archiveCid);
      } catch (e) {
        // Cache pointer is non-authoritative (RFC trust model: the cache is a
        // performance optimization, getDeals is the correctness oracle). A failed
        // pointer read must never fail the render — degrade to the no-archive
        // (N-cat) path, which fetchCollections handles when archiveCid is ''.
        console.log(
          `archive pointer read failed, falling back to no-archive: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    trace.push({
      cache: 'pointer',
      publication,
      archiveCid: archiveCid || '(empty)',
      collections: (job.templateConfig.collections || []).length,
      maintainCache,
    });

    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(
      publication,
      rpcs,
    );

    if (multisig == null || configModule == null || publicationModule == null)
      throw 'Failed to resolve publication modules';

    let body: any | undefined | null = await fetchById(
      job.id,
      publicationModule,
      rpcs?.L2,
      gateway,
    );
    if (body == undefined || body == null || body.id == undefined) throw 'Post content not found';
    trace.push(body);

    let config: any;
    try {
      config = await getConfig(configCid, configModule, rpcs?.L2, gateway);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      availability.push({
        kind: 'config',
        cid: configCid,
        reason: `config fetch/parse failed: ${reason || 'unknown error'}`,
        fatal: true,
      });
      throw `config fetch failed: ${reason || 'unknown error'}`;
    }
    trace.push(config);

    let t1 = Date.now();
    trace.push(`got body & config: ${((t1 - t0) / 1000).toFixed(3)} seconds`);

    let templateData: any = await initTemplateData(
      protocolInfo,
      authorSafeAddress,
      signerAddress,
      job.templateConfig,
      body,
      publicationModule,
      rpcs?.L2,
      config.localePaths,
    );
    trace.push(templateData);

    // Revoke detection via on-chain deal state: the decrypt-path
    // `revoked` flag only covers decrypt failures, not a takedown on chain —
    // the author's terminal `retract` or the publication's `reject`.
    // Check hasDeal so a revoked plaintext item also renders
    // as revoked (empty html + preserved path for the orchestrator's
    // remove entry). The path is kept so the orchestrator can derive the
    // remove entry from the revoked job itself (no separate caller-supplied
    // remove entry required).
    //
    // Guard (reviewer C/G): hasDeal=false must only mark GENUINELY-revoked
    // items as revoked, never a live page that merely isn't a deal or a
    // transient RPC failure. Three conservative guards:
    //   a. TRIGGERED-CONTENT SCOPE: the check runs ONLY for the id(s) the
    //      caller rendered (input.triggeredContentIds, threaded through by the
    //      orchestrator from its contentIds). A cascade/ripple destination
    //      (e.g. home) is re-rendered as a consequence of the trigger and is
    //      NEVER hasDeal-checked — a destination pinned via query.genesis may
    //      never have been a deal, so hasDeal=false there would falsely
    //      revoke-and-remove a live page (publish-path regression, acceptance
    //      4; breaks 1(b) in production). A revoke is always about the id the
    //      caller rendered, never a destination.
    //   b. Only run the check when the item has a known path — a genuinely
    //      revoked item was previously rendered, so it has a path to remove.
    //      A pathless job (never rendered, nothing to remove) is never
    //      misclassified as revoked.
    //   c. isRevokedByDealState wraps the evmRead defensively: on RPC failure
    //      it defaults to NOT revoked (treat as still active). A transport
    //      failure must never turn a live page into a revoked-and-removed one;
    //      the orchestrator's runRenderActionWithRetry handles transient RPC
    //      failures.
    const triggeredIds: string[] = triggeredContentIds ?? [];
    if (triggeredIds.includes(job.id) && !templateData.revoked && templateData.path) {
      if (await isRevokedByDealState(job.id, publicationModule, rpcs?.L2)) {
        console.log(`hasDeal false for ${job.id.slice(0, 12)}… — treating as revoked`);
        templateData.revoked = true;
      }
    }

    if (!templateData.revoked) {
      job.revoked = false;

      let t2 = Date.now();
      trace.push(`decrypted body: ${((t2 - t0) / 1000).toFixed(3)} seconds`);

      trace.push({
        cache: 'job',
        jobId: job.id,
        template: job.templateConfig?.reference ?? job.templateConfig?.file ?? '(unknown)',
        collections: (job.templateConfig?.collections || []).length,
        maintainCache,
        preview,
      });

      const { collections, drift, skips } = await fetchCollections(
        job.templateConfig,
        publicationModule,
        rpcs?.L2,
        gateway,
        archiveCid,
      );
      // Record each data-fetch skip as a structured availability entry.
      for (const s of skips) {
        availability.push({
          kind: 'data',
          genesis: s.genesis,
          cid: s.cid,
          reason: s.reason,
          fatal: false,
        });
      }

      let t3 = Date.now();
      trace.push(`fetched collections: ${((t3 - t0) / 1000).toFixed(3)} seconds`);
      trace.push({
        cache: 'drift',
        hasDrift: !!drift,
        deals: drift?.deals?.length,
        needsFetch: drift?.needsFetch?.length,
        fetchedItems: drift?.fetchedItems?.size,
        maintainCache,
      });

      const decryptedCollections: Record<string, any[]> = {};
      for (const key of Object.keys(collections)) {
        const decrypted = await Promise.all(
          collections[key].map(async (item: any) => {
            if (item.encryption) {
              try {
                const d = await decryptRaw(
                  protocolInfo.pkp,
                  item,
                  authorSafeAddress,
                  publicationModule,
                  signerAddress,
                  rpcs?.L2,
                );
                if (!d) {
                  const errorMsg = `Failed to decrypt item ${item.id || 'unknown'}`;
                  console.log(errorMsg);
                  errors.push(errorMsg);
                  availability.push({
                    kind: 'data',
                    genesis: item.id,
                    cid: item.cid,
                    reason: errorMsg,
                    fatal: false,
                  });
                  return null;
                }
                // Integrity: the decrypted plaintext must hash to the
                // author-signed plaintextHash (the stored body is ciphertext, so
                // the check in readItemByEntry cannot apply). Hash the RAW bytes
                // the decryptor returned (d.raw) — never JSON.stringify(d.parsed),
                // which is not the string the author signed. A mismatch is
                // handled exactly like a decrypt failure — non-fatal to the page
                // (the item is dropped), because the remaining collections can
                // still render honestly. The unverified plaintext is NEVER used.
                const plaintextVerdict = verifyDecryptedBody(item, d.raw);
                if (plaintextVerdict === 'mismatch') {
                  const errorMsg = `Plaintext hash mismatch for item ${item.id || 'unknown'}${item.cid ? ` (${item.cid})` : ''}: decrypted body does not match the author-signed plaintextHash`;
                  console.log(errorMsg);
                  errors.push(errorMsg);
                  availability.push({
                    kind: 'data',
                    genesis: item.id,
                    cid: item.cid,
                    reason: errorMsg,
                    fatal: false,
                  });
                  return null;
                }
                if (plaintextVerdict !== 'verified') {
                  // Doubt, not tampering: 'weak' (the signed digest is not a
                  // keccak hex — a third-party hash algorithm, which
                  // inspectItemIntegrity also serves as 'unverifiable') or
                  // 'uncheckable' (nothing to check against). Dropping these
                  // would make the collection reader disagree with itself: the
                  // archive path keeps such an item. Log once per verdict and
                  // render.
                  warnUnverifiedDecrypted(plaintextVerdict, String(item.id ?? 'unknown'));
                }
                const obj = mergeDecrypted(item, d.parsed);
                return obj;
              } catch (error) {
                const errorMsg = `Decryption error for item ${item.id || 'unknown'}: ${error instanceof Error ? error.message : String(error)}`;
                console.log(errorMsg);
                errors.push(errorMsg);
                availability.push({
                  kind: 'data',
                  genesis: item.id,
                  cid: item.cid,
                  reason: errorMsg,
                  fatal: false,
                });
                return null;
              }
            } else {
              item.path = pathsForCollections(item, config);
              return item;
            }
          }),
        );
        decryptedCollections[key] = decrypted.filter(Boolean);
      }

      let t4 = Date.now();
      trace.push(`decrypted collections: ${((t4 - t0) / 1000).toFixed(3)} seconds`);

      templateData.collections = decryptedCollections;
      job.path = templateData.path;

      // Render with BUILT-IN helpers only. The Track-2 runtime publication-helper
      // injection path is DEAD (see brain/specs/RFC-content-transforms.md): the Lit
      // signing enclave cannot compile source→function at render time (CSP blocks
      // eval/new Function; the Lit bundler blocks dynamic import(); actions are
      // immutable + CID-pinned for PKP). Any `config.helpersCid` an old deployed
      // config still carries is IGNORED — graceful no-op, built-ins only. No
      // code-gen, no helper fetch, no eval is attempted here.
      try {
        html = await renderHTML(config, job.templateConfig, templateData, gateway);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        availability.push({
          kind: 'template',
          genesis: job.id,
          reason: `template render failed: ${reason || 'unknown error'}`,
          fatal: true,
        });
        throw `template render failed: ${reason || 'unknown error'}`;
      }

      if (typeof html === 'string') {
        console.log('HTML', html.slice(0, 400));

        let t5 = Date.now();
        trace.push(`rendered: ${((t5 - t0) / 1000).toFixed(3)} seconds`);

        // Build content info from actual data — identity comes from the ITEM
        // that was fetched, never from guesswork. `body.cid` is the real deal
        // CID carried by toBody (the old `body.cid || body.id` fallback emitted
        // `ipfs://0x…` for the bytes32 genesis, which is not a CID).
        const authorProof = toAuthorProof(body.proof, body.objectId);
        const metadata: S2SContentInfo = {
          author: {
            did: body.author || '',
            createdAt: body.creationDate || '',
            ...(authorProof ? { proof: authorProof } : {}),
          },
          publisher: {
            did: signerAddress ? `did:ethr:0x${signerAddress.replace('0x', '')}` : '',
            url: body.publication || '',
            ...(authorSafeAddress ? { safe: authorSafeAddress } : {}),
          },
          contentGenesis: job.id,
          // The item's own EIP-712 digest (sibling of proof), NOT the genesis.
          objectId: typeof body.objectId === 'string' ? body.objectId : undefined,
          contentCid: body.cid,
          plaintextHash: body.plaintextHash,
          mediaType: body.mediaType,
          specVersion: body.specVersion,
          licenseContract: publicationModule,
          isBasedOn: body.parent
            ? {
                genesis: toBytes32Id(body.parent),
                contentHash: '',
                timestamp: body.creationDate || '',
              }
            : undefined,
        };

        html = await addAndSignMetadata(job.id, html, protocolInfo, metadata);

        let t6 = Date.now();
        trace.push(`signed: ${((t6 - t0) / 1000).toFixed(3)} seconds`);

        const htmlCid = await uploadFile(gateway!, html!);
        job.html = htmlCid;

        // Cache-drift signal: compute whether the maintain-cache action should
        // fire and surface it in the success envelope. The orchestrator uses
        // this to launch the dedicated maintain-cache action (PR #69) in its
        // own fresh session — the render no longer writes the pointer itself.
        const shouldFire = shouldWriteBackCache(maintainCache, preview, drift);
        maintainCachePending = shouldFire;
        trace.push({
          cache: 'gate',
          maintainCache,
          preview,
          drift: drift ? 'present' : 'null',
          fire: shouldFire,
        });
      }
    } else {
      // B1 (reviewer): a revoked render is a SUCCESSFUL-but-revoked result,
      // NOT a hard failure. Return ok:true carrying job.revoked=true, the
      // preserved path, and empty html so the orchestrator's `successful`
      // list includes it and the activeJobs/revokedRemove separation in
      // sequence.ts can derive the remove entry from the revoked job's path.
      // (Before this fix the revoked branch pushed into `errors` and returned
      // ok:false with no data.job, so the path was dropped, the job was
      // retried 3x then thrown, and the remove entry never auto-derived — the
      // revoked page lingered in the MFS tree.)
      const revokedMsg = 'Content was revoked or failed to decrypt';
      console.log(revokedMsg);
      job.revoked = true;
      // Keep the path so the orchestrator can derive a remove entry from the
      // revoked job — the update action deletes the path from the MFS tree.
      // An empty path would make the orchestrator unable to construct the
      // remove entry, requiring the caller (neutralpress) to supply it.
      job.path = templateData.path || '';
      job.html = '';
      html = '';
    }

    // Data-fetch failures are NON-FATAL per the availability contract: a page
    // that rendered with some unavailable collection items still produces a
    // valid result. Classify any remaining errors as data availability entries
    // (non-fatal) and return ok:true. Only config/template failures (thrown
    // above) reach the catch block as ok:false.
    for (const err of errors) {
      // Avoid duplicating decrypt errors already recorded above.
      if (!availability.some((a) => a.reason === err)) {
        availability.push({
          kind: 'data',
          reason: err,
          fatal: false,
        });
      }
    }

    return {
      ok: true,
      action: 'render',
      trace,
      data: {
        job,
        html,
        timestamp: new Date().toISOString(),
        maintainCache: maintainCachePending,
        availability: availability.length > 0 ? availability : undefined,
      },
    };
  } catch (e) {
    // On fatal failure, surface the availability entries collected so far in
    // trace so callers can inspect the classified failures.
    if (availability.length > 0) {
      trace.push({ availability });
    }
    return {
      ok: false,
      action: 'single',
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      error:
        typeof e === 'string'
          ? e || 'render action failed'
          : (e as Error)?.message || String(e) || 'render action failed',
      trace,
    };
  }
}

export { main };
