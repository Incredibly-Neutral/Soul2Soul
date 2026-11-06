import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  parseAbiItem,
  padHex,
  slice,
  toFunctionSelector,
  type AbiFunction,
  type Hex,
} from 'viem';

import { PolicyError, checkUserOp, extractCalls, isCallAllowed } from '../src/callPolicy.js';
import type { Config } from '../src/types.js';

/* ------------------------------------------------------------- fixtures */

const TARGET = '0x2222222222222222222222222222222222222222' as const;
const TARGET_B = '0x3333333333333333333333333333333333333333' as const;
const OTHER = '0x4444444444444444444444444444444444444444' as const;
const FACTORY = '0x5555555555555555555555555555555555555555' as const;
const FACTORY_OTHER = '0x6666666666666666666666666666666666666666' as const;

const CHAIN = 8453;
const OTHER_CHAIN = 1;

const TRANSFER_ABI = parseAbiItem('function transfer(address to, uint256 amount)');
const TRANSFER_DATA = encodeFunctionData({ abi: [TRANSFER_ABI], args: [OTHER, 1n] });
const TRANSFER_SELECTOR = slice(TRANSFER_DATA, 0, 4);

const EXECUTE_ABI = parseAbiItem('function execute(address dest, uint256 value, bytes data)');
const BATCH_V7_ABI = parseAbiItem(
  'function executeBatch(address[] dest, uint256[] value, bytes[] data)',
);
const BATCH_V6_ABI = parseAbiItem('function executeBatch(address[] dest, bytes[] data)');
const BATCH_V8_ABI = parseAbiItem(
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
);
const ERC7579_ABI = parseAbiItem('function execute(bytes32 mode, bytes executionCalldata)');
const KERNEL_V2_ABI = parseAbiItem(
  'function execute(address dest, uint256 value, bytes data, uint8 operation)',
);
const SAFE_ABI = parseAbiItem(
  'function executeUserOp(address dest, uint256 value, bytes data, uint8 operation)',
);
const SAFE_ERROR_STRING_ABI = parseAbiItem(
  'function executeUserOpWithErrorString(address dest, uint256 value, bytes data, uint8 operation)',
);

function executeCallData(target: string, value: bigint, data: Hex): Hex {
  return encodeFunctionData({
    abi: [EXECUTE_ABI],
    args: [target as `0x${string}`, value, data],
  });
}

function batchV7CallData(
  targets: readonly string[],
  values: readonly bigint[],
  datas: readonly Hex[],
): Hex {
  return encodeFunctionData({
    abi: [BATCH_V7_ABI],
    args: [targets as readonly `0x${string}`[], values, datas],
  });
}

function batchV6CallData(targets: readonly string[], datas: readonly Hex[]): Hex {
  return encodeFunctionData({
    abi: [BATCH_V6_ABI],
    args: [targets as readonly `0x${string}`[], datas],
  });
}

function batchV8CallData(calls: readonly { target: string; value: bigint; data: Hex }[]): Hex {
  return encodeFunctionData({
    abi: [BATCH_V8_ABI],
    args: [
      calls.map((call) => ({
        target: call.target as `0x${string}`,
        value: call.value,
        data: call.data,
      })),
    ],
  });
}

/** ERC-7579 mode is a bitfield, so it is assembled rather than ABI-encoded. */
function modeField(callType: Hex, execType: Hex): Hex {
  return concatHex([callType, execType, padHex('0x', { size: 30 })]);
}

function erc7579CallData(mode: Hex, executionCalldata: Hex): Hex {
  return encodeFunctionData({ abi: [ERC7579_ABI], args: [mode, executionCalldata] });
}

function erc7579SingleMode(callType: Hex = '0x00', execType: Hex = '0x00'): Hex {
  return modeField(callType, execType);
}

function erc7579SingleExecution(target: string, value: bigint, data: Hex): Hex {
  return encodePacked(['address', 'uint256', 'bytes'], [target as `0x${string}`, value, data]);
}

function erc7579BatchExecution(
  calls: readonly { target: string; value: bigint; data: Hex }[],
): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        name: 'calls',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    [
      calls.map((call) => ({
        target: call.target as `0x${string}`,
        value: call.value,
        data: call.data,
      })),
    ],
  );
}

