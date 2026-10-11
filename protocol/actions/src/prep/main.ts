import {
  ActionResult,
  PrepData,
  PrepInput,
  S2SBody,
  S2SJob,
  S2STemplateConfig,
} from '@s2s/soul2soul-shared/lit-actions';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { getLatestEntry, fetchById, fetchByPublication, getVersion } from '../libs/module.factory';
import { getConfig, getTaskConfig } from '../render/config.ctrl';
import { requireFields, setRpcAuth } from '../libs/helpers';
import { catFile } from '../libs/ipfs.factory';
import { rippleFiresForBody } from './ripple-gate';

const ACTION = 'prep';

/**
 * For a content genesis, check the on-chain version log for the previous version.
 * Fetch its content item from IPFS and extract the old slug.
 * Returns the old slug, or null if this is the first version.
 */
async function getOldSlug(
  genesis: string,
  publicationModule: string,
  rpcs: string[] | undefined,
  gateway: string | undefined,
): Promise<string | null> {
  const version = await getVersion(genesis, publicationModule, rpcs);
  if (!version || !version.cid) return null;

  const item = JSON.parse(await catFile(gateway!, version.cid));
  if (!item.body) return null;

  const parsed = JSON.parse(item.body);
  return parsed.slug || null;
}

async function main(input: PrepInput): Promise<ActionResult<PrepData>> {
  let trace: any[] = [];

  console.log(`prep action @ ${new Date()}`);

  try {
    requireFields(input, ['publication', 'contentIds', 'endpoints']);
    const { publication, configCid, contentIds, endpoints } = input;
    console.log(endpoints);
    const gateway = endpoints.ipfsGateway;
    const rpcs = endpoints.rpcs;
    // Auth for Kubo RPC on the data gateway (token-gated writes; sent on reads too).
    setRpcAuth(endpoints.ipfsGatewayAuth);
    if (!Array.isArray(contentIds) || contentIds.length === 0)
      throw 'contentIds must be a non-empty array';

    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(
      publication,
      rpcs,
    );
    if (!multisig || !configModule || !publicationModule)
      throw `modules not found for '${publication}' (multisig/config/publication)`;

    const config = await getConfig(configCid, configModule, rpcs?.L2, gateway);
    const jobs: S2SJob[] = [];
    const remove: { path: string; replacedBy?: string }[] = [];

    for (const contentId of contentIds) {
      const body = await fetchById(contentId, publicationModule, rpcs?.L2, gateway);
      if (!body?.id) throw `content not found: '${contentId}'`;

      // Slug-change detection: compare current slug with the first-version slug
      const oldSlug = await getOldSlug(contentId, publicationModule, rpcs?.L2, gateway!);
      if (oldSlug && body.slug && oldSlug !== body.slug) {
        remove.push({ path: oldSlug, replacedBy: contentId });
        trace.push(`slug change: ${oldSlug} → ${body.slug} (${contentId.slice(0, 12)}…)`);
      }

      const { templateConfig, rippleConfigs } = await getTaskConfig(config, body);

      if (templateConfig && templateConfig.file != null) {
        jobs.push({ id: body.id, templateConfig, templateData: undefined, html: '' });
      }

      if (contentIds.length === 1) {
        for (const rippleConfig of rippleConfigs) {
          // Trigger-side gate: the ripple fires only if its origins match the
          // triggering body's postType AND every trigger_filters predicate
          // matches the body. Runs BEFORE the destination job is built, so it
          // gates both the genesis and non-genesis destination branches.
          if (!rippleFiresForBody(rippleConfig, body)) continue;

          const rippleTemplateConfig: S2STemplateConfig | undefined =
            config.mapping.templateConfig.find(
              (m: S2STemplateConfig) => m.reference === rippleConfig.destination,
            );
          if (!rippleTemplateConfig)
            throw `ripple destination '${rippleConfig.destination}' not in mapping.templateConfig`;

          let ripples: any[];

          if (rippleConfig.query?.genesis != undefined) {
            ripples = [{ id: rippleConfig.query.genesis }];
          } else {
            ripples = await fetchByPublication(publicationModule, rpcs?.L2, gateway);
            if (rippleConfig.filters?.length) {
              ripples = ripples.filter((item) =>
                rippleConfig.filters!.every((filter) =>
                  Object.entries(filter).every(([key, value]) => item[key] === value),
                ),
              );
            }
          }

          for (const ripple of ripples)
            if (ripple?.id)
              jobs.push({
                id: ripple.id,
                templateConfig: rippleTemplateConfig,
                templateData: undefined,
                html: '',
              });
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

    return {
      ok: true,
      action: ACTION,
      data: { jobs: uniqueJobs, remove: remove.length > 0 ? remove : undefined },
      trace,
    };
  } catch (e) {
    return {
      ok: false,
      action: ACTION,
      error: typeof e === 'string' ? e : ((e as Error)?.message ?? String(e)),
      trace,
    };
  }
}

export { main };
