import { FileSystemAdapter, Notice, TAbstractFile, TFile } from "obsidian";
import DSG from "./main";
import { IPublicationSrv, PublicationService } from "./publication/publication.service";
import { PreviewCtrlr } from "./preview.ctrlr";
import { getPublicationMultiSig, isAvailableEnsName } from "./publication/ens";
import { NewPublicationModal } from "./publication/new.modal";
import { getProtocolInfo, S2SProtocolInfo, pinCidFromRemote, renderwithLitActions } from "@s2s/soul2soul-shared";
import { ContentController } from "./content/content.ctrlr";

export interface IMainController {
	basePath: string;
	plugin: DSG;
	oxo: any;
	content: ContentController;
	preview: PreviewCtrlr;
	publications: any;
	protocolInfo: S2SProtocolInfo;

	getInitializedService: (subdomain: string) => Promise<IPublicationSrv>
	newPublication: (ensName: string, file: TFile) => Promise<void>;
	proposeContent: (_file: TAbstractFile) => Promise<void>;
	previewNote: (_file: TAbstractFile) => Promise<void>;
	grantLicense: (_file: TAbstractFile) => Promise<void>;
	revokeLicense: (tagName: string, _file: TAbstractFile) => Promise<void>;
	renderCalls: (publication: string, streamIds: string[], lit_usage_key: string) => Promise<void>;
	bulkrender: (
		post_type: string,
		ensName: string,
		pubContract: string,
	) => Promise<void>;
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
		this.content = new ContentController(this)
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
					const oxoPlugin = this.plugin.app.plugins.plugins["oxo-core"];
					
