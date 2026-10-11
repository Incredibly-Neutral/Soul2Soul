/**
 * Render pipeline helpers for neutralpress — extracted from the old
 * MainController monolith (main.ctrlr.ts).
 *
 * `renderCalls` drives the shared Lit render pipeline
 * (`renderwithLitActions`): prep → render → EVM update. It is the single
 * place neutralpress talks to the render sequence, and the only place that
 * knows how to translate a render result into preview/prod notice links.
 *
 * The optional `remove` parameter threads revocation removals into the update
 * Lit action (see publication/revoke.ts): the update action's existing
 * `remove[]` handling (gated by `verifyRevocable`, which requires the item's
 * deal to already be retracted on-chain) deletes the path from the published
 * tree so a revoked item actually disappears from the rendered site.
 */
import { Notice } from 'obsidian';
import {
	parseCID,
	pinCidFromRemote,
	renderwithLitActions,
	toPreviewLabel,
} from '@s2s/soul2soul-shared';
import type { IMainController } from '../main.ctrlr';
import { filecoinUploadBackground, kuboBaseUrl } from '../publication/filecoin';
import { subdomainOf } from '../content/ens-tags';

/** A path to remove from the published tree during an EVM update. */
export interface RemoveEntry {
	path: string;
	replacedBy?: string;
}

/** Build the DRPC/Alchemy RPC endpoints for the render pipeline. */
export function buildRpcEndpoints(main: IMainController): { L1: string[]; L2: string[] } {
	const rpcKey = main.oxo.ctrlr.plugin.settings.rpc_key;
	const alchemyKey = 'NFOkRqUo2swIC9g5tRJ7c';
	return {
		L1: [
			`https://lb.drpc.live/ethereum/${rpcKey}`,
			`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`,
		],
		L2: [
			`https://lb.drpc.live/base/${rpcKey}`,
			`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`,
		],
	};
}

/**
 * Strip a leading `/ipfs/<cid>` segment from a render path when it matches the
 * publish's own root CID. The `.preview` subdomain gateway — and the `.link`
 * DNSLink gateway — serve the site root at the domain itself, so that prefix
 * 404s. CIDv0 and CIDv1 share the multihash digest, so a digest-wise compare
 * only removes a matching root; a bare `/ipfs/<cid>` folds to `/`.
 */
export function pagePathFor(resPath: string, cid: string): string {
	const rest = resPath.replace(/^\/ipfs\/[^/]+/, '');
	if (rest === resPath) return resPath; // no leading /ipfs/<cid> — leave unchanged
	let matchesOwnCid = true;
	try {
		const seg = resPath.match(/^\/ipfs\/([^/]+)/)?.[1] ?? '';
		const a = parseCID(seg).digest;
		const b = parseCID(cid).digest;
		matchesOwnCid = a.length === b.length && a.every((byte, i) => byte === b[i]);
	} catch {
		/* unparseable segment — treat it as the spurious prefix */
	}
	return matchesOwnCid ? (rest.length ? rest : '/') : resPath;
}

/**
 * Run the full render pipeline (prep → render → EVM update) for a publication.
 *
 * @param publication ENS name of the publication being rendered.
 * @param streamIds  genesis ids to render as jobs.
 * @param lit_usage_key Lit usage key for the action run.
 * @param publish     true → live prod update; false → preview render.
 * @param remove      optional paths to delete from the published tree during
 *                    the update (revocations). Additive — safe default `[]`.
 */
