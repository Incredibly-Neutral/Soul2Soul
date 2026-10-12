/**
 * Upload/publish pipeline for neutralpress — the single author write path.
 *
 * Extracted from the old MainController `publishToPublication`. Split so the
 * three intents differ only in whether they render:
 *
 *   - Upload  → `{ render: false }`  (append + durability only, NO rendering)
 *   - Publish → `{ render: true }`   (append + full render, preview or prod)
 *
 * The on-chain write is `makeOffer` (the single append+deal transaction in
 * V2 — there is no separate grant transaction). Filecoin durability is
 * fire-and-forget and never blocks the flow.
 */
import { Notice, TFile } from 'obsidian';
import type { IMainController } from '../main.ctrlr';
import { subdomainOf } from '../content/ens-tags';
import { ipfsFromSettings, kuboBaseUrl } from './filecoin';
import { renderCalls } from '../render/render.helper';

export interface PublishOptions {
	/** Whether to run the render pipeline after the on-chain append. */
	render: boolean;
	/** For `render: true`: true → live prod update, false → preview render. */
	publish?: boolean;
}

/**
 * Sign → Kubo upload → `makeOffer` → (optional) render → Filecoin durability.
 *
 * @param file        the note being published.
 * @param publication ENS name of the target publication.
 * @param opts.render false makes Upload skip the render pipeline entirely.
 */
export async function publishToPublication(
	main: IMainController,
	file: TFile,
	publication: string,
	opts: PublishOptions = { render: true },
) {
	const subdomain = subdomainOf(publication);
	const service = await main.getInitializedService(subdomain);

	// Assign to main.notice (not a local) so render.helper/renderCalls can pick
	// up the SAME notice for its 4/5→5/5 updates and hide it on completion.
	// A local notice would never be hidden → '3/5 appending version...' would
	// stick on screen forever after every upload/publish.
	main.notice = new Notice('1/5 signing content ...', 0);

	// Build and sign the content item — this replaces the old Lens-based storeNoteOnLens
	const signedItem = await main.content.publishContent(file, subdomain);

	if (!signedItem) {
		console.error('publishToPublication: signing failed, aborting');
		main.notice?.hide();
		return;
	}

	main.notice?.setMessage('2/5 storing content item on Filecoin ... ');

	// Always re-upload — the content may have changed since the last publish.
	// The frontmatter root_cid is a fallback (handled below) if this upload fails.

	// 1. Upload to Kubo → get IPFS CID
	const kuboUrl = kuboBaseUrl(main);
	const kuboCid = await main.oxo.ctrlr.storage.uploadToKubo(signedItem, kuboUrl);
	console.log('[kubo] uploaded:', kuboCid);

	main.notice?.setMessage('3/5 appending version to publication contract ...');

	// Record the version on-chain via the publication module
	// genesis = signedItem.objectId (first version IS the genesis for a new note)
	const rootCid = kuboCid;
	const appendResult = await service.makeOffer(signedItem.objectId, rootCid);
	console.log('[append] tx:', appendResult);

	if (opts.render) {
		main.notice?.setMessage('4/5 Authorizing ...');
		await renderCalls(
			main,
			publication,
			[signedItem.objectId],
			main.oxo.settings.litUsageKey,
			opts.publish ?? false,
		);
	}

	// Hide the shared notice — renderCalls hides it for the render path; for
	// the upload path (render:false) it is still showing '3/5...', so hide it
	// here to cover both. Idempotent (hide on an already-hidden notice is a no-op).
	if (main.notice) main.notice.hide();

	/// fire & forget — the 4-way backup (filebase + pinata pins + filecoin)
	/// doesn't need to block the main flow. Launched AFTER the awaited
	/// makeOffer + renderCalls RPCs complete so the filecoin leg's CORS-shim
	/// install window never overlaps an awaited viem JSON-RPC (makeOffer /
	/// renderwithLitActions). viem's http() withTimeout only aborts() the fetch
	/// on timeout and relies on it rejecting, so a shim left installed across
	/// an awaited RPC could hang it indefinitely.
	const ipfs = ipfsFromSettings(main);
	void ipfs.backupToProviders(kuboCid, {
		filecoin: async () => {
			const pubAddress = await service.getMultiSig();
			const authorEoa = main.oxo.ctrlr.user?.eoa;
			return main.oxo.ctrlr.storage.uploadJson(
				signedItem,
				[pubAddress, authorEoa].filter(Boolean),
				'article',
			);
		},
		onFilecoinMismatch: (rootCid) => {
			new Notice(
				`⚠️ CID mismatch (article): Kubo ${kuboCid.slice(0, 12)}… ≠ Filecoin ${rootCid.slice(0, 12)}…`,
			);
		},
	});
}
