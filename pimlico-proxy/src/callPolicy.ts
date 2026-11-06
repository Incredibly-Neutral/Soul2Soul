/**
 * Call policy: unwrap a smart account's `execute` callData into the inner
 * calls it would make, then judge every inner call against the per-chain
 * target + selector allowlist.
 *
 * Every rejection is a `PolicyError` with a short message that is safe to
 * return to the client as the JSON-RPC error message.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  hexToBigInt,
  parseAbiItem,
  size,
  slice,
  toFunctionSelector,
  type AbiFunction,
  type Hex,
} from 'viem';

import type { Config } from './types.js';

export type Call = {
  target: string;
  value: bigint;
  data: Hex;
};

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** A decoder turns one account `execute` calldata blob into the inner calls. */
type Decoder = (callData: Hex) => Call[];

const decoders = new Map<string, Decoder>();

/** Narrowing helpers: decode output is untrusted shape, never assume it. */
function asAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new PolicyError(`could not decode ${label} calldata`);
  }
  return value;
}

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') {
    throw new PolicyError(`could not decode ${label} calldata`);
  }
  return value;
}

function asHex(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new PolicyError(`could not decode ${label} calldata`);
  }
  return value as Hex;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PolicyError(`could not decode ${label} calldata`);
  }
  return value;
}

/** Decode a call with viem, converting any viem/abi error into a PolicyError. */
function decodeArgs(item: AbiFunction, callData: Hex, label: string): readonly unknown[] {
  let args: readonly unknown[] | undefined;
  try {
    const decoded = decodeFunctionData({ abi: [item], data: callData }) as {
      readonly args?: readonly unknown[];
    };
    args = decoded.args;
  } catch {
    throw new PolicyError(`could not decode ${label} calldata`);
  }
  if (args === undefined) {
    throw new PolicyError(`could not decode ${label} calldata`);
  }
  return args;
}

function register(
  item: AbiFunction,
  label: string,
  decodeArgsFn: (args: readonly unknown[]) => Call[],
): void {
  const selector = toFunctionSelector(item);
  decoders.set(selector, (callData) => decodeArgsFn(decodeArgs(item, callData, label)));
}

function makeCall(target: unknown, value: unknown, data: unknown, label: string): Call {
  return {
    target: asAddress(target, label),
    value: asBigInt(value, label),
    data: asHex(data, label),
  };
}

/** Tuple entries decode to objects keyed by the ABI component names. */
function makeTupleCall(entry: unknown, label: string): Call {
  if (typeof entry !== 'object' || entry === null) {
    throw new PolicyError(`could not decode ${label} calldata`);
  }
  const tuple = entry as Record<string, unknown>;
  return makeCall(tuple['target'], tuple['value'], tuple['data'], label);
}

/* ------------------------------------------------------------------ table */

const SINGLE_LABEL = 'execute';
const BATCH_V7_LABEL = 'executeBatch(address[],uint256[],bytes[])';
const BATCH_V6_LABEL = 'executeBatch(address[],bytes[])';
const BATCH_V8_LABEL = 'executeBatch((address,uint256,bytes)[])';
const ERC7579_LABEL = 'execute(bytes32,bytes)';
const KERNEL_V2_LABEL = 'execute(address,uint256,bytes,uint8)';
const SAFE_LABEL = 'executeUserOp(address,uint256,bytes,uint8)';
const SAFE_ERROR_STRING_LABEL = 'executeUserOpWithErrorString(address,uint256,bytes,uint8)';

// Simple / Light single: execute(address,uint256,bytes)
register(
  parseAbiItem('function execute(address dest, uint256 value, bytes data)'),
  SINGLE_LABEL,
  (args) => [makeCall(args[0], args[1], args[2], SINGLE_LABEL)],
);

// Simple v0.7 batch: executeBatch(address[],uint256[],bytes[])
register(
  parseAbiItem('function executeBatch(address[] dest, uint256[] value, bytes[] data)'),
  BATCH_V7_LABEL,
  (args) => {
    const targets = asArray(args[0], BATCH_V7_LABEL);
    const values = asArray(args[1], BATCH_V7_LABEL);
    const datas = asArray(args[2], BATCH_V7_LABEL);
    if (targets.length !== values.length || targets.length !== datas.length) {
      throw new PolicyError(`could not decode ${BATCH_V7_LABEL} calldata`);
    }
    return targets.map((target, index) =>
      makeCall(target, values[index], datas[index], BATCH_V7_LABEL),
    );
  },
);

// Simple v0.6 / Light v1 batch: executeBatch(address[],bytes[]), value is zero
register(
  parseAbiItem('function executeBatch(address[] dest, bytes[] data)'),
  BATCH_V6_LABEL,
  (args) => {
    const targets = asArray(args[0], BATCH_V6_LABEL);
    const datas = asArray(args[1], BATCH_V6_LABEL);
    if (targets.length !== datas.length) {
      throw new PolicyError(`could not decode ${BATCH_V6_LABEL} calldata`);
    }
    return targets.map((target, index) => makeCall(target, 0n, datas[index], BATCH_V6_LABEL));
  },
);

