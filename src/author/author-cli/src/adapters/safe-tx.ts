// ============================================================================
// Safe Transaction Service adapter — the transport and the hashing behind
// `s2s signer`. A Safe is a multisig: one owner proposes a transaction with the
// service, the others confirm it, and the last one executes it on chain. The
// chain never sees a proposal until execution, so the service is the only
// record of what is pending, and the safeTxHash is the only handle that names
// one proposal.
//
// Two halves, deliberately separate:
//
//   the hashing (computeSafeTxHash, packSignatures, addOwnerWithThresholdData,
//   execTransactionArgs) is pure and offline. A wrong hash or a wrong signature
//   encoding fails on chain with no explanation, so it is pinned by tests
//   rather than discovered in production.
//
//   the transport (makeSafeTxService) is HTTP only. It never reads chain state:
//   the nonce, the owners and the threshold come from the caller, so a queue
//   listing costs nothing on an RPC. Every request goes through the injectable
//   `fetchImpl`, so tests never open a socket.
//
// The public host (https://safe-transaction-base.safe.global) serves
// unauthenticated requests at a rate that a busy CLI will hit. `safeTx.key`
// sends `Authorization: Bearer <key>`; a Safe account's own API key is the
// answer when the queue commands start returning 429.
// ============================================================================

import {
  concatHex,
  encodeFunctionData,
  hashTypedData,
  size,
  slice,
  type Address,
  type Hex,
} from 'viem';

import { safeAbi } from '@s2s/soul2soul-shared';

import { SAFE_L2_SINGLETON } from '../core/author-safe';
import type { CliConfig } from '../core/config';
import { CliError } from '../lib/errors';

/** Safe v1.4.1 CompatibilityFallbackHandler on Base (paired with the singleton). */
export const SAFE_FALLBACK_HANDLER: Address = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

/** Base mainnet. The service is per-chain and the CLI authors on Base only. */
const SAFE_TX_CHAIN_ID = 8453;

// ===========================================================================
// The transaction the Safe will execute
// ===========================================================================

/**
 * One Safe transaction as the service stores it. `nonce` is the Safe's next
 * nonce at proposal time — a proposal queued behind another keeps its own, and
 * the service refuses a hash that was computed for a different one.
 *
 * Gas fields are optional here and zero everywhere the CLI writes one: the
 * Safe reads them from the proposal, and a refund is not something a signer
 * asks for on the author's behalf.
 */
export interface SafeTxInput {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas?: bigint;
  baseGas?: bigint;
  gasPrice?: bigint;
  gasToken?: Address;
  refundReceiver?: Address;
  nonce: number;
}

/** A queued transaction as the service reports it. */
export interface SafeTxRecord {
  safeTxHash: Hex;
  /**
   * The Safe that holds it. The service does not return this — its own URL names
   * the Safe — so the transport fills it in from the request. `execTransaction`
   * has no other source for the address it must be sent to.
   */
  safe?: Address;
  nonce: number;
  to: Address;
  /** Decimal string: the service speaks JSON, and a uint256 overflows a float. */
  value: string;
  data: Hex;
  operation: number;
  confirmations: { owner: Address; signature: Hex }[];
  confirmationsRequired: number;
  isExecuted: boolean;
  dataDecoded?: { method: string; parameters: { name: string; value: unknown }[] };
}

/** The zero address — an omitted gas token or refund receiver is this, not null. */
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * The EIP-712 shape of a Safe transaction (Safe v1.4.1 `Safe.sol`).
 *
 * This literal is the contract, not a convenience: the typehash baked into the
 * Safe's own `getTransactionHash` is `keccak256` of exactly these field names
 * and types in this order. One renamed member and every signature recovers to
 * a different owner.
 */
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

// ===========================================================================
// Hashing
// ===========================================================================

/**
 * The safeTxHash: EIP-712 over the SafeTx struct, in the domain of the Safe
 * itself.
 *
 * The domain carries `{ chainId, verifyingContract: safe }` and nothing else.
 * Safe v1.4.1 dropped the `safeSingleton` member that some 1.3.0 deployments
 * had, so a domain that includes it computes a hash the Safe will never accept.
 *
 * `Safe.getTransactionHash(to, value, data, operation, safeTxGas, baseGas,
 * gasPrice, gasToken, refundReceiver, nonce)` on chain MUST return this same
 * value — it is the same struct and the same domain separator. When they
 * disagree, the service rejects the proposal or the confirmation never counts.
 */
export function computeSafeTxHash(args: { chainId: number; safe: Address; tx: SafeTxInput }): Hex {
  const { chainId, safe, tx } = args;
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas ?? 0n,
      baseGas: tx.baseGas ?? 0n,
      gasPrice: tx.gasPrice ?? 0n,
      gasToken: tx.gasToken ?? ZERO_ADDRESS,
      refundReceiver: tx.refundReceiver ?? ZERO_ADDRESS,
      nonce: BigInt(tx.nonce),
    },
  });
}