export async function renderCalls(
	main: IMainController,
	publication: string,
	streamIds: string[],
	lit_usage_key: string,
	publish: boolean,
	remove?: RemoveEntry[],
) {
	console.log(
		`Starting render process for publication ${publication} with ${streamIds.length} stream IDs`,
	);

	try {
		if (main.notice) main.notice.setMessage('4/5 Rendering ...');

		console.log(publication);

		// move outside
		const signature = await main.oxo.ctrlr.account['BASE'].signMessage('lit actions auth');
		const rpcs = buildRpcEndpoints(main);
		const kuboToken = main.oxo?.settings?.kubo_token;
		const res: any = await renderwithLitActions(
			!publish,
			main.oxo.ctrlr.lit,
			signature,
			lit_usage_key,
			main.protocolInfo,
			main.notice,
			main.oxo.ctrlr.user.safe,
			publication,
			streamIds,
			undefined,
			rpcs,
			undefined,
			remove,
			undefined, // reset
			kuboToken ? `Bearer ${kuboToken}` : undefined, // _ipfsGatewayAuth
		);

		console.log({ RES: res });

		if (main.notice) main.notice.setMessage('5/5 Pinning ...');

		if (res.cid) {
			// Fire-and-forget both the IPFS pin and the Filecoin upload in
			// parallel — neither blocks the render flow, and the two durable-
			// storage paths run concurrently (SPEC-00 §3.2: IPFS pinning +
			// Filecoin hot-storage). pinCidFromRemote swallows errors and
			// returns a boolean, so this can't throw into renderCalls.
			// Provider selected via oxo settings pin_provider (default: filebase).
			const pinProvider = main.oxo.settings.pin_provider || 'filebase';
			const token =
				pinProvider === 'pinata'
					? main.oxo.settings.pinata_jwt || ''
					: main.oxo.settings.filebase_token || '';
			void pinCidFromRemote(res.cid, 'https://ipfs.transport-union.dev', token, pinProvider).then(
				(ok) => {
					console.log(ok ? `pinned on ${pinProvider}` : `${pinProvider} pin failed`);
				},
			);

			if (publish) {
				// Fire-and-forget Filecoin durability for the rendered site root
				// (SPEC-00 §3.2 — rendered HTML → Filecoin hot-storage). Attributed
				// to the publication multisig + author EOA — same owners as the
				// article upload — so the root piece is attributed in storage
				// listings (oxo filecoin view / safe-app storage tab).
				filecoinUploadBackground(
					main,
					'render-root',
					async () => {
						const pubAddress = await main
							.getInitializedService(subdomainOf(publication))
							.then((s) => s.getMultiSig());
						const authorEoa = main.oxo.ctrlr.user?.eoa;
						return main.oxo.ctrlr.storage.uploadTree(
							res.cid,
							kuboBaseUrl(main),
							[pubAddress, authorEoa].filter(Boolean),
							'render-root',
						);
					},
					res.cid,
				);
			}
		}

		// do i want to unpin deprecated html ?

		if (main.notice) main.notice.hide();

		const _link = (text: string, url: string) => {
			const fragment = document.createDocumentFragment();

			const link = fragment.createEl('a', { text, href: url });
			link.addEventListener('click', (e) => {
				e.preventDefault();
				window.open(url, '_blank');
			});
			fragment.createEl('br');

			return fragment;
		};

		const v1Label = toPreviewLabel(res.cid);
		const pagePath = (p: string) => pagePathFor(p, res.cid);

		// Preview link — root CID (full site)
		const rootLink = _link(
			`${v1Label}.preview → site root`,
			`https://${v1Label}.preview.transport-union.dev/`,
		);
		// Preview link — published page
		const pageLink = _link(
			`${v1Label}.preview${pagePath(res.path)} → published`,
			`https://${v1Label}.preview.transport-union.dev${pagePath(res.path)}`,
		);

		const previewNotice = new Notice('', 0);
		previewNotice.noticeEl.appendChild(pageLink);
		previewNotice.noticeEl.appendChild(rootLink);

		console.log(`preview root: https://${v1Label}.preview.transport-union.dev/`);
		console.log(
			`preview page: https://${v1Label}.preview.transport-union.dev${pagePath(res.path)}`,
		);
		if (publish) {
			const prodRootLink = _link(`${publication} → root`, `https://${publication}.link/`);
			const prodPageLink = _link(
				`${publication}${pagePath(res.path)} → published`,
				`https://${publication}.link${pagePath(res.path)}`,
			);
			const prodNotice = new Notice('', 0);
			prodNotice.noticeEl.appendChild(prodPageLink);
			prodNotice.noticeEl.appendChild(prodRootLink);
			console.log(`prod root: https://${publication}.link/`);
			console.log(`prod page: https://${publication}.link${pagePath(res.path)}`);
		}
	} catch (error: any) {
		console.error(`Error during render process for ${publication}:`, error);
		throw new Error(`Render process failed: ${error.message}`);
	}
}
