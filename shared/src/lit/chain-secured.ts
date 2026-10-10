/**
 * chain-secured.ts — sovereign (ChainSecured) Lit client for the s2s account.
 *
 * The s2s Lit account is being re-provisioned under a NEW ChainSecured account
 * whose on-chain admin is the Gnosis Safe `0x24936f87442673B7c057BF3f5dCCB726baF20c6B`
 * (= PROTOCOL_SAFE_ADDRESS) on Base mainnet (chain_id 8453).
 *
 * ChainSecured mode has NO account API key and NO admin REST auth: every admin
 * write is a wallet-signed transaction to the AccountConfig diamond where
 * `msg.sender == adminWalletAddress` (the Safe). This module is the pure,
 * viem-only building block for that path — it holds no account key, never calls
 * the admin REST endpoints, and only builds Safe batch transactions. The batch
 * is proposed through the @safe-global kits in
 * `protocol/scripts/lit/chain-secured-safe.ts`, which reuses the exact
 * mechanism from `protocol/scripts/lit/update-protocol.ts`.
 *
 * Reference implementation (mirrored here):
 *   - LIT-Protocol/chipotle lit-static/core_sdk.js (sovereign addGroup /
 *     addAction / addActionToGroup / addPkpToGroup / registerWalletDerivation /
 *     setUsageApiKey / adminHashOverride)
 *   - lit-api-server/.../AccountConfigFacets/WritesFacet.sol (exact signatures)
 */
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { randomBytes } from 'node:crypto';

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * The AccountConfig diamond every ChainSecured admin write targets.
 * Live Base 8453 value from `GET /core/v1/get_node_chain_config` (the same
 * address the reference SDK pins in `account_config_full_abi.js`). The
 * WritesFacet holds addGroup/addAction/.../setUsageApiKey/registerWalletDerivation.
 */
export const ACCOUNT_CONFIG_DIAMOND = '0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa' as const;

/** Base mainnet (the Lit Chipotle chain). */
export const LIT_CHAIN_ID = 8453n as const;

/** Prod Core API base URL (no-auth endpoints only: prepare_wallet). */
export const DEFAULT_LIT_API_URL = 'https://api.chipotle.litprotocol.com/core/v1' as const;

/**
 * AccountApiKeyHash = uint256(keccak256(abi.encodePacked(safeAddress))).
 * The first uint256 arg of every WritesFacet call for a ChainSecured account.
 * Matches `ethers.solidityPackedKeccak256(['address'], [address])` used by the
 * reference SDK (`adminHashOverride`) and the contract's own
 * `newChainSecuredAccount` (WritesFacet.sol).
 */
export function adminHash(safeAddress: string): bigint {
  return BigInt(keccak256(encodePacked(['address'], [getAddress(safeAddress)])));
}

/**
 * actionHash = uint256(keccak256(raw CID string bytes)) — mirrors the existing
 * `LitService.registerAction` helper (`hashedCid = keccak256(toBytes(cid))`),
 * which the server hashes identically.
 */
export function actionHash(cid: string): bigint {
  return BigInt(keccak256(toBytes(cid)));
}

/**
 * Mint a chain-secured usage key purely on-chain: 32 random bytes ->
 * `lk_` + lowercase 2-digit-0-padded hex. Only the keccak256 hash is ever
 * written on-chain (setUsageApiKey); the cleartext key is returned once and
 * must be saved to config.json / .env (VITE_LIT_USAGE_KEY).
 */
export interface UsageKey {
  /** Cleartext `lk_`-prefixed key string (save this; it is shown once). */
  key: string;
  /** uint256(keccak256(utf8(key))) — the only thing registered on-chain. */
  usageHash: bigint;
}

export function generateUsageKey(): UsageKey {
  const bytes = randomBytes(32);
  const key = 'lk_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const usageHash = BigInt(keccak256(toBytes(key)));
  return { key, usageHash };
}

// ── ABIs ────────────────────────────────────────────────────────────────────

/**
 * Minimal WritesFacet ABI (viem) — the ChainSecured admin writes we need.
 * Signatures verified against LIT-Protocol/chipotle
 * lit-api-server/blockchain/lit_node_express/contracts/AccountConfigFacets/WritesFacet.sol.
 */
