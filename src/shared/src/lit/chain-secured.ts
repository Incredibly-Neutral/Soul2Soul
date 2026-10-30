/**
 * Chain-secured (sovereign) Lit client for the s2s monorepo.
 *
 * The s2s Lit account is a CHAIN-SECURED Lit account: its on-chain admin is the
 * Gnosis Safe 0x24936f87442673B7c057BF3f5dCCB726baF20c6B (= PROTOCOL_SAFE_ADDRESS)
 * on Base mainnet (chain_id 8453). Chain-secured accounts have NO account API key
 * and NO admin REST auth: every admin write is a wallet-signed transaction to the
 * AccountConfig diamond 0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa, signed by the
 * Safe (msg.sender == adminWalletAddress).
 *
 * This module is the sovereign counterpart of the API-mode `LitService` in
 * ./lit.service.ts. It deliberately does NOT touch the API-mode client and is
 * exported via the `@s2s/soul2soul-shared/chain-secured` subpath (NOT the package
 * root) so app bundles never pull in the Safe SDK.
 *
 * Primary sources (2026-10-05):
 *  - WritesFacet.sol / ViewsFacet.sol / AppStorage.sol from
 *    LIT-Protocol/chipotle (lit-api-server/blockchain/lit_node_express/contracts/AccountConfigFacets/)
 *  - core_sdk.js / account_config_full_abi.js / tx_lifecycle.js from lit-static
 *  - press/scripts/lit/update-protocol.ts (the Safe propose mechanism reused here)
 *
 * Verified vectors (independent keccak256 check):
 *  - actionHash('QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh') ==
 *    0xf2925f24662e3bd9ab6c3087a0ab7f8384eb96bacd46729a8eaeaba828ce97e1 (matches config.json)
 *  - adminHash('0x24936f87442673B7c057BF3f5dCCB726baF20c6B') ==
 *    0x11adab45e07d6dd847846fd13be95947bf24119ebfdae77f91d6598dbed69760
 */
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import Safe from '@safe-global/protocol-kit';
import SafeApiKit from '@safe-global/api-kit';
import { OperationType } from '@safe-global/types-kit';

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * AccountConfig diamond (EIP-2535) on Base mainnet (chain 8453).
 * Live value from GET https://api.chipotle.litprotocol.com/core/v1/get_node_chain_config:
 *   { chain_name: 'Base', chain_id: 8453, contract_address: '0xaaaaa9...a7aa' }
 * (pinned in lit-static/account_config_full_abi.js as the `prod` deployment).
 */
export const ACCOUNT_CONFIG_ADDRESS = '0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa' as const;

/** Chain the AccountConfig diamond lives on (Base mainnet). */
export const ACCOUNT_CONFIG_CHAIN_ID = 8453n;

/** Public Base mainnet RPC (fallback when no DRPC key is configured). */
export const BASE_MAINNET_RPC_URL = 'https://mainnet.base.org';

/** Lit Core API base URL (production). */
export const LIT_CORE_API_BASE_URL = 'https://api.chipotle.litprotocol.com/core/v1';

/**
 * On-chain admin of the chain-secured Lit account = the s2s Gnosis Safe
 * (must equal PROTOCOL_SAFE_ADDRESS in .env). Every WritesFacet call is
 * wallet-signed by this Safe; msg.sender must equal adminWalletAddress.
 */
export const PROTOCOL_SAFE_ADDRESS = '0x24936f87442673B7c057BF3f5dCCB726baF20c6B' as const;

/** OperationType.Call (0) — every WritesFacet call is a regular (non-delegate) call. */
export const OPERATION_CALL = OperationType.Call;

// ── Types ───────────────────────────────────────────────────────────────────

/** One calldata-encoded admin write against the AccountConfig diamond. */
export interface EncodedWrite {
  /** Function name on WritesFacet (for human-readable printing). */
  functionName: string;
  /** Decoded positional args (for human-readable printing). */
  args: readonly unknown[];
  /** viem encodeFunctionData output. */
  data: Hex;
}

