import { FileSystemAdapter, Notice, TAbstractFile, TFile } from 'obsidian';
import DSG from './main';
import { IPublicationSrv, PublicationService } from './publication/publication.service';
import { PreviewCtrlr } from './preview.ctrlr';
import { getPublicationMultiSig, isAvailableEnsName } from './publication/ens';
import { NewPublicationModal } from './publication/new.modal';
import {
	getProtocolInfo,
	S2SProtocolInfo,
	pinCidFromRemote,
	renderwithLitActions,
	toPreviewLabel,
} from '@s2s/soul2soul-shared';
import type { FilecoinUploadResult } from '@s2s/soul2soul-shared/filecoin';
import { ContentController } from './content/content.ctrlr';
import { checkFilecoinStatus, logAvailability, measureAvailability } from './avail';

export interface IMainController {
	basePath: string;
	plugin: DSG;
	oxo: any;
	content: ContentController;
	preview: PreviewCtrlr;
	publications: any;
	protocolInfo: S2SProtocolInfo;

	getInitializedService: (subdomain: string) => Promise<IPublicationSrv>;
	newPublication: (ensName: string, file: TFile) => Promise<void>;
	proposeContent: (_file: TAbstractFile, publish: boolean) => Promise<void>;
	// previewNote: (_file: TAbstractFile) => Promise<void>;
	// grantLicense: (_file: TAbstractFile) => Promise<void>;
	revokeLicense: (tagName: string, _file: TAbstractFile) => Promise<void>;
	renderCalls: (
		publication: string,
		streamIds: string[],
		lit_usage_key: string,
		publish: boolean,
	) => Promise<void>;
	bulkrender: (post_type: string, ensName: string, pubContract: string) => Promise<void>;
}

export class MainController implements IMainController {
	basePath!: string;
	oxo: any;
	plugin: DSG;
	preview: PreviewCtrlr;
	content: ContentController;
	publications: any;
	protocolInfo!: S2SProtocolInfo;
	notice!: Notice;

	constructor(plugin: DSG) {
		this.plugin = plugin;
		this.preview = new PreviewCtrlr(this);
		this.content = new ContentController(this);
		this.publications = {};

		// Set basePath using Obsidian's adapter
		const adapter = this.plugin.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			this.basePath = adapter.getBasePath();
		}

