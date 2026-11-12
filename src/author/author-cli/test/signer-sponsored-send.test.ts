// ============================================================================
// The sponsored send itself: what a userOp carries, and what its receipt means.
//
// No socket and no stub account. The account is a real
// `SafeSmartAccount.toSafeSmartAccount` bound to an address (so it needs no
// factory read), the client is permissionless' own `createSmartAccountClient`,
// and its transport is `custom` — viem's in-memory transport, which hands each
// JSON-RPC request to this file instead of to a URL. What the test asserts on is
// therefore the exact `callData` a bundler would receive.
//
// This is the layer the command tests cannot see: they stub `sendSponsored`, so
// a send that encoded no call at all, or that reported a reverted userOp as
// success, passed all of them.
// ============================================================================

import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  createPublicClient,
  custom,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Address } from 'viem/account-abstraction';
import { createSmartAccountClient } from 'permissionless';
import { SafeSmartAccount } from 'permissionless/accounts/safe';
import { describe, expect, it } from 'vitest';

import {
  sendCallAsUserOp,
  SponsoredSendRefused,
  SponsoredSendReverted,
  SponsoredSendUncertain,
} from '../src/adapters/tx-runner';
import { read4337From, type Safe4337Reads } from '../src/commands/signer-store';
import { SAFE_4337_MODULE } from '../src/core/author-safe';
import { SAFE_FALLBACK_HANDLER_SLOT, addressFromWord } from '../src/core/author-contracts';

