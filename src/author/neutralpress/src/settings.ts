import { App, PluginSettingTab, Setting } from "obsidian";
import { getProtocolInfo, S2SPublication } from "@s2s/soul2soul-shared";

export interface Settings {
	dev: boolean;
	data_gateway: string;
	arbiscan_key: string;
	basescan_key: string;
	publications: S2SPublication[];
	contract_factory: string;
	ens_registry: string;
	ens_resolver: string;
	ens_records: string;
	safe_records_factory: string;
	proxy_admin: string;
	chain_id: string;
}

export const DEFAULT_SETTINGS: Settings = {
	dev: false,
	data_gateway: "https://ipfs.transport-union.dev",
	arbiscan_key: "",
	basescan_key: "",
	
	publications: [] as S2SPublication[],
	contract_factory: "0x5a9F61C144862b46A29A434d5C17036Ff5fA40C0",
	ens_registry: "0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5", // custom open subdomain registry // move to protocolInfo
	ens_resolver: "0x5ED9023eaDbE9757E347E92D1Da97F2e0b010b61", // custom resolver with ccip read // move to protocolInfo
	ens_records: "0x5D42f9b016B4251FC6407d5e8154DA887F394900", // move to protocolInfo
	safe_records_factory: "0xed933AB957aa3440133cdf1236662635d4eb2Ccf", // move to protocolInfo
	proxy_admin: "0x66d5549fdfaCc3606EB5bcD702D989A846A936c0", // is tis used ? 
	chain_id: "8453",
};


export class DSGSettingsTab extends PluginSettingTab {
	plugin: any;
	name: string;

	constructor(app: App, plugin: any) {
		super(app, plugin);
		this.plugin = plugin;
		this.name = "NP settings";
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h3", { text: "NeutralPress settings" });

		new Setting(containerEl)
			.setName("Prod/Dev")
			.setDesc("In dev mode we follow the config on dev.---protocol.eth")
			.addToggle((toggle: any) => {
				toggle.setValue(this.plugin.settings.dev);
				toggle.onChange(async (value: string) => {
					this.plugin.settings.dev = value;
					await this.plugin.saveSettings();

					this.plugin.ctrlr.protocolInfo = await getProtocolInfo(
						this.plugin.ctrlr, this.plugin.oxo.ctrlr.account["ETH_MAINNET"].provider, this.plugin.oxo.ctrlr.account["BASE"].provider
					);
				});
			});
	}
}