function expectPolicyError(fn: () => void, expected?: RegExp): PolicyError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PolicyError, `expected PolicyError, got ${String(caught)}`);
  if (expected !== undefined) {
    assert.match(caught.message, expected);
  }
  return caught;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8080,
    pimlicoApiKey: 'pim_test_secret',
    sponsorshipPolicyId: 'sp_test',
    pimlicoBaseUrl: 'http://localhost:3000',
    allowedChainIds: new Set([CHAIN]),
    allowedCalls: [],
    allowedMethods: new Set(['eth_sendUserOperation']),
    authMode: 'none',
    corsOrigins: [],
    rateLimitPerMinute: 60,
    allowNativeValue: false,
    allowDeployment: false,
    allowedFactories: [],
    trustProxy: false,
    upstreamTimeoutMs: 10_000,
    ...overrides,
  };
}

/** Config that allows TARGET + TRANSFER_SELECTOR on CHAIN only. */
function makeAllowedConfig(overrides: Partial<Config> = {}): Config {
  return makeConfig({
    allowedCalls: [{ chainId: CHAIN, target: TARGET, selector: TRANSFER_SELECTOR }],
    ...overrides,
  });
}

/* --------------------------------------------------- derived selectors */

describe('account execute selectors', () => {
  const documented: readonly (readonly [AbiFunction, string])[] = [
    [
      parseAbiItem('function execute(address dest, uint256 value, bytes calldata data)'),
      '0xb61d27f6',
    ],
    [
      parseAbiItem('function executeBatch(address[] dest, uint256[] value, bytes[] data)'),
      '0x47e1da2a',
    ],
    [parseAbiItem('function executeBatch(address[] dest, bytes[] data)'), '0x18dfb3c7'],
    [
      parseAbiItem('function executeBatch((address target, uint256 value, bytes data)[] calls)'),
      '0x34fcd5be',
    ],
    [parseAbiItem('function execute(bytes32 mode, bytes executionCalldata)'), '0xe9ae5c53'],
    [
      parseAbiItem(
        'function execute(address dest, uint256 value, bytes calldata data, uint8 operation)',
      ),
      '0x51945447',
    ],
    [
      parseAbiItem(
        'function executeUserOp(address dest, uint256 value, bytes calldata data, uint8 operation)',
      ),
      '0x7bb37428',
    ],
    [
      parseAbiItem(
        'function executeUserOpWithErrorString(address dest, uint256 value, bytes calldata data, uint8 operation)',
      ),
      '0x541d63c8',
    ],
  ];

  test('derived selectors match the documented hex', () => {
    for (const [abiItem, selector] of documented) {
      assert.equal(toFunctionSelector(abiItem), selector, abiItem.name);
    }
  });
});

/* ------------------------------------------------------------- decoding */

