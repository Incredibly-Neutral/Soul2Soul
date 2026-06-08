// src/lib/protocol-integration.ts

import type { EthersContract } from '@/types';
import SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { getProtocolInfo, S2SProtocolInfo } from '@s2s/soul2soul-shared/safe-app';

export class ProtocolIntegration {
  private safeSdk: SafeAppsSDK | null = null;
  private protocolInfo!: S2SProtocolInfo;

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
        
        const providerL1 = new window.ethers.JsonRpcProvider(this.getRpcUrl(1));
        const providerL2 = new window.ethers.JsonRpcProvider(this.getRpcUrl(8453));

        this.protocolInfo  = await getProtocolInfo(false, providerL1, providerL2);

        return this.protocolInfo;

    } catch (error) {
      console.error('Failed to initialize Safe SDK:', error);
      return undefined;
    }
  }


  isConnected(): boolean {
    return this.safeSdk !== null;
  }


  getRpcUrl(chainId: number): string {
    let rpc = '';

    switch (chainId) {
      case 1:
        rpc = `https://rpc.ankr.com/eth`;
        break;
      case 8453:
        rpc = 'https://mainnet.base.org';
        break;
    }

    return rpc;
  }
}