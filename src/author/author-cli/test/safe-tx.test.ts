// ============================================================================
// Safe Transaction Service adapter — the hashing and the transport.
//
// No test here opens a socket: every request goes through the fake `fetch`
// below. Every hash assertion is either a pinned literal, a hand-written
// keccak encoding of the EIP-712 digest, or a real signature recovering to the
// key that made it.
// ============================================================================

import {
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  recoverAddress,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { safeAbi } from '@s2s/soul2soul-shared';

import {
  addOwnerWithThresholdData,
  computeSafeTxHash,
  execTransactionArgs,
  makeSafeTxService,
  packVerifiedSignatures,
  predecessorOf,
  SAFE_FALLBACK_HANDLER,
  SENTINEL_OWNERS,
  swapOwnerData,
  type SafeTxInput,
  type SafeTxRecord,
} from '../src/adapters/safe-tx';
import { SAFE_L2_SINGLETON } from '../src/core/author-safe';
import { loadConfig, type CliConfig } from '../src/core/config';
import { CliError, UsageError } from '../src/lib/errors';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const OWNER_A = '0x1111111111111111111111111111111111111111' as const;
const OWNER_B = '0x2222222222222222222222222222222222222222' as const;
const TARGET = '0x3333333333333333333333333333333333333333' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const CHAIN_ID = 8453;

/** Two throwaway keys, so signing and recovery are exercised for real. */
const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const KEY_B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const KEY_STRANGER = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;

const accountA = privateKeyToAccount(KEY_A);
const accountB = privateKeyToAccount(KEY_B);
const stranger = privateKeyToAccount(KEY_STRANGER);

/**
 * The SafeTx struct as EIP-712. Written out here rather than imported so the
 * test does not read the implementation's own constant — the pinned digest
 * below is what guards both copies against a silent rename.
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

/** The proposal `s2s signer add` makes: add OWNER_B at threshold 2, nonce 7. */
const ADD_OWNER_TX: SafeTxInput = {
  to: SAFE,
  value: 0n,
  data: addOwnerWithThresholdData(OWNER_B, 2),
  operation: 0,
  nonce: 7,
};

const SAFE_TX_HASH = computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: ADD_OWNER_TX });

const nowhere = {
  userConfigPath: '/nonexistent/s2s/custom.json',
  projectConfigPath: '/nonexistent/.s2sconfig.json',
  legacyConfigPath: '/nonexistent/s2s/config.json',
  defaultsPath: '/nonexistent/s2s/defaults.json',
  authorsPath: '/nonexistent/s2s/authors.json',
};

// ===========================================================================
// The hash
// ===========================================================================