// Simple v0.8 / Light v2 batch: executeBatch((address,uint256,bytes)[])
register(
  parseAbiItem('function executeBatch((address target, uint256 value, bytes data)[] calls)'),
  BATCH_V8_LABEL,
  (args) => {
    const calls = asArray(args[0], BATCH_V8_LABEL);
    return calls.map((entry) => makeTupleCall(entry, BATCH_V8_LABEL));
  },
);

// ERC-7579: execute(bytes32 mode, bytes executionCalldata)
const ERC7579_CALL_TYPE_SINGLE = '0x00';
const ERC7579_CALL_TYPE_BATCH = '0x01';
const ERC7579_CALL_TYPE_STATICCALL = '0xfe';
const ERC7579_CALL_TYPE_DELEGATECALL = '0xff';
const ERC7579_SINGLE_HEADER_BYTES = 52;

const ERC7579_CALLS_PARAM = {
  type: 'tuple[]',
  name: 'calls',
  components: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
} as const;

function decodeErc7579(args: readonly unknown[]): Call[] {
  const mode = asHex(args[0], ERC7579_LABEL);
  const executionCalldata = asHex(args[1], ERC7579_LABEL);

  const callType = slice(mode, 0, 1);
  const execType = slice(mode, 1, 2);

  if (callType === ERC7579_CALL_TYPE_STATICCALL || callType === ERC7579_CALL_TYPE_DELEGATECALL) {
    throw new PolicyError(`ERC-7579 call type ${callType} not allowed`);
  }
  if (callType !== ERC7579_CALL_TYPE_SINGLE && callType !== ERC7579_CALL_TYPE_BATCH) {
    throw new PolicyError(`ERC-7579 call type ${callType} not allowed`);
  }
  if (execType !== '0x00' && execType !== '0x01') {
    throw new PolicyError(`ERC-7579 exec type ${execType} not allowed`);
  }

  if (callType === ERC7579_CALL_TYPE_SINGLE) {
    if (size(executionCalldata) < ERC7579_SINGLE_HEADER_BYTES) {
      throw new PolicyError('ERC-7579 single execution calldata too short');
    }
    const target = slice(executionCalldata, 0, 20);
    const value = hexToBigInt(slice(executionCalldata, 20, ERC7579_SINGLE_HEADER_BYTES));
    const data =
      size(executionCalldata) > ERC7579_SINGLE_HEADER_BYTES
        ? slice(executionCalldata, ERC7579_SINGLE_HEADER_BYTES)
        : '0x';
    return [{ target, value, data }];
  }

  let decoded: unknown;
  try {
    decoded = decodeAbiParameters([ERC7579_CALLS_PARAM], executionCalldata)[0];
  } catch {
    throw new PolicyError(`could not decode ${ERC7579_LABEL} calldata`);
  }
  const entries = asArray(decoded, ERC7579_LABEL);
  return entries.map((entry) => makeTupleCall(entry, ERC7579_LABEL));
}

register(
  parseAbiItem('function execute(bytes32 mode, bytes executionCalldata)'),
  ERC7579_LABEL,
  decodeErc7579,
);

/** Kernel v2 and the Safe 4337 module both carry an `operation` byte: 0 only. */
function requireCallOperation(args: readonly unknown[], label: string): Call[] {
  const operation = args[3];
  if (typeof operation !== 'number' || operation !== 0) {
    throw new PolicyError(`operation ${String(operation)} not allowed`);
  }
  return [makeCall(args[0], args[1], args[2], label)];
}

register(
  parseAbiItem('function execute(address dest, uint256 value, bytes data, uint8 operation)'),
  KERNEL_V2_LABEL,
  (args) => requireCallOperation(args, KERNEL_V2_LABEL),
);

register(
  parseAbiItem('function executeUserOp(address dest, uint256 value, bytes data, uint8 operation)'),
  SAFE_LABEL,
  (args) => requireCallOperation(args, SAFE_LABEL),
);

register(
  parseAbiItem(
    'function executeUserOpWithErrorString(address dest, uint256 value, bytes data, uint8 operation)',
  ),
  SAFE_ERROR_STRING_LABEL,
  (args) => requireCallOperation(args, SAFE_ERROR_STRING_LABEL),
);

/* --------------------------------------------------------------- decoding */

function decodeCalls(callData: Hex): Call[] {
  if (size(callData) < 4) {
    throw new PolicyError('empty callData');
  }
  const selector = slice(callData, 0, 4);
  const decoder = decoders.get(selector);
  if (!decoder) {
    throw new PolicyError('unknown account execute function');
  }
  return decoder(callData);
}