					if (oxoPlugin && oxoPlugin.ctrlr) {
						this.oxo = oxoPlugin;
						return true; // Plugin and controller loaded successfully
					}
				} catch (error) {
					console.warn("Error accessing 0xobsidian plugin:", error);
				}

				attempts++;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			console.warn("0xobsidian plugin not found after", maxAttempts, "attempts");
			return false;
		};

		// Wait for plugin to be available
		const pluginLoaded = await waitForPlugin();
		
		if (!pluginLoaded) {
			console.log("0xo plugin not present")
			return; // Plugin never loaded
		}

		// Plugin is loaded, now check for active user (no retries - either they have one or they don't)
		if (!this.oxo.ctrlr.hasActiveUser()) {
			console.log("0xObsidian does not have an active user selected");
			return; // User needs to select an account manually
		}

		// We have a plugin AND an active user, now init chains
		try {

			// Dit toch naar 0x0? 
			const success = await this.oxo.ctrlr.initChains([
				"ETH_MAINNET",
				"BASE",
			]);

			if (success) {
				this.protocolInfo = await getProtocolInfo(
					this.plugin.settings.dev, 
					this.oxo.ctrlr.account["ETH_MAINNET"].publicClient, 
					this.oxo.ctrlr.account["BASE"].publicClient
				);

				console.log("protocolInfo", this.protocolInfo);
				// this.oxo.ctrlr.lit.createPkpAuthContext(this.protocolInfo.pkp.publicKey)

				
			}
		} catch (error) {
			console.warn("Error initializing chains:", error);
		}

		// const { addr } = await getPublicationMultiSig(this,'test12345');
		// console.log(addr)
	}

	async newPublication(tagName: string, file: TFile)  {

		const ensName = tagName.toLowerCase().replace("--s2s", "") + ".soul2soul.eth";
		const subdomain = ensName.split(".")[0];

		if (this.publications[subdomain] != undefined) {
			this.grantLicense(file);
			return;
		}

		this.publications[subdomain] = new PublicationService(this,subdomain);
	
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

	async previewNote(_file: TAbstractFile) {
		// preview should call renderer directly
		// it should replace relative urls with absolute ones
		// find solution for typography

		const file = this.plugin.app.vault.getFileByPath(_file.path);
		if (file != null) {
	
			const { contentId, publicContent, toEncrypt } = await this.content.parseNote(file);
			const html = await this.preview.renderHTML(
				contentId,
				publicContent.publications[0],
			);
			await this.preview.display(html);
		}
	}

	async grantLicense(_file: TAbstractFile) {
		const file = this.plugin.app.vault.getFileByPath(_file.path);
		if (file != null) {


			const { contentId, publicContent } = await this.content.parseNote(file);
			const lensProfileId = "";

			for (const pub of publicContent.publications) {
	
				const subdomain = pub.split(".")[0];
				// console.log("subdomain", subdomain);
			
				if(this.publications[subdomain] == undefined) {
					this.publications[subdomain] = new PublicationService(this, subdomain)
					await this.publications[subdomain].init();
				}

				const isLicensed = await this.publications[subdomain].isLicensed(contentId);
 
				console.log("isLicensed:", isLicensed)

				if (!isLicensed) {
					console.log("L1")
					await this.publications[subdomain].grantLicense(contentId, lensProfileId);
					console.log("L2")
				}
			}
		}
	}

	async revokeLicense(subdomain: string, _file: TAbstractFile): Promise<void> {

		console.log("revoking license for", subdomain);

		const file = this.plugin.app.vault.getFileByPath(_file.path);

		if (file != null) {
			try {
				let { streamId }: any = await this.content.parseNote(file);
			
				if (this.publications[subdomain].dealsModule == undefined) {
					await this.publications[subdomain].init();
				}

				const dealExists = await this.publications[subdomain].isLicensed(streamId); 
				if (dealExists) {
					this.publications[subdomain].revokeLicense(streamId);
				}

			} catch (error) {
				console.error("Error in revokeDeal:", error);
			}
		}
	}

	isValidForPublishing(file: TFile | null) : file is TFile {

		return file != null && file instanceof TFile && (file.path.endsWith(".base") || file.path.endsWith(".md")) ? true : false

	}

	async getInitializedService(subdomain: string) {

			if (this.publications[subdomain] == undefined) {

				this.publications[subdomain] = new PublicationService(this, subdomain);
				await this.publications[subdomain].init();
			}
		
			return this.publications[subdomain];
	}

	async publishToPublication(file: TFile, contentId: string, publicContent: any, toEncrypt: any, publication: string) {

		let license;
		const subdomain = publication.split(".")[0];
		const service = await this.getInitializedService(subdomain);
		// const lit_usage_key = this.oxo.settings.litUsageKey;

		this.notice = new Notice('1/5 storing item ...', 0);
		
		await this.content.storeNoteOnLens(file, this.protocolInfo, contentId, publicContent, toEncrypt, subdomain)

		this.notice.setMessage(`2/5 registering permission to publish on ${subdomain} ... `);

		console.log("b4 license check", contentId, subdomain, service)

		const isLicensed = await service.isLicensed(contentId);
		console.log(service);
		console.log(isLicensed)
		if (!isLicensed) {
			license = await service.grantLicense(contentId);
			console.log(license)
		}

		this.notice.setMessage('3/5 Authorizing ...')
		
		if (isLicensed || license != undefined) {
			await this.renderCalls(publication, [contentId], this.oxo.settings.litUsageKey);
		}

	}

	async proposeContent(_file: TAbstractFile) {
		
		const file = this.plugin.app.vault.getFileByPath(_file.path);

		if (!this.isValidForPublishing(file)) return;

		const { contentId, publicContent, toEncrypt } = await this.content.parseNote(file);

		for (const publication of publicContent.publications) {

			this.publishToPublication(file, contentId, publicContent, toEncrypt, publication)	
		}
		
	}

	async renderCalls(publication: string, streamIds: string[], lit_usage_key: string) {

		console.log(`Starting render process for publication ${publication} with ${streamIds.length} stream IDs`);

		try {

			this.notice.setMessage('4/5 Rendering ... (~ 30 sec)');

			const res: any = await renderwithLitActions(this.oxo.ctrlr, lit_usage_key, this.protocolInfo, this.notice, this.oxo.ctrlr.user.safe, publication, streamIds, true, false, false)

			this.notice.setMessage('5/5 Pinning ...');

			if(res.cid) {
				await pinCidFromRemote(res.cid, "https://ipfs.tranport-union.dev", this.oxo.settings.pinata_jwt)
				console.log("pinned on pinata")
			}


			// do i want to unpin deprecated html ? 

			this.notice.hide();

			const _link = (text: string, url: string) => {

				const fragment = document.createDocumentFragment();

				const link = fragment.createEl('a', { text, href: url });
				link.addEventListener('click', (e) => {
					e.preventDefault();
					window.open(url, '_blank');
				});
				fragment.createEl('br');

				return fragment
			};

			new Notice(_link(`${res.cid}`, `https://neutralpress.mypinata.cloud/ipfs/${res.cid}`), 0);
			new Notice(_link(publication + '.link' + res.path, 'https://' + publication + '.link' + res.path), 0);

			console.log(res.jobs);
			console.log('cbor', res.cbor)
			console.log('ipfs://' + res.cid);
			console.log('https://' + publication + '.link' + res.path)

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