/** One entry of a Safe batch (SafeTx meta-transaction). */
export interface SafeBatchEntry {
  to: Hex;
  value: string;
  data: Hex;
  operation: OperationType;
}

/** A freshly minted usage key: cleartext (shown once) + its on-chain hash. */
export interface UsageKey {
  usageKey: string;
  usageHash: Hex;
}

/** Shape of press/scripts/lit/config.json group entries. */
export interface LitActionConfig {
  name: string;
  cid: string;
  hashedCid: string;
}
export interface LitGroupConfig {
  name: string;
  id: number;
  actions: LitActionConfig[];
  pkps: string[];
  usage_key: string;
}
export interface LitConfigFile {
  groups: LitGroupConfig[];
}

// ── ABIs (minimal WritesFacet / ViewsFacet subsets, viem) ───────────────────

export const writesFacetAbi = [
  {
    type: 'function',
    name: 'addGroup',
    inputs: [
      { name: 'apiKeyHash', type: 'uint256' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'cidHashes', type: 'uint256[]' },
      { name: 'pkpIds', type: 'address[]' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'addAction',
    inputs: [
      { name: 'accountApiKeyHash', type: 'uint256' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'actionHash', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'addActionToGroup',
    inputs: [
      { name: 'apiKeyHash', type: 'uint256' },
      { name: 'groupId', type: 'uint256' },
      { name: 'action', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'removeActionFromGroup',
    inputs: [
      { name: 'apiKeyHash', type: 'uint256' },
      { name: 'groupId', type: 'uint256' },
      { name: 'action', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'removeAction',
    inputs: [
      { name: 'accountApiKeyHash', type: 'uint256' },
      { name: 'actionHash', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'addPkpToGroup',
    inputs: [
      { name: 'apiKeyHash', type: 'uint256' },
      { name: 'groupId', type: 'uint256' },
      { name: 'pkpId', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'registerWalletDerivation',
    inputs: [
      { name: 'apiKeyHash', type: 'uint256' },
      { name: 'pkpId', type: 'address' },
      { name: 'derivationPath', type: 'uint256' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setUsageApiKey',
    inputs: [
      { name: 'accountApiKeyHash', type: 'uint256' },
      { name: 'usageApiKeyHash', type: 'uint256' },
      { name: 'expiration', type: 'uint256' },
      { name: 'balance', type: 'uint256' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'createGroups', type: 'bool' },
      { name: 'deleteGroups', type: 'bool' },
      { name: 'createPKPs', type: 'bool' },
      { name: 'manageIPFSIdsInGroups', type: 'uint256[]' },
      { name: 'addPkpToGroups', type: 'uint256[]' },
      { name: 'removePkpFromGroups', type: 'uint256[]' },
      { name: 'executeInGroups', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const;

export const viewsFacetAbi = [
  {
    type: 'function',
    name: 'accountExistsAndIsMutable',
    inputs: [{ name: 'apiKeyHash', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAccountWalletAddress',
    inputs: [{ name: 'apiKeyHash', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'listGroups',
    inputs: [
      { name: 'accountApiKeyHash', type: 'uint256' },
      { name: 'pageNumber', type: 'uint256' },
      { name: 'pageSize', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'name', type: 'string' },
          { name: 'description', type: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'listActions',
    inputs: [
      { name: 'accountApiKeyHash', type: 'uint256' },
      { name: 'pageNumber', type: 'uint256' },
      { name: 'pageSize', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'name', type: 'string' },
          { name: 'description', type: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'listActionsInGroup',
    inputs: [
      { name: 'accountApiKeyHash', type: 'uint256' },
      { name: 'groupId', type: 'uint256' },
      { name: 'pageNumber', type: 'uint256' },
      { name: 'pageSize', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'name', type: 'string' },
          { name: 'description', type: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

// ── Hashing helpers ─────────────────────────────────────────────────────────

/**
 * On-chain account identity hash for a chain-secured account.
 * uint256(keccak256(abi.encodePacked(adminWalletAddress))) — the 20 raw bytes
 * of the Safe address. (core_sdk `_adminHash` with adminHashOverride.)
 */
export function adminHash(safeAddress: string): Hex {
  return keccak256(toBytes(getAddress(safeAddress)));
}

/**
 * Action hash for an IPFS CID: keccak256 of the raw CID string bytes.
 * Mirrors LitService.registerAction's `hashedCid = keccak256(toBytes(cid))`.
 */
export function actionHash(cid: string): Hex {
  return keccak256(toBytes(cid));
}

/** keccak256 of the UTF-8 bytes of a usage key string — the on-chain hash. */
export function usageHash(usageKey: string): Hex {
  return keccak256(toBytes(usageKey));
}

/**
 * Mint a chain-secured usage key locally (pure on-chain path, no server).
 * 32 CSPRNG bytes → `'lk_' + hex` (2-digit 0-padded lowercase). Only the
 * keccak256 hash is ever written on-chain; the cleartext is shown once and
 * must be saved by the operator.
 */
export function generateUsageKey(): UsageKey {
  const randBytes = new Uint8Array(32);
  crypto.getRandomValues(randBytes);
  const usageKey = 'lk_' + Array.from(randBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return { usageKey, usageHash: usageHash(usageKey) };
}

// ── Encoders (WritesFacet) ──────────────────────────────────────────────────

export interface AddGroupParams {
  apiKeyHash: Hex;
  name: string;
  description: string;
  cidHashes: Hex[];
  pkpIds: Hex[];
}
export function encodeAddGroup(p: AddGroupParams): EncodedWrite {
  const args = [p.apiKeyHash, p.name, p.description, p.cidHashes, p.pkpIds] as const;
  return {
    functionName: 'addGroup',
    args,
    data: encodeFunctionData({ abi: writesFacetAbi, functionName: 'addGroup', args }),
  };
}

export interface AddActionParams {
  apiKeyHash: Hex;
  name: string;
  description: string;
  actionHash: Hex;
}
export function encodeAddAction(p: AddActionParams): EncodedWrite {
  const args = [p.apiKeyHash, p.name, p.description, p.actionHash] as const;
  return {
    functionName: 'addAction',
    args,
    data: encodeFunctionData({ abi: writesFacetAbi, functionName: 'addAction', args }),
  };
}

export interface AddActionToGroupParams {
  apiKeyHash: Hex;
  groupId: bigint | number;
  action: Hex;
}
export function encodeAddActionToGroup(p: AddActionToGroupParams): EncodedWrite {
  const args = [p.apiKeyHash, BigInt(p.groupId), p.action] as const;
  return {
    functionName: 'addActionToGroup',
    args,
    data: encodeFunctionData({ abi: writesFacetAbi, functionName: 'addActionToGroup', args }),
  };
}

export interface RemoveActionFromGroupParams {
  apiKeyHash: Hex;
  groupId: bigint | number;
  action: Hex;
}
export function encodeRemoveActionFromGroup(p: RemoveActionFromGroupParams): EncodedWrite {
  const args = [p.apiKeyHash, BigInt(p.groupId), p.action] as const;
  return {
    functionName: 'removeActionFromGroup',
    args,
    data: encodeFunctionData({ abi: writesFacetAbi, functionName: 'removeActionFromGroup', args }),
  };
}

export interface RemoveActionParams {
  apiKeyHash: Hex;
  actionHash: Hex;
}
export function encodeRemoveAction(p: RemoveActionParams): EncodedWrite {
  const args = [p.apiKeyHash, p.actionHash] as const;
  return {
    functionName: 'removeAction',
    args,
    data: encodeFunctionData({ abi: writesFacetAbi, functionName: 'removeAction', args }),
  };
}

export interface AddPkpToGroupParams {
  apiKeyHash: Hex;
  groupId: bigint | number;
  pkpId: Hex;
}
export function encodeAddPkpToGroup(p: AddPkpToGroupParams): EncodedWrite {
  const args = [p.apiKeyHash, BigInt(p.groupId), p.pkpId] as const;
  return {
    functionName: 'addPkpToGroup',
    args,
    data: encodeFunctionData({ abi: writesFacetAbi, functionName: 'addPkpToGroup', args }),
  };
}

export interface RegisterWalletDerivationParams {
  apiKeyHash: Hex;
  pkpId: Hex;
  /** 0x-prefixed hex uint256 from /prepare_wallet — passed VERBATIM. */
  derivationPath: Hex;
  name: string;
  description: string;
}
export function encodeRegisterWalletDerivation(p: RegisterWalletDerivationParams): EncodedWrite {
  const args = [p.apiKeyHash, p.pkpId, p.derivationPath, p.name, p.description] as const;
  return {
    functionName: 'registerWalletDerivation',
    args,
    data: encodeFunctionData({
      abi: writesFacetAbi,
      functionName: 'registerWalletDerivation',
      args,
    }),
  };
}

export interface SetUsageApiKeyParams {
  apiKeyHash: Hex;
  usageApiKeyHash: Hex;
  /** 0 = never expires. */
  expiration?: bigint | number;
  /** 0 in chain-secured mode (no server-side Stripe billing). */
  balance?: bigint | number;
  name: string;
  description: string;
  createGroups?: boolean;
  deleteGroups?: boolean;
  createPKPs?: boolean;
  manageIPFSIdsInGroups?: Hex[];
  addPkpToGroups?: Hex[];
  removePkpFromGroups?: Hex[];
  executeInGroups?: Hex[];
}
export function encodeSetUsageApiKey(p: SetUsageApiKeyParams): EncodedWrite {
  const args = [
    p.apiKeyHash,
    p.usageApiKeyHash,
    BigInt(p.expiration ?? 0),
    BigInt(p.balance ?? 0),
    p.name,
    p.description,
    p.createGroups ?? false,
    p.deleteGroups ?? false,
    p.createPKPs ?? false,
    p.manageIPFSIdsInGroups ?? [],
    p.addPkpToGroups ?? [],
    p.removePkpFromGroups ?? [],
    p.executeInGroups ?? [],
  ] as const;
  return {
    functionName: 'setUsageApiKey',
    args,
    data: encodeFunctionData({ abi: writesFacetAbi, functionName: 'setUsageApiKey', args }),
  };
}

// ── Safe batch ──────────────────────────────────────────────────────────────

/**
 * Wrap encoded WritesFacet calls into Safe batch entries ({ to, value, data,
 * operation }) targeting the AccountConfig diamond. Mirrors the transaction
 * shape built by press/scripts/lit/update-protocol.ts.
 */
export function buildSafeBatch(
  writes: EncodedWrite[],
  to: Hex = ACCOUNT_CONFIG_ADDRESS,
): SafeBatchEntry[] {
  return writes.map((w) => ({
    to,
    value: '0',
    data: w.data,
    operation: OPERATION_CALL,
  }));
}

/** Human-readable rendering of a Safe batch (dry-run / debug output). */
export function prettyPrintBatch(transactions: SafeBatchEntry[]): string {
  const lines: string[] = [];
  transactions.forEach((tx, i) => {
    let fn = 'unknown';
    let args: readonly unknown[] = [];
    try {
      const decoded = decodeFunctionData({ abi: writesFacetAbi, data: tx.data });
      fn = decoded.functionName;
      args = decoded.args ?? [];
    } catch {
      // leave fn/args at their defaults
    }
    lines.push(`[${i + 1}] WritesFacet.${fn}`);
    lines.push(`    to:    ${tx.to}`);
    lines.push(`    value: ${tx.value}`);
    lines.push(`    data:  ${tx.data}`);
    lines.push(`    args:  ${formatArgs(args)}`);
  });
  return lines.join('\n');
}

function formatValue(a: unknown): string {
  if (typeof a === 'bigint') return `0x${a.toString(16)}`;
  if (Array.isArray(a)) return `[${a.map(formatValue).join(', ')}]`;
  if (typeof a === 'string') return JSON.stringify(a);
  return String(a);
}

function formatArgs(args: readonly unknown[]): string {
  return args.map(formatValue).join(', ');
}

// ── RPC helpers ─────────────────────────────────────────────────────────────

/** Resolve a Base RPC URL from the environment (matches update-protocol.ts). */
export function resolveLitRpcUrl(): string {
  if (process.env.BASE_RPC_URL) return process.env.BASE_RPC_URL;
  if (process.env.VITE_DRPC_API_KEY) {
    return `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`;
  }
  return BASE_MAINNET_RPC_URL;
}

function viewClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) });
}

export interface ChainSecuredVerification {
  ok: boolean;
  adminWalletAddress: string | null;
  mutableBySafe: boolean | null;
  errors: string[];
}

/**
 * Verify the account at adminHash is chain-secured and owned by the Safe:
 *  - getAccountWalletAddress(adminHash) should return the Safe address;
 *  - accountExistsAndIsMutable(adminHash) called FROM the Safe should be true
 *    (for an unmanaged account this only passes when sender == adminWalletAddress).
 * Failures are reported (and callers should warn non-fatally), never thrown.
 */
export async function verifyAccountChainSecured(opts: {
  adminHash: Hex;
  safeAddress: string;
  rpcUrl?: string;
}): Promise<ChainSecuredVerification> {
  const client = viewClient(opts.rpcUrl ?? resolveLitRpcUrl());
  const errors: string[] = [];
  let adminWalletAddress: string | null = null;
  let mutableBySafe: boolean | null = null;

  try {
    adminWalletAddress = await client.readContract({
      address: ACCOUNT_CONFIG_ADDRESS,
      abi: viewsFacetAbi,
      functionName: 'getAccountWalletAddress',
      args: [BigInt(opts.adminHash)],
    });
  } catch (err) {
    errors.push(`getAccountWalletAddress failed: ${(err as Error).message}`);
  }

  try {
    mutableBySafe = await client.readContract({
      address: ACCOUNT_CONFIG_ADDRESS,
      abi: viewsFacetAbi,
      functionName: 'accountExistsAndIsMutable',
      args: [BigInt(opts.adminHash)],
      account: getAddress(opts.safeAddress),
    });
  } catch (err) {
    errors.push(`accountExistsAndIsMutable failed: ${(err as Error).message}`);
  }

  const adminMatches =
    !!adminWalletAddress && getAddress(adminWalletAddress) === getAddress(opts.safeAddress);
  return {
    ok: adminMatches && mutableBySafe === true,
    adminWalletAddress,
    mutableBySafe,
    errors,
  };
}

/**
 * Best-effort prediction of the next group id for an account. addGroup assigns
 * strictly-increasing ids (groupCount++), so the next id is max(listed)+1, or 1
 * for a fresh account. Returns null when the view read is unavailable. Only safe
 * when no concurrent group creation happens before the batch executes — if wrong,
 * the whole Safe batch reverts atomically.
 */
export async function predictNextGroupId(opts: {
  adminHash: Hex;
  rpcUrl?: string;
  pageSize?: number;
}): Promise<bigint | null> {
  const client = viewClient(opts.rpcUrl ?? resolveLitRpcUrl());
  try {
    const groups = await client.readContract({
      address: ACCOUNT_CONFIG_ADDRESS,
      abi: viewsFacetAbi,
      functionName: 'listGroups',
      args: [BigInt(opts.adminHash), 0n, BigInt(opts.pageSize ?? 100)],
    });
    let maxId = 0n;
    for (const g of groups) {
      const id = BigInt(g.id);
      if (id > maxId) maxId = id;
    }
    return maxId + 1n;
  } catch {
    return null;
  }
}

/**
 * Best-effort check whether an action hash is currently bound to a group
 * (listActionsInGroup returns the group's cidHash set). Returns null when the
 * view read is unavailable. Used to decide whether removeActionFromGroup is
 * safe to include in a batch (it reverts if the action is not in the group).
 */
export async function isActionInGroup(opts: {
  adminHash: Hex;
  groupId: bigint | number;
  actionHash: Hex;
  rpcUrl?: string;
  pageSize?: number;
}): Promise<boolean | null> {
  const client = viewClient(opts.rpcUrl ?? resolveLitRpcUrl());
  try {
    const actions = await client.readContract({
      address: ACCOUNT_CONFIG_ADDRESS,
      abi: viewsFacetAbi,
      functionName: 'listActionsInGroup',
      args: [BigInt(opts.adminHash), BigInt(opts.groupId), 0n, BigInt(opts.pageSize ?? 100)],
    });
    return actions.some((a) => BigInt(a.id) === BigInt(opts.actionHash));
  } catch {
    return null;
  }
}

// ── prepare_wallet (no auth) ────────────────────────────────────────────────

export interface PreparedWallet {
  walletAddress: string;
  derivationPath: Hex;
}

/**
 * Mint a PKP via POST /core/v1/prepare_wallet — no auth, no signature, NOT
 * idempotent (new wallet every call). Returns the wallet address and its
 * 0x-prefixed lowercase-hex derivation path, which is passed VERBATIM to
 * registerWalletDerivation. If the binding tx never lands the keypair is
 * merely discarded (compute cost only); re-running mints a fresh one.
 */
export async function prepareWallet(opts: { baseUrl?: string } = {}): Promise<PreparedWallet> {
  const baseUrl = opts.baseUrl ?? LIT_CORE_API_BASE_URL;
  const response = await fetch(`${baseUrl}/prepare_wallet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Lit prepare_wallet returned non-JSON: ${response.status} ${text.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    throw new Error(String(data.error ?? data.message ?? data.detail ?? `HTTP ${response.status}`));
  }
  const walletAddress = (data.wallet_address ?? data.walletAddress) as string | undefined;
  const derivationPath = (data.derivation_path ?? data.derivationPath) as string | undefined;
  if (!walletAddress || !derivationPath) {
    throw new Error(
      `prepare_wallet response missing wallet_address/derivation_path: ${JSON.stringify(data)}`,
    );
  }
  return { walletAddress, derivationPath: derivationPath as Hex };
}

// ── Safe propose / finalize ─────────────────────────────────────────────────

export interface ProposeToSafeOptions {
  transactions: SafeBatchEntry[];
  safeAddress: string;
  signerPrivateKey: Hex;
  rpcUrl: string;
  senderAddress?: string;
  chainId?: bigint;
}

/**
 * Propose a Safe batch exactly like press/scripts/lit/update-protocol.ts:
 *  - @safe-global/protocol-kit Safe.init({ provider, signer, safeAddress })
 *  - createTransaction({ transactions }) + getTransactionHash + signHash
 *  - @safe-global/api-kit proposeTransaction on Base (chainId 8453n)
 * The batch is NOT auto-executed — Safe owners must confirm in the Safe UI.
 * @returns the Safe tx hash (for later finalize / confirmation).
 */
export async function proposeToSafe(opts: ProposeToSafeOptions): Promise<{ safeTxHash: string }> {
  const chainId = opts.chainId ?? ACCOUNT_CONFIG_CHAIN_ID;
  const protocolKit = await Safe.init({
    provider: opts.rpcUrl,
    signer: opts.signerPrivateKey,
    safeAddress: getAddress(opts.safeAddress),
  });

  const apiKit = new SafeApiKit({ chainId });

  const safeTransaction = await protocolKit.createTransaction({
    transactions: opts.transactions,
  });
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const senderSignature = await protocolKit.signHash(safeTxHash);

  // senderAddress is the Safe OWNER EOA that signed the hash (NOT the Safe
  // itself) — mirror update-protocol.ts, which passes account.address where
  // account = privateKeyToAccount(PROTOCOL_PRIVATE_KEY).
  const senderAddress =
    opts.senderAddress ?? getAddress(privateKeyToAccount(opts.signerPrivateKey).address);

  await apiKit.proposeTransaction({
    safeAddress: getAddress(opts.safeAddress),
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress,
    senderSignature: senderSignature.data,
  });

  console.log('✅ Transaction proposed to Safe');
  console.log('Safe Tx Hash:', safeTxHash);
  return { safeTxHash };
}

export interface ExecutedGroupId {
  isExecuted: boolean;
  executionTxHash: string | null;
  /** The ACTUAL on-chain group id decoded from the GroupAdded receipt log. */
  groupId: bigint | null;
}

/**
 * After a provision Safe batch has been executed, read the addGroup receipt and
 * decode the real group id from the `GroupAdded(uint256,uint256)` log (topic2 is
 * the indexed groupId). Never hardcoded — this is the source of truth persisted
 * to config.json at finalize.
 */
export async function readExecutedGroupId(opts: {
  safeTxHash: string;
  adminHash: Hex;
  safeAddress: string;
  chainId?: bigint;
  rpcUrl: string;
}): Promise<ExecutedGroupId> {
  const chainId = opts.chainId ?? ACCOUNT_CONFIG_CHAIN_ID;
  const apiKit = new SafeApiKit({ chainId });

  let details: Record<string, unknown>;
  try {
    details = (await apiKit.getTransaction(opts.safeTxHash)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Safe API getTransaction failed for ${opts.safeTxHash}: ${(err as Error).message}`,
    );
  }

  const isExecuted = !!details.isExecuted;
  const executionTxHash = (details.txHash ??
    details.transactionHash ??
    details.executionTxHash ??
    null) as string | null;

  if (!isExecuted || !executionTxHash) {
    return { isExecuted, executionTxHash: null, groupId: null };
  }

  const client = viewClient(opts.rpcUrl);
  const receipt = await client.getTransactionReceipt({
    hash: executionTxHash as `0x${string}`,
  });
  const topic0 = keccak256(toBytes('GroupAdded(uint256,uint256)'));
  const expectedApiKeyHash = BigInt(opts.adminHash);
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() === topic0.toLowerCase()) {
      if (BigInt(log.topics[1] ?? 0) === expectedApiKeyHash) {
        const groupId = BigInt(log.topics[2] ?? 0);
        return { isExecuted, executionTxHash, groupId };
      }
    }
  }
  return { isExecuted, executionTxHash, groupId: null };
}

// ── config.json helpers ─────────────────────────────────────────────────────

export function loadLitConfig(configPath: string): LitConfigFile {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as LitConfigFile;
  if (!Array.isArray(parsed.groups)) {
    throw new Error(`Lit config at ${configPath} has no "groups" array`);
  }
  return parsed;
}

export function saveLitConfig(configPath: string, config: LitConfigFile): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

export function findS2SGroup(config: LitConfigFile, groupName = 's2s'): LitGroupConfig | undefined {
  return config.groups.find((g) => g.name === groupName);
}

// ── env loading ─────────────────────────────────────────────────────────────

/**
 * Load .env from the monorepo root (three levels up from press/scripts/lit,
 * two levels up from this file), with protocol/.env as a fallback. Mirrors
 * add-dev-action.ts's root resolution; `tsx --require dotenv/config` also loads
 * root .env from the CWD, this makes it robust to any cwd.
 */
export function loadMonorepoEnv(fromFile: string): void {
  const scriptDir = path.dirname(fromFile);
  const root = path.resolve(scriptDir, '../../..'); // <root>/press/scripts/lit -> <root>
  dotenv.config({ path: path.join(root, '.env') });
  dotenv.config({ path: path.join(scriptDir, '../.env') });
}

/** Resolve the Safe owner EOA signer key from env (PROTOCOL_PRIVATE_KEY). */
export function requireProtocolPrivateKey(): Hex {
  const key = process.env.PROTOCOL_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'PROTOCOL_PRIVATE_KEY is not set — a Safe owner EOA key is required to propose Safe transactions',
    );
  }
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}
