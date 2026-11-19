// src/lib/protocol-integration.ts

import type { EthersContract } from '@/types';
import SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { createPublicClient, http } from 'viem';
import { getManifest, S2SManifest } from '@s2s/soul2soul-shared/safe-app';
import { getRpcUrl } from './evm';

export class ProtocolIntegration {
  private safeSdk: SafeAppsSDK | null = null;
  private providerL1: any = null;
  private providerL2: any = null;
  public protocolInfo!: S2SManifest;

  async initialize(): Promise<S2SManifest | undefined> {
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
        
        this.providerL1 = createPublicClient({
          chain: undefined,
          transport: http(getRpcUrl(1)),
        });
        this.providerL2 = createPublicClient({
          chain: undefined,
          transport: http(getRpcUrl(8453)),
        });

        // The current document, because the module factory it carries is what
        // finds the publication's records at all. A publication that pins a
        // version is read again below, once the records are in (see load).
        this.protocolInfo = await getManifest(this.providerL1, this.providerL2);

        return this.protocolInfo;

    } catch (error) {
      console.error('Failed to initialize Safe SDK:', error);
      return undefined;
    }
  }

  getInfo(): S2SManifest {

      return this.protocolInfo; 
  }

  /**
   * The document a publication pinned, by version. `getManifest(version)` reads
   * that snapshot and never falls back to the current document, so a pin at a
   * version the module does not hold throws instead of running other code.
   */
  async load(version: string): Promise<S2SManifest> {
      if (!this.providerL1 || !this.providerL2) {
          throw new Error('ProtocolIntegration.load before initialize');
      }
      this.protocolInfo = await getManifest(this.providerL1, this.providerL2, version);
      return this.protocolInfo;
  }


  isConnected(): boolean {
    return this.safeSdk !== null;
  }
}