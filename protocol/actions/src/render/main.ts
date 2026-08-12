import {
  S2SContentInfo,
  ActionResult,
  SingleInput,
  SingleData,
} from '@s2s/soul2soul-shared/lit-actions';
import { decrypt } from '../libs/decrypt';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { catFile, uploadFile } from '../libs/ipfs.factory';
import { evmRead } from '../libs/evm';
import { getProtocolInfo } from '../libs/protocol.factory';
import { fetchById } from '../libs/module.factory';

import { Abi_S2SRecordsModule } from '../../../contracts/generated/abis/S2SRecordsModule.ts';

import { getConfig } from './config.ctrl';
import {
  initTemplateData,
  fetchCollections,
  mergeDecrypted,
  pathsForCollections,
} from './data.ctrlr';
import { addAndSignMetadata } from './metadata';
import { renderHTML } from '../renderer/html.ctrlr';
import { snapshotHelperMap, resetHelperMap } from '../renderer/handlebars.factory';
import {
  TEMPLATE_HELPERS_RECORD_KEY,
  TEMPLATE_HELPERS_CONFIG_FIELD,
  validateHelpersSource,
  mergePublicationHelpers,
} from '../renderer/helpers';

import { extractSignerAddress } from '../libs/gates';
import { requireFields } from '../libs/helpers';
import { toBytes32Id } from '@s2s/soul2soul-shared/lit-actions';

/**
 * True when a `getRecord` failure means the record is simply absent on-chain
 * (the S2S Records Module reverts with `EmptyKey` for an empty key and
 * `KeyNotFound` for a missing key). These DEGRADE gracefully to built-in-only
 * helpers; any other error is surfaced loudly.
 */
export const isMissingRecordError = (e: unknown): boolean => {
  const msg = typeof e === 'string' ? e : ((e as Error)?.message ?? String(e));
  return /EmptyKey|KeyNotFound/i.test(msg);
};

/**
 * Resolve the publication's template-helper CID.
 *
 * 1. If the publication config carries `helpersCid` (camelCase, matching
 *    `assetsCid` / `templateCid`), use it directly — it takes precedence over
 *    the on-chain record so configs that already carry the CID avoid a chain hop.
 * 2. Otherwise read the `template_helpers_cid` record off the S2S Records
 *    Module (the `configModule` Safe KV store — the publication module has no
 *    `getRecord`) via `getRecord`.
 *
 * Returns `null` (graceful degrade — render with built-ins only) when the
 * record is missing (`KeyNotFound`/`EmptyKey`). Throws on any other failure.
 */
const resolveTemplateHelpersCid = async (
  config: any,
  configModule: string,
  rpcs?: string[],
): Promise<string | null> => {
  const configCid = config?.[TEMPLATE_HELPERS_CONFIG_FIELD];
  if (typeof configCid === 'string' && configCid.length > 0) {
    return configCid;
  }
  try {
    const cid = await evmRead(
      'L2',
      configModule,
      Abi_S2SRecordsModule,
      'getRecord',
      [TEMPLATE_HELPERS_RECORD_KEY],
      rpcs,
    );
    return typeof cid === 'string' && cid.length > 0 ? cid : null;
  } catch (e) {
    if (isMissingRecordError(e)) return null; // no helper record → built-ins only
    throw e; // any other failure surfaces loudly upstream
  }
};

// exported for unit testing
export { resolveTemplateHelpersCid };

/**
 * Inject publication helpers for the CURRENT render into the shared helper map
 * (per-render scoped by the caller's snapshot/reset). Returns `null` on success
 * or a human-readable error string on a broken helper (the caller must surface
 * it loudly — never silently render without a broken helper).
 */
const injectPublicationHelpers = async (
  config: any,
  configModule: string,
  rpcs: string[] | undefined,
  gateway: string | undefined,
  trace: any[],
): Promise<string | null> => {
  try {
    const helperCid = await resolveTemplateHelpersCid(config, configModule, rpcs);
    if (!helperCid) {
      trace.push({ action: 'helpers', injected: false, reason: 'no helper record' });
      return null;
    }
    const source = await catFile(gateway!, helperCid);
    const publicationHelpers = validateHelpersSource(source); // throws on broken module
    const { merged, skipped } = mergePublicationHelpers(publicationHelpers);
    console.log(
      `[helpers] injected ${merged} publication helper(s) from cid ${helperCid}` +
        (skipped.length ? `; skipped built-in collisions: ${skipped.join(', ')}` : ''),
    );
    trace.push({ action: 'helpers', injected: true, cid: helperCid, merged, skipped });
    return null;
  } catch (e) {
    return typeof e === 'string' ? e : ((e as Error)?.message ?? String(e));
  }
};

// exported for unit testing
export { injectPublicationHelpers };

async function main(input: SingleInput): Promise<ActionResult<SingleData>> {
  let html: string | undefined = undefined;
  let t0 = Date.now();
  console.log(`new render @ ${new Date()}`);
  let trace: any[] = [];
  let errors: string[] = [];

  try {
    requireFields(input, ['job', 'signature', 'authorSafeAddress', 'publication', 'endpoints']);
    const { job, signature, authorSafeAddress, configCid, publication, preview, endpoints } = input;
    const gateway = endpoints.ipfsGateway;
    const rpcs = endpoints.rpcs;

    const signerAddress = extractSignerAddress(
      ethers.utils.hashMessage('lit actions auth'),
      signature,
    );

    const protocolInfo = await getProtocolInfo(false, rpcs);
    if (!protocolInfo) throw 'Failed to fetch protocol info';

    const { multisig, configModule, publicationModule } =
      await getDomainOwnerAndModules(publication, rpcs);

    if (multisig == null || configModule == null || publicationModule == null)
      throw 'Failed to resolve publication modules';

    let body: any | undefined | null = await fetchById(job.id, publicationModule, rpcs?.L2, gateway);
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
    );
    trace.push(templateData);

    if (!templateData.revoked) {
      job.revoked = false;

      let t2 = Date.now();
      trace.push(`decrypted body: ${((t2 - t0) / 1000).toFixed(3)} seconds`);

      let collections = await fetchCollections(job.templateConfig, publicationModule, rpcs?.L2, gateway);

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

      // ── Track 2 (RFC A): publication-scoped template-helper injection ──
      // Per-render isolation: snapshot the pristine built-in helper map, merge
      // THIS publication's helpers for the duration of the render, then reset
      // in `finally` so no helper leaks into another render or shadows a
      // built-in in the long-lived runner process.
      const helperSnapshot = snapshotHelperMap();
      try {
        const helperFailure = await injectPublicationHelpers(
          config,
          configModule,
          rpcs?.L2,
          gateway,
          trace,
        );
        if (helperFailure) {
          // Broken helper → fail LOUDLY (never silently render without it).
          const errorMsg = `template helper injection failed: ${helperFailure}`;
          console.log(`[helpers] ${errorMsg}`);
          errors.push(errorMsg);
        } else {
          html = await renderHTML(config, job.templateConfig, templateData, gateway);
        }
      } finally {
        resetHelperMap(helperSnapshot);
      }

      // When a broken publication helper failed injection we did NOT render
      // (html stays `undefined`); the errors check below returns ok:false for
      // that case, so skip the downstream sign/upload work.
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
      }
    } else {
      const revokedMsg = 'Content was revoked or failed to decrypt';
      console.log(revokedMsg);
      errors.push(revokedMsg);
      job.revoked = true;
      job.path = '';
      job.html = '';
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