/**
 * Print the Safe transaction that upgrades one publication proxy.
 *
 * The upgrade is a UUPS `upgradeToAndCall` sent **to the proxy**. `_authorizeUpgrade`
 * is `onlySafe`, so only the publication's own Safe can send it — this script
 * never signs anything, it only prints what to paste.
 *
 * The upgrade data is `0x` by default: no initializer runs. A V4 implementation
 * has no initializer at all, and `reinitializeV3()` is gated by `reinitializer(2)`,
 * so on a proxy that already ran it the nonce is spent and attaching it again
 * reverts the whole upgrade. Those V3 proxies are exactly the population being
 * upgraded, which is why the backfill is opt-in rather than the default.
 *
 * `--reinit-v3` attaches `reinitializeV3()` for the one case that still needs it:
 * a V2 proxy that has never backfilled the agreement counter. A V3 proxy, or any
 * proxy whose nonce 2 is spent, must be upgraded with plain `0x`.
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
 *   pnpm upgrade:pub -- <proxy> <implementation> [--format batch|data] [--reinit-v3]
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

/** No initializer: the honest default for a proxy whose reinitializer nonce is spent. */
const NO_INITIALIZER = '0x' as const;

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error(
    'Usage: pnpm upgrade:pub -- <proxy> [implementation] [--format batch|data] [--reinit-v3]',
  );
  console.error('  implementation defaults to PUBLICATION_IMPLEMENTATION_ADDRESS in .env');
  console.error('  upgrade data defaults to 0x; --reinit-v3 attaches reinitializeV3() (V2 only)');
  process.exit(1);
}

const argv = process.argv.slice(2);
let format: 'batch' | 'data' = 'batch';
let reinitV3 = false;
const positional: string[] = [];

// pnpm forwards the `--` separator as an argument, and the documented form is
// `pnpm upgrade:pub -- <proxy>`, so drop it rather than parsing it as an address.
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--') continue;
  if (arg === '--format') {
    const value = argv[++i];
    if (value !== 'batch' && value !== 'data') usage(`--format must be batch or data, got ${value}`);
    format = value;
  } else if (arg.startsWith('--format=')) {
    const value = arg.slice('--format='.length);
    if (value !== 'batch' && value !== 'data') usage(`--format must be batch or data, got ${value}`);
    format = value;
  } else if (arg === '--reinit-v3') {
    reinitV3 = true;
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

const initializer = reinitV3
  ? encodeFunctionData({ abi: UPGRADE_ABI, functionName: 'reinitializeV3' })
  : NO_INITIALIZER;

const data = encodeFunctionData({
  abi: UPGRADE_ABI,
  functionName: 'upgradeToAndCall',
  args: [implementation, initializer],
});

if (format === 'data') {
  console.log(data);
  process.exit(0);
}

const attached = reinitV3 ? 'reinitializeV3()' : '0x';
const batch = {
  version: '1.0',
  chainId: CHAIN_ID,
  createdAt: Date.now(),
  meta: {
    name: `Upgrade publication ${proxy} to ${implementation}`,
    description: `upgradeToAndCall(${implementation}, ${attached})`,
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: proxy,
    createdFromOwnerAddress: '',
  },
  transactions: [{ to: proxy, value: '0', data }],
};

console.log(JSON.stringify(batch, null, 2));
console.error(`\nTo:    ${proxy}`);
console.error(`Data:  ${data}`);
console.error(`Init:  ${initializer}  (${reinitV3 ? 'reinitializeV3()' : 'none, nonce 2 left alone'})`);
