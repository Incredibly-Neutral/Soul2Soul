// ============================================================================
// TxRunner adapters — the two execution modes the CLI needs (SPEC-hosts AD-1):
//
//   EoaRunner     — direct EOA transactions (viem wallet). Used for the author
//                   flows: upload / preview / publish / revoke. The publication
//                   Safe is the actor on chain only for `new`/module installs;
//                   author flows need just an EOA (genesisAuthor = EOA, INV-10),
//                   and makeOffer/retract are sent as plain txs from the owner.
//
//   SafeRunner    — ERC-4337 smart account via permissionless `toSafeSmartAccount`
//                   + Pimlico bundler/paymaster (all HTTP). Used for `new`:
//                   twin L1+L2 Safes (same salt → same address) execute the ENS
//                   registration (L1) and module installs (L2).
// ============================================================================

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createSmartAccountClient, type SmartAccountClient } from 'permissionless';
import { SafeSmartAccount, type ToSafeSmartAccountReturnType } from 'permissionless/accounts/safe';
import { createPimlicoClient, type PimlicoClient } from 'permissionless/clients/pimlico';
import {
  entryPoint06Address,
  entryPoint07Address,
} from 'viem/account-abstraction';

import type { TxCall, TxRunner } from '@s2s/soul2soul-shared';

import type { EntryPointVersion } from '../core/config';

/** Parse a JSON ABI string defensively. */
function parseAbi(abi: string): Abi {
  return JSON.parse(abi) as Abi;
}

// ===========================================================================
// EOA runner
// ===========================================================================

export interface EoaRunnerOptions {
  chain: Chain;
  rpcUrl: string;
  privateKey: Hex;
}

/**
 * Direct-EOA TxRunner. `updateSigner` swaps the signing account; `genericTx`
 * encodes calldata and sends it as a plain transaction from the EOA.
 * Deployments are unsupported (author flows never deploy).
 */
export function createEoaRunner(opts: EoaRunnerOptions): TxRunner {
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const wallet = createWalletClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  let account: PrivateKeyAccount = privateKeyToAccount(opts.privateKey);

  return {
    updateSigner: (pk: string): Promise<string> => {
      account = privateKeyToAccount(pk as Hex);
      return Promise.resolve(account.address);
    },
    connectToFreshSafe: (_salt: string): Promise<string> => Promise.resolve(account.address),
    connectToExistingSafe: (safeAddress: `0x${string}`): Promise<string> => Promise.resolve(safeAddress),
    genericRead: async (
      address: `0x${string}`,
      abi: string,
      method: string,
      args: unknown[],
    ): Promise<unknown> =>
      publicClient.readContract({
        address,
        abi: parseAbi(abi),
        functionName: method,
        args,
      }),
    genericTx: async (
      address: `0x${string}`,
      abi: string,
      method: string,
      args: unknown[],
      deploy: boolean,
    ): Promise<string> => {
      if (deploy) {
        throw new Error(
          'EOA runner does not support deployments; author flows never deploy contracts',
        );
      }
      const data = encodeFunctionData({ abi: parseAbi(abi), functionName: method, args });
      return wallet.sendTransaction({ account, to: address, data });
    },
    batchGenericTx: async (calls: TxCall[]): Promise<string[]> => {
      const hashes: string[] = [];
      for (const call of calls) {
        if (call.deploy) {
          throw new Error('EOA runner does not support deployments in batch calls');
        }
        const data = encodeFunctionData({
          abi: parseAbi(call.abi),
          functionName: call.method,
          args: call.args,
        });
        hashes.push(await wallet.sendTransaction({ account, to: call.address, data }));
      }
      return hashes;
    },
  };
}

// ===========================================================================
// Safe runner (permissionless smart account)
// ===========================================================================

export interface SafeRunnerOptions<
  TChain extends Chain = Chain,
  TEntry extends EntryPointVersion = EntryPointVersion,
