// src/lib/safe-integration.ts
import { Abi_S2SPublicationModuleV2 } from '../../../protocol/generated/abis/S2SPublicationModuleV2';
import { Abi_S2SRecordsModule } from '../../../protocol/generated/abis/S2SRecordsModule';

import { toBytes32Id } from '@s2s/soul2soul-shared';

import type { SafeInfo, EthersContract } from '@/types';
import SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { SafeAppProvider } from '@safe-global/safe-apps-provider';
import { getRpcUrl } from './evm';

/**
 * The address a contract wrapper was constructed with (ethers v6 `target`).
 *
 * Tx payloads must take their `to:` from here, never from `safeInfo`: that
 * snapshot is exactly what went stale in the step-3 crash (`to: ''` →
 * `invalid address`), and `target` is the address the ABI was bound to, so a
 * payload can never be built for a different module than the one that encoded
 * it.
 */
function contractAddress(module: unknown): string {
  const target = (module as { target?: unknown } | null)?.target;
  return typeof target === 'string' ? target : '';
}

export class SafeIntegration {
  private safeSdk: SafeAppsSDK | null = null;
  public recordsModule: EthersContract | null = null;
  public publicationModule: any | null = null;
  private safeInfo: SafeInfo = {
    safeAddress: '',
    s2sRecords: '',
    s2sPublication: '',
    chainId: 1,
    network: '',
    owners: [],
    threshold: 1,
    modules: [],
  };