describe('computeSafeTxHash', () => {
  /**
   * A pinned digest for one fixed proposal.
   *
   * Derived from the EIP-712 definition and reproduced independently by
   * @safe-global/protocol-kit 6.1.2: `hashTypedData` over the type list
   * `getEip712TxTypes('1.4.1')` exports, domain `{chainId, verifyingContract}`,
   * gives exactly this value. It is still NOT verified against a live Safe —
   * `Safe.getTransactionHash` is that proof, and it needs a chain this machine
   * may not reach. What the literal catches is a silent change to the domain or
   * the struct on the day someone edits them.
   */
  const EXPECTED = '0xf9224ce364e9091d7c03fa8cae100ef7e729d050233bdf975a91a1fb904a79ed';

  it('matches the pinned digest for a fixed proposal', () => {
    expect(SAFE_TX_HASH).toBe(EXPECTED);
  });

  it('matches a hand-written keccak encoding of the same struct', () => {
    const domainTypehash = keccak256(
      stringToHex('EIP712Domain(uint256 chainId,address verifyingContract)'),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [domainTypehash, BigInt(CHAIN_ID), SAFE],
      ),
    );
    const txTypehash = keccak256(
      stringToHex(
        'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'uint8' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint256' },
        ],
        [
          txTypehash,
          ADD_OWNER_TX.to,
          ADD_OWNER_TX.value,
          keccak256(ADD_OWNER_TX.data),
          ADD_OWNER_TX.operation,
          0n,
          0n,
          0n,
          ZERO,
          ZERO,
          7n,
        ],
      ),
    );

    expect(SAFE_TX_HASH).toBe(keccak256(concatHex(['0x1901', domainSeparator, structHash])));
  });

  it('is the digest a typed-data signer signs', async () => {
    const signature = await accountA.signTypedData({
      domain: { chainId: CHAIN_ID, verifyingContract: SAFE },
      types: SAFE_TX_TYPES,
      primaryType: 'SafeTx',
      message: {
        to: ADD_OWNER_TX.to,
        value: ADD_OWNER_TX.value,
        data: ADD_OWNER_TX.data,
        operation: ADD_OWNER_TX.operation,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: ZERO,
        refundReceiver: ZERO,
        nonce: 7n,
      },
    });
    // Recovering over the digest, not over a prefixed one: this is the same
    // test the Safe performs, and it only passes if the digest is right.
    expect(
      await packVerifiedSignatures(
        [accountA.address],
        new Map([[accountA.address, signature]]),
        SAFE_TX_HASH,
      ),
    ).toBe(signature);
  });

  it('carries the chain id in the domain', () => {
    expect(computeSafeTxHash({ chainId: 1, safe: SAFE, tx: ADD_OWNER_TX })).not.toBe(SAFE_TX_HASH);
  });

  it('carries the Safe as verifyingContract and nothing else in the domain', () => {
    expect(computeSafeTxHash({ chainId: CHAIN_ID, safe: TARGET, tx: ADD_OWNER_TX })).not.toBe(
      SAFE_TX_HASH,
    );
  });

  it('hashes an omitted gas field as zero, not as absent', () => {
    expect(
      computeSafeTxHash({
        chainId: CHAIN_ID,
        safe: SAFE,
        tx: { ...ADD_OWNER_TX, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n },
      }),
    ).toBe(SAFE_TX_HASH);
  });
});

// ===========================================================================
// Calldata
// ===========================================================================

describe('addOwnerWithThresholdData', () => {
  it('encodes the v1.4.1 selector and both arguments', () => {
    const data = addOwnerWithThresholdData(OWNER_B, 2);
    expect(data.startsWith('0x0d582f13')).toBe(true);

    const decoded = decodeFunctionData({ abi: safeAbi, data });
    expect(decoded.functionName).toBe('addOwnerWithThreshold');
    expect(decoded.args).toEqual([OWNER_B, 2n]);
  });
});

describe('predecessorOf', () => {
  // Three real keys, so the checksummed form differs from the lowercase one.
  const first = accountA.address;
  const middle = accountB.address;
  const last = stranger.address;
  const owners = [first, middle, last] as const;

  it('finds the owner before a middle entry', () => {
    expect(predecessorOf(owners, last)).toBe(middle);
    expect(predecessorOf(owners, middle)).toBe(first);
  });

  it('answers the sentinel for the first owner', () => {
    expect(SENTINEL_OWNERS).toBe('0x0000000000000000000000000000000000000001');
    expect(predecessorOf(owners, first)).toBe(SENTINEL_OWNERS);
  });

  it('refuses an owner the list does not hold, naming it', () => {
    expect(() => predecessorOf(owners, TARGET)).toThrow(UsageError);
    expect(() => predecessorOf(owners, TARGET)).toThrow(TARGET);
  });

  it('compares a checksum-less address equal to its checksummed form', () => {
    const lowered = last.toLowerCase() as Address;
    // The list holds the checksummed form and the answer is the predecessor of
    // it, not of some other entry.
    expect(predecessorOf(owners, lowered)).toBe(middle);
    // Reversed: the list holds lowercase, the caller passes checksummed.
    expect(predecessorOf([first, middle, lowered], last)).toBe(middle);
    // The predecessor comes back checksummed, ready for calldata.
    expect(predecessorOf(owners, last)).not.toBe(middle.toLowerCase());
  });
});

