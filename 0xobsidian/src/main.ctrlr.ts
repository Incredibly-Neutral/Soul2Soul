import OxO from "./main.js";
import { IOXOUser, OXOUser } from "./user/user.js";
import { IpfsCtrlr, ipfsController } from "./ipfs/ipfs.ctrlr.js";;
import { PinataService } from "./ipfs/pinata.ctrlr.js";
import { LitService } from "@s2s/soul2soul-shared";
import { LensService } from "./lens/lens.ctrlr.js";
import { IPermissionlessSimpleService, PermissionlessSimpleService } from "./eth/permissionless.simple.service.js";
import { FilecoinController, FilecoinSessionKeyData } from "./filecoin/filecoin.ctrlr.js";
import { Notice } from "obsidian";
import { IWaapService, WaapService } from "./eth/waap.service.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { ViemService } from "./eth/viem.service.js";
import { base } from "viem/chains";

// @ts-ignore
const basePath = (app.vault.adapter as any).basePath;

export interface IMainController {
  user: IOXOUser;
  basePath: string;
  env: { [key: string]: string | undefined };
  /** 4337 smart account per chain (PermissionlessSimpleService). */
  account: { [key: string]: IPermissionlessSimpleService };
  storage?: FilecoinController;
  safeInstance: any;
  ipfs: IpfsCtrlr;
  lit: any;
  lens: any;
  plugin: OxO;
  waap: IWaapService;
  init: () => Promise<void>;
  initChains: (chains: string[]) => Promise<boolean>;
  initChain: (chain: string) => Promise<void>;
  hasActiveUser: () => boolean;
  hasAccounts: () => string[];
  newAuthor: (name: string, type: string, privateKey?: string) => Promise<void>;
  toggleAuthor: (user: IOXOUser) => Promise<void>;
}

export class MainController implements IMainController {
  user!: IOXOUser;
  basePath: string;
  env!: { [key: string]: string | undefined };
  viem!: ViemService;
  account!: { [key: string]: IPermissionlessSimpleService };
  storage?: FilecoinController;
  ipfs!: IpfsCtrlr;
  lit!: any;
  lens: any;
  pinata!: PinataService;
  plugin: OxO;
  waap!: IWaapService

  constructor(plugin: OxO) {
    this.basePath = basePath;
    this.ipfs = ipfsController;
    this.plugin = plugin;
  }

  async init() {

    this.account = {};
    this.pinata = new PinataService(this);
    this.lit = new LitService({ "environment": "prod"});
    this.viem = new ViemService(base, this.plugin.settings.rpc_key)
    this.lens = new LensService(this);
  
    const activeUser = this.plugin.settings.authors.find((a: any) => a.active);

    if (activeUser == undefined) {
      new Notice("no active 0xObsidian user", 3000)
    } else {
      const { name, active, private_key, eoa, safe } = activeUser;
      this.user = new OXOUser(name, active, private_key, eoa, safe);

      // if (!await this.user.checkLensProfile(this)) {
      //   console.log("hoi, nieuwe lens account")
      //   this.user.addLensAccount(this)
      // }
    }

    // ── Filecoin storage init ─────────────────────────────────────
    await this.initFilecoin();
  }

  /**
   * Load the session key from the plugin folder and initialise the
   * FilecoinController with it.
   */
  private async initFilecoin(): Promise<void> {
    // Plugin folimport { getPackedSettings } from "http2";der: {vault}/.obsidian/plugins/0xobsidian/
    const pluginDir = resolve(this.basePath, ".obsidian", "plugins", "0xobsidian");
    const skPath = resolve(pluginDir, "session-key.json");

    if (!existsSync(skPath)) {
      console.log("[filecoin] No session-key.json found — skipping Filecoin init");
      return;
    }

    try {
      const raw = readFileSync(skPath, "utf-8");
      const skData: FilecoinSessionKeyData = JSON.parse(raw);

      // Build the RPC URL from the DRPC key in settings
      const rpcKey = this.plugin.settings.rpc_key;
      const rpcUrl = rpcKey
        ? `https://lb.drpc.live/filecoin/${rpcKey}`
        : "https://api.node.glif.io/rpc/v1";

      this.storage = new FilecoinController(this);
      await this.storage.initWithSessionKey(skData, rpcUrl);

      new Notice(`📦 Filecoin storage ready — payer: ${skData.rootAddress}`, 4000);
    } catch (err: any) {
      console.error("[filecoin] Failed to init Filecoin storage:", err);
    }
  }

  hasActiveUser() {
    return this.user && this.user.private_key ? true : false;
  }

  hasAccounts() {
    return Object.keys(this.account)
  }

  async initChains(chains: string[]) {

    for (const chain of chains) {
      await this.initChain(chain);
    }

    return true;
  }

  async initChain(chain: string) {

      this.account[chain] = new PermissionlessSimpleService(this, chain);
      
      await this.account[chain].updateSigner(this.user.private_key)
      
      console.log("Simple account address:", this.account[chain].address)

      // Simple smart accounts deploy on first userOp — no separate deploy step needed
  }

  async newAuthor(name: string, type: string, privateKey?: string) {

    this.user = new OXOUser(
      name,
      true,
      privateKey,       // use imported key if given, undefined = generate random
      undefined,
      undefined,
    );

    // you may need to switch to other account type !! 
    if (this.hasAccounts().length < 1) {
      await this.initChains(['ETH_MAINNET','BASE'])
    } else {

      for (const chain of Object.keys(this.account)) {
        await this.account[chain].updateSigner(this.user.private_key);
      }
    }

    // console.log("type", type)

    switch (type) {

      case "safe": 

        this.user = new OXOUser(
          name,
          true,
          privateKey,   // use imported key if given, undefined = generate random
          undefined,
          undefined,
        );

        // you may need to switch to other account type !! 
        if (this.hasAccounts().length < 1) {
          await this.initChains(['ETH_MAINNET','BASE'])
        } else {

          for (const chain of Object.keys(this.account)) {
              await this.account[chain].updateSigner(this.user.private_key);
          }
        }

        // Store the simple account address in the user's safe field
        this.user.safe = this.account["ETH_MAINNET"]?.address;
      
        break;
    }

   // this.user.lens = await this.user.addLensAccount(this)

    this.plugin.settings.authors.push(this.user);
    this.plugin.authorsTab.display();
    this.plugin.saveSettings();
  }

  async toggleAuthor(_user: IOXOUser) {
    this.user = new OXOUser(
      _user.name,
      _user.active,
      _user.private_key,
      _user.eoa,
      _user.safe,
    );

    for (const chain of Object.keys(this.account)) {
      this.account[chain].updateSigner(this.user.private_key);
    }

    this.lit.init();
  }

  safeInstance (chain: string) {
    return new PermissionlessSimpleService(this, chain);
  }
}