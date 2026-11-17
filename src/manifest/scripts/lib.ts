/**
 * Shared plumbing for the four scripts. Nothing here decides anything: a script
 * reads `.env`, checks what it can check, and hands one call to the protocol safe.
 *
 * The hand-off is the writer's: a proposal on the Safe Transaction Service,
 * signed by `PROTOCOL_PRIVATE_KEY`, which has to be an owner or a delegate of
 * `PROTOCOL_SAFE_ADDRESS`. A bare run proposes and prints the safe transaction
 * hash. `--json` prints a Transaction Builder batch instead, for a machine that
 * cannot reach the service, and `--data` prints the calldata.
 */

import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, getAddress, isAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// scripts -> manifest -> src -> repo root
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

export const MANIFEST_KIND = keccak256(toHex('s2s.module.manifest'));

export const FACTORY_ABI = [
  {
    type: 'function',
    name: 'setImplementation',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'kind', type: 'bytes32' },
      { name: 'implementation', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'createModule',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'safe', type: 'address' },
      { name: 'kind', type: 'bytes32' },
      { name: 'params', type: 'bytes' },
    ],
    outputs: [
      { name: 'module', type: 'address' },
      { name: 'created', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'moduleAddress',
    stateMutability: 'view',
    inputs: [
      { name: 'safe', type: 'address' },
      { name: 'kind', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'moduleOf',
    stateMutability: 'view',
    inputs: [
      { name: 'safe', type: 'address' },
      { name: 'kind', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'latestImplementation',
    stateMutability: 'view',
    inputs: [{ name: 'kind', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isApproved',
    stateMutability: 'view',
    inputs: [
      { name: 'kind', type: 'bytes32' },
      { name: 'implementation', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isRevoked',
    stateMutability: 'view',
    inputs: [
      { name: 'kind', type: 'bytes32' },
      { name: 'implementation', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'protocolSafe',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const MODULE_ABI = [
  { type: 'function', name: 'NAME', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'safe', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'moduleKind', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'manifestVersion', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getVersions', stateMutability: 'view', inputs: [], outputs: [{ type: 'string[]' }] },
] as const;

export const rpcUrl =
  process.env.BASE_RPC_URL ||
  (process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
    : 'https://mainnet.base.org');

export const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

export function env(name: string): string {
  const value = process.env[name];
  if (!value) refuse(`${name} is not set in .env`);
  return value;
}

export function addressEnv(name: string): `0x${string}` {
  const value = env(name);
  if (!isAddress(value)) refuse(`${name} is not an address: ${value}`);
  return getAddress(value);
}

export function optionalAddressEnv(name: string): `0x${string}` | null {
  const value = process.env[name];
  if (!value) return null;
  if (!isAddress(value)) refuse(`${name} is not an address: ${value}`);
  return getAddress(value);
}

export function wallet() {
  const key = env('PROTOCOL_PRIVATE_KEY');
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
  return createWalletClient({ account, chain: base, transport: http(rpcUrl) });
}

export function artifact(contract: string) {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../artifacts/src/S2SManifestModule.sol/${contract}.json`, import.meta.url)),
      'utf8',
    ),
  ) as { abi: readonly unknown[]; bytecode: `0x${string}` };
}

/** Narrative. stderr, so stdout carries only what a machine can paste. */
export function say(...lines: string[]) {
  for (const line of lines) console.error(line);
}

/** The one thing a run is for. stdout. */
export function emit(value: string) {
  console.log(value);
}

export function refuse(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/**
 * Hand one call to the protocol safe.
 *
 * A proposal, not a send: the safe accepts the call from its own address, so the
 * key this machine holds can only put a batch in front of the owners, never
 * execute it. The libraries are imported here so `--json` and `--data` need
 * neither them nor a network.
 */
export async function deliver(to: `0x${string}`, data: `0x${string}`, description: string) {
  if (process.argv.includes('--data')) return emit(data);
  if (process.argv.includes('--json')) return emit(batchTx(to, data, description));

  const safeAddress = addressEnv('PROTOCOL_SAFE_ADDRESS');
  const key = env('PROTOCOL_PRIVATE_KEY');
  const signer = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);

  const [{ default: Safe }, { default: SafeApiKit }] = await Promise.all([
    import('@safe-global/protocol-kit'),
    import('@safe-global/api-kit'),
  ]);

  const protocolKit = await Safe.init({ provider: rpcUrl, signer: key, safeAddress });
  const apiKit = new SafeApiKit({ chainId: BigInt(base.id) });

  const transaction = await protocolKit.createTransaction({
    transactions: [{ to, value: '0', data }],
  });
  const safeTxHash = await protocolKit.getTransactionHash(transaction);
  const signature = await protocolKit.signHash(safeTxHash);

  await apiKit.proposeTransaction({
    safeAddress,
    safeTransactionData: transaction.data,
    safeTxHash,
    senderAddress: signer.address,
    senderSignature: signature.data,
  });

  say(`Proposed to ${safeAddress} by ${signer.address}. The owners sign there; nothing was executed.`);
  emit(safeTxHash);
}

/**
 * A Safe Transaction Builder batch of one call, for a machine that cannot reach
 * the Safe Transaction Service. The owners paste it into the app and sign once.
 */
export function batchTx(to: `0x${string}`, data: `0x${string}`, description = '') {
  return JSON.stringify(
    {
      version: '1.0',
      chainId: String(base.id),
      createdAt: Date.now(),
      meta: {
        name: 'Transactions Batch',
        description,
        txBuilderVersion: '1.16.5',
        createdFromSafeAddress: optionalAddressEnv('PROTOCOL_SAFE_ADDRESS') ?? '',
        createdFromOwnerAddress: '',
        checksum: '',
      },
      transactions: [{ to, value: '0', data, contractMethod: null, contractInputsValues: null }],
    },
    null,
    2,
  );
}
