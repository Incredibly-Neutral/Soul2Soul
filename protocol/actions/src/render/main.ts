/// <reference path="../action_globals.ts" />

import {
  S2SContentInfo,
  ActionResult,
  SingleInput,
  SingleData,
} from '@s2s/soul2soul-shared/lit-actions';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { decrypt } from '../libs/decrypt';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { catFile, uploadFile } from '../libs/ipfs.factory';
import { getProtocolInfo } from '../libs/protocol.factory';
import { evmRead, evmWrite, toHexString } from '../libs/evm';
import { fetchById } from '../libs/module.factory';
import { parseArchive, reconcile, mergeArchive, serialize } from '../libs/archive.factory';

import { getConfig } from './config.ctrl';
import {
  initTemplateData,
  fetchCollections,
  mergeDecrypted,
  pathsForCollections,
  shouldWriteBackCache,
  type CollectionsDrift,
} from './data.ctrlr';
import { addAndSignMetadata } from './metadata';
import { renderHTML } from '../renderer/html.ctrlr';

import { extractSignerAddress } from '../libs/gates';
import { requireFields } from '../libs/helpers';
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

// ENS records contract ABI (getText/setText) — local mirror of update/main.ts;
// no shared ABI import. Used to read the per-publication content archive
// pointer (`content_cache_<publication>` text record on the publication node).
const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value) nonpayable',
];

/**
 * T4 write-back: close the archive drift observed by the read path.
 *
 * I/O-bound and thin by design — all decisions are pure (reconcile in
 * archive.factory, shouldWriteBackCache in data.ctrlr). The caller gates on
 * `shouldWriteBackCache` (maintainCache === true && !preview && drift > 0) and
 * wraps this in try/catch: a failure anywhere here (cat, parse, pin, evmWrite)
 * must never fail the render — the cache is a performance optimization,
 * getDeals is the correctness oracle.
 *
 * Flow (per the T4 contract):
 *   a. archiveCid is already read by the T3 read path above (getText
 *      'content_cache_<publication>'); an empty pointer ⇒ no archive to
 *      maintain ⇒ no write.
 *   b. cat the CURRENT archive fresh, parse, reconcile against the same deals
 *      the read path used (reused — no extra getDeals RPC in-session).
 *   c. if needsFetch non-empty (drift > 0): merge the freshly-fetched full
 *      items into the archive, serialize, uploadFile → newCid.
 *   d. evmWrite setText with confirm=false — fire-and-forget (await broadcast,
 *      not receipt). Push the result to trace.
 *   e. if drift === 0: no write — steady state stays read-only.
 */
async function writeBackArchiveCache(opts: {
  archiveCid: string;
  publication: string;
  publicationModule: string;
  protocolInfo: any;
  gateway?: string;
  rpcs?: { L1?: string[]; L2?: string[] };
  drift: CollectionsDrift;
  trace: any[];
}): Promise<void> {
  const { archiveCid, publication, publicationModule, protocolInfo, gateway, rpcs, drift, trace } =
    opts;

  // b. Read the current archive fresh (self-contained), parse, and reconcile
  // against the same deals the read path used (reused — no extra getDeals RPC
  // in-session; the freshness oracle is stable within one render).
  const archive = parseArchive(await catFile(gateway!, archiveCid));
  const { needsFetch } = reconcile(drift.deals, archive);

  // e. Steady state (drift === 0) performs zero writes — read-only.
  if (needsFetch.length === 0) return;

  // c. Merge the freshly-fetched FULL items (tracked by the read path) into
  // the archive, serialize, and pin via uploadFile. Encrypted items contribute
  // ciphertext only — exactly as the archive lib handles.
  const refreshed = new Map<string, S2SContentItem>();
  for (const entry of needsFetch) {
    const item = drift.fetchedItems.get(entry.genesis);
    if (item) refreshed.set(entry.genesis, item);
  }

  // N1 (reviewer): if the fresh reconcile surfaced entries the read path never
  // fetched (e.g. the archive/pointer changed between read and write-back),
  // `refreshed` can be empty — merging nothing would still pin + fire a
  // pointless setText tx that burns gas. The archive snapshot would be
  // unchanged anyway, so skip the write entirely (zero writes).
  if (refreshed.size === 0) return;

  const next = mergeArchive(archive, drift.deals, refreshed);
  const newCid = await uploadFile(gateway!, serialize(next));

  // d. Fire-and-forget pointer update: confirm=false → await broadcast, not
  // receipt. Push the result to trace.
  const node = ethers.utils.namehash(publication);
  const result = await evmWrite(
    'L2',
    protocolInfo.pkp,
    protocolInfo.ensRecords,
    RECORDS_CONTRACT_ABI,
    'setText',
    [node, `content_cache_${publication}`, toHexString(newCid)],
    false,
    rpcs?.L2?.[0],
  );
  trace.push(JSON.stringify(result));
}

