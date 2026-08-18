import { FileSystemAdapter, Notice, TAbstractFile, TFile } from 'obsidian';
import DSG from './main';
import { IPublicationSrv, PublicationService } from './publication/publication.service';
import { PreviewCtrlr } from './preview.ctrlr';
import { getPublicationMultiSig, isAvailableEnsName } from './publication/ens';
import { NewPublicationModal } from './publication/new.modal';
import { getProtocolInfo, S2SProtocolInfo } from '@s2s/soul2soul-shared';
import { ContentController } from './content/content.ctrlr';
import { runIntent } from './publication/intents';
import { renderCalls as renderCallsHelper } from './render/render.helper';

export interface IMainController {
	basePath: string;
	plugin: DSG;
	oxo: any;
	content: ContentController;
	preview: PreviewCtrlr;
	publications: any;
	protocolInfo: S2SProtocolInfo;
	notice: Notice;

	getInitializedService: (subdomain: string) => Promise<IPublicationSrv>;
	newPublication: (ensName: string, file: TFile) => Promise<void>;
	isValidForPublishing: (file: TFile | null) => file is TFile;
	proposeContent: (_file: TAbstractFile) => Promise<void>;
	revokeContent: (_file: TAbstractFile) => Promise<void>;
	publishContent: (_file: TAbstractFile, publish: boolean) => Promise<void>;
	renderCalls: (
		publication: string,
		streamIds: string[],
		lit_usage_key: string,
		publish: boolean,
		remove?: { path: string; replacedBy?: string }[],
	) => Promise<void>;
}

/**
 * MainController — thin delegating wrapper.
 *
 * The heavy lifting lives in single-intent modules under `src/`:
 *   - publication/intents.ts   → runIntent + one function per intent
 *   - publication/publish.ts   → upload/publish pipeline (render-gated)
 *   - publication/revoke.ts    → retract flow (on-chain + remove re-render)
 *   - publication/filecoin.ts  → durability helpers
 *   - render/render.helper.ts  → renderCalls + RPC/path builders
 *   - content/ens-tags.ts      → pure tag ⇄ ENS helpers
 *
 * IMainController's surface is kept stable (with `revokeContent` instead of
 * the old mismatched `retractContent`) so main.ts and the modals don't break.
 */
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

	/** Upload intent — append + durability, no rendering. */
	async proposeContent(_file: TAbstractFile) {
		await runIntent(this, _file, 'upload');
	}

	/** Revoke intent — on-chain retract + remove-plumbing re-render. */
	async revokeContent(_file: TAbstractFile) {
		await runIntent(this, _file, 'retract');
	}

	/** Publish intent — append + full render (publish=false → preview). */
	async publishContent(_file: TAbstractFile, publish: boolean) {
		await runIntent(this, _file, 'publish', publish);
	}

	/** Render pipeline (prep → render → EVM update) — delegates to render.helper. */
	async renderCalls(
		publication: string,
		streamIds: string[],
		lit_usage_key: string,
		publish: boolean,
		remove?: { path: string; replacedBy?: string }[],
	) {
		await renderCallsHelper(this, publication, streamIds, lit_usage_key, publish, remove);
	}


}
