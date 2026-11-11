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
//   the hashing (computeSafeTxHash, packSignatures, packVerifiedSignatures,
//   addOwnerWithThresholdData, execTransactionArgs) is pure and offline. A wrong hash or a wrong signature
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
  hashMessage,
  hashTypedData,
  recoverAddress,
  size,
  type Address,
  type Hex,
} from 'viem';

import { safeAbi } from '@s2s/soul2soul-shared';

import { SAFE_L2_SINGLETON } from '../core/author-safe';
import type { CliConfig } from '../core/config';
import { CliError, describeError, UsageError } from '../lib/errors';

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
  /**
   * The gas fields, as the service stores them. They are part of the signed
   * struct, so `execTransactionArgs` must pass them back unchanged: a proposal
   * made by another tool can carry a nonzero `safeTxGas` or a paying
   * `gasToken`, and re-encoding it with zeros yields a different transaction
   * hash than the one the owners signed. Optional only so a hand-built record
   * defaults to the zeros the CLI proposes.
   */
  safeTxGas?: string;
  baseGas?: string;
  gasPrice?: string;
  gasToken?: Address;
  refundReceiver?: Address;
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
 * The domain is `{ chainId, verifyingContract: safe }` and nothing else. No
 * Safe version ever put the singleton in the domain — below v1.3.0 the domain
 * was `{ verifyingContract }` alone, and from v1.3.0 on it is exactly these two
 * fields (@safe-global/protocol-kit's `getEip712TxTypes` is the reference).
 * `safeSingleton` belongs to the v1.3.0 *SafeSetup* struct, not here, so a
 * domain that carries it computes a hash the Safe will never accept.
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
 * Concatenate signatures the way Safe v1.4.1 `checkNSignatures` reads them: 65
 * bytes each, owners in ascending address order, no separator. `signers` are
 * the owners whose signatures go in, and `signatures` is keyed by those same
 * owners, matched case-insensitively.
 *
 * The `v` byte is not the ECDSA recovery id here, it is the recovery id plus a
 * scheme flag. `Safe.sol` reads `v > 30` as eth_sign — recover over
 * `keccak256("\x19Ethereum Signed Message:\n32" || safeTxHash)` with `v - 4` —
 * and reads any other `v` as a signature over the digest itself.
 *
 * INVARIANT: every signature passed here is a *message* signature over the
 * safeTxHash, the scheme `s2s signer confirm` produces. Each `v` is therefore
 * emitted as 31/32, and an input that already carries 31/32 keeps it. Both a
 * message signature and a typed-data signature arrive from a wallet as 27/28,
 * so this function cannot tell them apart and cannot prove the invariant. When
 * the signatures come from elsewhere — the service's `confirmations` array —
 * use `packVerifiedSignatures`, which recovers each one against its owner and
 * fails instead of emitting a signature the Safe will reject.
 *
 * Order is by address, not by the order the confirmations arrived: the Safe
 * walks the list and requires each recovered owner to be strictly greater than
 * the previous, so out of order is `GS026`.
 */
export function packSignatures(signers: Address[], signatures: Map<Address, Hex>): Hex {
  return pack(signers, signatures, (signer) => (signer.parity === 0 ? 31 : 32));
}

/**
 * `packSignatures` with the scheme flag proved rather than assumed.
 *
 * Each signature is recovered over the digest and, failing that, over the
 * prefixed digest, and the `v` byte that made it recover is the one emitted. A
 * signature that recovers to neither is refused: packing it would produce a
 * transaction the Safe rejects with `GS026`, with nothing said about which
 * owner was wrong. Needs a secp256k1 recovery per owner, hence async.
 */
export async function packVerifiedSignatures(
  signers: Address[],
  signatures: Map<Address, Hex>,
  safeTxHash: Hex,
): Promise<Hex> {
  const bySigner = new Map<string, { parsed: ParsedSignature; owner: Address }>();
  for (const owner of signers) {
    bySigner.set(owner.toLowerCase(), {
      parsed: readSignature(owner, lookup(signatures, owner)),
      owner,
    });
  }

  const flags = new Map<string, 'typed' | 'message'>();
  for (const [key, { parsed, owner }] of bySigner) {
    const digest = typedDigest(parsed);
    const typed = await recoversTo(digest, safeTxHash, owner);
    if (typed) {
      flags.set(key, 'typed');
      continue;
    }
    if (!(await recoversTo(digest, hashMessage({ raw: safeTxHash }), owner))) {
      throw new CliError(
        `signature for ${owner} recovers to another address over ${safeTxHash}`,
        1,
        'signature_not_owner',
      );
    }
    flags.set(key, 'message');
  }

  return pack(signers, signatures, (parsed, owner) => {
    const typed = flags.get(owner.toLowerCase()) === 'typed';
    if (typed) return parsed.parity === 0 ? 27 : 28;
    return parsed.parity === 0 ? 31 : 32;
  });
}

interface ParsedSignature {
  r: Hex;
  s: Hex;
  parity: 0 | 1;
}

/** One 65-byte signature, split, with the eth_sign flag stripped off `v`. */
function readSignature(owner: Address, signature: Hex): ParsedSignature {
  if (size(signature) !== 65) {
    throw new CliError(
      `signature for ${owner} is ${size(signature)} bytes, expected 65`,
      1,
      'signature_malformed',
    );
  }
  const raw = Number.parseInt(signature.slice(-2), 16);
  // 31/32 means the writer already flagged it as an eth_sign signature; 27/28
  // is the bare recovery id. Anything else is not a Safe signature.
  const v = raw > 30 ? raw - 4 : raw;
  if (v !== 27 && v !== 28) {
    throw new CliError(
      `signature for ${owner} carries v=${raw}; Safe v1.4.1 reads 27/28 or 31/32`,
      1,
      'signature_malformed',
    );
  }
  return {
    r: `0x${signature.slice(2, 66)}`,
    s: `0x${signature.slice(66, 130)}`,
    parity: v === 27 ? 0 : 1,
  };
}

function lookup(signatures: Map<Address, Hex>, owner: Address): Hex {
  // The caller's map may use checksummed addresses while the owner list does
  // not, and a bare miss would read as "no signature" for a signature it has.
  for (const [signer, signature] of signatures) {
    if (signer.toLowerCase() === owner.toLowerCase()) return signature;
  }
  throw new CliError(`no signature for Safe owner ${owner}`, 1, 'signature_missing');
}

/** r || s || v, in the sort order the Safe requires. */
function pack(
  signers: Address[],
  signatures: Map<Address, Hex>,
  v: (parsed: ParsedSignature, owner: Address) => number,
): Hex {
  const sorted = [...signers].sort((a, b) => {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return concatHex(
    sorted.map((owner) => {
      const parsed = readSignature(owner, lookup(signatures, owner));
      return concatHex([parsed.r, parsed.s, `0x${v(parsed, owner).toString(16)}`]);
    }),
  );
}

/** r || s || 27/28, the form `recoverAddress` takes. */
function typedDigest(parsed: ParsedSignature): Hex {
  return concatHex([parsed.r, parsed.s, `0x${(parsed.parity === 0 ? 27 : 28).toString(16)}`]);
}

async function recoversTo(signature: Hex, digest: Hex, owner: Address): Promise<boolean> {
  return (await recoverAddress({ hash: digest, signature })).toLowerCase() === owner.toLowerCase();
}

/**
 * The call to make on the Safe once enough owners have confirmed:
 * `execTransaction` with the proposal's own fields and the packed signatures.
 *
 * Every field of the signed struct comes from the record, gas fields included:
 * substituting zeros for a nonzero `safeTxGas`, `gasPrice` or `gasToken`
 * changes the transaction hash, and the Safe then treats the signatures as
 * made by strangers. The call goes to the Safe, not to the proposal's `to`.
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
        BigInt(record.safeTxGas ?? '0'),
        BigInt(record.baseGas ?? '0'),
        BigInt(record.gasPrice ?? '0'),
        record.gasToken ?? ZERO_ADDRESS,
        record.refundReceiver ?? ZERO_ADDRESS,
        signatures,
      ],
    }),
  };
}

// ===========================================================================
// Transport
// ===========================================================================

/**
 * The HTTP surface of the service — no chain reads, no signing.
 *
 * Route shapes are not symmetric: the *collection* is Safe-scoped
 * (`/safes/{safe}/multisig-transactions/`) because a page of a Safe's queue is
 * a list, while a single transaction and its confirmations are keyed by hash
 * alone (`/multisig-transactions/{hash}/`). Same split in
 * @safe-global/api-kit: `getMultisigTransactions(safe)` versus
 * `getTransaction(safeTxHash)` and `confirmTransaction(safeTxHash, signature)`.
 */
export interface SafeTxService {
  register(
    safe: Address,
    info: { owners: Address[]; threshold: number; version?: string; modules?: Address[] },
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
    // Kept as the service sends them: they are inside the signed struct, so
    // `execTransactionArgs` has to hand them back byte for byte.
    safeTxGas: String(source.safeTxGas ?? '0'),
    baseGas: String(source.baseGas ?? '0'),
    gasPrice: String(source.gasPrice ?? '0'),
    gasToken: String(source.gasToken ?? ZERO_ADDRESS) as Address,
    refundReceiver: String(source.refundReceiver ?? ZERO_ADDRESS) as Address,
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
  const base = opts.config.safeTx.url.trim().replace(/\/+$/, '');
  if (base === '') {
    // An unset endpoint is a configuration mistake, not a transport failure:
    // `fetch('/api/...')` would report a bare "fetch failed" from a relative URL
    // and send the user looking for a network problem that does not exist.
    throw new UsageError(
      '`safeTx.url` is not set. Run `s2s config set safeTx.url https://safe-transaction-base.safe.global` or set S2S_SAFE_TX_URL.',
    );
  }
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
      // cause chain names the real one and the base URL is the part the user
      // can fix.
      throw new CliError(
        `Safe Transaction Service unreachable at ${base}: ${describeError(err)}`,
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
        // Whatever the caller declares. The service treats this as truth in
        // `Safe.getInfo` and the UI's module tab, so it is not ours to invent:
        // an author Safe is an ERC-4337 account with the Safe4337Module
        // enabled, and a caller that knows the module passes it here rather
        // than having this function assert an empty set.
        modules: info.modules ?? [],
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
      // `ordering=nonce` is the service's promise, not something to rely on for
      // correctness: the queue is the order the nonces must be executed in, and
      // a page that arrives in another order would be executed out of turn.
      return results
        .map((entry) => toRecord(entry, safe))
        .sort((left, right) => left.nonce - right.nonce);
    },

    /**
     * One queued transaction. The route names the hash, not the Safe: the
     * hash is globally unique, so `safe` is only what the returned record is
     * labelled with.
     */
    get: async (safe, safeTxHash): Promise<SafeTxRecord> =>
      toRecord(await json('GET', `/api/v1/multisig-transactions/${safeTxHash}/`), safe),

    /** Add one owner's signature to a queued transaction. */
    confirm: async ({ safe, safeTxHash, signature }): Promise<void> => {
      await json('POST', `/api/v1/multisig-transactions/${safeTxHash}/confirmations/`, {
        signature,
      });
    },
  };
}
