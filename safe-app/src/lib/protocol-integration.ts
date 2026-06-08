// src/lib/protocol-integration.ts

import type { EthersContract } from '@/types';
import SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { createPublicClient, http } from 'viem';
import { getProtocolInfo, S2SProtocolInfo } from '@s2s/soul2soul-shared/safe-app';
import { getRpcUrl } from './evm';

export class ProtocolIntegration {
  private safeSdk: SafeAppsSDK | null = null;
  public protocolInfo!: S2SProtocolInfo;

  async initialize(): Promise<S2SProtocolInfo | undefined> {
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
        
        const providerL1 = createPublicClient({
          chain: undefined,
          transport: http(getRpcUrl(1)),
        });
        const providerL2 = createPublicClient({
          chain: undefined,
          transport: http(getRpcUrl(8453)),
        });

        this.protocolInfo  = await getProtocolInfo(false, providerL1, providerL2);

        return this.protocolInfo;

    } catch (error) {
      console.error('Failed to initialize Safe SDK:', error);
      return undefined;
    }
  }

  getInfo(): S2SProtocolInfo {

      return this.protocolInfo; 
  }


  isConnected(): boolean {
    return this.safeSdk !== null;
  }
}