// ============================================================================
// prep/collection-plan.ts — the member pages a collection bundle gains, and
// the ones it loses, relative to the bundle version already stored.
//
// Pure: a publication config, the new decrypted body and the previous flat
// body in; jobs and removals out. No chain read, no IPFS, no clock, so every
// decision can be tested against fixtures.
//
// A member is a page in its own right: it gets the same job a standalone post
// gets, addressed by the bundle genesis plus the member's key. A member that is
// gone, or whose slug moved it, loses the page it used to occupy; the new path,
// if any, is covered by that member's job.
// ============================================================================

import {
  collectionMemberBody,
  expandCollection,
  isCollectionContainer,
  type CollectionBundleFields,
  type S2SBody,
  type S2SExpandedCollectionMember,
  type S2SJob,
  type S2SPublicationConfig,
  type S2STemplateConfig,
} from '@s2s/soul2soul-shared/lit-actions';
import { createPath } from '../libs/paths';
import { getTaskConfig } from '../render/config.ctrl';

/** Where a member lands, with the template that put it there. */
interface ResolvedPage {
  templateConfig: S2STemplateConfig;
  path: string;
}

/**
 * Members of a confirmed container. `expandCollection` returns a union because
 * it also passes a non-container through; inside a container every element is
 * an expanded member, and the key is what tells them apart.
 */
const membersOf = (bundle: CollectionBundleFields): S2SExpandedCollectionMember[] =>
  expandCollection(bundle).filter(
    (body): body is S2SExpandedCollectionMember => 'collectionKey' in body,
  );

/**
 * The page a body occupies, or null when its post type maps to no template.
 * An unmapped member is the same as an unmapped post today: no job, no throw.
 * The `file` check mirrors the bundle job's own rule, so a template that cannot
 * render is not planned into a job.
 */
const resolvePage = (
  body: S2SBody,
  config: S2SPublicationConfig,
  localePaths: Record<string, string> | undefined,
): ResolvedPage | null => {
  const { templateConfig } = getTaskConfig(config, body);
  if (!templateConfig?.file) return null;

  const path = createPath(body, templateConfig, localePaths);
  if (!path) return null;

  return { templateConfig, path };
};

/**
 * Plan the member work for one collection bundle.
 *
 * `body` is the new decrypted flat body; `oldBody` is the version already
 * stored, or null for a first publication. A body that is not a collection
 * container yields nothing — prep's own single job stands unchanged.
 */
export function planCollectionJobs(args: {
  config: S2SPublicationConfig;
  body: CollectionBundleFields;
  oldBody: CollectionBundleFields | null;
}): { jobs: S2SJob[]; remove: { path: string; replacedBy?: string }[] } {
  const { config, body, oldBody } = args;

  if (!isCollectionContainer(body)) return { jobs: [], remove: [] };

  const jobs: S2SJob[] = [];
  const jobPaths = new Set<string>();
  // The new member's page per key: what a former member is compared against.
  const nextPaths = new Map<string, string>();

  for (const member of membersOf(body)) {
    const page = resolvePage(member, config, config.localePaths);
    if (!page) continue;

    jobs.push({
      id: member.id,
      sourceId: body.id,
      collectionKey: member.collectionKey,
      templateConfig: page.templateConfig,
      // Left for the render to build, exactly as the bundle job's is.
      templateData: undefined,
      html: '',
      path: page.path,
    });
    jobPaths.add(page.path);
    nextPaths.set(member.collectionKey, page.path);
  }

  // Removals are diffed against the stored bundle only. Its members inherit
  // postType, locale and the rest from it, so the old page is resolved from a
  // body built the same way the render built it the first time.
  const removals: { path: string; replacedBy?: string }[] = [];
  if (oldBody && isCollectionContainer(oldBody)) {
    const items = oldBody.collection?.items ?? [];
    items.forEach((item, index) => {
      const oldMember = collectionMemberBody(oldBody, item, index);
      const oldPage = resolvePage(oldMember, config, config.localePaths);
      if (!oldPage) return;

      // Still there at the same path: nothing moved, nothing to delete.
      if (nextPaths.get(item.key) === oldPage.path) return;

      removals.push({ path: oldPage.path, replacedBy: body.id });
    });
  }

  // One removal per path, and never a path a new job is about to occupy: a
  // move that lands where another member already is must not delete that page.
  const seen = new Set<string>();
  const remove = removals
    .filter((entry) => {
      if (jobPaths.has(entry.path) || seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { jobs, remove };
}
