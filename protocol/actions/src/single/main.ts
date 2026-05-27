import { S2SBody, S2SContentInfo } from "@s2s/soul2soul-shared/lit-actions";
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

async function main({ job, signature, authorSafeAddress, configCid, publication, debug, dev } : any) { 

    const signerAddress = extractSignerAddress(ethers.utils.hashMessage("lit actions auth"), signature);

    console.log("SIGNER",signerAddress);

    let html: string | undefined = undefined;
    let t0 = Date.now(); 
    let logz: any[] = [];
    let errors: string[] = []; // Track all errors
    
    const protocolInfo = await getProtocolInfo(false);
    if (!protocolInfo) throw "Failed to fetch protocol info";
    // console.log(protocolInfo)

    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(publication);

    // console.log(publication, multisig, configModule, publicationModule)
    if(multisig == null || configModule == null || publicationModule == null ) return;

    let body: any | undefined | null = await fetchById(job.id)
    if (body == undefined || body == null || body.id == undefined) throw "Post content not found"
    logz.push(body)

    let config = await getConfig(authorSafeAddress, configCid, configModule, dev);
    logz.push(config)

    let t1 = Date.now();
    logz.push(`got body & config: ${((t1 - t0) / 1000).toFixed(3)} seconds`);

    let templateData : any = await initTemplateData(
        protocolInfo,
        authorSafeAddress,
        signerAddress,
        job.templateConfig,
        body,
        publicationModule,  
    ) 

    logz.push(templateData)


    if (!templateData.revoked) {

        job.revoked = false;

        let t2 = Date.now();
        logz.push(`decrypted body: ${((t2 - t0) / 1000).toFixed(3)} seconds`);

        let collections = await fetchCollections(job.templateConfig);

        try {
            console.log("collections", collections['posts'].map( (item: any) => item.tags))
        }
        catch (e) {}
  
        let t3 = Date.now();
        logz.push(`fetched collections: ${((t3 - t0) / 1000).toFixed(3)} seconds`)

        const decryptedCollections: Record<string, any[]> = {};

        for (const key of Object.keys(collections)) {

            const decrypted = await Promise.all(
                collections[key].map(async (item: any) => {

                    // console.log("collection item tags", item.tags)

                    if (item.encryption) {
                        console.log("encryption")
                        try {
                            const d = await decrypt(protocolInfo.pkp.ethAddress, item, authorSafeAddress, publicationModule, signerAddress);
                            if (!d) {
                                const errorMsg = `Failed to decrypt item ${item.id || 'unknown'}`;
                                console.log(errorMsg);
                                errors.push(errorMsg);
                                return null;
                            }
                            const obj = mergeDecrypted(item, d);
                            obj.C
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
        logz.push(`decrypted collections:  ${((t4 - t0) / 1000).toFixed(3)} seconds`);

        templateData.collections = decryptedCollections;

        // Set the interpolated path on the job so updateEvm uses the real slug
        job.path = templateData.path;

        // render method was per publication .. no longer possible ... 
        html = await renderHTML(config, job.templateConfig,  templateData);

        console.log("HTML1", html.slice(0,200))

        let t5 = Date.now();
        logz.push(`rendered: ${((t5 - t0) / 1000).toFixed(3)} seconds`);

        if (!dev) {

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
            }

        
            html = await addAndSignMetadata(job.id, html, protocolInfo, metadata);
        }

        console.log("HTML2", html.slice(0,200))

        let t6 = Date.now();
        logz.push(`signed: ${((t6 - t0) / 1000).toFixed(3)} seconds`);

     
       const htmlCid  = await uploadFile(html!);
       console.log("HTMLCID",htmlCid)
       job.html = htmlCid


    } else {

        const revokedMsg = "Content was revoked or failed to decrypt";
        console.log(revokedMsg);
        errors.push(revokedMsg);
        
        job.revoked = true
        job.path = "";
        job.html = ""
    } 

    return {
        success: errors.length === 0,
        timestamp: new Date(),
        job,
        html,
        logz,
        ...(errors.length > 0 && { errors }), // Only include if there are errors
    }
}