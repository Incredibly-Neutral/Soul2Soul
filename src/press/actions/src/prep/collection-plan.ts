// ============================================================================
// prep/collection-plan.ts — the member pages a collection bundle gains, and
// the ones it loses, relative to the bundle version already stored.
//
// Pure planner: no chain read, no IPFS, no clock, so every decision can be
// tested against fixtures. It imports the render config module prep already
// loads (getTaskConfig keys a body on its postType); nothing new reaches the
// action bundle.
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
 *
 * `bundlePath` is the page the bundle's own job occupies, when one claims it.
 * A member that moves onto that path must not remove the page being written.
 */
export function planCollectionJobs(args: {
  config: S2SPublicationConfig;
  body: CollectionBundleFields;
  oldBody: Partial<CollectionBundleFields> | null;
  bundlePath?: string;
}): { jobs: S2SJob[]; remove: { path: string; replacedBy?: string }[] } {
  const { config, body, oldBody, bundlePath } = args;

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

  // Removals are diffed against the stored bundle only. getOldBody returns the
  // stored body bytes, not a flat body: the collection document is there, the
  // mediaType and page fields are not, so the document's items are what mark a
  // former container. Each item the CLI writes carries its own postType and
  // locale, so collectionMemberBody takes them from the item.
  const removals: { path: string; replacedBy?: string }[] = [];
  const storedItems = oldBody?.collection?.items;
  if (Array.isArray(storedItems)) {
    storedItems.forEach((item, index) => {
      const oldMember = collectionMemberBody(
        {
          id: body.id,
          author: '',
          postType: item.postType ?? oldBody?.postType,
          collection: oldBody?.collection,
        },
        item,
        index,
      );
      const oldPage = resolvePage(oldMember, config, config.localePaths);
      if (!oldPage) return;

      // Still there at the same path: nothing moved, nothing to delete.
      if (nextPaths.get(item.key) === oldPage.path) return;

      removals.push({ path: oldPage.path, replacedBy: body.id });
    });
  }

  // The bundle's own page is written by its job too, so it is never a removal
  // target. Then: one removal per path, and never a path a new job is about to
  // occupy — a move that lands where another page already is must not delete it.
  if (bundlePath) jobPaths.add(bundlePath);
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