export const WRITES_FACET_ABI = [
  {
    type: 'function',
    name: 'addGroup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'apiKeyHash', type: 'uint256' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'cidHashes', type: 'uint256[]' },
      { name: 'pkpIds', type: 'address[]' },
    ],
    outputs: [{ name: 'groupId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'addAction',
    stateMutability: 'nonpayable',
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
    stateMutability: 'nonpayable',
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
    stateMutability: 'nonpayable',
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
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'accountApiKeyHash', type: 'uint256' },
      { name: 'actionHash', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'addPkpToGroup',
    stateMutability: 'nonpayable',
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
    stateMutability: 'nonpayable',
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
    stateMutability: 'nonpayable',
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

/** Read-only views used to verify the account is ChainSecured. */
export const ACCOUNT_VIEW_ABI = [
  {
    type: 'function',
    name: 'getAccountWalletAddress',
    stateMutability: 'view',
    inputs: [{ name: 'apiKeyHash', type: 'uint256' }],
    outputs: [{ name: 'adminWalletAddress', type: 'address' }],
  },
  {
    type: 'function',
    name: 'accountExistsAndIsMutable',
    stateMutability: 'view',
    inputs: [{ name: 'apiKeyHash', type: 'uint256' }],
    outputs: [{ name: 'mutable', type: 'bool' }],
  },
] as const;

/** Events we parse from receipts (deploy-group --finalize reads the group id). */
export const ACCOUNT_CONFIG_EVENTS = [
  {
    type: 'event',
    name: 'GroupAdded',
    inputs: [
      { name: 'apiKeyHash', type: 'uint256', indexed: true },
      { name: 'groupId', type: 'uint256', indexed: true },
    ],
  },
] as const;

// ── Safe batch transaction shape (matches update-protocol.ts) ───────────────

/**
 * One entry in a Safe batch — identical shape to update-protocol.ts's
 * `{ to, value, data, operation }` (operation 0 = OperationType.Call).
 */
export interface ChainSecuredSafeTransaction {
  to: Address;
  /** '0' hex string — the Safe pays gas for the whole batch. */
  value: string;
  data: Hex;
  /** 0 = OperationType.Call (matches @safe-global/types-kit). */
  operation: number;
}

/** A registered Lit action (config.json entry shape). */
export interface ActionDef {
  name: string;
  cid: string;
  hashedCid: bigint;
  description?: string;
}

// ── Encoders (each returns encodeFunctionData for the diamond) ──────────────

export interface AddGroupArgs {
  accountApiKeyHash: bigint;
  name: string;
  description: string;
  cidHashes: bigint[];
  pkpIds: Address[];
}

export interface AddActionArgs {
  accountApiKeyHash: bigint;
  name: string;
  description: string;
  actionHash: bigint;
}

export interface AddActionToGroupArgs {
  accountApiKeyHash: bigint;
  groupId: bigint;
  action: bigint;
}

export interface RemoveActionFromGroupArgs {
  accountApiKeyHash: bigint;
  groupId: bigint;
  action: bigint;
}

export interface RemoveActionArgs {
  accountApiKeyHash: bigint;
  actionHash: bigint;
}

export interface AddPkpToGroupArgs {
  accountApiKeyHash: bigint;
  groupId: bigint;
  pkpId: Address;
}

export interface RegisterWalletDerivationArgs {
  accountApiKeyHash: bigint;
  pkpId: Address;
  /** 0x-prefixed hex uint256 from prepare_wallet, passed VERBATIM. */
  derivationPath: bigint | Hex;
  name: string;
  description: string;
}

export interface SetUsageApiKeyArgs {
  accountApiKeyHash: bigint;
  usageApiKeyHash: bigint;
  expiration: bigint;
  balance: bigint;
  name: string;
  description: string;
  createGroups: boolean;
  deleteGroups: boolean;
  createPKPs: boolean;
  manageIPFSIdsInGroups: bigint[];
  addPkpToGroups: bigint[];
  removePkpFromGroups: bigint[];
  executeInGroups: bigint[];
}

export function encodeAddGroup(args: AddGroupArgs): Hex {
  return encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'addGroup',
    args: [args.accountApiKeyHash, args.name, args.description, args.cidHashes, args.pkpIds],
  });
}

export function encodeAddAction(args: AddActionArgs): Hex {
  return encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'addAction',
    args: [args.accountApiKeyHash, args.name, args.description, args.actionHash],
  });
}

export function encodeAddActionToGroup(args: AddActionToGroupArgs): Hex {
  return encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'addActionToGroup',
    args: [args.accountApiKeyHash, args.groupId, args.action],
  });
}

export function encodeRemoveActionFromGroup(args: RemoveActionFromGroupArgs): Hex {
  return encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'removeActionFromGroup',
    args: [args.accountApiKeyHash, args.groupId, args.action],
  });
}