  /**
   * Read the Safe, discover the S2S modules and publish the result.
   *
   * ATOMIC and NON-DESTRUCTIVE by construction: discovery accumulates into
   * LOCALS and `this.recordsModule` / `this.publicationModule` / `this.safeInfo`
   * are assigned once, at the end. Nothing on `this` is mutated in between.
   *
   * This is the fix for the step-3 crash: `initialize()` used to write
   * `safeInfo = { s2sRecords: '', s2sPublication: '', ... }` up front and fill
   * the addresses in inside the awaited NAME() loop, so any read that landed in
   * that window (`setRecord`'s `to:`, a second overlapping `fetchFreshData`, the
   * page's very first records fetch) saw a known module with an empty address
   * and proposed a tx to `''`. Overlapping calls are now harmless: each computes
   * a complete snapshot and publishes it whole.
   *
   * Non-destructive in the second sense too: a discovery pass that fails to find
   * a module (e.g. NAME() reverting under RPC pressure) keeps the address we
   * already know rather than blanking it. The one case that DOES clear a module
   * is the module genuinely leaving the Safe's module list (a reset): it is
   * dropped so `hasRecordsModule()` stops lying. A module the Safe never listed
   * — adopted mid-init from the factory logs, deployed but not yet enabled — is
   * deliberately kept: the enable tx has not run yet, and clearing it would
   * strand the init flow's own recovery (see `adoptModules`). For the same
   * reason the publish merges: a wrapper adopted while this pass was awaiting a
   * NAME() probe is newer than the one we captured and wins.
   */
  async initialize(): Promise<SafeInfo> {
    try {
      if (typeof SafeAppsSDK === 'undefined') {
        throw new Error('SafeAppsSDK not available');
      }

      const opts = {
        allowedDomains: [/app\.safe\.global$/],
        debug: false,
      };

      this.safeSdk = new SafeAppsSDK(opts);
      const safeData: any = await this.safeSdk!.safe.getInfo();

      const modules: string[] = safeData.modules ?? [];
      const prevModules = this.safeInfo?.modules ?? [];
      const isListed = (address: string) =>
        modules.some((m) => (m ?? '').toLowerCase() === address.toLowerCase());
      const wasListed = (address: string) =>
        prevModules.some((m) => (m ?? '').toLowerCase() === address.toLowerCase());

      // Discovery locals — `this` is untouched until the end.
      // Captured so the publish below can tell whether an out-of-band adoption
      // (`adoptModules`, which can land while a NAME() probe is awaiting)
      // replaced the field under us.
      const capturedRecords = this.recordsModule;
      const capturedPublication = this.publicationModule;
      let recordsModule: EthersContract | null = capturedRecords;
      let publicationModule: any | null = capturedPublication;

      // Drop a module the Safe used to list and no longer does (reset), so
      // hasRecordsModule()/hasPublicationModule() cannot keep claiming it.
      const knownRecords = contractAddress(recordsModule);
      if (knownRecords && wasListed(knownRecords) && !isListed(knownRecords)) {
        console.log('Records module is gone from the Safe, clearing it:', knownRecords);
        recordsModule = null;
      }
      const knownPublication = contractAddress(publicationModule);
      if (knownPublication && wasListed(knownPublication) && !isListed(knownPublication)) {
        console.log('Publication module is gone from the Safe, clearing it:', knownPublication);
        publicationModule = null;
      }

      const rpcUrl = getRpcUrl(safeData.chainId);
      const provider = new window.ethers.JsonRpcProvider(rpcUrl);

      // Find both modules
      const NAME_ABI = ['function NAME() view returns (string)'];

      for (const moduleAddress of modules) {
        try {
          // Check for NAME function with minimal ABI
          const moduleChecker = new window.ethers.Contract(moduleAddress, NAME_ABI, provider);

          const name = await moduleChecker.NAME();
          console.log(`Module ${moduleAddress} has NAME:`, name);

          if (name === 'S2S Records Module') {
            // Create full contract instance with complete ABI
            recordsModule = new window.ethers.Contract(
              moduleAddress,
              Abi_S2SRecordsModule,
              provider,
            );
            console.log('Found Records Module:', moduleAddress);
          } else if (name === 'S2S Publication Module V2') {
            // Create full contract instance with complete ABI
            publicationModule = new window.ethers.Contract(
              moduleAddress,
              Abi_S2SPublicationModuleV2,
              provider,
            );
            console.log('Found Publication Module:', moduleAddress);
          }
        } catch (error) {
          // Module doesn't have NAME() function, skip it. The previously known
          // contract (if any) is kept — see the non-destructive note above.
          console.log(`Module ${moduleAddress} doesn't have NAME(), skipping`);
        }
      }

      // Merge with anything adopted while this pass was awaiting a probe. The
      // field having changed means a NEWER wrapper exists (adoptModules is the
      // only mid-pass writer: it runs when the init flow learns the addresses
      // from factory logs), so keep it — publishing our older local would
      // discard it, and hasRecordsModule() would then be false for the rest of
      // the page (Config tab gone, a config session dropped).
      if (this.recordsModule && this.recordsModule !== capturedRecords) {
        recordsModule = this.recordsModule;
      }
      if (this.publicationModule && this.publicationModule !== capturedPublication) {
        publicationModule = this.publicationModule;
      }

      // Single, complete publication of the discovery result. The addresses in
      // safeInfo are DERIVED from the contracts, so "known module, empty
      // address" is not representable.
      this.recordsModule = recordsModule;
      this.publicationModule = publicationModule;
      this.safeInfo = {
        safeAddress: safeData.safeAddress,
        s2sRecords: contractAddress(recordsModule),
        s2sPublication: contractAddress(publicationModule),
        chainId: safeData.chainId,
        network: safeData.network,
        modules,
        owners: safeData.owners,
        threshold: safeData.threshold,
      };

      return this.safeInfo;
    } catch (error) {
      console.error('Failed to initialize Safe SDK:', error);
      return this.safeInfo;
    }
  }

  // ===== GENERIC SAFE PRIMITIVES (module-install / init flow, SPEC-author-hosts AD-3) =====
  // These are runtime-agnostic Safe-side building blocks. The orchestration
  // layer (publication-init) injects them as deps and never imports this file's
  // host internals.