describe('extractCalls', () => {
  test('Simple / Light single execute(address,uint256,bytes)', () => {
    const calls = extractCalls(executeCallData(TARGET, 7n, TRANSFER_DATA));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.target.toLowerCase(), TARGET);
    assert.equal(calls[0]!.value, 7n);
    assert.equal(calls[0]!.data, TRANSFER_DATA);
  });

  test('Simple v0.7 batch executeBatch(address[],uint256[],bytes[])', () => {
    const calls = extractCalls(
      batchV7CallData([TARGET, TARGET_B], [1n, 2n], [TRANSFER_DATA, '0x']),
    );
    assert.deepEqual(
      calls.map((call) => [call.target.toLowerCase(), call.value, call.data]),
      [
        [TARGET, 1n, TRANSFER_DATA],
        [TARGET_B, 2n, '0x'],
      ],
    );
  });

  test('Simple v0.6 / Light v1 batch executeBatch(address[],bytes[]) sets value to zero', () => {
    const calls = extractCalls(batchV6CallData([TARGET, TARGET_B], [TRANSFER_DATA, '0x']));
    assert.deepEqual(
      calls.map((call) => [call.target.toLowerCase(), call.value, call.data]),
      [
        [TARGET, 0n, TRANSFER_DATA],
        [TARGET_B, 0n, '0x'],
      ],
    );
  });

  test('Simple v0.8 / Light v2 batch executeBatch((address,uint256,bytes)[])', () => {
    const calls = extractCalls(
      batchV8CallData([
        { target: TARGET, value: 3n, data: TRANSFER_DATA },
        { target: TARGET_B, value: 0n, data: '0x' },
      ]),
    );
    assert.deepEqual(
      calls.map((call) => [call.target.toLowerCase(), call.value, call.data]),
      [
        [TARGET, 3n, TRANSFER_DATA],
        [TARGET_B, 0n, '0x'],
      ],
    );
  });

  test('ERC-7579 single mode decodes the packed target/value/data', () => {
    const calls = extractCalls(
      erc7579CallData(erc7579SingleMode(), erc7579SingleExecution(TARGET, 9n, TRANSFER_DATA)),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.target.toLowerCase(), TARGET);
    assert.equal(calls[0]!.value, 9n);
    assert.equal(calls[0]!.data, TRANSFER_DATA);
  });

  test('ERC-7579 single mode yields empty data when no callData follows the header', () => {
    const calls = extractCalls(
      erc7579CallData(erc7579SingleMode(), erc7579SingleExecution(TARGET, 0n, '0x')),
    );
    assert.equal(calls[0]!.data, '0x');
    assert.equal(calls[0]!.value, 0n);
  });

  test('ERC-7579 batch mode decodes each tuple', () => {
    const calls = extractCalls(
      erc7579CallData(
        erc7579SingleMode('0x01', '0x00'),
        erc7579BatchExecution([
          { target: TARGET, value: 1n, data: TRANSFER_DATA },
          { target: TARGET_B, value: 0n, data: '0x' },
        ]),
      ),
    );
    assert.deepEqual(
      calls.map((call) => [call.target.toLowerCase(), call.value, call.data]),
      [
        [TARGET, 1n, TRANSFER_DATA],
        [TARGET_B, 0n, '0x'],
      ],
    );
  });

  test('ERC-7579 accepts exec type 0x01', () => {
    const calls = extractCalls(
      erc7579CallData(
        erc7579SingleMode('0x00', '0x01'),
        erc7579SingleExecution(TARGET, 1n, TRANSFER_DATA),
      ),
    );
    assert.equal(calls.length, 1);
  });

  test('ERC-7579 rejects staticcall and delegatecall call types', () => {
    for (const callType of ['0xfe', '0xff'] as const) {
      expectPolicyError(
        () =>
          extractCalls(
            erc7579CallData(
              erc7579SingleMode(callType, '0x00'),
              erc7579SingleExecution(TARGET, 0n, TRANSFER_DATA),
            ),
          ),
        /ERC-7579 call type/,
      );
    }
  });

  test('ERC-7579 rejects a bad exec type', () => {
    expectPolicyError(
      () =>
        extractCalls(
          erc7579CallData(
            erc7579SingleMode('0x00', '0x02'),
            erc7579SingleExecution(TARGET, 0n, TRANSFER_DATA),
          ),
        ),
      /ERC-7579 exec type/,
    );
  });

  test('ERC-7579 rejects a too-short single execution calldata', () => {
    expectPolicyError(
      () => extractCalls(erc7579CallData(erc7579SingleMode(), '0x1234')),
      /too short/,
    );
  });

  test('Kernel v2 accepts operation 0 and rejects operation 1', () => {
    const ok = encodeFunctionData({
      abi: [KERNEL_V2_ABI],
      args: [TARGET, 5n, TRANSFER_DATA, 0],
    });
    const calls = extractCalls(ok);
    assert.equal(calls[0]!.value, 5n);
    assert.equal(calls[0]!.data, TRANSFER_DATA);

    const bad = encodeFunctionData({
      abi: [KERNEL_V2_ABI],
      args: [TARGET, 5n, TRANSFER_DATA, 1],
    });
    expectPolicyError(() => extractCalls(bad), /operation 1 not allowed/);
  });

  test('Safe module accepts operation 0 and rejects operation 1', () => {
    const safeAbis: readonly AbiFunction[] = [SAFE_ABI, SAFE_ERROR_STRING_ABI];
    for (const abiItem of safeAbis) {
      const ok = encodeFunctionData({ abi: [abiItem], args: [TARGET, 0n, TRANSFER_DATA, 0] });
      assert.equal(extractCalls(ok)[0]!.data, TRANSFER_DATA);

      const bad = encodeFunctionData({ abi: [abiItem], args: [TARGET, 0n, TRANSFER_DATA, 1] });
      expectPolicyError(() => extractCalls(bad), /operation 1 not allowed/);
    }
  });

  test('rejects an unknown account execute function', () => {
    const unknown = encodeFunctionData({
      abi: [parseAbiItem('function somethingElse(uint256 x)')],
      args: [1n],
    });
    expectPolicyError(() => extractCalls(unknown), /unknown account execute function/);
  });

  test('rejects empty callData', () => {
    expectPolicyError(() => extractCalls('0x'), /empty callData/);
  });

  test('rejects a batch with zero entries', () => {
    expectPolicyError(() => extractCalls(batchV7CallData([], [], [])), /no calls/);
    expectPolicyError(() => extractCalls(batchV8CallData([])), /no calls/);
    expectPolicyError(() => extractCalls(batchV6CallData([], [])), /no calls/);
    expectPolicyError(
      () =>
        extractCalls(erc7579CallData(erc7579SingleMode('0x01', '0x00'), erc7579BatchExecution([]))),
      /no calls/,
    );
  });
});