export function encodeRemoveAction(args: RemoveActionArgs): Hex {
  return encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'removeAction',
    args: [args.accountApiKeyHash, args.actionHash],
  });
}

export function encodeAddPkpToGroup(args: AddPkpToGroupArgs): Hex {
  return encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'addPkpToGroup',
    args: [args.accountApiKeyHash, args.groupId, args.pkpId],
  });
}

export function encodeRegisterWalletDerivation(args: RegisterWalletDerivationArgs): Hex {
  // The server returns derivation_path as 0x-prefixed lowercase hex; the value
  // is passed VERBATIM (BigInt('0x…') preserves the exact uint256).
  const derivationPath =
    typeof args.derivationPath === 'string' ? BigInt(args.derivationPath) : args.derivationPath;
  return encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'registerWalletDerivation',
    args: [args.accountApiKeyHash, args.pkpId, derivationPath, args.name, args.description],
  });
}

export function encodeSetUsageApiKey(args: SetUsageApiKeyArgs): Hex {
  return encodeFunctionData({
    abi: WRITES_FACET_ABI,
    functionName: 'setUsageApiKey',
    args: [
      args.accountApiKeyHash,
      args.usageApiKeyHash,
      args.expiration,
      args.balance,
      args.name,
      args.description,
      args.createGroups,
      args.deleteGroups,
      args.createPKPs,
      args.manageIPFSIdsInGroups,
      args.addPkpToGroups,
      args.removePkpFromGroups,
      args.executeInGroups,
    ],
  });
}

// ── Batch builders ──────────────────────────────────────────────────────────

const tx = (data: Hex): ChainSecuredSafeTransaction => ({
  to: ACCOUNT_CONFIG_DIAMOND,
  value: '0',
  data,
  operation: 0,
});

export interface ReProvisionBatchParams {
  accountApiKeyHash: bigint;
  groupName: string;
  groupDescription: string;
  actionDefs: ActionDef[];
  pkpAddress: Address;
  derivationPath: bigint | Hex;
  usageKey: UsageKey;
  /**
   * The group id the new group will get. For a fresh account the first group
   * id is 1; the deploy script resolves the real id by simulating `addGroup`
   * (staticCall) before building the batch.
   */
  groupId: bigint;
  pkpName?: string;
  pkpDescription?: string;
  usageKeyName?: string;
  usageKeyDescription?: string;
}

/**
 * Full re-provision batch — in Safe-execution order:
 *   1. addGroup(...)                    — create the group (returns new id)
 *   2. registerWalletDerivation(...)    — bind the freshly minted PKP
 *   3. addAction x N                    — register action metadata
 *   4. addActionToGroup x N             — bind each action CID to the group
 *   5. addPkpToGroup(...)               — bind the PKP to the group
 *   6. setUsageApiKey(...)              — register the usage key scoped to the group
 */
export function buildReProvisionBatch(
  params: ReProvisionBatchParams,
): ChainSecuredSafeTransaction[] {
  const {
    accountApiKeyHash: h,
    groupName,
    groupDescription,
    actionDefs,
    pkpAddress,
    derivationPath,
    usageKey,
    groupId,
  } = params;

  const batch: ChainSecuredSafeTransaction[] = [
    tx(
      encodeAddGroup({
        accountApiKeyHash: h,
        name: groupName,
        description: groupDescription,
        cidHashes: actionDefs.map((a) => a.hashedCid),
        pkpIds: [pkpAddress],
      }),
    ),
    tx(
      encodeRegisterWalletDerivation({
        accountApiKeyHash: h,
        pkpId: pkpAddress,
        derivationPath,
        name: params.pkpName ?? 's2s pkp',
        description: params.pkpDescription ?? 's2s protocol pkp (chain-secured)',
      }),
    ),
  ];

  for (const a of actionDefs) {
    batch.push(
      tx(
        encodeAddAction({
          accountApiKeyHash: h,
          name: a.name,
          description: a.description ?? a.name,
          actionHash: a.hashedCid,
        }),
      ),
    );
  }
  for (const a of actionDefs) {
    batch.push(
      tx(
        encodeAddActionToGroup({
          accountApiKeyHash: h,
          groupId,
          action: a.hashedCid,
        }),
      ),
    );
  }

  batch.push(
    tx(encodeAddPkpToGroup({ accountApiKeyHash: h, groupId, pkpId: pkpAddress })),
    tx(
      encodeSetUsageApiKey({
        accountApiKeyHash: h,
        usageApiKeyHash: usageKey.usageHash,
        expiration: 0n,
        balance: 0n,
        name: params.usageKeyName ?? 's2s usage key',
        description: params.usageKeyDescription ?? 's2s protocol usage key (chain-secured)',
        createGroups: false,
        deleteGroups: false,
        createPKPs: false,
        manageIPFSIdsInGroups: [groupId],
        addPkpToGroups: [],
        removePkpFromGroups: [],
        executeInGroups: [groupId],
      }),
    ),
  );

  return batch;
}

