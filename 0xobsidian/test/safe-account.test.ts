/**
 * PermissionlessSafeService — address derivation and deployment test.
 *
 * Verifies that toSafeSmartAccount produces the same counterfactual
 * address given the same owner key + salt, and that isDeployed()
 * returns false before any user operation is sent.
 *
 * Required env vars (loaded from ../.env by vitest.setup.ts):
 *   VITE_DRPC_API_KEY    DRPC key for the Base mainnet endpoint
 *   TEST_PRIVATE_KEY     A hex private key for test EOA derivation
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { PermissionlessSafeService } from '../src/eth/permissionless.safe.service.js';

type MockMain = {
  plugin: {
    settings: {
      rpc_key: string;
      pimlico_key: string;
    };
  };
};

describe('PermissionlessSafeService', () => {
  const rpcKey = process.env.VITE_DRPC_API_KEY;
  const testPk = process.env.TEST_PRIVATE_KEY;
  const chainName = 'BASE';
  const testSalt = 's2s_test_author_vitest';

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

    eoa = privateKeyToAccount(testPk as `0x${string}`).address;
  });

  describe('address derivation', () => {
    it('should derive the same address given the same owner key and salt', async () => {
      if (!ready) return;

      const mock: MockMain = {
        plugin: {
          settings: {
            rpc_key: rpcKey!,
            pimlico_key: 'dummy',
          },
        },
      };

      const svc1 = new PermissionlessSafeService(mock as any, chainName);
      await svc1.updateSigner(testPk!);
      const addr1 = await svc1.connectToFreshSafe(testSalt);

      const svc2 = new PermissionlessSafeService(mock as any, chainName);
      await svc2.updateSigner(testPk!);
      const addr2 = await svc2.connectToFreshSafe(testSalt);

      // Same owner + same salt → same counterfactual Safe address
      expect(addr2).toBe(addr1);
    });

    it('should derive different addresses for different salts', async () => {
      if (!ready) return;

      const mock: MockMain = {
        plugin: {
          settings: {
            rpc_key: rpcKey!,
            pimlico_key: 'dummy',
          },
        },
      };

      const svc = new PermissionlessSafeService(mock as any, chainName);
      await svc.updateSigner(testPk!);
      const addr1 = await svc.connectToFreshSafe('salt_a');
      const addr2 = await svc.connectToFreshSafe('salt_b');

      expect(addr2).not.toBe(addr1);
    });
  });

  describe('signer', () => {
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

      const svc = new PermissionlessSafeService(mock as any, chainName);
      const signerAddress = await svc.updateSigner(testPk!);

      expect(signerAddress.toLowerCase()).toBe(eoa.toLowerCase());
    });
  });

  describe('deployment status', () => {
    it('should return false from isDeployed() for a counterfactual address', async () => {
      if (!ready) return;

      const mock: MockMain = {
        plugin: {
          settings: {
            rpc_key: rpcKey!,
            pimlico_key: 'dummy',
          },
        },
      };

      const svc = new PermissionlessSafeService(mock as any, chainName);
      await svc.updateSigner(testPk!);
      await svc.connectToFreshSafe(testSalt);

      // Counterfactual address — not deployed until first userOp
      const deployed = await svc.isDeployed();
      expect(deployed).toBe(false);
    });
  });
});