/* --------------------------------------------------------------- policy */

describe('isCallAllowed', () => {
  test('matches target and selector case-insensitively', () => {
    const cfg = makeConfig({
      allowedCalls: [
        {
          chainId: CHAIN,
          target: TARGET.toUpperCase().replace('0X', '0x'),
          selector: '0xA9059CBB',
        },
      ],
    });
    assert.equal(isCallAllowed(cfg, CHAIN, TARGET, '0xa9059cbb'), true);
    assert.equal(isCallAllowed(cfg, CHAIN, TARGET, '0xdeadbeef'), false);
  });

  test('a wildcard selector allows any selector', () => {
    const cfg = makeConfig({ allowedCalls: [{ chainId: CHAIN, target: TARGET, selector: '*' }] });
    assert.equal(isCallAllowed(cfg, CHAIN, TARGET, '0xdeadbeef'), true);
  });
});

describe('checkUserOp', () => {
  test('allowed target + selector passes', () => {
    const cfg = makeAllowedConfig();
    checkUserOp({ callData: executeCallData(TARGET, 0n, TRANSFER_DATA) }, CHAIN, cfg);
  });

  test('wrong selector on an allowed target is rejected', () => {
    const cfg = makeAllowedConfig();
    const callData = executeCallData(
      TARGET,
      0n,
      encodeFunctionData({
        abi: [parseAbiItem('function approve(address spender, uint256 amount)')],
        args: [OTHER, 1n],
      }),
    );
    expectPolicyError(
      () => checkUserOp({ callData }, CHAIN, cfg),
      /selector 0x095ea7b3 not allowed for target 0x2222/,
    );
  });

  test('wrong target is rejected', () => {
    const cfg = makeAllowedConfig();
    const callData = executeCallData(OTHER, 0n, TRANSFER_DATA);
    expectPolicyError(
      () => checkUserOp({ callData }, CHAIN, cfg),
      /target 0x4444.* not allowed on chain 8453/,
    );
  });

  test('right target on the wrong chain is rejected', () => {
    const cfg = makeAllowedConfig();
    const callData = executeCallData(TARGET, 0n, TRANSFER_DATA);
    expectPolicyError(() => checkUserOp({ callData }, OTHER_CHAIN, cfg), /not allowed on chain 1/);
  });

  test('an entry without chainId applies on every allowed chain', () => {
    const cfg = makeConfig({ allowedCalls: [{ target: TARGET, selector: TRANSFER_SELECTOR }] });
    checkUserOp({ callData: executeCallData(TARGET, 0n, TRANSFER_DATA) }, CHAIN, cfg);
    checkUserOp({ callData: executeCallData(TARGET, 0n, TRANSFER_DATA) }, OTHER_CHAIN, cfg);
  });

  test('one bad inner call rejects the whole batch', () => {
    const cfg = makeAllowedConfig({
      allowedCalls: [
        { chainId: CHAIN, target: TARGET, selector: TRANSFER_SELECTOR },
        { chainId: CHAIN, target: TARGET_B, selector: TRANSFER_SELECTOR },
      ],
    });
    const good = batchV7CallData([TARGET, TARGET_B], [0n, 0n], [TRANSFER_DATA, TRANSFER_DATA]);
    checkUserOp({ callData: good }, CHAIN, cfg);

    const mixed = batchV7CallData(
      [TARGET, OTHER, TARGET_B],
      [0n, 0n, 0n],
      [TRANSFER_DATA, TRANSFER_DATA, TRANSFER_DATA],
    );
    expectPolicyError(() => checkUserOp({ callData: mixed }, CHAIN, cfg), /target 0x4444/);
  });

  test('native value is rejected by default and allowed with allowNativeValue', () => {
    const callData = executeCallData(TARGET, 1n, '0x');
    const strict = makeConfig({
      allowedCalls: [{ chainId: CHAIN, target: TARGET, selector: '*' }],
    });
    expectPolicyError(() => checkUserOp({ callData }, CHAIN, strict), /native value not allowed/);

    const permissive = makeConfig({
      allowedCalls: [{ chainId: CHAIN, target: TARGET, selector: '*' }],
      allowNativeValue: true,
    });
    checkUserOp({ callData }, CHAIN, permissive);
  });

  test('deployment is rejected unless allowDeployment', () => {
    const callData = executeCallData(TARGET, 0n, TRANSFER_DATA);
    expectPolicyError(
      () => checkUserOp({ callData, factory: FACTORY }, CHAIN, makeAllowedConfig()),
      /deployment not allowed/,
    );
    checkUserOp(
      { callData, factory: FACTORY },
      CHAIN,
      makeAllowedConfig({ allowDeployment: true }),
    );
  });

  test('initCode deployment is gated the same way', () => {
    const callData = executeCallData(TARGET, 0n, TRANSFER_DATA);
    const initCode = concatHex([FACTORY, '0xdeadbeef']);
    expectPolicyError(
      () => checkUserOp({ callData, initCode }, CHAIN, makeAllowedConfig()),
      /deployment not allowed/,
    );
    checkUserOp({ callData, initCode }, CHAIN, makeAllowedConfig({ allowDeployment: true }));
  });

  test('a populated factory allowlist rejects unlisted factories', () => {
    const callData = executeCallData(TARGET, 0n, TRANSFER_DATA);
    const cfg = makeAllowedConfig({ allowDeployment: true, allowedFactories: [FACTORY] });

    expectPolicyError(
      () => checkUserOp({ callData, factory: FACTORY_OTHER }, CHAIN, cfg),
      /factory not allowed/,
    );
    checkUserOp({ callData, factory: FACTORY }, CHAIN, cfg);
    checkUserOp({ callData, factory: FACTORY.toUpperCase().replace('0X', '0x') }, CHAIN, cfg);
  });

  test('rejects malformed user operations as PolicyError, never a crash', () => {
    const cfg = makeAllowedConfig();
    for (const userOp of [null, undefined, 'not an object', 42, []]) {
      expectPolicyError(() => checkUserOp(userOp, CHAIN, cfg), /must be an object/);
    }
    expectPolicyError(() => checkUserOp({}, CHAIN, cfg), /callData must be a hex string/);
    expectPolicyError(
      () => checkUserOp({ callData: 123 }, CHAIN, cfg),
      /callData must be a hex string/,
    );
    expectPolicyError(
      () => checkUserOp({ callData: 'nothex' }, CHAIN, cfg),
      /callData must be a hex string/,
    );
    expectPolicyError(
      () => checkUserOp({ callData: '0xzzzz' }, CHAIN, cfg),
      /callData must be a hex string/,
    );
    expectPolicyError(() => checkUserOp({ callData: '0x' }, CHAIN, cfg), /empty callData/);
  });

  test('rejects an EIP-7702 authorization: the delegate would be the code that runs', () => {
    const cfg = makeAllowedConfig();
    const callData = executeCallData(TARGET, 0n, TRANSFER_DATA);
    const auth = {
      chainId: String(CHAIN),
      address: OTHER,
      nonce: '0x0',
      yParity: '0x0',
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    };

    expectPolicyError(
      () => checkUserOp({ callData, eip7702Auth: auth }, CHAIN, cfg),
      /eip7702Auth not allowed/,
    );
    expectPolicyError(
      () => checkUserOp({ callData, authorizationList: [auth] }, CHAIN, cfg),
      /authorizationList not allowed/,
    );
    // A packed auth tuple on its own is a present authorization too.
    expectPolicyError(
      () => checkUserOp({ callData, eip7702Auth: `0x${'33'.repeat(97)}` }, CHAIN, cfg),
      /eip7702Auth not allowed/,
    );
  });

  test('accepts an absent, null or empty authorization field', () => {
    const cfg = makeAllowedConfig();
    const callData = executeCallData(TARGET, 0n, TRANSFER_DATA);

    checkUserOp({ callData }, CHAIN, cfg);
    for (const empty of [undefined, null, '', '0x', []]) {
      checkUserOp({ callData, eip7702Auth: empty }, CHAIN, cfg);
      checkUserOp({ callData, authorizationList: empty }, CHAIN, cfg);
    }
  });

  test('error messages never contain the Pimlico API key', () => {
    const cfg = makeAllowedConfig();
    const error = expectPolicyError(() =>
      checkUserOp({ callData: executeCallData(OTHER, 0n, TRANSFER_DATA) }, CHAIN, cfg),
    );
    assert.ok(!error.message.includes(cfg.pimlicoApiKey));
    assert.ok(!error.message.includes(cfg.sponsorshipPolicyId));
  });
});