/** The Safe the userOp comes from. Bound, so the account reads no factory. */
const SAFE: Address = '0x1111111111111111111111111111111111111111';
const KEY_OWNER: Hex = `0x${'00'.repeat(31)}01`;
const USER_OP_HASH: Hex = `0x${'11'.repeat(32)}`;
/** What `feeOverrides()` returns with a paymaster configured: explicit prices. */
const FEES = { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
const TX_HASH: Hex = `0x${'22'.repeat(32)}`;

/**
 * The two selectors this test is about. `0x6a761202` is
 * `execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)`
 * and `0x541d63c8` is
 * `executeUserOpWithErrorString(address,uint256,bytes,uint8)`, which is how a
 * Safe 1.4.1 account's `encodeCalls` wraps a single call before the module ever
 * sees it.
 */
const EXEC_TRANSACTION = '0x6a761202';
const EXECUTE_USER_OP = '0x541d63c8';

const EXECUTE_USER_OP_ABI = parseAbi([
  'function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)',
]);

/** `execTransaction`'s calldata for the Safe, with one 65-byte signature. */
const SIGNATURE: Hex = `0x${'ab'.repeat(65)}`;
const EXEC_DATA: Hex = encodeFunctionData({
  abi: parseAbi([
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
  ]),
  functionName: 'execTransaction',
  args: [
    SAFE,
    0n,
    '0x',
    0,
    0n,
    0n,
    0n,
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000',
    SIGNATURE,
  ],
});

/** A receipt as viem's `waitForUserOperationReceipt` returns it. */
function userOpReceipt(input: { success: boolean; reason?: string }): Record<string, unknown> {
  return {
    userOpHash: USER_OP_HASH,
    entryPoint: entryPoint07Address,
    sender: SAFE,
    nonce: '0x1',
    paymaster: '0x0000000000000000000000000000000000000000',
    actualGasCost: '0x1',
    actualGasUsed: '0x1',
    success: input.success,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    logs: [],
    receipt: {
      transactionHash: TX_HASH,
      transactionIndex: '0x0',
      blockHash: `0x${'33'.repeat(32)}`,
      blockNumber: '0x1',
      from: '0x0000000000000000000000000000000000000000',
      to: entryPoint07Address,
      cumulativeGasUsed: '0x1',
      gasUsed: '0x1',
      contractAddress: null,
      logs: [],
      logsBloom: `0x${'00'.repeat(256)}`,
      status: input.success ? '0x1' : '0x0',
      type: '0x2',
      effectiveGasPrice: '0x1',
    },
  };
}

interface Bundler {
  /** A permissionless smart-account client wired to this fake bundler. */
  client: Parameters<typeof sendCallAsUserOp>[0];
  /** Every JSON-RPC method the client called, in order. */
  methods: string[];
  /** The userOp from `eth_sendUserOperation`, as the bundler would decode it. */
  submitted(): { callData: Hex; sender: Address };
}

/**
 * A client whose bundler answers from this file. `submit` and `receipt` decide
 * how, so a rejection at either phase can be tested without a socket.
 */
async function bundler(options: {
  submit?: () => never;
  receipt?: () => Record<string, unknown>;
} = {}): Promise<Bundler> {
  const methods: string[] = [];
  let submitted: { callData: Hex; sender: Address } | undefined;

  /** Answer one JSON-RPC request. `unknown` in and out, so nothing here is `any`. */
  const reply = (method: string, params: unknown): unknown => {
    switch (method) {
      case 'eth_chainId':
        return `0x${base.id.toString(16)}`;
      case 'eth_getCode':
        return '0xdeadbeef';
      case 'eth_call':
        // EntryPoint's `getNonce`; any small number will do.
        return `0x${'00'.repeat(31)}01`;
      case 'eth_estimateUserOperationGas':
        return {
          preVerificationGas: '0x10000',
          verificationGasLimit: '0x100000',
          callGasLimit: '0x100000',
          paymasterVerificationGasLimit: '0x1000',
          paymasterPostOpGasLimit: '0x1000',
        };
      case 'eth_sendUserOperation': {
        if (options.submit) options.submit();
        const first = (params as readonly { callData: string; sender: Address }[])[0];
        if (!first) throw new Error('no userOp in eth_sendUserOperation');
        submitted = { callData: first.callData as Hex, sender: first.sender };
        return USER_OP_HASH;
      }
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return '0x1';
      case 'eth_getUserOperationReceipt':
        return options.receipt ? options.receipt() : userOpReceipt({ success: true });
      default:
        throw new Error(`unexpected JSON-RPC method ${method}`);
    }
  };

  const transport = custom({
    // viem types this argument `any`; the two fields are all this fake reads.
    request: (args: { method: string; params?: unknown }) => {
      methods.push(args.method);
      return Promise.resolve(reply(args.method, args.params));
    },
  });

  const client = createPublicClient({ chain: base, transport });
  const account = await SafeSmartAccount.toSafeSmartAccount({
    client,
    owners: [privateKeyToAccount(KEY_OWNER)],
    version: '1.4.1',
    address: SAFE,
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  return {
    client: createSmartAccountClient({ account, chain: base, bundlerTransport: transport }),
    methods,
    submitted: () => {
      if (!submitted) throw new Error('no userOp was submitted');
      return submitted;
    },
  };
}

describe('the sponsored send — what the userOp carries', () => {
  it('sends execTransaction inside the userOp, signatures included, not an empty call', async () => {
    const fake = await bundler();

    const hash = await sendCallAsUserOp(fake.client, {
      to: SAFE,
      data: EXEC_DATA,
      fees: FEES,
    });

    expect(hash).toBe(TX_HASH);
    const userOp = fake.submitted();
    expect(userOp.sender).toBe(SAFE);
    // The Safe account wraps a single call in `executeUserOpWithErrorString`, so
    // the outer prefix is that selector, and the `execTransaction` calldata is
    // its `data` argument. A userOp with no calls produced `0x` here.
    expect(userOp.callData.startsWith(EXECUTE_USER_OP)).toBe(true);
    const wrapped = decodeFunctionData({ abi: EXECUTE_USER_OP_ABI, data: userOp.callData });
    expect(wrapped.functionName).toBe('executeUserOpWithErrorString');
    const [to, , data, operation] = wrapped.args;
    expect(to).toBe(SAFE);
    expect(operation).toBe(0);
    // The call the Safe makes on itself is the `execTransaction` of the proposal.
    expect(data.startsWith(EXEC_TRANSACTION)).toBe(true);
    // And the assembled signatures ride inside it, which is the whole point: the
    // Safe validates this userOp with the owner's signature, then executes.
    expect(data.slice(2 + 8).includes(SIGNATURE.slice(2))).toBe(true);
    // Submission first, then the receipt: the two phases the errors are tagged on.
    expect(fake.methods.indexOf('eth_sendUserOperation')).toBeLessThan(
      fake.methods.indexOf('eth_getUserOperationReceipt'),
    );
  });
});

describe('the sponsored send — what its receipt means', () => {
  it('reports a reverted userOp as a failure naming the transaction', async () => {
    const fake = await bundler({
      receipt: () => userOpReceipt({ success: false, reason: 'GS026' }),
    });

    const err = await sendCallAsUserOp(fake.client, {
      to: SAFE,
      data: EXEC_DATA,
      fees: FEES,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // `waitForUserOperationReceipt` resolves for a reverted userOp: only
    // `success` distinguishes "the call ran" from "the transaction exists".
    expect(err).toBeInstanceOf(SponsoredSendReverted);
    const reverted = err as SponsoredSendReverted;
    expect(reverted.transactionHash).toBe(TX_HASH);
    expect(reverted.reason).toBe('GS026');
    expect(reverted.message).toContain(TX_HASH);
    expect(reverted.message).toContain('GS026');
  });

  it('names the transaction when a reverted userOp carries no reason', async () => {
    const fake = await bundler({ receipt: () => userOpReceipt({ success: false }) });

    const err = await sendCallAsUserOp(fake.client, { to: SAFE, data: EXEC_DATA, fees: FEES }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(SponsoredSendReverted);
    expect((err as SponsoredSendReverted).reason).toBeUndefined();
    expect((err as Error).message).toContain(TX_HASH);
  });

  it('reports a rejected submission as refused, before anything is submitted', async () => {
    const fake = await bundler({
      submit: () => {
        throw new Error('paymaster refused: policy denied (AA31 paymaster deposit too low)');
      },
    });

    const err = await sendCallAsUserOp(fake.client, { to: SAFE, data: EXEC_DATA, fees: FEES }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(SponsoredSendRefused);
    expect((err as Error).message).toContain('AA31');
    expect((err as Error).message).toContain('policy denied');
  });

  it('reports a receipt that never arrives as uncertain, carrying the userOp hash', async () => {
    const fake = await bundler({
      receipt: () => {
        throw new Error('Timed out while waiting for user operation receipt to be included');
      },
    });

    const err = await sendCallAsUserOp(fake.client, { to: SAFE, data: EXEC_DATA, fees: FEES }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // The submission happened, so this is the phase that may have landed.
    expect(err).toBeInstanceOf(SponsoredSendUncertain);
    expect((err as SponsoredSendUncertain).userOpHash).toBe(USER_OP_HASH);
  });
});

describe('reading the Safe 4337 state', () => {
  /** Reads that answer from a storage word and one boolean. */
  function reads(word: Hex | undefined, moduleEnabled: boolean): Safe4337Reads {
    return {
      word: (slot) => {
        expect(slot).toBe(SAFE_FALLBACK_HANDLER_SLOT);
        return Promise.resolve(word);
      },
      moduleEnabled: (module) => {
        expect(module).toBe(SAFE_4337_MODULE);
        return Promise.resolve(moduleEnabled);
      },
    };
  }

  const asWord = (address: Address): Hex =>
    `0x${'00'.repeat(12)}${address.slice(2)}` as Hex;

  it('reads the module installed as the fallback handler out of storage', async () => {
    const state = await read4337From(reads(asWord(SAFE_4337_MODULE), true));
    expect(state.moduleEnabled).toBe(true);
    expect(state.fallbackHandler).toBe(SAFE_4337_MODULE);
  });

  it('reads a different handler installed in the same slot', async () => {
    const other: Address = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
    const state = await read4337From(reads(asWord(other), false));
    expect(state.fallbackHandler).toBe(other);
    expect(state.moduleEnabled).toBe(false);
  });

  it('reports no handler when the slot is empty', async () => {
    // Safe 1.4.1 has no `getFallbackHandler()`: an empty slot is the only honest
    // answer, and the caller says the module cannot validate a userOp.
    const state = await read4337From(reads(undefined, false));
    expect(state.fallbackHandler).toBeNull();
  });

  it('decodes an address from the low 20 bytes of a storage word', () => {
    expect(addressFromWord(`0x${'ff'.repeat(12)}${SAFE.slice(2)}`)).toBe(SAFE);
    expect(addressFromWord(`0x${'00'.repeat(32)}`)).toBeNull();
    expect(addressFromWord(undefined)).toBeNull();
  });
});