> {
  chain: TChain;
  rpcUrl: string;
  /** EOA owner of the Safe. */
  privateKey: Hex;
  /** Pimlico (or any ERC-4337) bundler RPC URL. */
  bundlerUrl: string;
  /** Optional Pimlico paymaster RPC URL for gas sponsorship. */
  paymasterUrl: string | undefined;
  /** EntryPoint version the bundler serves. */
  entryPointVersion: TEntry;
  /** Safe proxy implementation version. */
  safeVersion: '1.4.1' | '1.5.0';
}

/** Deterministic salt-nonce from a human salt string (same on L1 and L2). */
export function saltNonceFor(salt: string): bigint {
  const hash = keccak256(toBytes(salt));
  return BigInt(hash) & BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
}

/**
 * ERC-4337 Safe TxRunner. `connectToFreshSafe` returns the counterfactual
 * address for a salt (the Safe is auto-deployed on the first userOp);
 * `connectToExistingSafe` re-targets an already-deployed Safe. `genericTx`
 * submits a userOp through the bundler (paymaster-sponsored when configured).
 */
export async function createSafeRunner<
  TChain extends Chain,
  TEntry extends EntryPointVersion,
>(
  opts: SafeRunnerOptions<TChain, TEntry>,
): Promise<TxRunner> {
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const entryPoint = {
    address: opts.entryPointVersion === '0.7' ? entryPoint07Address : entryPoint06Address,
    version: opts.entryPointVersion,
  } as const;

  let owner: PrivateKeyAccount = privateKeyToAccount(opts.privateKey);
  type SafeAccount = ToSafeSmartAccountReturnType<TEntry>;
  let smartAccount: SafeAccount;
  let client: SmartAccountClient | undefined;
  let paymaster: PimlicoClient<TEntry> | undefined;

  if (opts.paymasterUrl) {
    paymaster = createPimlicoClient({
      transport: http(opts.paymasterUrl),
      entryPoint: {
        address: entryPoint.address,
        version: entryPoint.version,
      },
    });
  }

  const rebuild = async (targetAddress?: Address, saltNonce?: bigint): Promise<string> => {
    smartAccount = await SafeSmartAccount.toSafeSmartAccount({
      client: publicClient,
      owners: [owner],
      version: opts.safeVersion,
      entryPoint,
      ...(targetAddress ? { address: targetAddress } : {}),
      ...(saltNonce !== undefined ? { saltNonce } : {}),
    });
    client = createSmartAccountClient({
      account: smartAccount,
      chain: opts.chain,
      bundlerTransport: http(opts.bundlerUrl),
      ...(paymaster ? { paymaster } : {}),
    });
    return smartAccount.address;
  };

  await rebuild();

  return {
    updateSigner: async (pk: string): Promise<string> => {
      owner = privateKeyToAccount(pk as Hex);
      return rebuild();
    },
    connectToFreshSafe: async (salt: string): Promise<string> => rebuild(undefined, saltNonceFor(salt)),
    connectToExistingSafe: async (safeAddress: `0x${string}`): Promise<string> =>
      rebuild(safeAddress),
    genericRead: async (
      address: `0x${string}`,
      abi: string,
      method: string,
      args: unknown[],
    ): Promise<unknown> =>
      publicClient.readContract({
        address,
        abi: parseAbi(abi),
        functionName: method,
        args,
      }),
    genericTx: async (
      address: `0x${string}`,
      abi: string,
      method: string,
      args: unknown[],
    ): Promise<string> => {
      if (!client) throw new Error('SafeRunner not initialised — call connect first');
      const data = encodeFunctionData({ abi: parseAbi(abi), functionName: method, args });
      return client.sendTransaction({ to: address, data } as never);
    },
    batchGenericTx: async (calls: TxCall[]): Promise<string[]> => {
      if (!client) throw new Error('SafeRunner not initialised — call connect first');
      const hashes: string[] = [];
      for (const call of calls) {
        const data = encodeFunctionData({
          abi: parseAbi(call.abi),
          functionName: call.method,
          args: call.args,
        });
        hashes.push(await client.sendTransaction({ to: call.address, data } as never));
      }
      return hashes;
    },
  };
}
