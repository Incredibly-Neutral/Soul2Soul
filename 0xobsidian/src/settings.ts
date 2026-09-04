import { PluginSettingTab } from 'obsidian';
import { App, Setting } from 'obsidian';
import OxO from './main.js';
import { IOXOUser } from './user/user.js';
import { IInvite, IUpdate } from './types/oxo.js';
import { accountField } from './settings.factory.js';
import { AuthorModal } from './user/author.modal.js';

export type PinProvider = 'pinata' | 'filebase';

export interface IOxOSettings {
	authors: IOXOUser[];
	updates: Record<string, IUpdate[]>;
	invites: IInvite[];
	updatesIncludeMyOwn: boolean;
	listening: boolean;
	pimlico_key: string;
	rpc_key: string;
	arbiscan_key: string;
	basescan_key: string;
	etherscan_key: string;
	pinata_api_key: string;
	pinata_secret_key: string;
	pinata_jwt: string;
	filebase_token: string;
	pin_provider: PinProvider;
	litUsageKey: string;
	kubo_url: string;
}

export const DEFAULT_SETTINGS: IOxOSettings = {
	authors: [],
	updates: {},
	invites: [],
	updatesIncludeMyOwn: false,
	listening: false,
	rpc_key: '',
	basescan_key: '',
	arbiscan_key: '',
	etherscan_key: 'REDACTED',
	pimlico_key: '',
	pinata_api_key: '',
	pinata_jwt: '',
	pinata_secret_key: '',
	filebase_token: '',
	pin_provider: 'filebase',
	litUsageKey: '',
	kubo_url: 'ipfs.transport-union.dev',
};

export class OxOAuthorsTab extends PluginSettingTab {
	plugin: OxO;
	name: string;
	/** Track which authors have their private key revealed in the UI. */
	private readonly privateKeyRevealed = new Set<string>();

	constructor(app: App, plugin: OxO) {
		super(app, plugin);
		this.plugin = plugin;
		this.name = '0xO authors';
	}

	async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setHeading() // This makes it appear as a header
			.setName('Authors:');
		// .setDesc('Create a local signer and Modular Smart Account following EIP-4337 on Arbitrum Sepolia')
		// .addButton( button => button
		// 	.setButtonText("New")
		// 	.onClick( async () => {
		// 		await this.plugin.ctrlr.newAuthor();
		// 	})
		// );

		for (const [index, author] of this.plugin.settings.authors.entries()) {
			const authorEl = containerEl.createEl('div', {});
			authorEl.setCssStyles({
				marginTop: '2rem',
				paddingBottom: '1rem',
				paddingTop: '2rem',
				borderTop: '1px solid #000',
			});

			if (index === this.plugin.settings.authors.length - 1) {
				authorEl.setCssStyles({
					borderBottom: '1px solid #000',
					marginBottom: '1rem',
				});
			}

			// if (author.eoa == undefined) {
			//   const wallet = new Wallet(author.private_key);
			//   author.eoa = wallet.address;
			//   this.plugin.saveSettings();
			// }

			// if (author.safe == undefined || author.safe == "") {

			//   author.safe = await this.plugin.ctrlr.account[
			//     Object.keys(this.plugin.ctrlr.account)[0]
			//   ].getSafeAddress([author.eoa], "default_safe");

			//   this.plugin.saveSettings();
			// }

			new Setting(authorEl)
				.setName('Name')
				.setDesc('')
				.addText((text) =>
					text.setValue(author.name).onChange(async (value) => {
						author.name = value;
						await this.plugin.saveSettings();
					}),
				)
				.addToggle((button) =>
					button.setValue(author.active).onChange(async () => {
						// Controller owns the "at most one active author" rule + persists.
						await this.plugin.ctrlr.toggleAuthor(author);
						this.plugin.authorsTab.display();
					}),
				)
				.addButton((button) =>
					button.setButtonText('Hide').onClick(async () => {
						// Controller handles removal + clearing the active user/accounts
						// so the next new author starts from a blank slate.
						await this.plugin.ctrlr.hideAuthor(author);
					}),
				);

			const didValue = `did:ethr:${author.safe}`;
			new Setting(authorEl)
				.setName('DID')
				.setDesc(didValue)
				.addButton((button) =>
					button.setButtonText('Copy').onClick(() => {
						navigator.clipboard.writeText(didValue);
					}),
				);

			const pkRevealed = this.privateKeyRevealed.has(author.name);

			new Setting(authorEl)
				.setName('Private Key:')
				.setDesc(pkRevealed ? author.private_key : '••••••••••••••••')
				.addButton((button) =>
					button.setButtonText(pkRevealed ? 'Hide' : 'Reveal').onClick(() => {
						if (pkRevealed) {
							this.privateKeyRevealed.delete(author.name);
						} else {
							this.privateKeyRevealed.add(author.name);
						}
						this.display();
					}),
				)
				.addButton((button) =>
					button.setButtonText('Copy').onClick(() => {
						if (author.private_key) {
							navigator.clipboard.writeText(author.private_key);
						}
					}),
				);

			// moeten we niet meteen alles inladen ? [user][chain]?
			for (const chain of Object.keys(this.plugin.ctrlr.account)) {
				accountField(chain, author, authorEl);
			}

			// new Setting(authorEl) // This makes it appear as a header
			//   .setName("Lens profile:")
			//   .setDesc(author.lens || "")
			//   .addButton((button) =>
			//     button.setButtonText("Copy").onClick(() => {
			//       navigator.clipboard.writeText(author.lens || "");
			//     }),
			//   );
		}