export interface SwapActionBatchParams {
  accountApiKeyHash: bigint;
  groupId: bigint;
  /** hashedCid of the action being replaced (removed from the group first). */
  oldHashedCid: bigint;
  action: ActionDef;
}

/**
 * Recurring swap: remove the old action from the group, register the new
 * action metadata, bind the new CID to the existing group.
 */
export function buildSwapActionBatch(params: SwapActionBatchParams): ChainSecuredSafeTransaction[] {
  const { accountApiKeyHash: h, groupId, oldHashedCid, action } = params;
  return [
    tx(
      encodeRemoveActionFromGroup({
        accountApiKeyHash: h,
        groupId,
        action: oldHashedCid,
      }),
    ),
    tx(
      encodeAddAction({
        accountApiKeyHash: h,
        name: action.name,
        description: action.description ?? action.name,
        actionHash: action.hashedCid,
      }),
    ),
    tx(
      encodeAddActionToGroup({
        accountApiKeyHash: h,
        groupId,
        action: action.hashedCid,
      }),
    ),
  ];
}

export interface AddActionBatchParams {
  accountApiKeyHash: bigint;
  groupId: bigint;
  action: ActionDef;
}

/** Recurring add: register the action metadata + bind it to the existing group. */
export function buildAddActionBatch(params: AddActionBatchParams): ChainSecuredSafeTransaction[] {
  const { accountApiKeyHash: h, groupId, action } = params;
  return [
    tx(
      encodeAddAction({
        accountApiKeyHash: h,
        name: action.name,
        description: action.description ?? action.name,
        actionHash: action.hashedCid,
      }),
    ),
    tx(
      encodeAddActionToGroup({
        accountApiKeyHash: h,
        groupId,
        action: action.hashedCid,
      }),
    ),
  ];
}

export interface RemoveActionBatchParams {
  accountApiKeyHash: bigint;
  groupId: bigint;
  /** hashedCid of the action to remove from the group (and then delete). */
  hashedCid: bigint;
}

/** Recurring remove: remove the action from the group, then delete it. */
export function buildRemoveActionBatch(
  params: RemoveActionBatchParams,
): ChainSecuredSafeTransaction[] {
  const { accountApiKeyHash: h, groupId, hashedCid } = params;
  return [
    tx(
      encodeRemoveActionFromGroup({
        accountApiKeyHash: h,
        groupId,
        action: hashedCid,
      }),
    ),
    tx(encodeRemoveAction({ accountApiKeyHash: h, actionHash: hashedCid })),
  ];
}

// ── Dry-run / human-readable batch rendering ────────────────────────────────

const fmtBigInt = (v: bigint): string =>
  v > 0xffffffffffffffffn ? `0x${v.toString(16)} (${String(v)})` : v.toString();

/** Render a decoded ABI arg as a compact human-readable string. */
function fmtArg(arg: unknown): string {
  if (typeof arg === 'bigint') return fmtBigInt(arg);
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'boolean') return String(arg);
  if (Array.isArray(arg)) return `[${arg.map(fmtArg).join(', ')}]`;
  return String(arg);
}

export interface DecodedBatchTx {
  index: number;
  to: Address;
  value: string;
  data: Hex;
  functionName: string;
  args: readonly unknown[];
}

/**
 * Decode a batch into human-readable entries (function name + decoded args)
 * via a viem round-trip — also serves as the ABI-encoding validation.
 */
export function decodeBatch(batch: ChainSecuredSafeTransaction[]): DecodedBatchTx[] {
  return batch.map((t, index) => {
    const decoded = decodeFunctionData({ abi: WRITES_FACET_ABI, data: t.data });
    return {
      index,
      to: t.to,
      value: t.value,
      data: t.data,
      functionName: decoded.functionName,
      args: decoded.args,
    };
  });
}