		// Wait for 0xobsidian plugin to be available
		this.initializeOxo();
	}

	private async initializeOxo() {
		let attempts = 0;
		const maxAttempts = 10;

		// Wait for plugin to load (this might take time)
		const waitForPlugin = async () => {
			while (attempts < maxAttempts) {
				try {
					// @ts-ignore
					const oxoPlugin = this.plugin.app.plugins.plugins['oxo-core'];

					if (oxoPlugin && oxoPlugin.ctrlr) {
						this.oxo = oxoPlugin;
						return true; // Plugin and controller loaded successfully
					}
				} catch (error) {
					console.warn('Error accessing 0xobsidian plugin:', error);
				}

				attempts++;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			console.warn('0xobsidian plugin not found after', maxAttempts, 'attempts');
			return false;
		};

		// Wait for plugin to be available
		const pluginLoaded = await waitForPlugin();

		if (!pluginLoaded) {
			console.log('0xo plugin not present');
			return; // Plugin never loaded
		}

		// Plugin is loaded, now check for active user (no retries - either they have one or they don't)
		if (!this.oxo.ctrlr.hasActiveUser()) {
			console.log('0xObsidian does not have an active user selected');
			return; // User needs to select an account manually
		}

		// We have a plugin AND an active user, now init chains
		try {
			// Dit toch naar 0x0?
			const success = await this.oxo.ctrlr.initChains(['ETH_MAINNET', 'BASE']);

			if (success) {
				this.protocolInfo = await getProtocolInfo(
					this.plugin.settings.dev,
					this.oxo.ctrlr.account['ETH_MAINNET'].publicClient,
					this.oxo.ctrlr.account['BASE'].publicClient,
				);

				console.log('protocolInfo', this.protocolInfo);
				// this.oxo.ctrlr.lit.createPkpAuthContext(this.protocolInfo.pkp.publicKey)
			}
		} catch (error) {
			console.warn('Error initializing chains:', error);
		}
	}

	async newPublication(tagName: string, file: TFile) {
		const ensName = tagName.toLowerCase().replace('--s2s', '') + '.soul2soul.eth';
		const subdomain = ensName.split('.')[0];

		if (this.publications[subdomain] != undefined) {
			//this.grantLicense(file);
			return;
		}

		this.publications[subdomain] = new PublicationService(this, subdomain);

		const isAvailable = await isAvailableEnsName(this, tagName);

		if (!isAvailable) {
			await this.publications[subdomain].init();
		} else {
			new NewPublicationModal(
				this.plugin.app,
				this.plugin.ctrlr,
				ensName,
				async (
					name: string,
					owners: string[],
					authors: string[],
					devRepository: string,
					branch: string,
				) => {
					await this.publications[subdomain].new(
						this,
						name,
						owners,
						authors,
						devRepository,
						branch,
					);
				},
			).open();
		}
	}

	// async grantLicense(_file: TAbstractFile) {
	// 	const file = this.plugin.app.vault.getFileByPath(_file.path);
	// 	if (file != null) {

	// 		const { tags, contentId } = await this.content.parseNote(file);
	// 		const lensProfileId = "";

	// 		const publications = tags
	// 			.filter((tag: string) => tag.endsWith("--s2s"))
	// 			.map((tag: string) => tag.replace("--s2s", ".soul2soul.eth"));

	// 		for (const pub of publications) {

	// 			const subdomain = pub.split(".")[0];

	// 			if(this.publications[subdomain] == undefined) {
	// 				this.publications[subdomain] = new PublicationService(this, subdomain)
	// 				await this.publications[subdomain].init();
	// 			}

	// 			const licensedId = contentId ?? pub;
	// 			const isLicensed = await this.publications[subdomain].isLicensed(licensedId);

	// 			console.log("isLicensed:", isLicensed)

	// 			if (!isLicensed) {
	// 				console.log("L1")
	// 				await this.publications[subdomain].grantLicense(licensedId, lensProfileId);
	// 				console.log("L2")
	// 			}
	// 		}
	// 	}
	// }

	async revokeLicense(subdomain: string, _file: TAbstractFile): Promise<void> {
		console.log('revoking license for', subdomain);

		const file = this.plugin.app.vault.getFileByPath(_file.path);

		if (file != null) {
			try {
				console.log(0);
				let { contentId }: any = await this.content.parseNote(file);

				if (this.publications[subdomain].dealsModule == undefined) {
					await this.publications[subdomain].init();
				}

				console.log('S', contentId);
				const dealExists = await this.publications[subdomain].isLicensed(contentId);
				console.log('DE', dealExists);

				if (dealExists) {
					console.log(1);
					const revokeResult = await this.publications[subdomain].revokeLicense(contentId);
					console.log('RR', revokeResult);
				}
			} catch (error) {
				console.error('Error in revokeDeal:', error);
			}
		}
	}

	isValidForPublishing(file: TFile | null): file is TFile {
		return file != null &&
			file instanceof TFile &&
			(file.path.endsWith('.base') || file.path.endsWith('.md'))
			? true
			: false;
	}

	async getInitializedService(subdomain: string) {
		if (this.publications[subdomain] == undefined) {
			this.publications[subdomain] = new PublicationService(this, subdomain);
			await this.publications[subdomain].init();
		}

		return this.publications[subdomain];
	}

	/** Normalized Kubo API base URL (with protocol) for Filecoin tree export. */
	private get kuboBaseUrl(): string {
		const raw = this.oxo.settings.kubo_url || 'ipfs.transport-union.dev';
		return raw.startsWith('http') ? raw : `https://${raw}`;
	}

	/**
	 * Fire-and-forget Filecoin durability upload (SPEC-00 §3.2).
	 * Never throws, never blocks the main flow. When `expectedCid` is given,
	 * asserts CID parity with the Filecoin rootCid (INV-13) and surfaces a
	 * notice on mismatch. When `onResult` is given, it is invoked with the
	 * upload result (or `undefined` if the upload failed) — used to chain the
	 * Filecoin availability check, which needs the piece CID only the upload
	 * produces.
	 */
	private filecoinUploadBackground(
		kind: string,
		upload: () => Promise<FilecoinUploadResult>,
		expectedCid?: string,
		onResult?: (result: FilecoinUploadResult | undefined) => void,
	): void {
		(async () => {
			try {
				const result = await upload();
				// Capture the {rootCid, pieceCid} result — Filecoin is indexed by
				// piece CID, which the availability check polls via isRetrievable.
				onResult?.(result);
				// Quiet success — no logging unless CID parity is violated.
				if (expectedCid && result.rootCid && expectedCid !== result.rootCid) {
					console.error(
						`[cid-mismatch] ${kind}: Kubo ${expectedCid.slice(0, 12)}… ≠ Filecoin ${result.rootCid.slice(0, 12)}…`,
					);
					new Notice(
						`⚠️ CID mismatch (${kind}): Kubo ${expectedCid.slice(0, 12)}… ≠ Filecoin ${result.rootCid.slice(0, 12)}…`,
					);
				}
			} catch (err) {
				// Exactly one concise line — never the full error object / nested causes.
				// Detect the min-2-copies failure by its stable error name rather than
				// importing the class: a value import would force esbuild to bundle the
				// whole filecoin module (and @filoz/synapse-sdk) into this plugin.
				if (err instanceof Error && err.name === 'FilecoinMinCopiesError') {
					console.error(`[filecoin] ${kind} background upload failed: ${err.message}`);
				} else {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[filecoin] ${kind} background upload failed: ${msg}`);
				}
				// The upload is broken upstream (KNOWN) — surface the absence so the
				// availability check can report a full-window, not-reached leg.
				onResult?.(undefined);
			}
		})();
	}

	async publishToPublication(file: TFile, publication: string, publish: boolean) {
		let license;
		const subdomain = publication.split('.')[0];
		const service = await this.getInitializedService(subdomain);

		this.notice = new Notice('1/5 signing content ...', 0);

		// Build and sign the content item — this replaces the old Lens-based storeNoteOnLens
		const signedItem = await this.content.publishContent(file, subdomain);

		if (!signedItem) {
			console.error('publishToPublication: signing failed, aborting');
			this.notice.hide();
			return;
		}

		this.notice.setMessage(`2/5 storing content item on Filecoin ... `);

		// Always re-upload — the content may have changed since the last publish.
		// The frontmatter root_cid is a fallback (handled below) if this upload fails.

		// 1. Upload to Kubo → get IPFS CID
		const kuboUrl = this.kuboBaseUrl;
		const kuboCid = await this.oxo.ctrlr.storage.uploadToKubo(signedItem, kuboUrl);
		console.log('[kubo] uploaded:', kuboCid);

		/// fire & forget — Filecoin upload doesn't need to block the main flow
		this.filecoinUploadBackground(
			'article',
			async () => {
				const pubAddress = await service.getMultiSig();
				const authorEoa = this.oxo.ctrlr.user?.eoa;
				return this.oxo.ctrlr.storage.uploadJson(
					signedItem,
					[pubAddress, authorEoa].filter(Boolean),
					'article',
				);
			},
			kuboCid,
		);

		////

		this.notice.setMessage('3/5 appending version to publication contract ...');

		// Record the version on-chain via the publication module
		// genesis = signedItem.objectId (first version IS the genesis for a new note)
		const rootCid = kuboCid;
		const appendResult = await service.makeOffer(signedItem.objectId, rootCid);
		console.log('[append] tx:', appendResult);

		this.notice.setMessage('4/5 Authorizing ...');

		// if (isLicensed || license != undefined) {
		await this.renderCalls(
			publication,
			[signedItem.objectId],
			this.oxo.settings.litUsageKey,
			publish,
		);
		//  }
	}

	async proposeContent(_file: TAbstractFile, publish: boolean) {
		const file = this.plugin.app.vault.getFileByPath(_file.path);

		if (!this.isValidForPublishing(file)) return;

		const { tags } = await this.content.parseNote(file);
		const publications = tags
			? tags
					.filter((tag: string) => tag.endsWith('--s2s'))
					.map((tag: string) => tag.replace('--s2s', '.soul2soul.eth'))
			: [];

		for (const publication of publications) {
			this.publishToPublication(file, publication, publish);
		}
	}

	async renderCalls(
		publication: string,
		streamIds: string[],
		lit_usage_key: string,
		publish: boolean,
	) {
		console.log(
			`Starting render process for publication ${publication} with ${streamIds.length} stream IDs`,
		);

		try {
			if (this.notice) this.notice.setMessage('4/5 Rendering ...');

			console.log(publication);

			// move outside
			const signature = await this.oxo.ctrlr.account['BASE'].signMessage('lit actions auth');
			// Build RPC endpoints from the DRPC key, with Alchemy fallback
			const rpcKey = this.oxo.ctrlr.plugin.settings.rpc_key;
			const alchemyKey = 'NFOkRqUo2swIC9g5tRJ7c';
			const rpcs = {
				L1: [
					`https://lb.drpc.live/ethereum/${rpcKey}`,
					`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`,
				],
				L2: [
					`https://lb.drpc.live/base/${rpcKey}`,
					`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`,
				],
			};
			const res: any = await renderwithLitActions(
				!publish,
				this.oxo.ctrlr.lit,
				signature,
				lit_usage_key,
				this.protocolInfo,
				this.notice,
				this.oxo.ctrlr.user.safe,
				publication,
				streamIds,
				undefined,
				rpcs,
			);

			console.log({ RES: res });

			if (this.notice) this.notice.setMessage('5/5 Pinning ...');

			if (res.cid) {
				// Fire-and-forget both the Pinata pin and the Filecoin upload in
				// parallel — neither blocks the render flow, and the two durable-
				// storage paths run concurrently (SPEC-00 §3.2: IPFS pinning +
				// Filecoin hot-storage). pinCidFromRemote swallows errors and
				// returns a boolean, so this can't throw into renderCalls.
				void pinCidFromRemote(
					res.cid,
					'https://ipfs.transport-union.dev',
					this.oxo.settings.pinata_jwt,
				).then((ok) => console.log(ok ? 'pinned on pinata' : 'pinata pin failed'));

				// Publish availability — fire-and-forget, never blocks. The 3 HTTP
				// legs (.link / pinata / ipfs.io) run immediately; the 4th leg
				// (Filecoin isRetrievable) runs once the Filecoin upload resolves,
				// because Filecoin is indexed by piece CID which only the upload
				// produces. Once both have settled, log all four timings.
				const basePromise = measureAvailability(publication, res.cid, this.oxo.settings.pinata_jwt);

				const runFilecoinLeg = (result?: FilecoinUploadResult) => {
					void checkFilecoinStatus(
						{ pieceCid: result?.pieceCid ?? '' },
						this.oxo.ctrlr.storage,
					).then((filecoin) => basePromise.then((base) => logAvailability({ ...base, filecoin })));
				};

				if (publish) {
					// Fire-and-forget Filecoin durability for the rendered site root
					// (SPEC-00 §3.2 — rendered HTML → Filecoin hot-storage). Currently
					// broken upstream (KNOWN); on failure runFilecoinLeg gets undefined,
					// so the leg reports a full-window, not-reached instead of crashing.
					this.filecoinUploadBackground(
						'render-root',
						() => this.oxo.ctrlr.storage.uploadTree(res.cid, this.kuboBaseUrl),
						res.cid,
						runFilecoinLeg,
					);
				} else {
					// Preview (no Filecoin upload): the leg reports not-reached.
					runFilecoinLeg(undefined);
				}
			}

			

			// do i want to unpin deprecated html ?

			if (this.notice) this.notice.hide();

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
			// Preview link — root CID (full site)
			const rootLink = _link(
				`${v1Label}.preview → site root`,
				`https://${v1Label}.preview.transport-union.dev/`,
			);
			// Preview link — published page
			const pageLink = _link(
				`${v1Label}.preview${res.path} → published`,
				`https://${v1Label}.preview.transport-union.dev${res.path}`,
			);
			const previewNotice = new Notice('', 0);
			previewNotice.noticeEl.appendChild(pageLink);
			previewNotice.noticeEl.appendChild(rootLink);

			console.log(`preview root: https://${v1Label}.preview.transport-union.dev/`);
			console.log(`preview page: https://${v1Label}.preview.transport-union.dev${res.path}`);
			if (publish) {
				const prodRootLink = _link(`${publication} → root`, `https://${publication}.link/`);
				const prodPageLink = _link(
					`${publication}${res.path} → published`,
					`https://${publication}.link${res.path}`,
				);
				const prodNotice = new Notice('', 0);
				prodNotice.noticeEl.appendChild(prodPageLink);
				prodNotice.noticeEl.appendChild(prodRootLink);
				console.log(`prod root: https://${publication}.link/`);
				console.log(`prod page: https://${publication}.link${res.path}`);
			}
		} catch (error: any) {
			console.error(`Error during render process for ${publication}:`, error);
			throw new Error(`Render process failed: ${error.message}`);
		}
	}

	async bulkrender(post_type: string, ensName: string, pubContract: string) {
		// console.log(
		// 	`Running bulkRender for post_type: ${post_type} on ${ensName}`,
		// );
		// try {
		// 	const streamIds = await getFilesByPostType(
		// 		this.plugin,
		// 		post_type,
		// 		ensName.replace(".--s2s.eth", "--s2s"),
		// 		pubContract,
		// 	);
		// 	console.log(`Found ${streamIds.length} streamIds for bulkRender`);
		// 	// Check which streamIds already have deals
		// 	const subdomain = ensName.split(".")[0]
		// 	const dealStatuses = await this.publications[subdomain].hasDealBatch(
		// 		pubContract,
		// 		streamIds,
		// 	);
		// 	// Filter to only streamIds that have deals
		// 	const streamIdsWithDeals = streamIds.filter(
		// 		(id) => dealStatuses[id],
		// 	);
		// 	console.log(
		// 		`${streamIdsWithDeals.length} out of ${streamIds.length} items have deals`,
		// 	);
		// 	// Process streamIds in batches
		// 	const batchSize = 3;
		// 	const batches = [];
		// 	// Split streamIds into batches
		// 	for (let i = 0; i < streamIdsWithDeals.length; i += batchSize) {
		// 		batches.push(streamIdsWithDeals.slice(i, i + batchSize));
		// 	}
		// 	console.log(
		// 		`Processing streamIds in ${batches.length} batches of up to ${batchSize} items each`,
		// 	);
		// 	// Process each batch sequentially
		// 	for (let i = 0; i < batches.length; i++) {
		// 		const batch = batches[i];
		// 		console.log(`Processing batch ${i + 1} of ${batches.length}`);
		// 		await this.renderCalls(ensName, batch);
		// 		console.log(`Completed batch ${i + 1} of ${batches.length}`);
		// 	}
		// } catch (error) {
		// 	console.error("Error getting files for bulkRender:", error);
		// 	throw error;
		// }
	}

	// async bulkUpload() {

	//     console.log('readying for bulk upload');

	//     const getFiles = async (distPath: string): Promise<string[]> => {
	//         const adapter = this.plugin.app.vault.adapter;
	//         const files = await adapter.list(distPath);
	//         return files.files;
	//     }

	//     const pubName = this.plugin.settings.publication;
	//     const path =  this.basePath + "/" + pubName;

	//     let tasks: SGTask[] = [];
	//     const fileNames = await getFiles(path);

	//     for (let i = 0; i < fileNames.length; i++) {
	//         const file = fileNames[i];
	//         try {
	//             const task: SGTask = {
	//                 slug: file,
	//                 // author: "Unamore",
	//                 // post_type: "painting",
	//                 // tags: "",
	//                 // categories: "",
	//                 // parent: "0",
	//                 // creation_date: "",
	//                 // modified_date: "",
	//                 // title: "",
	//                 // order: 0,
	//                 // content: ""
	//             }
	//             tasks.push(task);
	//         } catch(error) {
	//             console.error('Error processing file:', file, error);
	//         }
	//     }

	//     console.log(tasks);
	// }

	// async bulkUploadPaintings() {

	//     console.log('readying for bulk upload');

	//     const getFiles = async (distPath: string): Promise<string[]> => {
	//         const adapter = this.plugin.app.vault.adapter;
	//         const files = await adapter.list(distPath);
	//         return files.files;
	//     }

	//     const folder = "paintings";
	//     const path =  this.basePath + "/" + folder;

	//     let tasks: SGTask[] = [];
	//     const fileNames = await getFiles(path);

	//     for (let i = 0; i < fileNames.length; i++) {
	//         const file = fileNames[i];
	//         try {
	//             const task: SGTask = {
	//                 slug: file,
	//                 // author: "Unamore",
	//                 // post_type: "painting",
	//                 // tags: "",
	//                 // categories: "",
	//                 // parent: "0",
	//                 // creation_date: "",
	//                 // modified_date: "",
	//                 // title: "",
	//                 // order: 0,
	//                 // content: ""
	//             }
	//             tasks.push(task);
	//         } catch(error) {
	//             console.error('Error processing file:', file, error);
	//         }
	//     }

	//     console.log(tasks);
	// }
}
