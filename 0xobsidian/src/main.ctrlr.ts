import OxO from "./main.js";
import { IOXOUser, OXOUser } from "./user/user.js";
import { IpfsCtrlr, ipfsController } from "./ipfs/ipfs.ctrlr.js";;
import { PinataService } from "./ipfs/pinata.ctrlr.js";
import { LitService } from "@s2s/soul2soul-shared";
import { IPermissionlessSafeService, PermissionlessSafeService } from "./eth/permissionless.safe.service.js";
import { FilecoinController, FilecoinSessionKeyData } from "./filecoin/filecoin.ctrlr.js";
import { Notice } from "obsidian";
import { IWaapService, WaapService } from "./eth/waap.service.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { ViemService } from "./eth/viem.service.js";
import { base } from "viem/chains";
import { chai } from "vitest";

// @ts-ignore
const basePath = (app.vault.adapter as any).basePath;

export interface IMainController {
  user?: IOXOUser;
  basePath: string;
  env: { [key: string]: string | undefined };
  /** 4337 smart account per chain (PermissionlessSafeService). */
  account: { [key: string]: IPermissionlessSafeService };
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
  hideAuthor: (user: IOXOUser) => Promise<void>;
  /** Drop all per-chain smart-account services so the next user is fresh. */
  resetAccounts: () => void;
}

export class MainController implements IMainController {
  user!: IOXOUser;
  basePath: string;
  env!: { [key: string]: string | undefined };
  viem!: ViemService;
  account!: { [key: string]: IPermissionlessSafeService };
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

      // new Notice(`📦 Filecoin storage ready — payer: ${skData.rootAddress}`, 4000);
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

      const chainName = chain; // preserve original name for lookup

      if (this.account[chain] == undefined) {
        this.account[chain] = new PermissionlessSafeService(this, chainName);
        await this.account[chain].updateSigner(this.user.private_key);

        if (this.user.safe == undefined) {
          // Salt is derived ONLY from the fresh EOA (no chain in it) so the
          // counterfactual Safe address is identical on every chain. That's
          // what lets us deploy "the safe on Base" now and deploy the SAME
          // safe on mainnet later for a publication.
          const salt = `s2s_${this.user.eoa}`;
          await this.account[chain].connectToFreshSafe(salt)

        } else {
          await this.account[chain].connectToExistingSafe(this.user.safe as  `0x${string}`)

        }
      }
  }

  async newAuthor(name: string, type: string, privateKey?: string) {

    // A new user is a blank slate: forget any previous in-memory user and
    // tear down their per-chain accounts before we build anything fresh.
    this.user = undefined as any;
    this.resetAccounts();

    this.user = new OXOUser(
      name,
      true,
      privateKey,       // use imported key if given, undefined = generate random
      undefined,        // eoa derived from the (fresh) private key
      undefined,        // safe derived fresh from the EOA salt
    );

    // Init BOTH chains for the fresh user, but only DEPLOY on Base.
    // Intentional asymmetry: mainnet is initialised now, but its safe is only
    // deployed later on the rare publication path. Do not reduce to Base-only.
    await this.initChains(['ETH_MAINNET', 'BASE']);
    await this.account["BASE"].deploySafe();

    // Store the Safe address in the user's safe field
    this.user.safe = this.account["BASE"]?.address;

   // this.user.lens = await this.user.addLensAccount(this)

    // Enforce a single active author so the persisted config can't end up
    // with two "active" users bleeding into each other on reload.
    for (const a of this.plugin.settings.authors) {
      (a as any).active = false;
    }

    this.plugin.settings.authors.push(this.user);
    this.plugin.authorsTab.display();
    this.plugin.saveSettings();
  }

  /**
   * Drop every per-chain smart-account service. Must be called whenever the
   * active user changes (new / switch / hide) so a previous author's signer
   * and Safe address can never leak into the next one.
   */
  resetAccounts() {
    this.account = {};
  }

  async toggleAuthor(_user: IOXOUser) {

    const authors = this.plugin.settings.authors;
    const target = authors.find((a: any) => a.name === _user.name);
    if (!target) return;

    // Flip the target; enforce "at most one active" (0 or 1). Clear everyone
    // first, then re-activate the target only if we're switching it on.
    const willActivate = !(target as any).active;
    for (const a of authors) (a as any).active = false;
    if (willActivate) (target as any).active = true;

    // Any change of the active user is a blank slate for the on-chain
    // accounts, so a previous author's signer/safe can't leak through.
    this.resetAccounts();

    if (willActivate) {
      this.user = new OXOUser(
        target.name,
        true,
        target.private_key,
        target.eoa,
        target.safe,
      );

      // Rebind accounts to this user's key + stored safe on both chains.
      // initChain updates the signer AND reconnects via connectToExistingSafe.
      await this.initChains(['ETH_MAINNET', 'BASE']);
    } else {
      // Toggled off ⇒ no active user. Zero active is allowed.
      this.user = undefined as any;
    }

    await this.plugin.saveSettings();
  }

  /**
   * Hide (remove) an author from the persisted config. If the hidden author
   * is the currently-active user, wipe the in-memory session too — clearing
   * the user and every per-chain account — so a subsequent new user starts
   * truly fresh with nothing left over from this one.
   */
  async hideAuthor(_user: IOXOUser) {

    this.plugin.settings.authors = this.plugin.settings.authors.filter(
      (a: any) => a.name !== _user.name,
    );

    if (this.user?.name === _user.name) {
      this.user = undefined as any;
      this.resetAccounts();
    }

    await this.plugin.saveSettings();
    this.plugin.authorsTab.display();
  }

  safeInstance (chain: string) {
    return new PermissionlessSafeService(this, chain);
  }
}