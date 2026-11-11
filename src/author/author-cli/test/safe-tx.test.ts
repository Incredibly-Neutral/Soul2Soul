// ============================================================================
// Safe Transaction Service adapter — the hashing and the transport.
//
// No test here opens a socket: every request goes through the fake `fetch`
// below, and every hash assertion is either a pinned literal or a second,
// hand-written EIP-712 computation of the same digest.
// ============================================================================

import {
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  stringToHex,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { safeAbi } from '@s2s/soul2soul-shared';

import {
  addOwnerWithThresholdData,
  computeSafeTxHash,
  execTransactionArgs,
  makeSafeTxService,
  packSignatures,
  SAFE_FALLBACK_HANDLER,
  type SafeTxInput,
  type SafeTxRecord,
} from '../src/adapters/safe-tx';
import { SAFE_L2_SINGLETON } from '../src/core/author-safe';
import { loadConfig, type CliConfig } from '../src/core/config';
import { CliError } from '../src/lib/errors';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const OWNER_A = '0x1111111111111111111111111111111111111111' as const;
const OWNER_B = '0x2222222222222222222222222222222222222222' as const;
const ORDER_LOW = '0x1111111111111111111111111111111111111111' as const;
const ORDER_HIGH = '0x9999999999999999999999999999999999999999' as const;
const TARGET = '0x3333333333333333333333333333333333333333' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const CHAIN_ID = 8453;

/** The proposal `s2s signer add` makes: add OWNER_B at threshold 2, nonce 7. */
const ADD_OWNER_TX: SafeTxInput = {
  to: SAFE,
  value: 0n,
  data: addOwnerWithThresholdData(OWNER_B, 2),
  operation: 0,
  nonce: 7,
};

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
   * The fixture is derived from the EIP-712 definition — domain
   * `{chainId, verifyingContract}`, the ten-field SafeTx struct — and checked
   * against a second, hand-written encoding in the test below. It has NOT been
   * compared against a live Safe: the whole point of pinning it is to catch a
   * silent change to the domain or the struct on the day someone edits them,
   * not to prove the chain agrees. `Safe.getTransactionHash` is the proof, and
   * it must return this same value.
   */
  const EXPECTED = '0xf9224ce364e9091d7c03fa8cae100ef7e729d050233bdf975a91a1fb904a79ed';

  it('matches the pinned digest for a fixed proposal', () => {
    expect(computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: ADD_OWNER_TX })).toBe(EXPECTED);
  });

  it('matches a hand-written EIP-712 encoding of the same struct', () => {
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

    expect(computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: ADD_OWNER_TX })).toBe(
      keccak256(concatHex(['0x1901', domainSeparator, structHash])),
    );
  });

  it('carries the chain id in the domain', () => {
    const other = computeSafeTxHash({ chainId: 1, safe: SAFE, tx: ADD_OWNER_TX });
    expect(other).not.toBe(computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: ADD_OWNER_TX }));
  });

  it('carries the Safe as verifyingContract and nothing else in the domain', () => {
    const other = computeSafeTxHash({ chainId: CHAIN_ID, safe: TARGET, tx: ADD_OWNER_TX });
    expect(other).not.toBe(computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: ADD_OWNER_TX }));
  });

  it('hashes an omitted gas field as zero, not as absent', () => {
    const explicit = computeSafeTxHash({
      chainId: CHAIN_ID,
      safe: SAFE,
      tx: { ...ADD_OWNER_TX, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n },
    });
    expect(explicit).toBe(computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: ADD_OWNER_TX }));
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
  const signature = (r: string, s: string, v: string): `0x${string}` =>
    `0x${r.repeat(32)}${s.repeat(32)}${v}` as `0x${string}`;

  /** viem hands back v = 27/28 (0x1b/0x1c) for a message signature. */
  const SIG_LOW = signature('aa', 'bb', '1b');
  const SIG_HIGH = signature('cc', 'dd', '1c');

  it('orders by owner address ascending and bumps v to the eth_sign scheme', () => {
    // Given high first: the Safe walks the list and requires ascending owners.
    const packed = packSignatures(
      [ORDER_HIGH, ORDER_LOW],
      new Map([
        [ORDER_HIGH, SIG_HIGH],
        [ORDER_LOW, SIG_LOW],
      ]),
    );

    expect(packed).toBe(`0x${trimV(SIG_LOW)}1f${trimV(SIG_HIGH)}20`);
  });

  it('keeps a signature that already carries 31/32', () => {
    const already = signature('ee', 'ff', '1f');
    expect(packSignatures([ORDER_LOW], new Map([[ORDER_LOW, already]]))).toBe(already);
  });

  it('refuses an owner it has no signature for', () => {
    try {
      packSignatures([ORDER_LOW], new Map());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('signature_missing');
    }
  });

  it('refuses a signature that is not 65 bytes', () => {
    try {
      packSignatures([ORDER_LOW], new Map([[ORDER_LOW, '0x1234']]));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).code).toBe('signature_malformed');
    }
  });
});

