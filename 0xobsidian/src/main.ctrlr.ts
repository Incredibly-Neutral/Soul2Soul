import OxO from "./main.js";
import { IOXOUser, OXOUser } from "./user/user.js";
import { IpfsCtrlr, ipfsController } from "./ipfs/ipfs.ctrlr.js";;
import { PinataService } from "./ipfs/pinata.ctrlr.js";
import { LitService } from "./lit/lit.service.js";
import { LensService } from "./lens/lens.ctrlr.js";
import { IPermissionlessSafeService, PermissionlessSafeService } from "./eth/permissionless.safe.service.js";
import { Notice } from "obsidian";
import { IWaapService, WaapService } from "./eth/waap.service.js";

// @ts-ignore
const basePath = (app.vault.adapter as any).basePath;

export interface IMainController {
  user: IOXOUser;
  basePath: string;
  env: { [key: string]: string | undefined };
  account: { [key: string]: IPermissionlessSafeService }; 
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
  newAuthor: (name: string, type: string) => Promise<void>;
  toggleAuthor: (user: IOXOUser) => Promise<void>;
}

export class MainController implements IMainController {
  user!: IOXOUser;
  basePath: string;
  env!: { [key: string]: string | undefined };
  account!: { [key: string]: IPermissionlessSafeService };
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
    this.lit = new LitService(this);
    this.lens = new LensService(this);
  
    const activeUser = this.plugin.settings.authors.find((a: any) => a.active);

    if (activeUser == undefined) {

      new Notice("no active 0xObsidian user", 3000)

    } else {
      const { name, active, private_key, eoa, safe } = activeUser;
      this.user = new OXOUser(name, active, private_key, eoa, safe);

      if (!await this.user.checkLensProfile(this)) {
        console.log("hoi, nieuwe lens account")
        this.user.addLensAccount(this)
      }
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

      const salt = "default_safe";
      this.account[chain] = new PermissionlessSafeService(this, chain);
      
      const signerAddress = await this.account[chain].updateSigner(this.user.private_key)
      const safe_address = await this.account[chain].connectToFreshSafe(salt);
      // const deployed = await this.account[chain].isDeployed();
      // if (!deployed) {
      //   new Notice("deploying safe to " + chain);
      //   const deploy = await this.account[chain].valueTx(safe_address, "1");
      // }

      await this.account[chain].connectToExistingSafe(safe_address);
      
  }

  async newAuthor(name: string, type: string) {

    this.user = new OXOUser(
      name,
      true,
      undefined,
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
          undefined,
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

        this.user.safe = await this.account["ETH_MAINNET"].connectToFreshSafe("default_safe");
      
        break;
    }

    this.user.lens = await this.user.addLensAccount(this)

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

    // not checked
    for (const chain of Object.keys(this.account)) {
      if ('connectToFreshSafe' in this.account[chain]) {
        this.account[chain].updateSigner(this.user.private_key);
        this.account[chain].connectToFreshSafe("default_safe");
      }
    }

    this.lit.init();
  }

  safeInstance (chain: string) {
  
    return new PermissionlessSafeService(this, chain);
  }
}
