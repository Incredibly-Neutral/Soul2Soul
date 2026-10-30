/**
 * Minimal Obsidian API stub for headless unit tests.
 *
 * The `obsidian` package has no Node entrypoint (it's bundled by the plugin
 * build). This module provides just enough surface for neutralpress source
 * modules to load and for tests to exercise their logic — no DOM, no plugin
 * runtime. Vitest aliases `obsidian` → this file (see ../vitest.config.ts).
 *
 * If a test needs richer behavior, extend the relevant class here or
 * `vi.mock('obsidian')` in that specific test file.
 */

export class App {
	vault: any = {};
	workspace: any = {};
	metadataCache: any = {};
	fileManager: any = {};
}

export class TFile {
	name = '';
	path = '';
	stat: any = {};
	extension = 'md';
}

export class TAbstractFile {
	name = '';
	path = '';
}

export class Notice {
	noticeEl: any = { appendChild: () => {}, remove: () => {} };
	setMessage = () => {};
	hide = () => {};
	constructor(_message?: string, _timeout?: number) {}
}

export class FileSystemAdapter {}

export class MarkdownView {}

export class WorkspaceLeaf {}

export class ItemView {
	constructor(_leaf?: WorkspaceLeaf) {}
}

export class ViewCreator {}

export class Modal {
	app!: App;
	contentEl: any = { createEl: () => ({ addEventListener: () => {}, appendChild: () => {} }) };
	containerEl: any = { empty: () => {}, createEl: () => ({ addEventListener: () => {} }) };
	constructor(app: App) {
		this.app = app;
	}
	open() {}
	close() {}
	onOpen() {}
	onClose() {}
}

export class Plugin {
	app!: App;
	manifest: any = {};
	settings: any = {};
	constructor(app: App, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}
	async loadData() {
		return {};
	}
	async saveData() {}
	addRibbonIcon() {}
	addStatusBarItem() {
		return { setText: () => {} };
	}
	addCommand() {}
	addSettingTab() {}
	registerEvent() {}
	registerDomEvent() {}
	registerInterval() {}
}

export class PluginSettingTab {
	app!: App;
	containerEl: any = { empty: () => {}, createEl: () => ({}) };
	constructor(app: App, _plugin?: any) {
		this.app = app;
	}
	display() {}
}

export class Setting {
	constructor(_containerEl: any) {}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	setHeading() {
		return this;
	}
	addToggle() {
		return this;
	}
	addText() {
		return this;
	}
	addTextArea() {
		return this;
	}
	addDropdown() {
		return this;
	}
	addButton() {
		return this;
	}
	addExtraButton() {
		return this;
	}
}

export class CachedMetadata {}

export class Editor {}

export class Platform {}

export const requestUrl = async () => ({ json: {} });

export const normalizePath = (p: string) => p;

export const parseYaml = (s: string) => ({});

export const MarkdownRenderer = { render: async () => {} };

export const Component = class {};

export const moment = () => ({ format: () => '' });
