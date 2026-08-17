/**
 * Retract (Revoke) flow for neutralpress.
 *
 * Turns the `Revoke` intent into the sequence that actually makes a published
 * item disappear from the rendered site:
 *
 *   1. On-chain `service.retract(genesis)` FIRST — the author-caller path
 *      fully withdraws the item from the deal set and flips `hasDeal` → false
 *      (the gate the update action's `verifyRevocable` checks). It does NOT
 *      call `makeOffer`/`publishContent`/sign for the revoked item — that
 *      would re-add the deal.
 *   2. Re-render the live publication with the revoked item's old path in the
 *      `remove[]` list (threaded through renderCalls → renderwithLitActions →
 *      validateEvmUpdateInput/update). Because the deal is already retracted,
 *      `verifyRevocable` passes and the update action deletes the path
 *      recursively from the MFS tree.
 *
 * ### Remove-path derivation (B1)
 *
 * The render pipeline computes an item's page path in `createPath`
 * (`protocol/actions/src/render/data.ctrlr.ts`):
 *
 *     prefix  = localePaths[body.locale] ?? localePaths.default ?? ''   ('' if no localePaths)
 *     path    = prefix + templateConfig.path                            (with `{slug}` → body.slug)
 *
 * For the standard neutralpress publication scheme — `localePaths`
 * `{default:'', <locale>:'/<locale>'}` and template `path: '/{slug}'` — the
 * derived path is exactly `/<locale>/<slug>` (or `/<slug>` for the default
 * locale). `revokedPathFor` below reproduces that scheme, so it matches the
 * REAL default path. A publication whose on-chain mapping.json declares a
 * non-default `templateConfig.path` (e.g. `/posts/{slug}`) or a custom
 * `localePaths` cannot be derived client-side; in that case the remove entry
 * would be a no-op (the update action logs `skip remove`). Because that would
 * otherwise be a quiet miss, the flow surfaces a user-facing Notice with a
 * caveat (B1b) rather than failing silently.
 */
import { Notice, TFile } from 'obsidian';
import type { IMainController } from '../main.ctrlr';
import { subdomainOf } from '../content/ens-tags';
import type { RemoveEntry } from '../render/render.helper';
import { renderCalls } from '../render/render.helper';

/**
 * Derive the item's rendered path for a remove entry, matching the render
 * pipeline's `createPath` for the standard `/{slug}` template + default
 * localePaths scheme: `/<locale>/<slug>` for a declared non-default locale,
 * `/<slug>` for the default (/empty/`default`) locale. Leading slash is fine —
 * the update action's `sanitizeRemovePath` strips it.
 */
export function revokedPathFor(slug: string, locale?: string): string {
	const prefix = locale && locale !== 'default' ? `/${locale}` : '';
	return `${prefix}/${slug}`;
}