/** `0x` + 64 bytes, everything but the prefix and the trailing v. */
function trimV(signature: `0x${string}`): string {
  return signature.slice(2, -2);
}

// ===========================================================================
// execTransaction
// ===========================================================================

describe('execTransactionArgs', () => {
  const record: SafeTxRecord = {
    safeTxHash: computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: ADD_OWNER_TX }),
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
    const decoded = decodeFunctionData({ abi: safeAbi, data: execTransactionArgs(record, '0xdead').data });
    expect(decoded.functionName).toBe('execTransaction');
    expect(decoded.args).toEqual([SAFE, 0n, ADD_OWNER_TX.data, 0, 0n, 0n, 0n, ZERO, ZERO, '0xdead']);
  });

  it('refuses a record with no Safe address to send to', () => {
    expect(() => execTransactionArgs({ ...record, safe: undefined }, '0xdead')).toThrowError(CliError);
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
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

    expect(safeTxHash).toBe(
      computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: ADD_OWNER_TX }),
    );
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

  it('reads a record and names the Safe it came from', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: RECORD_JSON }]);
    const record = await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).get(
      SAFE,
      '0xabc',
    );

    expect(calls[0]?.url).toBe(`${BASE}/api/v1/safes/${SAFE}/multisig-transactions/0xabc/`);
    expect(record).toEqual({
      safeTxHash: '0xabc',
      safe: SAFE,
      nonce: 7,
      to: TARGET,
      value: '1000',
      data: '0x1234',
      operation: 0,
      confirmations: [],
      confirmationsRequired: 2,
      isExecuted: false,
      dataDecoded: {
        method: 'addOwnerWithThreshold',
        parameters: [{ name: 'owner', value: OWNER_B }],
      },
    });
  });

  it('maps the pending list, keeping the service order', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: {
          count: 2,
          results: [
            { ...RECORD_JSON, safeTxHash: '0xaaa', nonce: 7 },
            { ...RECORD_JSON, safeTxHash: '0xbbb', nonce: 8, isExecuted: false },
          ],
        },
      },
    ]);

    const records = await makeSafeTxService({
      config: configWith({ url: BASE }),
      fetchImpl,
    }).pending(SAFE);

    expect(records.map((record) => record.safeTxHash)).toEqual(['0xaaa', '0xbbb']);
    expect(records.map((record) => record.safe)).toEqual([SAFE, SAFE]);
  });

  it('posts a confirmation as {signature}', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: {} }]);
    await makeSafeTxService({ config: configWith({ url: BASE }), fetchImpl }).confirm({
      safe: SAFE,
      safeTxHash: '0xabc',
      signature: '0xdead',
    });

    expect(calls[0]?.url).toBe(
      `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/0xabc/confirmations/`,
    );
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
    const config = loadConfig({}, nowhere);
    expect(config.safeTx).toEqual({
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
