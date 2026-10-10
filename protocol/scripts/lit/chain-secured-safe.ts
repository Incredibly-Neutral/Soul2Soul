/**
 * chain-secured-safe.ts — Safe proposal + on-chain helpers for the ChainSecured
 * Lit re-provision, reusing the EXACT mechanism from update-protocol.ts
 * (@safe-global/protocol-kit Safe + @safe-global/api-kit SafeApiKit;
 * protocolKit.createTransaction({ transactions }) batch of {to,value,data};
 * signHash; apiKit.proposeTransaction; chainId 8453n).
 *
 * This module lives in protocol/ (not shared/) because the @safe-global kits are
 * protocol deps — the shared chain-secured client (shared/src/lit/chain-secured.ts)
 * stays viem-only and builds the batches; this module pushes them to the Safe.
 */
import Safe from '@safe-global/protocol-kit';
import SafeApiKit from '@safe-global/api-kit';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { base } from 'viem/chains';
import {
  ACCOUNT_CONFIG_DIAMOND,
  ACCOUNT_CONFIG_EVENTS,
  WRITES_FACET_ABI,
  type ChainSecuredSafeTransaction,
} from '@s2s/soul2soul-shared';

export interface ProposeToSafeParams {
  /** Batch built by buildReProvisionBatch / buildSwapActionBatch / … */
  transactions: ChainSecuredSafeTransaction[];
  /** The protocol Safe (PROTOCOL_SAFE_ADDRESS). */
  safeAddress: string;
  /** Safe owner EOA private key (PROTOCOL_PRIVATE_KEY; 0x-prefix optional). */
  signerPrivateKey: string;
  /** Base mainnet. */
  chainId?: bigint;
  /** Base RPC URL (e.g. https://lb.drpc.live/base/<key> or https://mainnet.base.org). */
  rpcUrl: string;
}

/**
 * Propose a Safe batch to the Safe Transaction Service (Base 8453).
 * Mirrors update-protocol.ts's proposeToSafe 1:1 — one owner signature from
 * PROTOCOL_PRIVATE_KEY; the remaining owners must still confirm in the Safe UI.
 * @returns the Safe Tx Hash (string).
 */
export async function proposeToSafe(params: ProposeToSafeParams): Promise<string> {
  const { transactions, safeAddress, signerPrivateKey, chainId = 8453n, rpcUrl } = params;

  const protocolKit = await Safe.init({
    provider: rpcUrl,
    signer: signerPrivateKey,
    safeAddress,
  });

  const apiKit = new SafeApiKit({ chainId });

  const safeTransaction = await protocolKit.createTransaction({ transactions });
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const senderSignature = await protocolKit.signHash(safeTxHash);

  const normalizedKey = signerPrivateKey.startsWith('0x')
    ? (signerPrivateKey as `0x${string}`)
    : (`0x${signerPrivateKey}` as `0x${string}`);
  const senderAddress = privateKeyToAccount(normalizedKey).address;

  await apiKit.proposeTransaction({
    safeAddress,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress,
    senderSignature: senderSignature.data,
  });

  console.log('✅ Transaction proposed to Safe');
  console.log('Safe Tx Hash:', safeTxHash);
  return safeTxHash;
}

export interface SimulateAddGroupParams {
  rpcUrl: string;
  /** Simulate from the Safe so msg.sender == admin for the chain-secured check. */
  safeAddress: Address | string;
  accountApiKeyHash: bigint;
  name: string;
  description: string;
  cidHashes: bigint[];
  pkpIds: Address[];
}

/**
 * Simulate `addGroup` (eth_call) to resolve the group id the new group WILL get
 * before the batch is proposed — the SDK does the same via staticCall and uses
 * the simulated return value for addActionToGroup / setUsageApiKey scoping.
 * @returns the new 1-based group id (first group on a fresh account = 1).
 */
export async function simulateAddGroup(params: SimulateAddGroupParams): Promise<bigint> {
  const { rpcUrl, safeAddress, accountApiKeyHash, name, description, cidHashes, pkpIds } = params;
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const data = encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'addGroup',
    args: [accountApiKeyHash, name, description, cidHashes, pkpIds],
  });
  const { data: result } = await client.call({
    account: safeAddress as Address,
    to: ACCOUNT_CONFIG_DIAMOND,
    data,
  });
  if (!result) {
    throw new Error('addGroup simulation returned no data');
  }
  return decodeFunctionResult({
    abi: WRITES_FACET_ABI,
    functionName: 'addGroup',
    data: result,
  });
}

export interface ResolveGroupIdFromSafeExecutionParams {
  safeTxHash: string;
  safeAddress: string;
  /** The accountApiKeyHash used in the batch (GroupAdded is indexed by it). */
  accountApiKeyHash: bigint;
  chainId?: bigint;
  rpcUrl: string;
}

export interface ResolvedExecution {
  executed: boolean;
  /** True if executed and a matching GroupAdded(accountApiKeyHash, …) was found. */
  groupId: bigint | null;
  executionTxHash: string | null;
  message: string;
}

/**
 * After the Safe executes the re-provision batch, find the real group id from
 * the addGroup receipt's GroupAdded event (NOT hardcoded). Uses the Safe
 * Transaction Service to resolve the proposal → execution tx hash, then parses
 * the receipt on Base for GroupAdded(accountApiKeyHash, groupId).
 */
export async function resolveGroupIdFromSafeExecution(
  params: ResolveGroupIdFromSafeExecutionParams,
): Promise<ResolvedExecution> {
  const { safeTxHash, safeAddress, accountApiKeyHash, chainId = 8453n, rpcUrl } = params;
  const apiKit = new SafeApiKit({ chainId });
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const safeTx = await apiKit.getSafeMultisigTransaction(safeTxHash);
  if (!safeTx.isExecuted || !safeTx.executionTxHash) {
    return {
      executed: false,
      groupId: null,
      executionTxHash: null,
      message:
        'Safe transaction not executed yet — confirm the proposal in the Safe UI, then re-run with --finalize.',
    };
  }

  const receipt = await client.getTransactionReceipt({
    hash: safeTx.executionTxHash as Hex,
  });
  const events = parseGroupAdded(receipt.logs as Log[]);
  const match = events.find((e) => e.args.apiKeyHash === accountApiKeyHash);
  if (!match) {
    return {
      executed: true,
      groupId: null,
      executionTxHash: safeTx.executionTxHash,
      message: `Executed (${safeTx.executionTxHash}) but no GroupAdded found for this account — check the batch.`,
    };
  }
  return {
    executed: true,
    groupId: match.args.groupId,
    executionTxHash: safeTx.executionTxHash,
    message: `Group created on-chain: group id ${match.args.groupId} (tx ${safeTx.executionTxHash}).`,
  };
}

function parseGroupAdded(logs: Log[]): { args: { apiKeyHash: bigint; groupId: bigint } }[] {
  return parseEventLogs({
    abi: ACCOUNT_CONFIG_EVENTS,
    logs,
  }) as { args: { apiKeyHash: bigint; groupId: bigint } }[];
}
