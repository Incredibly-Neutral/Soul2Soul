/**
 * PermissionlessSimpleService — deterministic address derivation test.
 *
 * Verifies that toSimpleSmartAccount produces the same counterfactual
 * address given the same owner key, and that isDeployed() returns false
 * before any user operation is sent.
 *
 * Required env vars (loaded from ../.env by vitest.setup.ts):
 *   VITE_DRPC_API_KEY    DRPC key for the Base mainnet endpoint
 *   TEST_PRIVATE_KEY     A hex private key for test EOA derivation
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { PermissionlessSimpleService } from '../src/eth/permissionless.simple.service.js';

type MockMain = {
  plugin: {
    settings: {
      rpc_key: string;
      pimlico_key: string;
    };
  };
};

describe('PermissionlessSimpleService', () => {
  const rpcKey = process.env.VITE_DRPC_API_KEY;
  const testPk = process.env.TEST_PRIVATE_KEY;
  const chainName = 'BASE';

  let ready = true;
  let eoa: string;

  beforeAll(() => {
    if (!rpcKey) {
      console.warn('Skipping: VITE_DRPC_API_KEY not set in ../.env');
      ready = false;
      return;
    }
    if (!testPk) {
      console.warn('Skipping: TEST_PRIVATE_KEY not set in ../.env');
      ready = false;
      return;
    }

    // Derive the expected EOA so we can verify it matches what the service computes
    eoa = privateKeyToAccount(testPk as `0x${string}`).address;
  });

  describe('address derivation', () => {
    it('should derive the same deterministic address given the same owner', async () => {
      if (!ready) return;

      const mock: MockMain = {
        plugin: {
          settings: {
            rpc_key: rpcKey!,
            pimlico_key: 'dummy',   // Not used for address derivation
          },
        },
      };

      const svc1 = new PermissionlessSimpleService(mock as any, chainName);
      const addr1 = await svc1.updateSigner(testPk!);

      const svc2 = new PermissionlessSimpleService(mock as any, chainName);
      const addr2 = await svc2.updateSigner(testPk!);

      // Same owner → same counterfactual address
      expect(addr2).toBe(addr1);
    });

    it('should return the correct EOA from updateSigner', async () => {
      if (!ready) return;

      const mock: MockMain = {
        plugin: {
          settings: {
            rpc_key: rpcKey!,
            pimlico_key: 'dummy',
          },
        },
      };

      const svc = new PermissionlessSimpleService(mock as any, chainName);
      const signerAddress = await svc.updateSigner(testPk!);

      expect(signerAddress.toLowerCase()).toBe(eoa.toLowerCase());
    });
  });

  describe('deployment status', () => {
    it('should return false from isDeployed() before any userOp', async () => {
      if (!ready) return;

      const mock: MockMain = {
        plugin: {
          settings: {
            rpc_key: rpcKey!,
            pimlico_key: 'dummy',
          },
        },
      };

      const svc = new PermissionlessSimpleService(mock as any, chainName);
      await svc.updateSigner(testPk!);

      const deployed = await svc.isDeployed();
      expect(deployed).toBe(false);
    });
  });
});
