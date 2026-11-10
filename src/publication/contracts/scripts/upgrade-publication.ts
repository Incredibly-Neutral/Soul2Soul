/**
 * Print the Safe transaction that upgrades one publication proxy to V3.
 *
 * The upgrade is a UUPS `upgradeToAndCall` sent **to the proxy**, with
 * `reinitializeV3()` attached so the agreement counter is backfilled in the same
 * transaction. `_authorizeUpgrade` is `onlySafe`, so only the publication's own
 * Safe can send it — this script never signs anything, it only prints what to
 * paste.
 *
 * Two output formats, both copy-pasteable:
 *
 *   --format data   the raw calldata for a "Custom data" / raw transaction
 *   --format batch  a Safe Transaction Builder batch file (default)
 *
 * The batch file exists so the Transaction Builder does not need an ABI at all:
 * save the output, then Load from JSON in the builder. No ABI paste, no manual
 * encoding, no way to fat-finger the initializer selector.
 *
 * Usage:
 *   cd src/publication/contracts
 *   pnpm upgrade:pub -- <proxy> <implementation> [--format batch|data]
 *
 *   # or take the implementation from .env (PUBLICATION_IMPLEMENTATION_ADDRESS)
 *   pnpm upgrade:pub -- <proxy>
 *
 * Read-only: no RPC, no key, no network. It encodes and prints.
 */

import { encodeFunctionData, getAddress, isAddress, parseAbi } from 'viem';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';

config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const UPGRADE_ABI = parseAbi([
  'function upgradeToAndCall(address newImplementation, bytes data) payable',
  'function reinitializeV3()',
]);

const CHAIN_ID = '8453'; // Base

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error('Usage: pnpm upgrade:pub -- <proxy> [implementation] [--format batch|data]');
  console.error('  implementation defaults to PUBLICATION_IMPLEMENTATION_ADDRESS in .env');
  process.exit(1);
}

const argv = process.argv.slice(2);
let format: 'batch' | 'data' = 'batch';
const positional: string[] = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--format') {
    const value = argv[++i];
    if (value !== 'batch' && value !== 'data') usage(`--format must be batch or data, got ${value}`);
    format = value;
  } else if (arg.startsWith('--format=')) {
    const value = arg.slice('--format='.length);
    if (value !== 'batch' && value !== 'data') usage(`--format must be batch or data, got ${value}`);
    format = value;
  } else {
    positional.push(arg);
  }
}

const [proxyArg, implArg] = positional;
if (!proxyArg) usage('Missing the proxy address.');

const proxy = isAddress(proxyArg)
  ? getAddress(proxyArg)
  : usage(`Not an address: ${proxyArg}`);

const implRaw = implArg || process.env.PUBLICATION_IMPLEMENTATION_ADDRESS;
if (!implRaw) usage('No implementation given and PUBLICATION_IMPLEMENTATION_ADDRESS is unset.');
const implementation = isAddress(implRaw)
  ? getAddress(implRaw)
  : usage(`Not an address: ${implRaw}`);

if (proxy === implementation) usage('Proxy and implementation are the same address.');

const initializer = encodeFunctionData({ abi: UPGRADE_ABI, functionName: 'reinitializeV3' });

const data = encodeFunctionData({
  abi: UPGRADE_ABI,
  functionName: 'upgradeToAndCall',
  args: [implementation, initializer],
});

if (format === 'data') {
  console.log(data);
  process.exit(0);
}

const batch = {
  version: '1.0',
  chainId: CHAIN_ID,
  createdAt: Date.now(),
  meta: {
    name: `Upgrade publication ${proxy} to V3`,
    description: `upgradeToAndCall(${implementation}, reinitializeV3())`,
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: proxy,
    createdFromOwnerAddress: '',
  },
  transactions: [{ to: proxy, value: '0', data }],
};

console.log(JSON.stringify(batch, null, 2));
console.error(`\nTo:    ${proxy}`);
console.error(`Data:  ${data}`);
console.error(`Init:  ${initializer}  (reinitializeV3())`);
