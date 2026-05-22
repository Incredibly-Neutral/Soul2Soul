import { S2SBody, S2SJob, S2STemplateConfig } from "@s2s/soul2soul-shared/lit-actions";
import { getDomainOwnerAndModules } from "../libs/ens.factory";
import { fetchById, fetchByQuery } from "../libs/lens.factory";
import { getProtocolInfo } from "../libs/protocol.factory";
import { getConfig, getTaskConfig } from "../single/config.ctrl";


async function main({ protocolInfo, authorSafeAddress, publication, configCid, contentIds, dev } : any) { 
  
    let jobs: S2SJob[] = [];

    // let protocolInfo;
    // try {
    //     protocolInfo = await getProtocolInfo(false);
    // } catch (error) {
    //     console.error("Failed to fetch protocol info:", error);
    //     throw error;
    // }

    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(publication);
    if(multisig == null || configModule == null || publicationModule == null ) return;

    const config = await getConfig(authorSafeAddress, configCid, configModule, dev);

    for (let contentId of contentIds) {

        let body: S2SBody | undefined | null  = await fetchById(contentId)    
        if (body == undefined || body == null || body.id == undefined) throw "Post content not found"

        const { templateConfig, rippleConfigs } = await getTaskConfig(config, body);

        jobs.push({
            id: body.id,
            templateConfig,
            templateData: undefined,
            html: "",
        });

        if (contentIds.length == 1) {
            
            for (const rippleConfig of rippleConfigs) {

                let ripples = await fetchByQuery(rippleConfig.query.method, rippleConfig.query.args)
            
                let rippleTemplateConfig: S2STemplateConfig =
                config.mapping.templateConfig.find(
                    (m: any) => m.reference === rippleConfig.destination
                );

                for (const ripple of ripples) {

                    if (ripple != null) {

                        jobs.push({
                            id: ripple.id,
                            templateConfig: rippleTemplateConfig,
                            templateData: undefined,
                            html: ""
                        });
                    }
                }
            }
        }
    }

    const uniqueJobs: S2SJob[] = [];
    for (const job of jobs) {
        const existingJob = uniqueJobs.find(
            (j: S2SJob) => j.id === job.id
        );
        if (!existingJob) {
            uniqueJobs.push(job);
        }
    }

    return {
            success: true,
            jobs: uniqueJobs
        }
};