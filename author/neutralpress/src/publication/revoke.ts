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
 *   2. Re-render the REVOKED contentId itself (B2). Because the deal is
 *      already retracted, the render action's hasDeal check — scoped to the
 *      triggered contentIds (the id the caller rendered, threaded through by
 *      the orchestrator) — marks the job `revoked`: it returns ok:true with
 *      empty html and the preserved path, and the orchestrator auto-derives a
 *      remove entry from that path (`revokedRemove` in
 *      shared/src/rendering/sequence.ts). Prep expands ripples for the revoked
 *      id just as on publish (postType matches a ripple origin → a cascaded
 *      destination job, e.g. home), and the destination re-renders ACTIVE (it
 *      is never hasDeal-checked) with its collection dropping the revoked
 *      item. So the revoke propagates to dependent pages in production: home
 *      re-renders and no longer lists the revoked post. When the postType has
 *      NO ripple, the update still processes the lone remove via the zero-jobs
 *      relaxation (jobs.length===0 && remove present). The `remove[]` list is
 *      still threaded through renderCalls → renderwithLitActions →
 *      validateEvmUpdateInput/update; because the deal is already retracted,
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
 * locale). `revokedPathFor` reproduces the renderer's `createPath` prefix
 * logic using the publication's REAL on-chain `localePaths` (read via the
 * Records module — see `publicationLocalePathsOf`). This means a locale
 * declared with an EMPTY prefix (e.g. `localePaths.en === ''`) correctly
 * resolves to `/<slug>` and is never silently mis-derived as `/en/<slug>`.
 * The remaining caveat is a non-default `templateConfig.path` (e.g.
 * `/posts/{slug}`), which is still assumed to be `/{slug}`; in that case the
 * remove entry would be a no-op (the update action logs `skip remove`).
 * Because that would otherwise be a quiet miss, the flow surfaces a
 * user-facing Notice with a caveat (B1b) rather than failing silently.
 */
import { Notice, TFile } from 'obsidian';
import type { IMainController } from '../main.ctrlr';
import { subdomainOf } from '../content/ens-tags';
import type { RemoveEntry } from '../render/render.helper';
import { renderCalls } from '../render/render.helper';
import { S2SRecordsModule } from '../../../../protocol/contracts/generated/abis';
import type { IPublicationSrv } from './publication.service';

/**
 * Read the publication's REAL `localePaths` from its on-chain config — the
 * same config the render pipeline reads when it computes an item's path via
 * `createPath` (Records module `getRecord('config')` -> config CID -> fetched
 * mapping). This lets `revokedPathFor` reproduce `createPath`'s prefix EXACTLY
 * (including a non-default locale mapped to an EMPTY prefix) instead of
 * assuming every non-default locale is `/<locale>`. Returns `undefined` when
 * the config cannot be resolved (offline, missing records module, parse
 * failure) so the caller falls back to the legacy scheme + caveat rather than
 * aborting the revoke.
 */
async function publicationLocalePathsOf(
	main: IMainController,
	service: IPublicationSrv,
): Promise<Record<string, string> | undefined> {
	try {
		// The Records module address is resolved during service init; it is a
		// concrete PublicationService field (not on the IPublicationSrv contract).
		const recordsModule = (service as any)?.configModule as string | undefined;
		if (!recordsModule) return undefined;

		const configCid = (await main.oxo.ctrlr.viem.read(
			recordsModule,
			S2SRecordsModule,
			'getRecord',
			['config'],
		)) as string;
		if (!configCid) return undefined;

		const config = await main.oxo.ctrlr.ipfs.getJsonLike(configCid, main.protocolInfo.gateway);
		if (!config || config.Type === 'error') return undefined;

		// The renderer reads the hoisted top-level `localePaths` (config-builder
		// and the neutralpress config builder both emit `mapping.localePaths` at
		// the top level of the built config).
		return (config.localePaths ?? config.mapping?.localePaths) as
			| Record<string, string>
			| undefined;
	} catch (error) {
		console.warn('[retract] could not read on-chain localePaths; using legacy scheme', error);
		return undefined;
	}
}

