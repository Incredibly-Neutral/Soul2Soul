import { ActionResult, PrepData, PrepInput, S2SBody, S2SJob, S2STemplateConfig } from "@s2s/soul2soul-shared/lit-actions";
import { getDomainOwnerAndModules } from "../libs/ens.factory";
import { getLatestEntry, fetchById, fetchByPublication } from "../libs/module.factory";
import { getConfig, getTaskConfig } from "../render/config.ctrl";
import { requireFields } from "../libs/helpers";

const ACTION = "prep";

async function main(input: PrepInput): Promise<ActionResult<PrepData>> {

  let trace: any[] = [];

  console.log(`prep action @ ${new Date()}`)

  try {
    requireFields(input, ["publication", "contentIds"]);          // configCid is optional
    const { publication, configCid, contentIds } = input;
    if (!Array.isArray(contentIds) || contentIds.length === 0)
      throw "contentIds must be a non-empty array";

    const { multisig, configModule, publicationModule } =
      await getDomainOwnerAndModules(publication);
    if (!multisig || !configModule || !publicationModule)
      throw `modules not found for '${publication}' (multisig/config/publication)`;

    const config = await getConfig(configCid, configModule);
    const jobs: S2SJob[] = [];

    for (const contentId of contentIds) {
      // const entry = await getLatestEntry(contentId, publicationModule);
      // if (!entry.cid) throw `content not found: '${contentId}'`;
      const body = await fetchById(contentId, publicationModule);
      if (!body?.id) throw `content not found: '${contentId}'`;

      const { templateConfig, rippleConfigs } = await getTaskConfig(config, body);
      jobs.push({ id: body.id, templateConfig, templateData: undefined, html: "" });

      // ripples = cascade re-renders; only expand for a single primary content id
      if (contentIds.length === 1) {
        for (const rippleConfig of rippleConfigs) {
          const rippleTemplateConfig: S2STemplateConfig | undefined =
            config.mapping.templateConfig.find(
              (m: S2STemplateConfig) => m.reference === rippleConfig.destination);
          if (!rippleTemplateConfig)
            throw `ripple destination '${rippleConfig.destination}' not in mapping.templateConfig`;

          const ripples = await fetchByPublication(publicationModule);
          for (const ripple of ripples)
            if (ripple?.id)
              jobs.push({ id: ripple.id, templateConfig: rippleTemplateConfig,
                          templateData: undefined, html: "" });
        }
      }
    }

    // dedup by id, first occurrence wins
    const seen = new Set<string>();
    const uniqueJobs: S2SJob[] = [];
    for (const job of jobs) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      uniqueJobs.push(job);
    }

    return { ok: true, action: ACTION, data: { jobs: uniqueJobs }, trace };
  } catch (e) {
    return { ok: false, action: ACTION,
             error: typeof e === "string" ? e : (e as Error)?.message ?? String(e), trace };
  }
}