import { S2SContentInfo, ActionResult, SingleInput, SingleData } from "@s2s/soul2soul-shared/lit-actions";
import { decrypt } from "../libs/decrypt";
import { getDomainOwnerAndModules } from "../libs/ens.factory";
import { uploadFile } from "../libs/ipfs.factory";
import { getProtocolInfo } from "../libs/protocol.factory";

import { getConfig } from "./config.ctrl";
import { initTemplateData, fetchCollections, mergeDecrypted, pathsForCollections } from "./data.ctrlr";
import { addAndSignMetadata } from "./metadata";
import { renderHTML} from "../renderer/html.ctrlr";
import { fetchById } from "../libs/lens.factory";
import { extractSignerAddress } from "../libs/gates";
import { requireFields } from "../libs/helpers";

async function main(input: SingleInput): Promise<ActionResult<SingleData>> {

  let html: string | undefined = undefined;
  let t0 = Date.now();
  let trace: any[] = [];
  let errors: string[] = [];

  try {
    requireFields(input, ["job", "signature", "authorSafeAddress", "publication"]);
    const { job, signature, authorSafeAddress, configCid, publication, preview } = input;

    const signerAddress = extractSignerAddress(ethers.utils.hashMessage("lit actions auth"), signature);

    console.log("SIGNER", signerAddress);

    const protocolInfo = await getProtocolInfo(false);
    if (!protocolInfo) throw "Failed to fetch protocol info";

    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(publication);

    if (multisig == null || configModule == null || publicationModule == null)
      throw "Failed to resolve publication modules";

    let body: any | undefined | null = await fetchById(job.id);
    if (body == undefined || body == null || body.id == undefined) throw "Post content not found";
    trace.push(body);

    let config = await getConfig(configCid, configModule);
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
    );
    trace.push(templateData);

    if (!templateData.revoked) {
      job.revoked = false;

      let t2 = Date.now();
      trace.push(`decrypted body: ${((t2 - t0) / 1000).toFixed(3)} seconds`);

      let collections = await fetchCollections(job.templateConfig);

      let t3 = Date.now();
      trace.push(`fetched collections: ${((t3 - t0) / 1000).toFixed(3)} seconds`);

      const decryptedCollections: Record<string, any[]> = {};
      for (const key of Object.keys(collections)) {
        const decrypted = await Promise.all(
          collections[key].map(async (item: any) => {
            if (item.encryption) {
              try {
                const d = await decrypt(protocolInfo.pkp, item, authorSafeAddress, publicationModule, signerAddress);
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
          })
        );
        decryptedCollections[key] = decrypted.filter(Boolean);
      }

      let t4 = Date.now();
      trace.push(`decrypted collections: ${((t4 - t0) / 1000).toFixed(3)} seconds`);

      templateData.collections = decryptedCollections;
      job.path = templateData.path;
      html = await renderHTML(config, job.templateConfig, templateData);

      console.log("HTML1", html.slice(0, 200));

      let t5 = Date.now();
      trace.push(`rendered: ${((t5 - t0) / 1000).toFixed(3)} seconds`);

      const metadata: S2SContentInfo = {
        author: {
          lens: "joera.lens",
          address: "0xAuthorAddress...",
          createdAt: ""
        },
        publisher: {
          ens: "mypub.eth",
          safe: "gno:0xSafeAddress...",
          url: "https://mypub.eth.limo/articles/my-article"
        },
        contentCid: "bafybei...",
        licenseContract: "gno:0xDealsModuleAddress...",
        isBasedOn: {
          lensPublicationId: "",
          contentHash: "",
          timestamp: ""
        }
      };

      html = await addAndSignMetadata(job.id, html, protocolInfo, metadata);

      let t6 = Date.now();
      trace.push(`signed: ${((t6 - t0) / 1000).toFixed(3)} seconds`);

      const htmlCid = await uploadFile(html!);
      job.html = htmlCid;
     

    } else {
      const revokedMsg = "Content was revoked or failed to decrypt";
      console.log(revokedMsg);
      errors.push(revokedMsg);
      job.revoked = true;
      job.path = "";
      job.html = "";
    }

    if (errors.length > 0) {
      return {
        ok: false,
        action: "single",
        error: errors.join("; "),
        trace,
      };
    }

    return {
      ok: true,
      action: "single",
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
      action: "single",
      error: typeof e === "string" ? e : (e as Error)?.message ?? String(e),
      trace
    };
  }
}