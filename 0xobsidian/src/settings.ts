import { PluginSettingTab } from "obsidian";
import { App, Setting } from "obsidian";
import OxO from "./main.js";
import { IOXOUser } from "./user/user.js";
import { IInvite, IUpdate } from "./types/oxo.js";
import { safeField } from "./settings.factory.js";
import { AuthorModal } from "./user/author.modal.js";

export interface IOxOSettings {
  authors: IOXOUser[];
  updates: { [key: string]: IUpdate[] };
  invites: IInvite[];
  updatesIncludeMyOwn: boolean;
  listening: boolean;
  alchemy_key: string;
  arbiscan_key: string;
  basescan_key: string;
  etherscan_key: string;
  pimlico_key: string;
  pinata_api_key: string;
  pinata_secret_key: string;
  pinata_jwt: string;
  lit_capacity_token: string;
}

export const DEFAULT_SETTINGS: IOxOSettings = {
  authors: [],
  updates: {},
  invites: [],
  updatesIncludeMyOwn: false,
  listening: false,
  alchemy_key: "",
  basescan_key: "",
  arbiscan_key: "",
  etherscan_key: "6QXJHPD91YEMD1YXYKAQF2XPIU2RZVIPQ3",
  pimlico_key: "",
  pinata_api_key: "",
  pinata_jwt: "",
  pinata_secret_key: "",
  lit_capacity_token: "328084",
};

export class OxOAuthorsTab extends PluginSettingTab {
  plugin: OxO;
  name: string;

  constructor(app: App, plugin: OxO) {
    super(app, plugin);
    this.plugin = plugin;
    this.name = "0xO authors";
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setHeading() // This makes it appear as a header
      .setName("Authors:");
    // .setDesc('Create a local signer and Modular Smart Account following EIP-4337 on Arbitrum Sepolia')
    // .addButton( button => button
    // 	.setButtonText("New")
    // 	.onClick( async () => {
    // 		await this.plugin.ctrlr.newAuthor();
    // 	})
    // );

    for (const [index, author] of this.plugin.settings.authors.entries()) {
      const authorEl = containerEl.createEl("div", {});
      authorEl.setCssStyles({
        marginTop: "2rem",
        paddingBottom: "1rem",
        paddingTop: "2rem",
        borderTop: "1px solid #000",
      });

      if (index === this.plugin.settings.authors.length - 1) {
        authorEl.setCssStyles({
          borderBottom: "1px solid #000",
          marginBottom: "1rem",
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
        .setName("Name")
        .setDesc("")
        .addText((text) =>
          text.setValue(author.name).onChange(async (value) => {
            author.name = value;
            await this.plugin.saveSettings();
          }),
        )
        .addToggle((button) =>
          button.setValue(author.active).onChange(async () => {
            for (let a of this.plugin.settings.authors.filter(
              (a: any) => a.name != author.name,
            )) {
              a.active = false;
            }
            author.active = !author.active;
            await this.plugin.saveSettings();
            await this.plugin.ctrlr.toggleAuthor(author);
            this.plugin.authorsTab.display();
          }),
        )
        .addButton((button) =>
          button.setButtonText("Hide").onClick(async () => {
            this.plugin.settings.authors = this.plugin.settings.authors.filter(
              (a: any) => a.name != author.name,
            );
            await this.plugin.saveSettings();
            this.plugin.authorsTab.display();
          }),
        );

      new Setting(authorEl) // This makes it appear as a header
        .setName("Signer:")
        .setDesc(author.eoa)
        .addButton((button) =>
          button.setButtonText("Copy").onClick(() => {
            navigator.clipboard.writeText(author.eoa);
          }),
        );

      // moeten we niet meteen alles inladen ? [user][chain]? 
      for (let chain of Object.keys(this.plugin.ctrlr.account)) {
        safeField(chain, author, authorEl);
      }

      new Setting(authorEl) // This makes it appear as a header
        .setName("Lens profile:")
        .setDesc(author.lens || "")
        .addButton((button) =>
          button.setButtonText("Copy").onClick(() => {
            navigator.clipboard.writeText(author.lens || "");
          }),
        );
    }

    new Setting(containerEl)
      // .setName('Authors')
      // .setDesc('Create a local signer and Modular Smart Account following EIP-4337 on Arbitrum Sepolia')
      .addButton((button) =>
        button.setButtonText("New Author").onClick(async () => {

          const onSubmit = async (name: string, type: string) => {
            await this.plugin.ctrlr.newAuthor(name, type);
          }
          return new AuthorModal(this.app, this.plugin.ctrlr, onSubmit).open();
        }),
      );

    new Setting(containerEl)
      .setHeading() // This makes it appear as a header
      .setName("Settings:");

    new Setting(containerEl).setName("ALCHEMY KEY").addText((text) =>
      text
        .setValue(this.plugin.settings.alchemy_key)
        .onChange(async (value) => {
          this.plugin.settings.alchemy_key = value;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl).setName("ARBISCAN KEY").addText((text) =>
      text
        .setValue(this.plugin.settings.arbiscan_key)
        .onChange(async (value) => {
          this.plugin.settings.arbiscan_key = value;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl).setName("BASESCAN KEY").addText((text) =>
      text
        .setValue(this.plugin.settings.basescan_key)
        .onChange(async (value) => {
          this.plugin.settings.basescan_key = value;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl).setName("PIMLICO KEY").addText((text) =>
      text
        .setValue(this.plugin.settings.pimlico_key)
        .onChange(async (value) => {
          this.plugin.settings.pimlico_key = value;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl)
      .setName("PINATA KEY")
      .setDesc("Service to serve content addressed uploads")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.pinata_api_key)
          .onChange(async (value) => {
            this.plugin.settings.pinata_api_key = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("PINATA SECRET KEY")
      .setDesc("Service to serve content addressed uploads")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.pinata_secret_key)
          .onChange(async (value) => {
            this.plugin.settings.pinata_secret_key = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("PINATA JWT")
      .setDesc("Service to serve content addressed uploads")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.pinata_jwt)
          .onChange(async (value) => {
            this.plugin.settings.pinata_jwt = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