/** Pretty-print a batch for dry-run / pre-proposal review. */
export function printBatch(batch: ChainSecuredSafeTransaction[]): void {
  const decoded = decodeBatch(batch);
  console.log(
    `\n── Safe batch: ${String(decoded.length)} transaction${decoded.length === 1 ? '' : 's'} ──`,
  );
  for (const d of decoded) {
    console.log(`\n[${String(d.index)}] ${d.functionName}()`);
    console.log(`    to:    ${d.to}`);
    console.log(`    value: ${d.value}`);
    console.log(`    data:  ${d.data}`);
    console.log(`    args:`);
    for (let i = 0; i < d.args.length; i++) {
      console.log(`      [${String(i)}] ${fmtArg(d.args[i])}`);
    }
  }
}

// ── No-auth endpoints (chain-secured path) ──────────────────────────────────

export interface PreparedWallet {
  /** Fresh PKP wallet address from the MPC. */
  walletAddress: Address;
  /**
   * 0x-prefixed lowercase hex uint256 from the server, passed VERBATIM to
   * registerWalletDerivation (must be non-zero).
   */
  derivationPath: string;
}

/**
 * Mint a PKP the chain-secured way: POST /core/v1/prepare_wallet (NO auth, no
 * signature). NOT idempotent — every call returns a brand-new wallet; register
 * exactly once via registerWalletDerivation in the Safe batch.
 */
export async function prepareWallet(params: {
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<PreparedWallet> {
  const { baseUrl = DEFAULT_LIT_API_URL, timeoutMs = 30_000 } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/prepare_wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `prepare_wallet returned non-JSON: ${String(res.status)} ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `prepare_wallet failed: ${String(res.status)} ${
          (data as { error?: string; message?: string }).error ??
          (data as { message?: string }).message ??
          text.slice(0, 300)
        }`,
      );
    }
    const { wallet_address, derivation_path } = data as {
      wallet_address?: string;
      derivation_path?: string;
    };
    if (!wallet_address || !derivation_path) {
      throw new Error(`prepare_wallet missing fields: ${JSON.stringify(data)}`);
    }
    return { walletAddress: getAddress(wallet_address), derivationPath: derivation_path };
  } finally {
    clearTimeout(timer);
  }
}

// ── Account verification (read-only, non-fatal) ─────────────────────────────

export interface AccountVerification {
  ok: boolean;
  exists: boolean;
  chainSecured: boolean;
  adminWallet: Address | null;
  mutableBySafe: boolean;
  accountApiKeyHash: bigint;
  message: string;
}

/**
 * Verify the Safe is the ChainSecured admin of the account, read-only:
 *   - `getAccountWalletAddress(adminHash)` must resolve to the Safe (for a
 *     ChainSecured account the admin wallet IS the Safe; a managed account's
 *     admin is a Lit-side address).
 *   - `accountExistsAndIsMutable(adminHash)` with `from = safe` returns true
 *     only when the Safe is the admin (ChainSecured), not an api_payer.
 *
 * Non-fatal: any RPC/view failure returns `ok:false` so callers can warn and
 * proceed. There is no public view exposing the raw `managed` flag in this ABI
 * version; admin-wallet == safe is the chain-secured signal.
 */
export async function verifyAccount(params: {
  rpcUrl: string;
  safeAddress: string;
  diamondAddress?: Address;
}): Promise<AccountVerification> {
  const safe = getAddress(params.safeAddress);
  const diamond = params.diamondAddress ?? ACCOUNT_CONFIG_DIAMOND;
  const h = adminHash(safe);
  try {
    const client = createPublicClient({ chain: base, transport: http(params.rpcUrl) });
    const adminWallet = await client.readContract({
      address: diamond,
      abi: ACCOUNT_VIEW_ABI,
      functionName: 'getAccountWalletAddress',
      args: [h],
    });
    const mutableBySafe = await client.readContract({
      address: diamond,
      abi: ACCOUNT_VIEW_ABI,
      functionName: 'accountExistsAndIsMutable',
      args: [h],
      account: safe,
    });
    const chainSecured = getAddress(adminWallet) === safe;
    return {
      ok: true,
      exists: true,
      chainSecured,
      adminWallet: getAddress(adminWallet),
      mutableBySafe,
      accountApiKeyHash: h,
      message: chainSecured
        ? `Account exists and is ChainSecured (admin wallet = ${safe})`
        : `WARNING: account admin (${getAddress(adminWallet)}) is NOT the Safe (${safe}) — is this the chain-secured account?`,
    };
  } catch (err) {
    return {
      ok: false,
      exists: false,
      chainSecured: false,
      adminWallet: null,
      mutableBySafe: false,
      accountApiKeyHash: h,
      message: `Could not verify account on-chain (rpc: ${params.rpcUrl}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
