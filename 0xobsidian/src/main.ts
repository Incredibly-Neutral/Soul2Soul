import { Plugin, SettingTab, Notice } from "obsidian";
import { DEFAULT_SETTINGS, IOxOSettings, OxOAuthorsTab } from "./settings.js";
import { IMainController, MainController } from "./main.ctrlr.js";

// Use Node.js require to access native modules
const { Buffer } = require("buffer");
const { TextEncoder, TextDecoder } = require("util");

// Use Node.js native implementations
if (typeof window !== "undefined") {
  window.Buffer = Buffer;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
}

export default class OxO extends Plugin {
  settings!: IOxOSettings;
  authorsTab!: SettingTab;
  ctrlr!: IMainController;

  async onload() {
    await this.loadSettings();
    this.ctrlr = new MainController(this);
    await this.ctrlr.init()
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.authorsTab = new OxOAuthorsTab(this.app, this);
    this.addSettingTab(this.authorsTab);
  }

  async clearSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