describe('swapOwnerData', () => {
  it('encodes the v1.4.1 selector and the three arguments in order', () => {
    const data = swapOwnerData(SENTINEL_OWNERS, OWNER_B, TARGET);
    expect(data.startsWith('0xe318b52b')).toBe(true);

    const decoded = decodeFunctionData({ abi: safeAbi, data });
    expect(decoded.functionName).toBe('swapOwner');
    expect(decoded.args).toEqual([SENTINEL_OWNERS, OWNER_B, TARGET]);
  });

  it('carries no threshold, so the swap cannot move it', () => {
    const decoded = decodeFunctionData({ abi: safeAbi, data: swapOwnerData(OWNER_A, OWNER_B, TARGET) });
    expect(decoded.args).toHaveLength(3);
  });
});

describe('packVerifiedSignatures', () => {
  /** Replace the trailing v byte. */
  const withV = (signature: Hex, v: number): Hex =>
    `0x${signature.slice(2, -2)}${v.toString(16).padStart(2, '0')}` as Hex;

  const ascending = (addresses: Address[]): Address[] =>
    [...addresses].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

  it('orders by address ascending and bumps a message signature to 31/32', async () => {
    const sigA = await accountA.signMessage({ message: { raw: SAFE_TX_HASH } });
    const sigB = await accountB.signMessage({ message: { raw: SAFE_TX_HASH } });

    // Given in the wrong order, and keyed by checksummed address.
    const packed = await packVerifiedSignatures(
      [accountB.address, accountA.address],
      new Map([
        [accountB.address, sigB],
        [accountA.address, sigA],
      ]),
      SAFE_TX_HASH,
    );

    const expected = ascending([accountA.address, accountB.address]).map((address) => {
      const signature = address === accountA.address ? sigA : sigB;
      return withV(signature, signature.endsWith('1b') ? 0x1f : 0x20);
    });

    expect(packed).toBe(concatHex(expected));
  });

  it('proves the mode when it is given the hash: a typed-data signature keeps v 27/28', async () => {
    const typed = await accountA.signTypedData({
      domain: { chainId: CHAIN_ID, verifyingContract: SAFE },
      types: SAFE_TX_TYPES,
      primaryType: 'SafeTx',
      message: {
        to: ADD_OWNER_TX.to,
        value: ADD_OWNER_TX.value,
        data: ADD_OWNER_TX.data,
        operation: ADD_OWNER_TX.operation,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: ZERO,
        refundReceiver: ZERO,
        nonce: 7n,
      },
    });
    const packed = await packVerifiedSignatures(
      [accountA.address],
      new Map([[accountA.address, typed]]),
      SAFE_TX_HASH,
    );
    expect(packed).toBe(typed);
  });

  it('proves the mode when it is given the hash: a message signature becomes 31/32', async () => {
    const message = await accountA.signMessage({ message: { raw: SAFE_TX_HASH } });
    const packed = await packVerifiedSignatures(
      [accountA.address],
      new Map([[accountA.address, message]]),
      SAFE_TX_HASH,
    );
    expect(packed).toBe(withV(message, message.endsWith('1b') ? 0x1f : 0x20));
  });

  it('refuses a signature that does not recover to the signer it is filed under', async () => {
    const wrong = await stranger.signMessage({ message: { raw: SAFE_TX_HASH } });
    try {
      await packVerifiedSignatures([accountA.address], new Map([[accountA.address, wrong]]), SAFE_TX_HASH);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('signature_not_owner');
    }
  });

  it('refuses an owner it has no signature for', async () => {
    await expect(
      packVerifiedSignatures([accountA.address], new Map(), SAFE_TX_HASH),
    ).rejects.toMatchObject({ code: 'signature_missing' });
  });

  it('keeps a signature that already carries the eth_sign flag', async () => {
    const message = await accountA.signMessage({ message: { raw: SAFE_TX_HASH } });
    const flagged = withV(message, message.endsWith('1b') ? 0x1f : 0x20);
    expect(
      await packVerifiedSignatures([accountA.address], new Map([[accountA.address, flagged]]), SAFE_TX_HASH),
    ).toBe(flagged);
  });

  it('reports a structurally invalid r/s as a CliError, not a viem throw', async () => {
    const impossible = `0x${'00'.repeat(64)}1b` as Hex;
    try {
      await packVerifiedSignatures(
        [accountA.address],
        new Map([[accountA.address, impossible]]),
        SAFE_TX_HASH,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('signature_malformed');
    }
  });

  it('refuses a signature that is not 65 bytes', async () => {
    await expect(
      packVerifiedSignatures(
        [accountA.address],
        new Map([[accountA.address, '0x1234']]),
        SAFE_TX_HASH,
      ),
    ).rejects.toMatchObject({ code: 'signature_malformed' });
  });
});

// ===========================================================================
// execTransaction
// ===========================================================================

describe('execTransactionArgs', () => {
  const record: SafeTxRecord = {
    safeTxHash: SAFE_TX_HASH,
    safe: SAFE,
    nonce: 7,
    to: SAFE,
    value: '0',
    data: ADD_OWNER_TX.data,
    operation: 0,
    confirmations: [],
    confirmationsRequired: 2,
    isExecuted: false,
  };

  it('calls the Safe, not the proposal target', () => {
    const args = execTransactionArgs(record, '0xdead');
    expect(args.to).toBe(SAFE);
    expect(args.data.startsWith('0x6a761202')).toBe(true);
  });

  it('passes the proposal fields, zero gas and the packed signatures', () => {
    const decoded = decodeFunctionData({
      abi: safeAbi,
      data: execTransactionArgs(record, '0xdead').data,
    });
    expect(decoded.functionName).toBe('execTransaction');
    expect(decoded.args).toEqual([SAFE, 0n, ADD_OWNER_TX.data, 0, 0n, 0n, 0n, ZERO, ZERO, '0xdead']);
  });

  it("re-encodes the record's own gas fields, or the hash the owners signed changes", () => {
    const paying: SafeTxRecord = {
      ...record,
      safeTxGas: '21000',
      baseGas: '3000',
      gasPrice: '1000000000',
      gasToken: OWNER_B,
      refundReceiver: OWNER_A,
    };
    const decoded = decodeFunctionData({
      abi: safeAbi,
      data: execTransactionArgs(paying, '0xdead').data,
    });
    expect(decoded.args).toEqual([
      SAFE,
      0n,
      ADD_OWNER_TX.data,
      0,
      21000n,
      3000n,
      1000000000n,
      OWNER_B,
      OWNER_A,
      '0xdead',
    ]);
  });

  it('checks the record against its own hash when it is told the chain', () => {
    // One field changed, the hash left alone: what a service serving stale
    // fields would look like, and the reason the check belongs here.
    const stale: SafeTxRecord = { ...record, value: '5' };
    try {
      execTransactionArgs(stale, '0xdead', { chainId: CHAIN_ID });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('safe_tx_hash_mismatch');
    }
  });

  it('refuses a record with no Safe address to send to', () => {
    expect(() => execTransactionArgs({ ...record, safe: undefined }, '0xdead')).toThrow(CliError);
  });
});

// ===========================================================================
// Transport
// ===========================================================================

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Reply {
  status?: number;
  body?: unknown;
}

/** A `fetch` that answers from a script and records every call. */
function fakeFetch(script: Reply[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    const reply = script[calls.length - 1] ?? { status: 200, body: {} };
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return Promise.resolve(new Response(text, { status: reply.status ?? 200 }));
  };
  return { fetchImpl, calls };
}

function configWith(safeTx: { url: string; key?: string }): CliConfig {
  return { safeTx } as unknown as CliConfig;
}

const BASE = 'https://safe-tx.example';

/**
 * A record as the service reports it: the fields, the Safe it belongs to, and
 * a hash that the fields actually reproduce. The adapter refuses anything else,
 * so a fixture with an invented hash would test nothing but the refusal.
 */
function recordFor(nonce: number, safe: Address = SAFE) {
  return {
    safe,
    safeTxHash: computeSafeTxHash({
      chainId: CHAIN_ID,
      safe,
      tx: { to: TARGET, value: 1000n, data: '0x1234', operation: 0, nonce },
    }),
    nonce,
    to: TARGET,
    value: '1000',
    data: '0x1234',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO,
    refundReceiver: ZERO,
    confirmations: [],
    confirmationsRequired: 2,
    isExecuted: false,
    dataDecoded: {
      method: 'addOwnerWithThreshold',
      parameters: [{ name: 'owner', value: OWNER_B, type: 'address' }],
    },
  };
}

const RECORD_JSON = recordFor(7);

describe('makeSafeTxService', () => {
  it('sends the key as a Bearer token and strips trailing slashes from the base', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { results: [] } }]);
    const service = makeSafeTxService({
      config: configWith({ url: `${BASE}/`, key: 'secret' }),
      fetchImpl,
    });

    await service.pending(SAFE);

    expect(calls[0]?.url).toBe(
      `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&ordering=nonce&limit=100`,
    );
    expect(calls[0]?.headers.authorization).toBe('Bearer secret');
  });

  it('follows `next` to reach a nonce on a later page, and reports the walk complete', async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          count: 3,
          next: `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&ordering=nonce&limit=1&offset=1`,
          results: [recordFor(7)],
        },
      },
      {
        body: {
          next: `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&ordering=nonce&limit=1&offset=2`,
          results: [recordFor(8)],
        },
      },
      { body: { count: 3, next: null, results: [recordFor(9)] } },
    ]);

    const { records, complete } = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).pending(SAFE);

    expect(complete).toBe(true);
    expect(records.map((record) => record.nonce)).toEqual([7, 8, 9]);
    // The second request goes to the configured base, not to `base` + the
    // absolute link the service returned.
    expect(calls[1]?.url).toBe(
      `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&ordering=nonce&limit=1&offset=1`,
    );
  });

  it('walks every page it may read, even when the wanted nonce is on the first', async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          next: `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/?offset=1`,
          results: [recordFor(7)],
        },
      },
      { body: { next: null, results: [recordFor(8)] } },
    ]);

    const { records, complete } = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).pending(SAFE);

    // Nothing about the walk depends on the order the pages arrive in: it reads
    // to the end of what it may read, and only then says the queue is exhausted.
    expect(complete).toBe(true);
    expect(calls).toHaveLength(2);
    expect(records.map((record) => record.nonce)).toEqual([7, 8]);
  });

  it('does not call a full last page the end of the queue', async () => {
    // A page of exactly the size it asked for, with no `next`: the service may
    // have truncated it, so "nothing at that nonce" is not an answer yet.
    const { fetchImpl } = fakeFetch([
      { body: { count: 100, next: null, results: Array.from({ length: 100 }, () => recordFor(7)) } },
    ]);

    const { complete } = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).pending(SAFE);

    expect(complete).toBe(false);
  });

  it('does not call the walk complete when the declared count is larger than what arrived', async () => {
    const { fetchImpl } = fakeFetch([
      { body: { count: 4, next: null, results: [recordFor(7), recordFor(8)] } },
    ]);

    const { complete } = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).pending(SAFE);

    expect(complete).toBe(false);
  });

  it('says the walk stopped at the cap rather than claiming the queue is exhausted', async () => {
    // Every page advertises another one: the cap is what ends the walk.
    const { fetchImpl, calls } = fakeFetch(
      Array.from({ length: 6 }, () => ({
        body: {
          next: `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/?offset=1`,
          results: [recordFor(7)],
        },
      })),
    );

    const { complete } = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).pending(SAFE);

    expect(complete).toBe(false);
    expect(calls).toHaveLength(5);
  });

  it('sends no Authorization header without a key', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { results: [] } }]);
    await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).pending(SAFE);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('raises a usage error when safeTx.url is unset, instead of failing at the socket', () => {
    try {
      makeSafeTxService({ config: configWith({ url: '' }), fetchImpl: fakeFetch([]).fetchImpl });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).message).toContain('safeTx.url');
    }
  });

  it('registers a Safe the service does not know', async () => {
    // GET → 404, then POST → 201.
    const { fetchImpl, calls } = fakeFetch([{ status: 404 }, { status: 201, body: {} }]);
    const service = makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl });

    await service.register(SAFE, { owners: [OWNER_A, OWNER_B], threshold: 2 });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/api/v1/safes/${SAFE}/`);
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toBe(`${BASE}/api/v1/safes/`);
    expect(calls[1]?.body).toEqual({
      address: SAFE,
      owners: [OWNER_A, OWNER_B],
      threshold: 2,
      singleton: SAFE_L2_SINGLETON,
      fallbackHandler: SAFE_FALLBACK_HANDLER,
      implementationVersion: '1.4.1',
      delegate: SAFE,
    });
    // No module claim: this caller did not state one, and the service serves
    // whatever it is told as the Safe's real module set.
    expect(calls[1]?.body).not.toHaveProperty('modules');
  });

  it('declares the modules the caller names rather than asserting none', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 404 }, { status: 201, body: {} }]);
    await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).register(SAFE, {
      owners: [OWNER_A],
      threshold: 1,
      modules: [TARGET],
    });
    expect((calls[1]?.body as { modules: string[] }).modules).toEqual([TARGET]);
  });

  it('leaves an already-registered Safe alone', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { address: SAFE } }]);
    await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).register(SAFE, {
      owners: [OWNER_A],
      threshold: 1,
      version: '1.4.1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it("posts the caller's signature verbatim and a sender that matches it", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: {} }]);
    const service = makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
      chainId: CHAIN_ID,
    });
    const signature = await accountA.sign({ hash: SAFE_TX_HASH });

    const { safeTxHash } = await service.propose({
      safe: SAFE,
      sender: accountA.address,
      tx: ADD_OWNER_TX,
      signature,
    });

    expect(safeTxHash).toBe(SAFE_TX_HASH);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE}/api/v1/safes/${SAFE}/multisig-transactions/`);
    expect(calls[0]?.body).toEqual({
      to: SAFE,
      value: '0',
      data: ADD_OWNER_TX.data,
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: 7,
      contractTransactionHash: safeTxHash,
      sender: accountA.address,
      signature,
      origin: 's2s',
    });

    // The service files the body's signature as the sender's confirmation, so it
    // has to be the sender's own over the hash — not a placeholder and not
    // somebody else's.
    const body = calls[0]?.body as { signature: Hex; sender: Address };
    expect(await recoverAddress({ hash: safeTxHash, signature: body.signature })).toBe(
      accountA.address,
    );
  });

  it.each([
    ['an empty 0x', '0x'],
    ['64 bytes', `0x${'11'.repeat(64)}`],
    ['130 bytes', `0x${'11'.repeat(130)}`],
  ])('refuses %s before the request', async (_shape, signature) => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: {} }]);
    const service = makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
      chainId: CHAIN_ID,
    });

    await expect(
      service.propose({
        safe: SAFE,
        sender: accountA.address,
        tx: ADD_OWNER_TX,
        signature: signature as Hex,
      }),
    ).rejects.toMatchObject({ code: 'signature_malformed' });
    // The service answers 422 {"signature":["This field may not be blank."]} to
    // the empty one; the round trip is not worth spending on any of them.
    expect(calls).toHaveLength(0);
  });

  it('refuses a signature that recovers to a key other than sender', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: {} }]);
    const service = makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
      chainId: CHAIN_ID,
    });
    // A real signature, by the wrong key: the shape is perfect and the service
    // would still refuse it as that address's confirmation.
    const signature = await accountB.sign({ hash: SAFE_TX_HASH });

    await expect(
      service.propose({
        safe: SAFE,
        sender: accountA.address,
        tx: ADD_OWNER_TX,
        signature,
      }),
    ).rejects.toMatchObject({ code: 'signature_sender_mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('posts the gas fields the hash was computed from', async () => {
    // A proposal that pays: hashing zeros and posting these would file it under
    // a hash its own body does not produce.
    const paying: SafeTxInput = {
      ...ADD_OWNER_TX,
      safeTxGas: 21000n,
      baseGas: 3000n,
      gasPrice: 1000000000n,
      gasToken: OWNER_B,
      refundReceiver: OWNER_A,
    };
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: {} }]);
    const service = makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
      chainId: CHAIN_ID,
    });

    const { safeTxHash } = await service.propose({
      safe: SAFE,
      sender: accountA.address,
      tx: paying,
      signature: await accountA.sign({
        hash: computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: paying }),
      }),
    });

    expect(calls[0]?.body).toMatchObject({
      safeTxGas: '21000',
      baseGas: '3000',
      gasPrice: '1000000000',
      gasToken: OWNER_B,
      refundReceiver: OWNER_A,
      contractTransactionHash: safeTxHash,
    });
    expect(safeTxHash).toBe(computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: paying }));
  });

  it('defaults the hash to Base mainnet', async () => {
    const { fetchImpl } = fakeFetch([{ status: 201, body: {} }]);
    const { safeTxHash } = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).propose({
      safe: SAFE,
      sender: accountA.address,
      tx: ADD_OWNER_TX,
      signature: await accountA.sign({ hash: SAFE_TX_HASH }),
    });

    expect(safeTxHash).toBe(computeSafeTxHash({ chainId: 8453, safe: SAFE, tx: ADD_OWNER_TX }));
  });

  it('reads a record by hash, not through the Safe collection', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: RECORD_JSON }]);
    const record = await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(
      SAFE,
      RECORD_JSON.safeTxHash,
    );

    expect(calls[0]?.url).toBe(`${BASE}/api/v1/multisig-transactions/${RECORD_JSON.safeTxHash}/`);
    expect(record).toEqual({
      safeTxHash: RECORD_JSON.safeTxHash,
      safe: SAFE,
      nonce: 7,
      to: TARGET,
      value: '1000',
      data: '0x1234',
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO,
      refundReceiver: ZERO,
      confirmations: [],
      confirmationsRequired: 2,
      isExecuted: false,
      dataDecoded: {
        method: 'addOwnerWithThreshold',
        parameters: [{ name: 'owner', value: OWNER_B }],
      },
    });
  });

  it('maps the pending list in nonce order, whatever order it arrives in', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: {
          count: 3,
          results: [recordFor(8), recordFor(7), recordFor(9)],
        },
      },
    ]);

    const { records, complete } = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).pending(SAFE);

    expect(complete).toBe(true);
    expect(records.map((record) => [record.nonce, record.safeTxHash])).toEqual([
      [7, recordFor(7).safeTxHash],
      [8, recordFor(8).safeTxHash],
      [9, recordFor(9).safeTxHash],
    ]);
    expect(records.map((record) => record.safe)).toEqual([SAFE, SAFE, SAFE]);
  });

  it('reads the record, then posts the confirmation against the hash route', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: RECORD_JSON }, { status: 201, body: {} }]);
    await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).confirm({
      safe: SAFE,
      safeTxHash: RECORD_JSON.safeTxHash,
      signature: '0xdead',
    });

    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(calls[1]?.url).toBe(
      `${BASE}/api/v1/multisig-transactions/${RECORD_JSON.safeTxHash}/confirmations/`,
    );
    expect(calls[1]?.body).toEqual({ signature: '0xdead' });
  });

  it('refuses to confirm a transaction that belongs to another Safe', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: recordFor(7, TARGET) },
      { status: 201, body: {} },
    ]);
    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).confirm({
        safe: SAFE,
        safeTxHash: recordFor(7, TARGET).safeTxHash,
        signature: '0xdead',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('safe_tx_safe_mismatch');
    }
    // Nothing was signed into another Safe's queue.
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('refuses a record the service labels with another Safe', async () => {
    const { fetchImpl } = fakeFetch([{ body: recordFor(7, TARGET) }]);
    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(
        SAFE,
        recordFor(7, TARGET).safeTxHash,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('safe_tx_safe_mismatch');
      expect((err as CliError).message).toContain(TARGET);
    }
  });

  it('refuses a record with no Safe field when the route cannot prove one', async () => {
    const anonymous: Record<string, unknown> = { ...RECORD_JSON };
    delete anonymous.safe;
    const { fetchImpl } = fakeFetch([{ body: anonymous }]);
    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(
        SAFE,
        RECORD_JSON.safeTxHash,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('safe_tx_bad_response');
    }
  });

  it('refuses a record whose fields do not reproduce its own hash', async () => {
    // Same transaction, one field changed: the hash no longer describes it.
    const { fetchImpl } = fakeFetch([{ body: { ...RECORD_JSON, value: '2000' } }]);
    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(
        SAFE,
        RECORD_JSON.safeTxHash,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('safe_tx_hash_mismatch');
    }
  });

  it('refuses a record for a different hash than the route named', async () => {
    // Self-consistent on its own terms — the fields reproduce its hash — but it
    // is not the proposal the caller asked for.
    const other = recordFor(8);
    const { fetchImpl } = fakeFetch([{ body: other }]);
    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(
        SAFE,
        RECORD_JSON.safeTxHash,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('safe_tx_wrong_transaction');
      expect((err as CliError).message).toContain(RECORD_JSON.safeTxHash);
      expect((err as CliError).message).toContain(other.safeTxHash);
    }
  });

  it('refuses to confirm when the read answers a different proposal', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: recordFor(8) },
      { status: 201, body: {} },
    ]);
    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).confirm({
        safe: SAFE,
        safeTxHash: RECORD_JSON.safeTxHash,
        signature: '0xdead',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('safe_tx_wrong_transaction');
    }
    // The POST never happened: no signature was filed against another proposal.
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('turns a non-2xx into a CliError carrying the status and the body text', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 422, body: { nonFieldErrors: ['hash mismatch'] } },
      { status: 422, body: { nonFieldErrors: ['hash mismatch'] } },
    ]);

    await expect(
      makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(SAFE, '0xabc'),
    ).rejects.toThrow(/422.*hash mismatch/);

    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(SAFE, '0xabc');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('safe_tx_http');
    }
  });

  it('names the endpoint when the service is unreachable', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;

    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).pending(SAFE);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('safe_tx_unreachable');
      expect((err as CliError).message).toContain(BASE);
    }
  });
});

// ===========================================================================
// Config
// ===========================================================================

describe('safeTx config', () => {
  it('defaults to the public Base host with no key', () => {
    expect(loadConfig({}, nowhere).safeTx).toEqual({
      url: 'https://safe-transaction-base.safe.global',
      key: undefined,
    });
  });

  it('takes the URL and the key from the env', () => {
    const config = loadConfig(
      { S2S_SAFE_TX_URL: 'https://internal.example', S2S_SAFE_TX_API_KEY: 'k3y' },
      nowhere,
    );
    expect(config.safeTx).toEqual({ url: 'https://internal.example', key: 'k3y' });
  });
});
