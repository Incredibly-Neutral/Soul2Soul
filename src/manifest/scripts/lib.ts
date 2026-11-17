/**
 * Shared plumbing for the four scripts. Nothing here decides anything: a script
 * reads `.env`, checks what it can check, and prints one of two things, the
 * calldata or a Safe Transaction Builder batch. The key only decides whether a
 * call can be sent from this machine.
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
  { type: 'function', name: 'VERSION', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
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
 * A Safe Transaction Builder batch of one call. The owners paste this into the
 * app and sign once; nothing this machine does on its own can move the factory.
 */
export function batchTx(to: `0x${string}`, data: `0x${string}`) {
  return JSON.stringify(
    {
      version: '1.0',
      chainId: String(base.id),
      createdAt: Date.now(),
      meta: {
        name: 'Transactions Batch',
        description: '',
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
