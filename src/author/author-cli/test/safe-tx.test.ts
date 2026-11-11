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
  hashMessage,
  keccak256,
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
  packSignatures,
  packVerifiedSignatures,
  SAFE_FALLBACK_HANDLER,
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

describe('packSignatures', () => {
  /** Replace the trailing v byte. */
  const withV = (signature: Hex, v: number): Hex =>
    `0x${signature.slice(2, -2)}${v.toString(16).padStart(2, '0')}` as Hex;

  const ascending = (addresses: Address[]): Address[] =>
    [...addresses].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

  it('orders by address ascending and bumps a message signature to 31/32', async () => {
    const sigA = await accountA.signMessage({ message: { raw: SAFE_TX_HASH } });
    const sigB = await accountB.signMessage({ message: { raw: SAFE_TX_HASH } });

    // Given in the wrong order, and keyed by checksummed address.
    const packed = packSignatures(
      [accountB.address, accountA.address],
      new Map([
        [accountB.address, sigB],
        [accountA.address, sigA],
      ]),
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

  it('refuses an owner it has no signature for', () => {
    try {
      packSignatures([accountA.address], new Map());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('signature_missing');
    }
  });

  it('keeps a signature that already carries the eth_sign flag', async () => {
    const message = await accountA.signMessage({ message: { raw: SAFE_TX_HASH } });
    const flagged = withV(message, message.endsWith('1b') ? 0x1f : 0x20);
    expect(packSignatures([accountA.address], new Map([[accountA.address, flagged]]))).toBe(flagged);
  });

  it('refuses a signature that is not 65 bytes', () => {
    try {
      packSignatures([accountA.address], new Map([[accountA.address, '0x1234']]));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('signature_malformed');
    }
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

  it('refuses a record with no Safe address to send to', () => {
    expect(() => execTransactionArgs({ ...record, safe: undefined }, '0xdead')).toThrowError(
      CliError,
    );
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
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ??
      {}) as unknown as Record<string, string>;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    const reply = script[calls.length - 1] ?? { status: 200, body: {} };
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function configWith(safeTx: { url: string; key?: string }): CliConfig {
  return { safeTx } as unknown as CliConfig;
}

const BASE = 'https://safe-tx.example';

const RECORD_JSON = {
  safeTxHash: '0xabc',
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
    parameters: [{ name: 'owner', value: OWNER_B, type: 'address' }],
  },
};

describe('makeSafeTxService', () => {
  it('sends the key as a Bearer token and strips trailing slashes from the base', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { results: [] } }]);
    const service = makeSafeTxService({
      config: configWith({ url: `${BASE}/`, key: 'secret' }),
      fetchImpl,
    });

    await service.pending(SAFE);

    expect(calls[0]?.url).toBe(
      `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&ordering=nonce`,
    );
    expect(calls[0]?.headers.authorization).toBe('Bearer secret');
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
      modules: [],
      delegate: SAFE,
    });
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

  it('proposes the transaction with its hash, zero gas and no signature', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: {} }]);
    const service = makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
      chainId: CHAIN_ID,
    });

    const { safeTxHash } = await service.propose({ safe: SAFE, sender: OWNER_A, tx: ADD_OWNER_TX });

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
      sender: OWNER_A,
      signature: '0x',
      origin: 's2s',
    });
  });

  it('defaults the hash to Base mainnet', async () => {
    const { fetchImpl } = fakeFetch([{ status: 201, body: {} }]);
    const { safeTxHash } = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).propose({ safe: SAFE, sender: OWNER_A, tx: ADD_OWNER_TX });

    expect(safeTxHash).toBe(computeSafeTxHash({ chainId: 8453, safe: SAFE, tx: ADD_OWNER_TX }));
  });

  it('reads a record by hash, not through the Safe collection', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: RECORD_JSON }]);
    const record = await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(
      SAFE,
      '0xabc',
    );

    expect(calls[0]?.url).toBe(`${BASE}/api/v1/multisig-transactions/0xabc/`);
    expect(record).toEqual({
      safeTxHash: '0xabc',
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
          results: [
            { ...RECORD_JSON, safeTxHash: '0xbbb', nonce: 8 },
            { ...RECORD_JSON, safeTxHash: '0xaaa', nonce: 7 },
            { ...RECORD_JSON, safeTxHash: '0xccc', nonce: 9 },
          ],
        },
      },
    ]);

    const records = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).pending(SAFE);

    expect(records.map((record) => [record.nonce, record.safeTxHash])).toEqual([
      [7, '0xaaa'],
      [8, '0xbbb'],
      [9, '0xccc'],
    ]);
    expect(records.map((record) => record.safe)).toEqual([SAFE, SAFE, SAFE]);
  });

  it('posts a confirmation against the hash route', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: {} }]);
    await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).confirm({
      safe: SAFE,
      safeTxHash: '0xabc',
      signature: '0xdead',
    });

    expect(calls[0]?.url).toBe(`${BASE}/api/v1/multisig-transactions/0xabc/confirmations/`);
    expect(calls[0]?.body).toEqual({ signature: '0xdead' });
  });

  it('turns a non-2xx into a CliError carrying the status and the body text', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 422, body: { nonFieldErrors: ['hash mismatch'] } },
      { status: 422, body: { nonFieldErrors: ['hash mismatch'] } },
    ]);

    await expect(
      makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(SAFE, '0xabc'),
    ).rejects.toThrowError(/422.*hash mismatch/);

    try {
      await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(SAFE, '0xabc');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('safe_tx_http');
    }
  });

  it('names the endpoint when the service is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

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