/** `addOwnerWithThreshold(newOwner, newThreshold)` — the calldata `signer add` proposes. */
export function addOwnerWithThresholdData(owner: Address, threshold: number): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'addOwnerWithThreshold',
    args: [owner, BigInt(threshold)],
  });
}

/**
 * Concatenate owner signatures the way Safe v1.4.1 `checkNSignatures` reads
 * them: 65 bytes each, owners in ascending address order, no separator.
 *
 * The `v` byte is not the ECDSA recovery id here, it is the recovery id plus a
 * scheme flag. Safe reads `v > 30` as eth_sign — recover over
 * `"\x19Ethereum Signed Message:\n32" || safeTxHash` — and subtracts 4 before
 * recovering. The CLI signs the hash as a message, so viem hands back 27/28 and
 * each one is bumped to 31/32. A signature that already carries 31/32 (a
 * caller that encoded its own) is kept.
 *
 * Order is by address, not by the order the confirmations arrived: the Safe
 * walks the list and requires each recovered owner to be strictly greater than
 * the previous, so out of order is `GS020` and a duplicate is `GS021`.
 */
export function packSignatures(owners: Address[], byOwner: Map<Address, Hex>): Hex {
  const sorted = [...owners].sort((a, b) => {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const parts: Hex[] = [];
  for (const owner of sorted) {
    const signature = byOwner.get(owner);
    if (signature === undefined) {
      throw new CliError(`no signature for Safe owner ${owner}`, 1, 'signature_missing');
    }
    if (size(signature) !== 65) {
      throw new CliError(
        `signature for ${owner} is ${size(signature)} bytes, expected 65`,
        1,
        'signature_malformed',
      );
    }
    const v = Number.parseInt(signature.slice(-2), 16);
    const packedV = v === 27 || v === 28 ? v + 4 : v;
    if (packedV !== 31 && packedV !== 32) {
      throw new CliError(
        `signature for ${owner} carries v=${v}; Safe v1.4.1 reads v=27/28 (message) or 31/32 (eth_sign)`,
        1,
        'signature_malformed',
      );
    }
    parts.push(concatHex([slice(signature, 0, 64), `0x${packedV.toString(16).padStart(2, '0')}`]));
  }
  return concatHex(parts);
}

/**
 * The call to make on the Safe once enough owners have confirmed:
 * `execTransaction` with the proposal's own fields and the packed signatures.
 *
 * Gas fields are zero and the refund receiver is the zero address, matching
 * what the CLI proposes. The call goes to the Safe, not to the proposal's `to`.
 */
export function execTransactionArgs(
  record: SafeTxRecord,
  signatures: Hex,
): { to: Address; data: Hex } {
  if (record.safe === undefined) {
    throw new CliError(
      `record ${record.safeTxHash} carries no Safe address, so there is nowhere to send execTransaction`,
      1,
      'safe_tx_bad_record',
    );
  }
  return {
    to: record.safe,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [
        record.to,
        BigInt(record.value),
        record.data,
        record.operation,
        0n,
        0n,
        0n,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        signatures,
      ],
    }),
  };
}

// ===========================================================================
// Transport
// ===========================================================================

/** The HTTP surface of the service — no chain reads, no signing. */
export interface SafeTxService {
  register(
    safe: Address,
    info: { owners: Address[]; threshold: number; version?: string },
  ): Promise<void>;
  propose(input: { safe: Address; sender: Address; tx: SafeTxInput }): Promise<{ safeTxHash: Hex }>;
  pending(safe: Address): Promise<SafeTxRecord[]>;
  get(safe: Address, safeTxHash: Hex): Promise<SafeTxRecord>;
  confirm(input: { safe: Address; safeTxHash: Hex; signature: Hex }): Promise<void>;
}

export interface SafeTxServiceOptions {
  config: CliConfig;
  /** Test seam: every request goes through this, and only this. */
  fetchImpl?: typeof fetch;
  /**
   * Chain the safeTxHash is computed for. Defaults to Base mainnet, where the
   * CLI authors; a `dev` deployment that points `safeTx.url` elsewhere must
   * name its own chain id, because the service cannot tell us which one it
   * indexes and a hash for the wrong chain is rejected as a mismatch.
   */
  chainId?: number;
}

/** A response before it is judged — the 404 of `register` needs the status. */
interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
}