		new Setting(containerEl)
			// .setName('Authors')
			// .setDesc('Create a local signer and Modular Smart Account following EIP-4337 on Arbitrum Sepolia')
			.addButton((button) =>
				button.setButtonText('New Author').onClick(async () => {
					const onSubmit = async (name: string, type: string, privateKey?: string) => {
						await this.plugin.ctrlr.newAuthor(name, type, privateKey);
					};
					new AuthorModal(this.app, this.plugin.ctrlr, onSubmit).open();
				}),
			);

		new Setting(containerEl)
			.setHeading() // This makes it appear as a header
			.setName('Settings:');

		new Setting(containerEl).setName('RPC KEY').addText((text) =>
			text.setValue(this.plugin.settings.rpc_key).onChange(async (value) => {
				this.plugin.settings.rpc_key = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName('ARBISCAN KEY').addText((text) =>
			text.setValue(this.plugin.settings.arbiscan_key).onChange(async (value) => {
				this.plugin.settings.arbiscan_key = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName('BASESCAN KEY').addText((text) =>
			text.setValue(this.plugin.settings.basescan_key).onChange(async (value) => {
				this.plugin.settings.basescan_key = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName('PIMLICO KEY').addText((text) =>
			text.setValue(this.plugin.settings.pimlico_key).onChange(async (value) => {
				this.plugin.settings.pimlico_key = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName('PINATA KEY')
			.setDesc('Service to serve content addressed uploads')
			.addText((text) =>
				text.setValue(this.plugin.settings.pinata_api_key).onChange(async (value) => {
					this.plugin.settings.pinata_api_key = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('PINATA SECRET KEY')
			.setDesc('Service to serve content addressed uploads')
			.addText((text) =>
				text.setValue(this.plugin.settings.pinata_secret_key).onChange(async (value) => {
					this.plugin.settings.pinata_secret_key = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('PINATA JWT')
			.setDesc('JWT for Pinata IPFS pinning (used when pin_provider is set to pinata)')
			.addText((text) =>
				text.setValue(this.plugin.settings.pinata_jwt).onChange(async (value) => {
					this.plugin.settings.pinata_jwt = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('FILEBASE TOKEN')
			.setDesc('Filebase access token for IPFS pinning (used when pin_provider is set to filebase)')
			.addText((text) =>
				text.setValue(this.plugin.settings.filebase_token).onChange(async (value) => {
					this.plugin.settings.filebase_token = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('PIN PROVIDER')
			.setDesc('Storage provider for IPFS pinning: "pinata" or "filebase" (default: filebase)')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('filebase', 'Filebase')
					.addOption('pinata', 'Pinata')
					.setValue(this.plugin.settings.pin_provider)
					.onChange(async (value) => {
						this.plugin.settings.pin_provider = value as PinProvider;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('LIT USAGE KEY')
			.setDesc('Key to run serverless functions')
			.addText((text) =>
				text.setValue(this.plugin.settings.litUsageKey).onChange(async (value) => {
					this.plugin.settings.litUsageKey = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