/**
 * Derive the item's rendered path for a remove entry, matching the render
 * pipeline's `createPath` for the standard `/{slug}` template. When the
 * publication's on-chain `localePaths` are supplied (see
 * `publicationLocalePathsOf`), the locale prefix is reproduced EXACTLY as the
 * renderer computes it:
 *
 *     prefix = localePaths[body.locale] ?? localePaths.default ?? ''
 *
 * so a declared non-default locale mapped to an EMPTY prefix (e.g.
 * `localePaths.en === ''`) correctly yields `/<slug>` — NOT `/en/<slug>`.
 * Without a localePaths map, fall back to the legacy default scheme: a
 * `/<locale>` prefix for any non-default locale, `''` for the default locale.
 * Leading slash is fine — the update action's `sanitizeRemovePath` strips it.
 */
export function revokedPathFor(
	slug: string,
	locale?: string,
	localePaths?: Record<string, string>,
): string {
	let prefix = localePaths ? (localePaths[locale ?? 'default'] ?? localePaths.default ?? '') : '';
	if (!localePaths && locale && locale !== 'default') prefix = `/${locale}`;
	return `${prefix}/${slug}`;
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
 * Revoke a note's claim on a publication: on-chain retract + re-render the
 * REVOKED contentId itself with a remove entry for the item's old path. Never
 * calls makeOffer for the item.
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

	// 2. Re-render the REVOKED contentId itself with the revoked path in remove[].
	// Resolve the publication's REAL on-chain localePaths so the remove path
	// reproduces createPath's prefix exactly — a locale mapped to an EMPTY
	// prefix (e.g. `localePaths.en === ''`) must NOT be derived as `/en/...`.
	// When the on-chain config can't be read we fall back to the legacy default
	// scheme and surface the caveat below rather than failing the revoke.
	const localePaths = await publicationLocalePathsOf(main, service);
	const removePath = revokedPathFor(slug, locale, localePaths);
	const remove: RemoveEntry[] = [{ path: removePath }];

	// User-facing confirmation + caveat (B1b): when localePaths were read
	// on-chain the locale prefix is exact; the remaining uncertainty is a
	// non-default `templateConfig.path` (the plugin still assumes `/{slug}`),
	// which would make the remove entry a no-op (update logs `skip remove`).
	// When localePaths could NOT be read we fall back to the legacy scheme, so
	// the caveat also covers a possibly-drifted locale prefix. Either way it is
	// surfaced so a non-default-scheme publication is never silently misled
	// into believing the item was removed from the rendered site.
	console.log(
		`[retract] remove entry ${removePath} (slug+locale${localePaths ? ', locale prefix from on-chain localePaths' : ', legacy default scheme'})`,
	);
	console.warn(
		`[retract] caveat: non-default templateConfig.path (on-chain mapping.json) could make this remove path drift; actual path is re-verified at update time by verifyRevocable`,
	);
	new Notice(
		`Revoked '${slug}' from ${publication}; on-chain retract complete. Removal requested — if the publication uses a custom template path, it completes on the next full render.`,
	);

	// Re-render the REVOKED contentId itself (B2). The on-chain retract already
	// flipped hasDeal → false, so the render action's hasDeal check — scoped to
	// triggeredContentIds=[genesis] (the id the caller rendered) — marks this
	// job `revoked`: it returns ok:true with empty html and the preserved path,
	// and the orchestrator auto-derives a remove entry from the revoked job's
	// path (revokedRemove in shared/src/rendering/sequence.ts) IN ADDITION to
	// the caller-supplied `remove` below. Prep expands ripples for the revoked
	// id just as on publish (postType matches a ripple origin → a cascaded
	// destination job like home); the destination re-renders ACTIVE — it is
	// never hasDeal-checked, since hasDeal is scoped to triggeredContentIds=
	// [genesis] — and its collection drops the revoked item. So dependent pages
	// re-render and no longer list the revoked post. If the postType has NO
	// ripple, the update still processes the lone remove via the zero-jobs
	// relaxation (jobs.length===0 && remove present).
	//
	// This is safe for Lit's 50-requests-per-session ceiling: at most the
	// revoked job + one level of ripple destinations (J small) — NOT the full
	// remaining deal array (that was the revoke re-render bug, ~65 requests).
	console.log(
		`[retract] re-rendering revoked id ${genesis.slice(0, 12)}… with remove entry ${removePath}`,
	);
	new Notice(`Revoked '${slug}' from ${publication}; re-rendered the publication without it`);

	await renderCalls(main, publication, [genesis], main.oxo.settings.litUsageKey, true, remove);
}
