// ============================================================================
// TxRunner adapters — the two execution modes the CLI needs (SPEC-author-hosts AD-1):
//
//   EoaRunner     — direct EOA transactions (viem wallet). Signs and pays, and
//                   is used for READS. It is deliberately NOT used for author
//                   writes (`makeOffer`/`retract`): the on-chain author is the
//                   author Safe, so those go through the SafeRunner. The
//                   earlier note here claimed "author flows need just an EOA
//                   (genesisAuthor = EOA, INV-10)" — that is wrong against the
//                   deployed module, which raises OnlySafe() for a first append
//                   from anyone that is neither the publication Safe nor
//                   whitelisted, and refuses an existing genesis from anyone
//                   but its genesisAuthor.
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

/**
 * The words of a thrown error, in the order viem and the bundler put them:
 * `shortMessage` first (it is the human half), then `details`, then `message`.
 */
function errorText(err: unknown): string {
  const seen: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const record = current as Record<string, unknown>;
    for (const field of ['shortMessage', 'details', 'message'] as const) {
      const value = record[field];
      if (typeof value === 'string' && value.trim() !== '' && !seen.includes(value)) {
        seen.push(value);
      }
    }
    current = record.cause;
  }
  return seen.join(': ') || 'no detail from the bundler';
}

/**
 * The bundler or paymaster refused the userOp: it was never submitted, so
 * retrying cannot execute it twice.
 */
export class SponsoredSendRefused extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SponsoredSendRefused';
  }
}

/**
 * The userOp was submitted — a userOp hash exists — and its receipt was not
 * seen. It may have landed: a retry could execute the call twice.
 */
export class SponsoredSendUncertain extends Error {
  readonly userOpHash: Hex;

  constructor(message: string, userOpHash: Hex, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SponsoredSendUncertain';
    this.userOpHash = userOpHash;
  }
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
  /**
   * Safe singleton + proxy factory. Leave undefined to use the library's
   * defaults *for that version* — which are NOT the addresses 0xobsidian uses:
   * it pins the SafeL2 v1.4.1 singleton (0x29fc…) while permissionless defaults
   * to the L1 singleton (0x4167…) for 1.4.1. The singleton is part of the
   * CREATE2 input, so getting this wrong changes the Safe address.
   */
  safeSingletonAddress?: Address;
  safeProxyFactoryAddress?: Address;
}

/**
 * Deterministic salt-nonce from a human salt string (same on L1 and L2).
 * Mirrors 0xobsidian's `PermissionlessSafeService`: the full unmasked keccak
 * of the salt. Masking any bits changes the CREATE2 input and therefore the
 * counterfactual address, so the CLI and the plugin must agree exactly.
 */
export function saltNonceFor(salt: string): bigint {
  return BigInt(keccak256(toBytes(salt)));
}

/**
 * ERC-4337 Safe TxRunner. `connectToFreshSafe` returns the counterfactual
 * address for a salt (the Safe is auto-deployed on the first userOp);
 * `connectToExistingSafe` re-targets an already-deployed Safe. `genericTx`
 * submits a userOp through the bundler (paymaster-sponsored when configured).
 */
export interface SafeRunnerHandle extends TxRunner {
  /** The counterfactual (not yet deployed) or connected Safe address. */
  address(): Address;
  /** Whether bytecode exists at the Safe address. */
  isDeployed(): Promise<boolean>;
  /**
   * Deploy the counterfactual Safe by sending a self-call userOp — the Safe
   * factory runs in the userOp's initCode. Returns the **on-chain transaction
   * hash**, like `sendCall`: permissionless' `sendTransaction` waits for the
   * userOp receipt and returns `receipt.transactionHash`, never the userOp hash.
   */
  deploy(): Promise<string>;
  /**
   * Send one raw call as a userOp and resolve with the **on-chain transaction
   * hash** once the userOp's receipt is in (permissionless' `sendTransaction`
   * waits for it; the userOp hash is not returned). `genericTx` encodes from an
   * ABI; this takes calldata the caller already has, such as a Safe's
   * `execTransaction`, and can address the Safe itself.
   *
   * A failure is phase-tagged, because the caller's advice depends on it: a
   * throw from submission is `SponsoredSendRefused` (nothing landed, retrying is
   * safe), a throw while waiting for the receipt is `SponsoredSendUncertain`
   * (the userOp hash exists, the outcome does not).
   */
  sendCall(to: Address, data: Hex): Promise<Hex>;
}

export async function createSafeRunner<
  TChain extends Chain,
  TEntry extends EntryPointVersion,
>(
  opts: SafeRunnerOptions<TChain, TEntry>,
): Promise<SafeRunnerHandle> {
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
      ...(opts.safeSingletonAddress ? { safeSingletonAddress: opts.safeSingletonAddress } : {}),
      ...(opts.safeProxyFactoryAddress
        ? { safeProxyFactoryAddress: opts.safeProxyFactoryAddress }
        : {}),
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

  /**
   * Fee overrides for a userOp. With a paymaster, viem asks for paymaster stub
   * data *before* gas estimation and omits maxFeePerGas/maxPriorityFeePerGas
   * from that request — Pimlico's schema rejects the call then ("method does
   * not exist" with a zod detail naming maxFeePerGas). 0xobsidian sidesteps it
   * by passing explicit gas prices on every send; do the same. Without a
   * paymaster the normal estimation path works, so add nothing.
   */
  const feeOverrides = async (): Promise<{
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }> => {
    if (!paymaster) return {};
    const gasPrice = await paymaster.getUserOperationGasPrice();
    return {
      maxFeePerGas: gasPrice.fast.maxFeePerGas,
      maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas,
    };
  };

  return {
    address: (): Address => smartAccount.address,
    isDeployed: async (): Promise<boolean> => {
      const code = await publicClient.getBytecode({ address: smartAccount.address });
      return code !== undefined && code !== '0x' && code.length > 2;
    },
    deploy: async (): Promise<string> => {
      if (!client) throw new Error('SafeRunner not initialised — call connect first');
      return client.sendTransaction({
        to: smartAccount.address,
        data: '0x',
        value: 0n,
        ...(await feeOverrides()),
      } as never);
    },
    sendCall: async (to: Address, data: Hex): Promise<Hex> => {
      if (!client) throw new Error('SafeRunner not initialised — call connect first');
      // Two phases, and they mean different things to whoever retries: the
      // bundler validates and simulates before it accepts a userOp, so a throw
      // here is "nothing was submitted", while a throw after the hash exists is
      // "submitted, receipt not seen". Collapsing them into one error is what
      // makes a retry that could execute twice look safe.
      let fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
      let userOpHash: Hex;
      try {
        fees = await feeOverrides();
        userOpHash = await client.sendUserOperation({ to, data, ...fees } as never);
      } catch (err) {
        throw new SponsoredSendRefused(errorText(err), { cause: err });
      }
      try {
        const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
        return receipt.receipt.transactionHash;
      } catch (err) {
        throw new SponsoredSendUncertain(errorText(err), userOpHash, { cause: err });
      }
    },
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
      return client.sendTransaction({ to: address, data, ...(await feeOverrides()) } as never);
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
        hashes.push(
          await client.sendTransaction({
            to: call.address,
            data,
            ...(await feeOverrides()),
          } as never),
        );
      }
      return hashes;
    },
  };
}
