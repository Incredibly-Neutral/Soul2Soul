/**
 * Print the Safe transaction that upgrades one publication proxy.
 *
 * The upgrade is a UUPS `upgradeToAndCall` sent **to the proxy**. `_authorizeUpgrade`
 * is `onlySafe`, so only the publication's own Safe can send it — this script
 * never signs anything, it only prints what to paste.
 *
 * The upgrade data has to name a function. OpenZeppelin 4.9 force-calls the new
 * implementation even when the payload is empty (`_upgradeToAndCallUUPS(..., true)`),
 * and this module has no `receive` and no `fallback`, so `0x` reverts the whole
 * upgrade on a delegatecall to nothing. The `0x` default this script used to print
 * was wrong for every proxy, and silently so: the transaction reverts at signing
 * time, not when the batch is built.
 *
 * Neither payload below changes agreement state:
 *
 *   NAME()            (0xa3f4df7e) the default. Answers on a proxy running V2,
 *                     V3, V4 or V5, costs a view call, and leaves the
 *                     reinitializer nonce alone. Correct for a proxy that has
 *                     already run the backfill, or never needed to.
 *
 *   reinitializeV3()  (--reinit-v3) the one-shot V3 backfill of
 *                     `agreementsHeldBy`. Only for a V2 proxy that has never run
 *                     it: `reinitializer(2)` reverts once nonce 2 is spent, and
 *                     that reverts the whole upgrade.
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
 *   # a V2 proxy that has never backfilled the counter
 *   pnpm upgrade:pub -- <proxy> --reinit-v3
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
  'function NAME() view returns (string)',
]);

const CHAIN_ID = '8453'; // Base

type Payload = { call: `0x${string}`; label: string; why: string };

/** The default: a view call that answers on every module version this repo has. */
const NAME_CALL: Payload = {
  call: encodeFunctionData({ abi: UPGRADE_ABI, functionName: 'NAME' }),
  label: 'NAME()',
  why: 'nonce 2 spent, or the proxy is not a V2 one',
};

/** The one-shot backfill, for a V2 proxy that has never run it. */
const REINIT_V3_CALL: Payload = {
  call: encodeFunctionData({ abi: UPGRADE_ABI, functionName: 'reinitializeV3' }),
  label: 'reinitializeV3()',
  why: 'V2 proxy that has never backfilled agreementsHeldBy',
};

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error(
    'Usage: pnpm upgrade:pub -- <proxy> [implementation] [--format batch|data] [--reinit-v3]',
  );
  console.error('  implementation defaults to PUBLICATION_IMPLEMENTATION_ADDRESS in .env');
  console.error('  upgrade data is NAME(); --reinit-v3 attaches reinitializeV3() (V2 only)');
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
    if (value !== 'batch' && value !== 'data')
      usage(`--format must be batch or data, got ${value}`);
    format = value;
  } else if (arg.startsWith('--format=')) {
    const value = arg.slice('--format='.length);
    if (value !== 'batch' && value !== 'data')
      usage(`--format must be batch or data, got ${value}`);
    format = value;
  } else if (arg === '--reinit-v3') {
    reinitV3 = true;
  } else {
    positional.push(arg);
  }
}

const [proxyArg, implArg] = positional;
if (!proxyArg) usage('Missing the proxy address.');

const proxy = isAddress(proxyArg, { strict: false })
  ? getAddress(proxyArg)
  : usage(`Not an address: ${proxyArg}`);

const implRaw = implArg || process.env.PUBLICATION_IMPLEMENTATION_ADDRESS;
if (!implRaw) usage('No implementation given and PUBLICATION_IMPLEMENTATION_ADDRESS is unset.');
const implementation = isAddress(implRaw, { strict: false })
  ? getAddress(implRaw)
  : usage(`Not an address: ${implRaw}`);

if (proxy === implementation) usage('Proxy and implementation are the same address.');

const initializer = reinitV3 ? REINIT_V3_CALL : NAME_CALL;

const data = encodeFunctionData({
  abi: UPGRADE_ABI,
  functionName: 'upgradeToAndCall',
  args: [implementation, initializer.call],
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
    name: `Upgrade publication ${proxy} to ${implementation} with ${initializer.label}`,
    description: `upgradeToAndCall(${implementation}, ${initializer.label}) — ${initializer.why}`,
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: proxy,
    createdFromOwnerAddress: '',
  },
  transactions: [{ to: proxy, value: '0', data }],
};

console.log(JSON.stringify(batch, null, 2));
console.error(`\nTo:    ${proxy}`);
console.error(`Data:  ${data}`);
console.error(`Init:  ${initializer.call}  (${initializer.label} — ${initializer.why})`);
