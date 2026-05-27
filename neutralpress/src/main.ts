import { IMainController, MainController } from "./main.ctrlr";

import {
	CachedMetadata,
	Editor,
	FileSystemAdapter,
	Plugin,
	TFile,
} from "obsidian";

import { DSGSettingsTab, DEFAULT_SETTINGS, Settings } from "./settings";
import { RevokeModal } from "./ui/revoke.modal"


export default class DSG extends Plugin {
	settings: Settings;
	ctrlr: IMainController;

	colourTags() {
		setTimeout(() => {
			document
				.querySelectorAll(".multi-select-pill")
				.forEach((el: HTMLElement) => {
					const text = el.querySelector(
						".multi-select-pill-content span",
					)?.textContent;
					const svg: HTMLElement | null = el.querySelector(
						".multi-select-pill-remove-button svg",
					);

					if (text != null && text.startsWith("p--")) {
						el.style.backgroundColor = "#c5f7da";
						el.style.color = "#41634f";
					}
					if (svg != null) {
						svg.style.stroke = "#41634f";
					}
				});
		}, 500);
	}

	extractTags(meta: CachedMetadata | null): string[] {
		if (!meta || !meta.frontmatter) return [];
		const fm = meta.frontmatter;
		if (Array.isArray(fm.tags)) return fm.tags;
		if (typeof fm.tags === "string") return fm.tags.split(/,\s*/);
		return [];
	}

	getStreamID(meta: CachedMetadata | null): string {
		if (!meta || !meta.frontmatter) return "";
		const fm = meta.frontmatter;
		if (fm.stream_id) return fm.stream_id;
		return "";
	}


	async onload() {
		this.addSettingTab(new DSGSettingsTab(this.app, this));
		await this.loadSettings();

		this.ctrlr = new MainController(this);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				const activeFile = this.app.workspace.getActiveFile() as TFile;

				menu.addItem((item) => {
					item.setTitle("Preview")
						.setIcon("document")
						.onClick(() => this.ctrlr.proposeContent(activeFile, false));
				});
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				menu.addItem((item) => {
					item.setTitle("Propose to print")
						.setIcon("document")
						.onClick(() => this.ctrlr.proposeContent(file, true));
				});
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.colourTags();
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", async (file: TFile) => {
				if (file.extension !== "md") return;

				this.colourTags();

				const cachedMeta = this.app.metadataCache.getFileCache(file);
				const previousTags = this.extractTags(cachedMeta);

				// Wait for next tick for updated metadata
				setTimeout(async () => {
					const updatedMeta =
						this.app.metadataCache.getFileCache(file);
					const newTags = this.extractTags(updatedMeta);

					const added = newTags.filter(
						(t) => !previousTags.includes(t),
					);
					const removed = previousTags.filter(
						(t) => !newTags.includes(t),
					);

					if (added.length > 0) {
						if (added[0].endsWith("--s2s")) {
							console.log("Web tag added:", added[0]);
							await this.ctrlr.newPublication(added[0], file);
						}
					} else if (removed.length > 0) {
						if (removed[0].endsWith("--s2s")) {
							console.log("Web tag removed:", removed[0]);
							const contentId = this.getStreamID(updatedMeta) /// ????
							const ensName = removed[0].toLowerCase().replace("--s2s", "") + ".soul2soul.eth";
							const subdomain = ensName.split(".")[0]
							const onSubmit = async () => {
								const { contentId, publicContent, toEncrypt } = await this.ctrlr.content.parseNote(file)
								await this.ctrlr.content.storeNoteOnLens(file, this.ctrlr.protocolInfo, contentId, publicContent, toEncrypt, subdomain);
								await this.ctrlr.revokeLicense(subdomain, file);
								await this.ctrlr.renderCalls(ensName, [contentId], this.ctrlr.oxo.settings.litUsageKey, true)
							}
							return new RevokeModal(this.app, this.ctrlr, ensName, onSubmit).open();
							
						}
					}
				}, 100); // short delay to let metadataCache update
			}),
		);

		this.addCommand({
			id: "publish",
			name: "publish",
			callback: () => {
				const activeFile = this.app.workspace.getActiveFile() as TFile;
				return this.ctrlr.proposeContent(activeFile, true);
			},
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
