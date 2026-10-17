// src/lib/safe-integration.ts
import { Abi_S2SPublicationModuleV2 } from '../../../protocol/generated/abis/S2SPublicationModuleV2'
import { Abi_S2SRecordsModule } from '../../../protocol/generated/abis/S2SRecordsModule'

import { toBytes32Id } from '@s2s/soul2soul-shared';
 
import type { SafeInfo, EthersContract } from '@/types';
import SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { SafeAppProvider } from '@safe-global/safe-apps-provider';
import { getRpcUrl } from './evm';

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
    modules: [] 
  };

  async initialize(): Promise<SafeInfo> {
    try {
      if (typeof SafeAppsSDK === 'undefined') {
        throw new Error('SafeAppsSDK not available');
      }

      const opts = {
        allowedDomains: [/app\.safe\.global$/],
        debug: false
      };

      this.safeSdk = new SafeAppsSDK(opts);
      const safeData: any = await this.safeSdk!.safe.getInfo();
      
      this.safeInfo = {
        safeAddress: safeData.safeAddress,
        s2sRecords: '',
        s2sPublication: '',
        chainId: safeData.chainId,
        network: safeData.network,
        modules: safeData.modules,
        owners: safeData.owners,
        threshold: safeData.threshold
      };

      const rpcUrl = getRpcUrl(this.safeInfo!.chainId);
      const provider = new window.ethers.JsonRpcProvider(rpcUrl);

      // Find both modules
      const NAME_ABI = [
        "function NAME() view returns (string)"
      ];

      for (const moduleAddress of this.safeInfo.modules) {
        try {
          // Check for NAME function with minimal ABI
          const moduleChecker = new window.ethers.Contract(
            moduleAddress,
            NAME_ABI,
            provider
          );
          
          const name = await moduleChecker.NAME();
          console.log(`Module ${moduleAddress} has NAME:`, name);
          
          if (name === "S2S Records Module") {
            // Create full contract instance with complete ABI
            this.recordsModule = new window.ethers.Contract(
              moduleAddress,
              Abi_S2SRecordsModule,
              provider
            );
            this.safeInfo.s2sRecords = moduleAddress;
            console.log("Found Records Module:", moduleAddress);
            
          } else if ( name === "S2S Publication Module V2" ) {

            // Create full contract instance with complete ABI
            this.publicationModule = new window.ethers.Contract(
              moduleAddress,
              Abi_S2SPublicationModuleV2,
              provider
            );
            this.safeInfo.s2sPublication = moduleAddress;
            console.log("Found Publication Module:", moduleAddress);
          }
          
        } catch (error) {
          // Module doesn't have NAME() function, skip it
          console.log(`Module ${moduleAddress} doesn't have NAME(), skipping`);
        }
      }

      return this.safeInfo;
    } catch (error) {
      console.error('Failed to initialize Safe SDK:', error);
      return this.safeInfo;
    }
  }

  // ===== GENERIC SAFE PRIMITIVES (module-install / init flow, SPEC-hosts AD-3) =====
  // These are runtime-agnostic Safe-side building blocks. The orchestration
  // layer (publication-init) injects them as deps and never imports this file's
  // host internals.

  /**
   * Propose an arbitrary batch of txs to the Safe for owner confirmation.
   * Used to install the records + publication modules in a single proposal
   * (SPEC-hosts AD-3 step 3). Returns the Safe UI queue URL.
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
   * Fetch raw factory `ModuleCreated` logs for a given safe address.
   * topic[1] is the padded indexed safe address (bytes32). Returns the raw
   * log objects, which carry `.topics`.
   */
  async fetchFactoryModuleCreatedLogs(
    factoryAddress: string,
    safeAddress: string,
    topic0: string,
    fromBlock: number
  ): Promise<Array<{ topics: string[] }>> {
    const provider = this.getProvider();
    const paddedSafe =
      '0x' + safeAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    return await provider.getLogs({
      address: factoryAddress,
      topics: [topic0, paddedSafe],
      fromBlock,
      toBlock: 'latest',
    });
  }

  /** Read whether a module is enabled on the Safe (standard Safe function). */
  async readIsModuleEnabled(moduleAddress: string): Promise<boolean> {
    const provider = this.getProvider();
    const contract = new window.ethers.Contract(
      this.safeInfo.safeAddress,
      ['function isModuleEnabled(address) view returns (bool)'],
      provider
    );
    return await contract.isModuleEnabled(moduleAddress);
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
      return await this.recordsModule.getRecord(key);
    } catch (error) {
      console.error(`Error getting record for key "${key}":`, error);
      throw error;
    }
  }

  async setRecord(key: string, value: string): Promise<string> {
    if (!this.safeSdk || !this.recordsModule) {
      throw new Error('Safe SDK or records module not initialized');
    }

    const txData = this.recordsModule.interface.encodeFunctionData('setRecord', [key, value]);
    
    await this.safeSdk.txs.send({
      txs: [{
        to: this.safeInfo.s2sRecords!,
        value: '0',
        data: txData
      }]
    });

    const safeUrl = `https://app.safe.global/transactions/queue?safe=${this.safeInfo.chainId}:${this.safeInfo.safeAddress}`;
    
    console.log('Transaction proposed. Execute at:', safeUrl);
    
    return safeUrl;
  }

  async deleteRecord(key: string): Promise<void> {
    if (!this.safeSdk || !this.recordsModule) {
      throw new Error('Safe SDK or records module not initialized');
    }

    const txData = this.recordsModule.interface.encodeFunctionData('deleteRecord', [key]);
    
    await this.safeSdk.txs.send({
      txs: [{
        to: this.safeInfo.s2sRecords!,
        value: '0',
        data: txData
      }]
    });
  }

  // ===== PUBLICATION MODULE — DEALS & OFFERS =====

  async makeOffer(genesis: string, cid: string): Promise<void> {
    if (!this.safeSdk || !this.publicationModule) {
      throw new Error('Safe SDK or publication module not initialized');
    }
    const txData = this.publicationModule.interface.encodeFunctionData(
      'makeOffer', [toBytes32Id(genesis), cid]
    );
    await this.safeSdk.txs.send({
      txs: [{ to: this.safeInfo.s2sPublication!, value: '0', data: txData }]
    });
  }

  async acceptOffer(genesis: string): Promise<void> {
    if (!this.safeSdk || !this.publicationModule) {
      throw new Error('Safe SDK or publication module not initialized');
    }
    const txData = this.publicationModule.interface.encodeFunctionData(
      'acceptOffer', [toBytes32Id(genesis)]
    );
    await this.safeSdk.txs.send({
      txs: [{ to: this.safeInfo.s2sPublication!, value: '0', data: txData }]
    });
  }

  async retract(genesis: string): Promise<void> {
    if (!this.safeSdk || !this.publicationModule) {
      throw new Error('Safe SDK or publication module not initialized');
    }
    const txData = this.publicationModule.interface.encodeFunctionData(
      'retract', [toBytes32Id(genesis)]
    );
    await this.safeSdk.txs.send({
      txs: [{ to: this.safeInfo.s2sPublication!, value: '0', data: txData }]
    });
  }

  async hasDeal(genesis: string): Promise<boolean> {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.hasDeal(toBytes32Id(genesis));
  }

  async getDeals(offset = 0, limit = 50): Promise<Array<{
    genesis: string; author: string; cid: string; timestamp: bigint;
  }>> {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.getDeals(offset, limit);
  }

  async getOffers(offset = 0, limit = 50): Promise<Array<{
    genesis: string; author: string; cid: string; timestamp: bigint;
  }>> {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    return await this.publicationModule.getOffers(offset, limit);
  }

  async getAllDealsAndOffers(): Promise<{
    deals: Array<{ genesis: string; author: string; cid: string; timestamp: bigint; status: 'deal' }>;
    offers: Array<{ genesis: string; author: string; cid: string; timestamp: bigint; status: 'offer' }>;
  }> {
    if (!this.publicationModule) throw new Error('Publication module not initialized');
    try {
      const [rawDeals, rawOffers] = await Promise.all([
        this.publicationModule.getDeals(0, 200),
        this.publicationModule.getOffers(0, 200),
      ]);
      const deals = rawDeals.map((e: any) => ({
        genesis: e.genesis, author: e.author, cid: e.cid, timestamp: e.timestamp, status: 'deal' as const,
      }));
      const offers = rawOffers.map((e: any) => ({
        genesis: e.genesis, author: e.author, cid: e.cid, timestamp: e.timestamp, status: 'offer' as const,
      }));
      return { deals, offers };
    } catch (error) {
      console.error('Error getting deals and offers:', error);
      return { deals: [], offers: [] };
    }
  }

  // ===== PUBLICATION MODULE - WHITELISTS =====
  
  async whitelistAuthor(author: string): Promise<void> {
    if (!this.safeSdk || !this.publicationModule) {
      throw new Error('Safe SDK or publication module not initialized');
    }

    const txData = this.publicationModule.interface.encodeFunctionData('whitelistAuthor', [author]);
    
    await this.safeSdk.txs.send({
      txs: [{
        to: this.safeInfo.s2sPublication!,
        value: '0',
        data: txData
      }]
    });
  }

  async removeWhitelistedAuthor(author: string): Promise<void> {
    if (!this.safeSdk || !this.publicationModule) {
      throw new Error('Safe SDK or publication module not initialized');
    }

    const txData = this.publicationModule.interface.encodeFunctionData('removeWhitelistedAuthor', [author]);
    
    await this.safeSdk.txs.send({
      txs: [{
        to: this.safeInfo.s2sPublication!,
        value: '0',
        data: txData
      }]
    });
  }

  async whitelistDev(dev: string): Promise<void> {
    if (!this.safeSdk || !this.publicationModule) {
      throw new Error('Safe SDK or publication module not initialized');
    }

    const txData = this.publicationModule.interface.encodeFunctionData('whitelistDev', [dev]);
    
    await this.safeSdk.txs.send({
      txs: [{
        to: this.safeInfo.s2sPublication!,
        value: '0',
        data: txData
      }]
    });
  }

  async removeWhitelistedDev(dev: string): Promise<void> {
    if (!this.safeSdk || !this.publicationModule) {
      throw new Error('Safe SDK or publication module not initialized');
    }

    const txData = this.publicationModule.interface.encodeFunctionData('removeWhitelistedDev', [dev]);
    
    await this.safeSdk.txs.send({
      txs: [{
        to: this.safeInfo.s2sPublication!,
        value: '0',
        data: txData
      }]
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

    switch(chainId) {
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

    const contract = new window.ethers.Contract(
      contractAddress,
      abi,
      provider
    );

    return { provider, contract };
  }

  async evmRead(chainId: number, l2records: string, abi: any, method: string, args: any[]) { 
    const { provider, contract } = this.evmSetup(l2records, abi, chainId);
    return await contract[method](...args);
  }

  async signWithSigner (message: string): Promise<string>{
    const provider = new window.ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    console.log("signer address", await signer.getAddress());
    return await signer.signMessage(message);
  }
}