async function main(input: SingleInput): Promise<ActionResult<SingleData>> {
  let html: string | undefined = undefined;
  let t0 = Date.now();
  console.log(`new render @ ${new Date()}`);
  let trace: any[] = [];
  let errors: string[] = [];

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
    } = input;
    const gateway = endpoints.ipfsGateway;
    const rpcs = endpoints.rpcs;

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

    let config = await getConfig(configCid, configModule, rpcs?.L2, gateway);
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
    // `revoked` flag only covers decrypt failures, not on-chain retract.
    // Check hasDeal so a retracted (revoked) plaintext item also renders
    // as revoked (empty html + preserved path for the orchestrator's
    // remove entry). The path is kept so the orchestrator can derive the
    // remove entry from the revoked job itself (no separate caller-supplied
    // remove entry required).
    //
    // Guard (reviewer C/G): hasDeal=false must only mark GENUINELY-revoked
    // items as revoked, never a live page that merely isn't a deal or a
    // transient RPC failure. Two conservative guards, matching the
    // established evmRead pattern in libs/gates.ts (canRead):
    //   a. Only run the check when the item has a known path — a genuinely
    //      revoked item was previously rendered, so it has a path to remove.
    //      A pathless job (never rendered, nothing to remove) is never
    //      misclassified as revoked.
    //   b. isRevokedByDealState wraps the evmRead defensively: on RPC failure
    //      it defaults to NOT revoked (treat as still active). A transport
    //      failure must never turn a live page into a revoked-and-removed one;
    //      the orchestrator's runRenderActionWithRetry handles transient RPC
    //      failures.
    if (!templateData.revoked && templateData.path) {
      if (await isRevokedByDealState(job.id, publicationModule, rpcs?.L2)) {
        console.log(`hasDeal false for ${job.id.slice(0, 12)}… — treating as revoked`);
        templateData.revoked = true;
      }
    }

    if (!templateData.revoked) {
      job.revoked = false;

      let t2 = Date.now();
      trace.push(`decrypted body: ${((t2 - t0) / 1000).toFixed(3)} seconds`);

      const { collections, drift } = await fetchCollections(
        job.templateConfig,
        publicationModule,
        rpcs?.L2,
        gateway,
        archiveCid,
      );

      let t3 = Date.now();
      trace.push(`fetched collections: ${((t3 - t0) / 1000).toFixed(3)} seconds`);

      const decryptedCollections: Record<string, any[]> = {};
      for (const key of Object.keys(collections)) {
        const decrypted = await Promise.all(
          collections[key].map(async (item: any) => {
            if (item.encryption) {
              try {
                const d = await decrypt(
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
                  return null;
                }
                const obj = mergeDecrypted(item, d);
                return obj;
              } catch (error) {
                const errorMsg = `Decryption error for item ${item.id || 'unknown'}: ${error instanceof Error ? error.message : String(error)}`;
                console.log(errorMsg);
                errors.push(errorMsg);
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
      html = await renderHTML(config, job.templateConfig, templateData, gateway);

      if (typeof html === 'string') {
        console.log('HTML', html.slice(0, 400));

        let t5 = Date.now();
        trace.push(`rendered: ${((t5 - t0) / 1000).toFixed(3)} seconds`);

        // Build content info from actual data
        const metadata: S2SContentInfo = {
          author: {
            did: body.author || '',
            createdAt: body.creationDate || '',
          },
          publisher: {
            did: signerAddress ? `did:ethr:0x${signerAddress.replace('0x', '')}` : '',
            url: body.publication || '',
          },
          contentCid: body.cid || body.id || '',
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

        // T4: drift-gated, fire-and-forget archive write-back. Only the
        // designated last parallel job (maintainCache === true) ever writes,
        // and never for preview. Best-effort: a failure anywhere in the
        // write-back (cat, parse, pin, evmWrite) is caught and must NOT fail
        // the render — the result is identical whether or not the cache write
        // succeeded. Steady state (no drift) performs zero writes.
        if (shouldWriteBackCache(maintainCache, preview, drift)) {
          try {
            await writeBackArchiveCache({
              archiveCid,
              publication,
              publicationModule,
              protocolInfo,
              gateway,
              rpcs,
              drift,
              trace,
            });
          } catch (e) {
            console.log(
              `archive write-back failed (best-effort, render unaffected): ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
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

    if (errors.length > 0) {
      return {
        ok: false,
        action: 'render',
        error: errors.join('; '),
        trace,
      };
    }

    return {
      ok: true,
      action: 'render',
      trace,
      data: {
        job,
        html,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (e) {
    return {
      ok: false,
      action: 'single',
      error: typeof e === 'string' ? e : ((e as Error)?.message ?? String(e)),
      trace,
    };
  }
}

export { main };
