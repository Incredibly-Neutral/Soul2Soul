import {
  ActionResult,
  PrepData,
  PrepInput,
  RevokeTarget,
  S2SBody,
  S2SJob,
  S2STemplateConfig,
  isCollectionContainer,
  type CollectionBundleFields,
  type S2SPublicationConfig,
} from '@s2s/soul2soul-shared/lit-actions';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { getManifest } from '../libs/protocol.factory';
import {
  ContentIntegrityError,
  fetchById,
  fetchByPublication,
  getLatestEntry,
  getVersion,
} from '../libs/module.factory';
import { getConfig, getTaskConfig } from '../render/config.ctrl';
import { requireFields, setRpcAuth } from '../libs/helpers';
import { catFile } from '../libs/ipfs.factory';
import { storedBody } from '../libs/item-integrity';
import { createPath } from '../libs/paths';
import { planCollectionJobs } from './collection-plan';
import { rippleFiresForBody } from './ripple-gate';

const ACTION = 'prep';

/**
 * For a content genesis, read the previous version's body from IPFS.
 * The body carries slug, locale and postType, which is what the page path is
 * derived from, so the whole body comes back rather than just the slug.
 */
async function getOldBody(
  genesis: string,
  publicationModule: string,
  rpcs: string[] | undefined,
  gateway: string | undefined,
): Promise<any | null> {
  const version = await getVersion(genesis, publicationModule, rpcs);
  if (!version || !version.cid) return null;

  const item = JSON.parse(await catFile(gateway!, version.cid));
  const body = storedBody(item);
  if (!body) return null;

  return JSON.parse(body);
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

    // The manifest first: it carries the factory discovery asks, so there is no
    // separate record read and nothing to null-check.
    const { moduleFactory: publicationFactory } = await getManifest(rpcs);

    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(
      publication,
      rpcs,
      publicationFactory,
    );
    if (!multisig || !configModule || !publicationModule)
      throw `modules not found for '${publication}' (multisig/config/publication)`;

    const config = await getConfig(configCid, configModule, rpcs?.L2, gateway);
    const jobs: S2SJob[] = [];
    const remove: { path: string; replacedBy?: string }[] = [];
    // Items refused by the integrity check are CONTAINED here: skipping one
    // publication must not cancel prep for every other contentId in the batch
    // (which would also starve their ripple jobs and renders). The render
    // action independently refuses to render such a body, so no job is lost —
    // it is reported instead of aborting the invocation.
    const skipped: { genesis: string; cid: string; reason: string }[] = [];
    // The body each content id resolved to, kept for the revoke pass: a
    // retracted item's body is the only place its locale and postType survive.
    const bodies = new Map<string, any>();

    for (const contentId of contentIds) {
      let body: any;
      try {
        body = await fetchById(contentId, publicationModule, rpcs?.L2, gateway);
      } catch (e) {
        if (!(e instanceof ContentIntegrityError)) throw e;
        console.warn(`prep: skip ${contentId} (cid ${e.cid})`, e.message);
        skipped.push({ genesis: contentId, cid: e.cid, reason: e.message });
        continue;
      }
      if (!body?.id) throw `content not found: '${contentId}'`;
      bodies.set(body.id, body);

      // Slug-change detection: compare the current path with the previous
      // version's, both derived by createPath, so a moved page is removed at
      // the path it actually had.
      const oldBody = await getOldBody(contentId, publicationModule, rpcs?.L2, gateway!);
      if (oldBody?.slug && body.slug && oldBody.slug !== body.slug) {
        const oldTemplateConfig = getTaskConfig(config, oldBody).templateConfig;
        const oldPath = oldTemplateConfig
          ? createPath(oldBody, oldTemplateConfig, config.localePaths)
          : `/${oldBody.slug}`;
        remove.push({ path: oldPath, replacedBy: contentId });
        trace.push(`slug change: ${oldBody.slug} → ${body.slug} (${contentId.slice(0, 12)}…)`);
      }

      const { templateConfig, rippleConfigs } = await getTaskConfig(config, body);

      // The page the bundle itself occupies, when a template claims it. The
      // collection plan needs it: a member that moves onto this path must not
      // remove the page this job is about to write.
      let bundlePath: string | undefined;
      if (templateConfig && templateConfig.file != null) {
        bundlePath = createPath(body, templateConfig, config.localePaths);
        jobs.push({
          id: body.id,
          templateConfig,
          // The page this item will occupy, from the same createPath the
          // render action writes with. The orchestrator turns it into the
          // remove entry for a revoke, so the removal names a page that exists.
          path: bundlePath,
          templateData: undefined,
          html: '',
        });
      }

      // A collection bundle is also a folder of pages: each member gets the job
      // its own template earns, and a member that is gone or moved loses the
      // page it used to occupy. The bundle's own job stays first; a bundle with
      // no members adds no member job and still renders.
      if (isCollectionContainer(body as { mediaType?: string })) {
        const plan = planCollectionJobs({
          config: config as S2SPublicationConfig,
          body: body as CollectionBundleFields,
          oldBody: oldBody as CollectionBundleFields | null,
          bundlePath,
        });
        jobs.push(...plan.jobs);
        for (const entry of plan.remove)
          if (!remove.some((r) => r.path === entry.path)) remove.push(entry);
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

    if (skipped.length > 0) trace.push({ skipped });

    // The caller names the ids it is revoking; the path comes from the
    // publication's template for that item's post type, the same createPath the
    // render writes with. It is never the caller's to guess: `/{slug}` removed
    // nothing on a post template that renders `/posts/{slug}/`.
    //
    // A retracted item's stored body keeps its public part but has lost the
    // slug (the version log tombstones it), so the body alone renders the path
    // as `/posts/{slug}/` — a directory that does not exist. The caller holds
    // the note and supplies the slug; the template still comes from the config.
    for (const target of (input.revoke ?? []) as RevokeTarget[]) {
      const body = bodies.get(target.id);
      const identity: any = {
        ...(body ?? {}),
        slug: body?.slug || target.slug,
        locale: body?.locale || target.locale,
        postType: body?.postType || target.postType,
      };
      const { templateConfig: revokeTemplateConfig } = await getTaskConfig(config, identity);
      const path = revokeTemplateConfig
        ? createPath(identity, revokeTemplateConfig, config.localePaths)
        : undefined;
      if (path && !path.includes('{')) {
        remove.push({ path });
        trace.push(
          `revoke ${target.id.slice(0, 12)}… → ${path}${body?.slug ? '' : ' (slug from the caller: the stored body has none)'}`,
        );
      } else {
        trace.push(`revoke: no page path for ${target.id.slice(0, 12)}… — nothing to remove`);
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
