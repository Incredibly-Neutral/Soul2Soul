// src/lib/protocol-integration.ts

import type { EthersContract } from '@/types';
import SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { createPublicClient, http } from 'viem';
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
        
        const providerL1 = createPublicClient({
          chain: undefined,
          transport: http(this.getRpcUrl(1)),
        });
        const providerL2 = createPublicClient({
          chain: undefined,
          transport: http(this.getRpcUrl(8453)),
        });

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

    const apiKey = import.meta.env.VITE_DRPC_API_KEY || "default";

    switch (chainId) {
      case 1:
        rpc = `https://lb.drpc.live/ethereum/${apiKey}`;
        break;
      case 8453:
        rpc = `https://lb.drpc.live/base/${apiKey}`;
        break;
    }

    return rpc;
  }
}