  /**
   * Propose an arbitrary batch of txs to the Safe for owner confirmation.
   * Used to install the records + publication modules in a single proposal
   * (SPEC-author-hosts AD-3 step 3). Returns the Safe UI queue URL.
   */
  async proposeBatch(txs: Array<{ to: string; value: string; data: string }>): Promise<string> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }

    await this.safeSdk.txs.send({ txs });

    const safeUrl = `https://app.safe.global/transactions/queue?safe=${this.safeInfo.chainId}:${this.safeInfo.safeAddress}`;

    console.log('Transaction batch proposed. Execute at:', safeUrl);

    return safeUrl;
  }

  /** Fresh JSON-RPC provider for the Safe's chain (same pattern as initialize). */
  getProvider() {
    const rpcUrl = getRpcUrl(this.safeInfo.chainId);
    return new window.ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Size in bytes of the code deployed at `address` on `chainId` (the Safe's
   * chain by default; pass 1 to check whether the same address is a Safe on
   * mainnet). 0 when the account has no contract.
   *
   * The init flow uses this to prove the module factories exist on the chain
   * the Safe lives on BEFORE proposing the create batch. A call to an address
   * with no code does not revert: the Safe tx SUCCEEDS as a no-op, nothing is
   * deployed, and no ModuleCreated log is ever emitted — so the flow would poll
   * for a deployment that can never happen. The factories are read from
   * on-chain protocol state through the Base provider (shared/src/protocol), so
   * pointing them at another chain (e.g. a mainnet Safe) is exactly that case.
   */
  async contractCodeSize(address: string, chainId?: number): Promise<number> {
    const provider =
      chainId === undefined ? this.getProvider() : this.evmSetup(address, [], chainId).provider;
    const code: string = await provider.getCode(address);
    // eth_getCode returns '0x' for an account without code: 2 hex chars per
    // byte once the 0x prefix is dropped.
    return Math.max(0, (code.length - 2) / 2);
  }

  /**
   * Fetch raw factory `ModuleCreated` logs for a given safe address.
   * topic[1] is the padded indexed safe address (bytes32). Returns the raw
   * log objects, which carry `.topics`.
   */
  async fetchFactoryModuleCreatedLogs(
    factoryAddress: string,
    safeAddress: string,
    topic0: string,
    fromBlock: number,
  ): Promise<Array<{ topics: string[] }>> {
    const provider = this.getProvider();
    const paddedSafe = '0x' + safeAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    return await provider.getLogs({
      address: factoryAddress,
      topics: [topic0, paddedSafe],
      fromBlock,
      toBlock: 'latest',
    });
  }

  /**
   * Current enabled-module list from the Safe (list order, for computing
   * disableModule prevModule). Fresh read via the SDK — not the possibly-stale
   * snapshot captured at initialize time.
   */
  async fetchSafeModules(): Promise<string[]> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const info = await this.safeSdk.safe.getInfo();
    return info.modules ?? [];
  }

  /** Read whether a module is enabled on the Safe (standard Safe function). */
  async readIsModuleEnabled(moduleAddress: string): Promise<boolean> {
    const provider = this.getProvider();
    const contract = new window.ethers.Contract(
      this.safeInfo.safeAddress,
      ['function isModuleEnabled(address) view returns (bool)'],
      provider,
    );
    return await contract.isModuleEnabled(moduleAddress);
  }

  /**
   * Adopt freshly-created module addresses mid-flow. `initialize()` only
   * finds modules already in the Safe's module list; during a fresh init they
   * are deployed AFTER that snapshot, so recordsModule/publicationModule stay
   * null on this page and the live finish-poll's getRecord would keep throwing
   * ("Records module not initialized") until a reload. Once the init component
   * learns the addresses (detection or a resumed session) it hands them back
   * here: this re-creates the contract wrappers so getRecord and the live
   * finish detection work without a reload, and flips
   * hasRecordsModule/hasPublicationModule so the app switches to its normal
   * UI.
   */
  async adoptModules(recordsModule?: string, publicationModule?: string): Promise<void> {
    console.log(
      `[si] adoptModules r=${recordsModule ?? 'null'} p=${publicationModule ?? 'null'} (had r=${String(!!this.recordsModule)} p=${String(!!this.publicationModule)})`,
    );
    if (recordsModule && !this.recordsModule) {
      this.recordsModule = new window.ethers.Contract(
        recordsModule,
        Abi_S2SRecordsModule,
        this.getProvider(),
      );
      if (this.safeInfo) this.safeInfo.s2sRecords = recordsModule;
    }
    if (publicationModule && !this.publicationModule) {
      this.publicationModule = new window.ethers.Contract(
        publicationModule,
        Abi_S2SPublicationModuleV2,
        this.getProvider(),
      );
      if (this.safeInfo) this.safeInfo.s2sPublication = publicationModule;
    }
  }

  // ===== RECORDS MODULE METHODS =====

  async getAllRecords(): Promise<[string[], string[]]> {
    if (this.recordsModule) {
      return await this.recordsModule.getAllRecords();
    }
    throw new Error('Records module not initialized');
  }

  async getRecord(key: string): Promise<string> {
    if (!this.recordsModule) {
      throw new Error('Records module not initialized');
    }

    try {
      const value = await this.recordsModule.getRecord(key);
      console.log(`[si] getRecord('${key}') -> '${value}'`);
      return value;
    } catch (error) {
      console.error(`Error getting record for key "${key}":`, error);
      throw error;
    }
  }

  /**
   * The records module, or a clear error. Also enforces that the wrapper knows
   * its own address: `to:` comes from `target`, never from `safeInfo` (whose
   * s2sRecords could be '' while the module was known — the step-3 crash).
   */
  private requireRecordsModule(): EthersContract {
    const module = this.recordsModule;
    if (!module || !contractAddress(module)) {
      throw new Error('records module not found on this Safe');
    }
    return module;
  }

  /** Same contract for the publication module. */
  private requirePublicationModule(): any {
    const module = this.publicationModule;
    if (!module || !contractAddress(module)) {
      throw new Error('publication module not found on this Safe');
    }
    return module;
  }

  async setRecord(key: string, value: string): Promise<string> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const recordsModule = this.requireRecordsModule();

    const txData = recordsModule.interface.encodeFunctionData('setRecord', [key, value]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(recordsModule),
          value: '0',
          data: txData,
        },
      ],
    });

    const safeUrl = `https://app.safe.global/transactions/queue?safe=${this.safeInfo.chainId}:${this.safeInfo.safeAddress}`;

    console.log('Transaction proposed. Execute at:', safeUrl);

    return safeUrl;
  }

  async deleteRecord(key: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const recordsModule = this.requireRecordsModule();

    const txData = recordsModule.interface.encodeFunctionData('deleteRecord', [key]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(recordsModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  // ===== PUBLICATION MODULE — DEALS & OFFERS =====

  async makeOffer(genesis: string, cid: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();
    const txData = publicationModule.interface.encodeFunctionData('makeOffer', [
      toBytes32Id(genesis),
      cid,
    ]);
    await this.safeSdk.txs.send({
      txs: [{ to: contractAddress(publicationModule), value: '0', data: txData }],
    });
  }

  async acceptOffer(genesis: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();
    const txData = publicationModule.interface.encodeFunctionData('acceptOffer', [
      toBytes32Id(genesis),
    ]);
    await this.safeSdk.txs.send({
      txs: [{ to: contractAddress(publicationModule), value: '0', data: txData }],
    });
  }

  async retract(genesis: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();
    const txData = publicationModule.interface.encodeFunctionData('retract', [
      toBytes32Id(genesis),
    ]);
    await this.safeSdk.txs.send({
      txs: [{ to: contractAddress(publicationModule), value: '0', data: txData }],
    });
  }

  async hasDeal(genesis: string): Promise<boolean> {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.hasDeal(toBytes32Id(genesis));
  }

  async getDeals(
    offset = 0,
    limit = 50,
  ): Promise<
    Array<{
      genesis: string;
      author: string;
      cid: string;
      timestamp: bigint;
    }>
  > {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.getDeals(offset, limit);
  }

  async getOffers(
    offset = 0,
    limit = 50,
  ): Promise<
    Array<{
      genesis: string;
      author: string;
      cid: string;
      timestamp: bigint;
    }>
  > {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.getOffers(offset, limit);
  }

  async getAllDealsAndOffers(): Promise<{
    deals: Array<{
      genesis: string;
      author: string;
      cid: string;
      timestamp: bigint;
      status: 'deal';
    }>;
    offers: Array<{
      genesis: string;
      author: string;
      cid: string;
      timestamp: bigint;
      status: 'offer';
    }>;
  }> {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    try {
      const [rawDeals, rawOffers] = await Promise.all([
        this.publicationModule.getDeals(0, 200),
        this.publicationModule.getOffers(0, 200),
      ]);
      const deals = rawDeals.map((e: any) => ({
        genesis: e.genesis,
        author: e.author,
        cid: e.cid,
        timestamp: e.timestamp,
        status: 'deal' as const,
      }));
      const offers = rawOffers.map((e: any) => ({
        genesis: e.genesis,
        author: e.author,
        cid: e.cid,
        timestamp: e.timestamp,
        status: 'offer' as const,
      }));
      return { deals, offers };
    } catch (error) {
      console.error('Error getting deals and offers:', error);
      return { deals: [], offers: [] };
    }
  }

  // ===== PUBLICATION MODULE - WHITELISTS =====

  async whitelistAuthor(author: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('whitelistAuthor', [author]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async removeWhitelistedAuthor(author: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('removeWhitelistedAuthor', [
      author,
    ]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async whitelistDev(dev: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('whitelistDev', [dev]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async removeWhitelistedDev(dev: string): Promise<void> {
    if (!this.safeSdk) {
      throw new Error('Safe SDK not initialized');
    }
    const publicationModule = this.requirePublicationModule();

    const txData = publicationModule.interface.encodeFunctionData('removeWhitelistedDev', [dev]);

    await this.safeSdk.txs.send({
      txs: [
        {
          to: contractAddress(publicationModule),
          value: '0',
          data: txData,
        },
      ],
    });
  }

  async getWhitelistedAuthors(): Promise<string[]> {
    if (!this.publicationModule) {
      throw new Error('Publication module not initialized');
    }
    return await this.publicationModule.getWhitelistedAuthors();
  }

  async getWhitelistedDevs(): Promise<string[]> {
    if (!this.publicationModule) {
      throw new Error('Publication module not initialized');
    }
    return await this.publicationModule.getWhitelistedDevs();
  }

  async canPublish(address: string): Promise<boolean> {
    if (!this.publicationModule) {
      throw new Error('Publication module not initialized');
    }
    return await this.publicationModule.canPublish(address);
  }

  // ===== UTILITY =====

  getSafeInfo(): SafeInfo {
    return this.safeInfo;
  }

  isConnected(): boolean {
    return this.safeSdk !== null;
  }

  hasRecordsModule(): boolean {
    return this.recordsModule !== null;
  }

  hasPublicationModule(): boolean {
    return this.publicationModule !== null;
  }

  evmSetup(contractAddress: string, abi: any, chainId: number) {
    let provider;
    const url = getRpcUrl(chainId);

    switch (chainId) {
      case 1:
        provider = new window.ethers.JsonRpcProvider(url);
        break;

      case 8453:
        provider = new window.ethers.JsonRpcProvider(url);
        break;

      case 84532:
        provider = new window.ethers.JsonRpcProvider(url);
        break;
    }

    const contract = new window.ethers.Contract(contractAddress, abi, provider);

    return { provider, contract };
  }

  async evmRead(chainId: number, l2records: string, abi: any, method: string, args: any[]) {
    const { provider, contract } = this.evmSetup(l2records, abi, chainId);
    return await contract[method](...args);
  }

  async signWithSigner(message: string): Promise<string> {
    const provider = new window.ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    console.log('signer address', await signer.getAddress());
    return await signer.signMessage(message);
  }
}