/** The service's own field names differ from ours in casing and nesting only. */
function toRecord(raw: unknown, safe: Address): SafeTxRecord {
  const source = (raw ?? {}) as Record<string, unknown>;
  const confirmations = Array.isArray(source.confirmations) ? source.confirmations : [];
  const decoded = source.dataDecoded as
    | { method?: unknown; parameters?: unknown }
    | null
    | undefined;
  const parameters = Array.isArray(decoded?.parameters) ? decoded.parameters : [];

  return {
    safeTxHash: String(source.safeTxHash ?? '') as Hex,
    safe,
    nonce: Number(source.nonce ?? 0),
    to: String(source.to ?? ZERO_ADDRESS) as Address,
    value: String(source.value ?? '0'),
    data: String(source.data ?? '0x') as Hex,
    operation: Number(source.operation ?? 0),
    confirmations: confirmations.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return { owner: String(item.owner ?? '') as Address, signature: String(item.signature ?? '') as Hex };
    }),
    confirmationsRequired: Number(source.confirmationsRequired ?? 0),
    isExecuted: source.isExecuted === true,
    ...(typeof decoded?.method === 'string'
      ? {
          dataDecoded: {
            method: decoded.method,
            parameters: parameters.map((entry) => {
              const item = (entry ?? {}) as Record<string, unknown>;
              return { name: String(item.name ?? ''), value: item.value };
            }),
          },
        }
      : {}),
  };
}

export function makeSafeTxService(opts: SafeTxServiceOptions): SafeTxService {
  const base = opts.config.safeTx.url.replace(/\/+$/, '');
  const key = opts.config.safeTx.key;
  const chainId = opts.chainId ?? SAFE_TX_CHAIN_ID;
  const doFetch = opts.fetchImpl ?? fetch;

  const raw = async (method: string, path: string, body?: unknown): Promise<RawResponse> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key !== undefined && key !== '') headers.authorization = `Bearer ${key}`;

    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      // fetch() reports DNS, TLS and socket failures all as "fetch failed"; the
      // base URL is the part of it the user can fix.
      throw new CliError(
        `Safe Transaction Service unreachable at ${base}: ${(err as Error).message}`,
        1,
        'safe_tx_unreachable',
      );
    }
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  };

  const fail = (method: string, path: string, response: RawResponse): never => {
    const bodyText = response.text.trim();
    throw new CliError(
      `Safe Transaction Service ${method} ${path} failed: ${response.status}${
        bodyText === '' ? '' : ` ${bodyText}`
      }`,
      1,
      'safe_tx_http',
    );
  };

  const json = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await raw(method, path, body);
    if (!response.ok) fail(method, path, response);
    if (response.text.trim() === '') return undefined;
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      throw new CliError(
        `Safe Transaction Service ${method} ${path} returned non-JSON: ${response.text.slice(0, 200)}`,
        1,
        'safe_tx_bad_response',
      );
    }
  };

  return {
    /**
     * Tell the service about a Safe it does not index yet: owners, threshold,
     * singleton and handler. Idempotent — a safe it already knows is left
     * alone, which is what makes `register` safe to call on every propose.
     */
    register: async (safe, info): Promise<void> => {
      const path = `/api/v1/safes/${safe}/`;
      const existing = await raw('GET', path);
      if (existing.ok) return;
      if (existing.status !== 404) fail('GET', path, existing);

      await json('POST', '/api/v1/safes/', {
        address: safe,
        owners: info.owners,
        threshold: info.threshold,
        singleton: SAFE_L2_SINGLETON,
        fallbackHandler: SAFE_FALLBACK_HANDLER,
        implementationVersion: info.version ?? '1.4.1',
        modules: [],
        delegate: safe,
      });
    },

    /**
     * Queue a transaction for the other owners. The signature is the service's
     * placeholder `0x`: the proposer's own signature is a confirmation, sent
     * separately, so a proposal and a confirmation are never the same request.
     */
    propose: async ({ safe, sender, tx }): Promise<{ safeTxHash: Hex }> => {
      const safeTxHash = computeSafeTxHash({ chainId, safe, tx });
      await json('POST', `/api/v1/safes/${safe}/multisig-transactions/`, {
        to: tx.to,
        value: tx.value.toString(),
        data: tx.data,
        operation: tx.operation,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
        nonce: tx.nonce,
        contractTransactionHash: safeTxHash,
        sender,
        signature: '0x',
        origin: 's2s',
      });
      return { safeTxHash };
    },

    /** Everything queued and not yet executed, in nonce order — the queue. */
    pending: async (safe): Promise<SafeTxRecord[]> => {
      const payload = (await json(
        'GET',
        `/api/v1/safes/${safe}/multisig-transactions/?executed=false&ordering=nonce`,
      )) as { results?: unknown[] } | undefined;
      const results = Array.isArray(payload?.results) ? payload.results : [];
      return results.map((entry) => toRecord(entry, safe));
    },

    get: async (safe, safeTxHash): Promise<SafeTxRecord> =>
      toRecord(
        await json('GET', `/api/v1/safes/${safe}/multisig-transactions/${safeTxHash}/`),
        safe,
      ),

    /** Add one owner's signature to a queued transaction. */
    confirm: async ({ safe, safeTxHash, signature }): Promise<void> => {
      await json('POST', `/api/v1/safes/${safe}/multisig-transactions/${safeTxHash}/confirmations/`, {
        signature,
      });
    },
  };
}
