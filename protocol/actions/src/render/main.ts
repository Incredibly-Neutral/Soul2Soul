import {
  S2SContentInfo,
  ActionResult,
  SingleInput,
  SingleData,
} from '@s2s/soul2soul-shared/lit-actions';
import { decrypt } from '../libs/decrypt';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { uploadFile } from '../libs/ipfs.factory';
import { getProtocolInfo } from '../libs/protocol.factory';
import { fetchById } from '../libs/module.factory';

import { getConfig } from './config.ctrl';
import {
  initTemplateData,
  fetchCollections,
  mergeDecrypted,
  pathsForCollections,
} from './data.ctrlr';
import { addAndSignMetadata } from './metadata';
import { renderHTML } from '../renderer/html.ctrlr';

import { extractSignerAddress } from '../libs/gates';
import { requireFields } from '../libs/helpers';
import { toBytes32Id } from '@s2s/soul2soul-shared/lit-actions';

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
      config.localePaths,
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