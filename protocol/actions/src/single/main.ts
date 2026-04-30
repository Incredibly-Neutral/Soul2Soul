/// <reference path="../action_globals.ts" />

import { S2SContentInfo } from "@s2s/soul2soul-shared/lit-actions";
import { decrypt } from "../libs/decrypt";
import { getDomainOwnerAndModules } from "../libs/ens.factory";
import { uploadFile } from "../libs/ipfs.factory";
import { getProtocolInfo } from "../libs/protocol.factory";
import { getBody } from "./body";

import { getConfig } from "./config.ctrl";
import { initTemplateData, fetchCollections, mergeDecrypted, pathsForCollections } from "./data.ctrlr";
import { addAndSignMetadata } from "./metadata";

const main = async () => {

    let { job  } = jsParams;
    const { authorSafeAddress, config_cid: configCid, publication, debug, dev } = jsParams;

    let html: string | undefined = undefined;
    let t0 = Date.now(); 
    let errors: string[] = []; // Track all errors
    
    const protocolInfo = await getProtocolInfo(authorSafeAddress, false);
    if (!protocolInfo) throw "Failed to fetch protocol info"

    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(publication);
    if(multisig == null || configModule == null || publicationModule == null ) return;

    const body = await getBody(job.id, "single")
    if (body.id == undefined) throw "Post content not found"

    let config = await getConfig(authorSafeAddress, configCid, configModule, dev);

    let t1 = Date.now();
    console.log("got body & config: ", ((t1 - t0) / 1000).toFixed(3), "seconds");

    let templateData : any = await initTemplateData(
        protocolInfo,
        authorSafeAddress,
        job.templateConfig,
        body,
        publicationModule,  
    ) 

    if (!templateData.revoked) {

        job.revoked = false;

        let t2 = Date.now();
        console.log("decrypted body: ", ((t2 - t0) / 1000).toFixed(3), "seconds");

        let collections = JSON.parse(await LitActions.runOnce({
            waitForResponse: true,
            name: `prepTD-${job.id.slice(0,4)}`
        }, async () => {    
            return JSON.stringify(await fetchCollections(
                job.templateConfig
            ));
        }));

        let t3 = Date.now();
        console.log("fetched collections: ", ((t3 - t0) / 1000).toFixed(3), "seconds");

        const decryptedCollections: Record<string, any[]> = {};

        for (const key of Object.keys(collections)) {
            const encrypted = collections[key].filter((item: any) => 
                item.content?.includes?.('ciphertext')
            );
            
            const decrypted = await Promise.all(
                encrypted.map(async (item: any) => {
                    try {
                        const d = await decrypt(item, authorSafeAddress, publicationModule);
                        if (!d) {
                            const errorMsg = `Failed to decrypt item ${item.id || 'unknown'}`;
                            console.log(errorMsg);
                            errors.push(errorMsg);
                            return null;
                        }
                        const obj = mergeDecrypted(item, d);
                        obj.path = pathsForCollections(obj, config);
                        return obj;
                    } catch (error) {
                        const errorMsg = `Decryption error for item ${item.id || 'unknown'}: ${error instanceof Error ? error.message : String(error)}`;
                        console.log(errorMsg);
                        errors.push(errorMsg);
                        return null;
                    }
                })
            );
            
            decryptedCollections[key] = decrypted.filter(Boolean);
        }
        
        let t4 = Date.now();
        console.log("decrypted collections: ", ((t4 - t0) / 1000).toFixed(3), "seconds");

        templateData.collections = decryptedCollections;

        let res: any = JSON.parse(await LitActions.call({
            ipfsId: config.render_action,
            params: {
                config,
                templateConfig: job.templateConfig,
                templateData,
            },
        }));

        let t5 = Date.now();
        console.log("rendered: ", ((t5 - t0) / 1000).toFixed(3), "seconds");

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
 
        html = await addAndSignMetadata(job.id, res.html, protocolInfo, metadata);

        let t6 = Date.now();
        console.log("signed: ", ((t6 - t0) / 1000).toFixed(3), "seconds");

        job.path = templateData.path;

        job = JSON.parse(await LitActions.runOnce({
            waitForResponse: true,
            name: `uploadHTML-${job.id.slice(0,4)}`
        },
        async () => {    
            job.html = await uploadFile(html!)
            return JSON.stringify(job);
        }));

    } else {
        const revokedMsg = "Content was revoked or failed to decrypt";
        console.log(revokedMsg);
        errors.push(revokedMsg);
        
        job.revoked = true
        job.path = "";
        job.html = ""
    }

    LitActions.setResponse({
        response: JSON.stringify({
            success: errors.length === 0,
            timestamp: new Date(),
            job,
            html,
            ...(errors.length > 0 && { errors }), // Only include if there are errors
        })
    })
}
main();