/** Case-insensitive genesis comparison (bytes32 ids are hex/0x-prefixed). */
function sameGenesis(a: string, b: string): boolean {
	return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Resolve the note's on-chain genesis: frontmatter `genesis`, else `content_id`. */
async function resolveGenesis(main: IMainController, file: TFile): Promise<string | null> {
	const cache = main.plugin.app.metadataCache.getFileCache(file);
	const genesis = cache?.frontmatter?.genesis;
	if (genesis) return genesis;
	const { contentId } = await main.content.parseNote(file);
	return contentId;
}

/**
 * Find ONE remaining live genesis to re-render post-retract, or null when the
 * deal set is now empty. Paginates safely across pages (B2) so a publication
 * with more than one page of deals is not misread as "none remaining" from a
 * truncated first page, and returns as soon as a candidate is found so we
 * never materialize the full deal list into memory.
 */
async function remainingDealGenesis(
	main: IMainController,
	service: any,
	revokedGenesis: string,
): Promise<string | null> {
	const PAGE_SIZE = 100;
	const MAX_PAGES = 500; // safety cap against a pathological infinite page stream
	let offset = 0;

	for (let page = 0; page < MAX_PAGES; page++) {
		const deals = ((await service.getDeals(offset, PAGE_SIZE)) ?? []) as { genesis?: string }[];
		for (const d of deals) {
			if (d.genesis && !sameGenesis(d.genesis, revokedGenesis)) {
				return d.genesis;
			}
		}

		// Fewer than a full page (or empty) ⇒ this was the last page.
		if (deals.length < PAGE_SIZE) break;
		offset += PAGE_SIZE;
	}

	return null;
}

/**
 * Revoke a note's claim on a publication: on-chain retract + re-render with a
 * remove entry for the item's old path. Never calls makeOffer for the item.
 */
export async function revokeContent(
	main: IMainController,
	file: TFile,
	publication: string,
): Promise<void> {
	const subdomain = subdomainOf(publication);
	const service = await main.getInitializedService(subdomain);

	const { slug, locale } = await main.content.parseNote(file);
	const genesis = (await resolveGenesis(main, file)) ?? subdomain;

	// 1. On-chain retract FIRST (author-caller path fully withdraws;
	//    flips hasDeal -> false so the update's verifyRevocable passes).
	console.log(`[retract] retracting ${genesis} from ${publication} ...`);
	await service.retract(genesis);
	console.log('[retract] on-chain retract complete');

	// 2. Re-render the live publication with the revoked path in remove[].
	const removePath = revokedPathFor(slug, locale);
	const remove: RemoveEntry[] = [{ path: removePath }];

	// User-facing confirmation + caveat (B1b): the derived remove path matches
	// the default `/{slug}` scheme, but the plugin cannot know a publication's
	// on-chain `templateConfig.path` / `localePaths` (mapping.json) client-side
	// REGARDLESS of locale — a non-default template path would make the remove
	// entry a no-op (update logs `skip remove`). Always log the caveat and
	// surface it in the Notice so a non-default-template publication is not
	// silently misled into believing the item was removed from the rendered site.
	console.log(
		`[retract] remove entry ${removePath} (derived from slug+locale under the default /{slug} scheme)`,
	);
	console.warn(
		`[retract] caveat: non-default templateConfig.path / localePaths (on-chain mapping.json) could make this remove path drift; actual path is re-verified at update time by verifyRevocable`,
	);
	new Notice(
		`Revoked '${slug}' from ${publication}; on-chain retract complete. Removal requested — if the publication uses a custom template path, it completes on the next full render.`,
	);

	const remainingGenesis = await remainingDealGenesis(main, service, genesis);

	if (remainingGenesis === null) {
		// The on-chain retract already flipped hasDeal → false. There is no safe
		// "remove-only" update: prep requires a non-empty `contentIds` array and
		// `validateEvmUpdateInput` requires `jobs.min(1)`, so an empty-streamIds
		// render would fail validation. The revoked page therefore stays in the
		// tree until a future render includes its remove path (verifyRevocable
		// will then pass and delete it). Surface this instead of failing quiet.
		console.warn(
			`[retract] no remaining live deals to re-render; remove entry ${removePath} will fire on the next render`,
		);
		new Notice(
			`Revoked '${slug}' from ${publication}; nothing left to re-render — page will be removed on the next render`,
		);
		return;
	}

	// There ARE other live items: re-render JUST ONE of them with the revoked
	// path in remove[]. The update action's cp-root staging preserves every
	// other already-rendered item, the single refresh job overwrites this one
	// item's path, and the remove loop deletes the revoked path — so the whole
	// site stays intact at J=1 (update ≈32-34 + one ~20-22 render job, both
	// well under Lit's 50-requests-per-session ceiling). Passing the FULL
	// remaining array here would have carried J≈6 jobs into one update session
	// (~65) and blown past 50 — that was the revoke re-render bug.
	console.log(
		`[retract] refreshed publication ${publication} with a single item (${remainingGenesis.slice(0, 12)}…) and remove entry ${removePath}`,
	);
	new Notice(
		`Revoked '${slug}' from ${publication}; refreshed the publication without it`,
	);

	await renderCalls(
		main,
		publication,
		[remainingGenesis],
		main.oxo.settings.litUsageKey,
		true,
		remove,
	);
}