/**
 * Turn the account's own `execute` wrapper calldata into the inner calls it
 * would make. Rejects unknown wrappers, undecodable arguments and empty batches.
 */
export function extractCalls(callData: Hex): Call[] {
  let calls: Call[];
  try {
    calls = decodeCalls(callData);
  } catch (error) {
    if (error instanceof PolicyError) {
      throw error;
    }
    throw new PolicyError('could not decode account callData');
  }
  if (calls.length === 0) {
    throw new PolicyError('no calls');
  }
  return calls;
}

/* --------------------------------------------------------------- policy */

/** True when `target` + `selector` are allowed on `chainId` by `cfg`. */
export function isCallAllowed(
  cfg: Config,
  chainId: number,
  target: string,
  selector: string,
): boolean {
  const normalizedTarget = target.toLowerCase();
  const normalizedSelector = selector.toLowerCase();
  return cfg.allowedCalls.some(
    (entry) =>
      (entry.chainId === undefined || entry.chainId === chainId) &&
      entry.target.toLowerCase() === normalizedTarget &&
      (entry.selector === '*' || entry.selector.toLowerCase() === normalizedSelector),
  );
}

function isTargetAllowed(cfg: Config, chainId: number, target: string): boolean {
  const normalizedTarget = target.toLowerCase();
  return cfg.allowedCalls.some(
    (entry) =>
      (entry.chainId === undefined || entry.chainId === chainId) &&
      entry.target.toLowerCase() === normalizedTarget,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && HEX_PATTERN.test(value);
}

/**
 * EIP-7702 authorization fields: an absent one is `undefined`, `null`, the
 * empty string, `0x` or an empty list. Anything else is a real authorization.
 */
const AUTHORIZATION_FIELDS = ['eip7702Auth', 'authorizationList'] as const;

function isAuthorizationPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value !== '' && value !== '0x';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * An EIP-7702 authorization replaces the sender's code with a delegate of the
 * client's choosing, so the `execute` wrapper in `callData` is not the code that
 * runs and the target/selector allowlist would be advisory. Reject outright.
 */
function checkAuthorizations(userOp: Record<string, unknown>): void {
  for (const field of AUTHORIZATION_FIELDS) {
    if (isAuthorizationPresent(userOp[field])) {
      throw new PolicyError(`${field} not allowed`);
    }
  }
}

/**
 * Enforce the call allowlist, the native-value gate and the deployment gate on
 * one user operation. Throws `PolicyError` on the first violation.
 */
export function checkUserOp(userOp: unknown, chainId: number, cfg: Config): void {
  if (!isRecord(userOp)) {
    throw new PolicyError('userOperation must be an object');
  }
  checkAuthorizations(userOp);
  const callData = userOp['callData'];
  if (!isHex(callData)) {
    throw new PolicyError('callData must be a hex string');
  }

  const calls = extractCalls(callData);

  for (const call of calls) {
    const target = call.target.toLowerCase();
    const selector = size(call.data) >= 4 ? slice(call.data, 0, 4) : '0x';
    if (isCallAllowed(cfg, chainId, target, selector)) {
      continue;
    }
    if (isTargetAllowed(cfg, chainId, target)) {
      throw new PolicyError(
        `selector ${selector} not allowed for target ${target} on chain ${chainId}`,
      );
    }
    throw new PolicyError(`target ${target} not allowed on chain ${chainId}`);
  }

  if (!cfg.allowNativeValue) {
    for (const call of calls) {
      if (call.value > 0n) {
        throw new PolicyError('native value not allowed');
      }
    }
  }

  checkDeployment(userOp, cfg);
}

function checkDeployment(userOp: Record<string, unknown>, cfg: Config): void {
  const factoryField = userOp['factory'];
  const initCodeField = userOp['initCode'];

  let factory: string | undefined;
  if (typeof factoryField === 'string' && factoryField !== '') {
    factory = factoryField;
  }

  if (initCodeField !== undefined && initCodeField !== null && initCodeField !== '') {
    if (!isHex(initCodeField)) {
      throw new PolicyError('initCode must be a hex string');
    }
    if (initCodeField !== '0x' && factory === undefined) {
      // Simple v0.6 style: the factory is the first 20 bytes of initCode.
      factory = size(initCodeField) >= 20 ? slice(initCodeField, 0, 20) : undefined;
      if (factory === undefined) {
        throw new PolicyError('initCode too short to contain a factory');
      }
    }
  }

  if (factory === undefined) {
    return;
  }

  if (!cfg.allowDeployment) {
    throw new PolicyError('deployment not allowed');
  }
  if (cfg.allowedFactories.length > 0) {
    const allowed = cfg.allowedFactories.some(
      (entry) => entry.toLowerCase() === factory.toLowerCase(),
    );
    if (!allowed) {
      throw new PolicyError('factory not allowed');
    }
  }
}
