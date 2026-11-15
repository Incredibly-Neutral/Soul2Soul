/**
 * Print the Safe transaction that adopts an existing publication.
 *
 * `registerModule(safe, module, implementation)` is sent **to the factory**, not
 * to the proxy, and only the protocol safe can send it (`onlyProtocolSafe`).
 * This script never signs anything: it encodes and prints what to paste.
 *
 * The `implementation` argument is the address the proxy delegated to *before*
 * the upgrade, because the factory cannot read another contract's ERC-1967 slot.
 * The order is read, register, upgrade: read the slot while the proxy still runs
 * V2/V3, register, and only then upgrade in place. A proxy upgraded first names
 * the V4 implementation in its slot, which the factory refuses as a legacy entry
 * with `ModuleNotRecognised(module)`, and the legacy set has no setter.
 *
 * Two output formats, both copy-pasteable:
 *
 *   --format batch  a Safe Transaction Builder batch file (default)
 *   --format data   the raw calldata for a "Custom data" / raw transaction
 *
 * Read-only in the strict sense: no key, no signing, and no network at all. It
 * encodes and prints.
 *
 * The one optional network step is a preflight, and it runs only when
 * `BASE_RPC_URL` is set. It asks the factory the four questions that decide
 * whether the call reverts or does nothing — `registeredModule(safe)`,
 * `module.safe()`, `isLegacyImplementation(implementation)` and
 * `isApprovedImplementation(implementation)` — and prints one line per condition
 * that would make the transaction a revert or a no-op. When `BASE_RPC_URL` is
 * unset it prints one line saying it was skipped. It never stops the calldata
 * from printing: a dead RPC or a wrong factory address is a sentence, not an
 * exit.
 *
 * Usage:
 *   cd src/publication/contracts
 *   pnpm register:module -- <safe> <module> <implementation> [--format batch|data]
 *
 *   # override the target factory
 *   pnpm register:module -- <safe> <module> <implementation> --factory 0x...
 *
 * The target is `PUBLICATION_FACTORY_ADDRESS` in the repo root .env unless
 * `--factory` is given. There is no default: a batch sent to the wrong factory
 * registers nothing and cannot be undone.
 *
 * The batch's `createdFromSafeAddress` is `PROTOCOL_SAFE_ADDRESS` when set,
 * because that is the Safe that must execute it, and blank otherwise — the
 * publication Safe in the arguments cannot send this call. Nothing here reads
 * the protocol safe from the factory, which would mean a network round trip.
 */

import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, parseAbi } from 'viem';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';

config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const FACTORY_ABI = parseAbi([
  'function registerModule(address safe, address module, address implementation)',
  'function registeredModule(address safe) view returns (address)',
  'function isLegacyImplementation(address implementation) view returns (bool)',
  'function isApprovedImplementation(address implementation) view returns (bool)',
]);

const MODULE_ABI = parseAbi(['function safe() view returns (address)']);

const CHAIN_ID = '8453'; // Base
const ZERO = '0x0000000000000000000000000000000000000000';

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error(
    'Usage: pnpm register:module -- <safe> <module> <implementation> [--format batch|data] [--factory 0x...]',
  );
  console.error('  the factory defaults to PUBLICATION_FACTORY_ADDRESS in .env');
  console.error('  the preflight runs only when BASE_RPC_URL is set');
  process.exit(1);
}

const argv = process.argv.slice(2);
let format: 'batch' | 'data' = 'batch';
let factoryArg: string | undefined;
const positional: string[] = [];

// pnpm forwards the `--` separator as an argument, and every usage line in the
// docs says `pnpm register:module -- <safe> ...`, so drop it rather than parsing
// it as an address.
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
  } else if (arg === '--factory') {
    factoryArg = argv[++i];
    if (!factoryArg) usage('--factory needs an address.');
  } else if (arg.startsWith('--factory=')) {
    factoryArg = arg.slice('--factory='.length);
  } else {
    positional.push(arg);
  }
}

const [safeArg, moduleArg, implArg] = positional;
if (!safeArg) usage('Missing the safe address.');
if (!moduleArg) usage('Missing the module address.');
if (!implArg) usage('Missing the implementation address.');

const safe = isAddress(safeArg) ? getAddress(safeArg) : usage(`Not an address: ${safeArg}`);
const module = isAddress(moduleArg) ? getAddress(moduleArg) : usage(`Not an address: ${moduleArg}`);
const implementation = isAddress(implArg) ? getAddress(implArg) : usage(`Not an address: ${implArg}`);

if (module === implementation) usage('Module and implementation are the same address.');

const factoryRaw = factoryArg || process.env.PUBLICATION_FACTORY_ADDRESS;
if (!factoryRaw) {
  usage(
    'No factory given and PUBLICATION_FACTORY_ADDRESS is unset. ' +
      'registerModule is sent to the factory, so there is no default.',
  );
}
const factory = isAddress(factoryRaw)
  ? getAddress(factoryRaw)
  : usage(`Not an address: ${factoryRaw}`);

// ── Preflight: only with an RPC, and never fatal ──────────────────

async function preflight(): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.error('Preflight skipped: BASE_RPC_URL is unset.');
    return;
  }

  const client = createPublicClient({ transport: http(rpcUrl) });
  const notes: string[] = [];

  try {
    const [registered, moduleSafe, legacy, approved] = await Promise.all([
      client.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'registeredModule',
        args: [safe],
      }),
      client.readContract({ address: module, abi: MODULE_ABI, functionName: 'safe' }),
      client.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'isLegacyImplementation',
        args: [implementation],
      }),
      client.readContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'isApprovedImplementation',
        args: [implementation],
      }),
    ]);

    if (registered !== ZERO) {
      notes.push(
        registered === module
          ? `no-op: ${safe} already registers ${module}; the call returns quietly and emits nothing`
          : `revert AlreadyRegistered: ${safe} is registered to ${registered}, not ${module}`,
      );
    }

    if (getAddress(moduleSafe) !== safe) {
      notes.push(`revert SafeMismatch: ${module}.safe() is ${moduleSafe}, not ${safe}`);
    }

    if (!legacy && !approved) {
      notes.push(
        `revert ModuleNotRecognised: ${implementation} is in neither the legacy set nor the approval set`,
      );
    }

    if (legacy && approved) {
      // No such implementation should exist: the constructor refuses a legacy
      // entry that answers factory(). Say so, and say which branch wins.
      notes.push(
        `note: ${implementation} is in both sets; branch is decided by whether ${module} answers ` +
          `factory() with ${factory}`,
      );
    }
  } catch (error) {
    notes.push(
      `preflight could not answer: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }

  if (notes.length === 0) {
    console.error('Preflight: no condition found that would revert or do nothing.');
    return;
  }
  for (const note of notes) console.error(`Preflight: ${note}`);
}

// ── Encode ───────────────────────────────────────────────────────

const data = encodeFunctionData({
  abi: FACTORY_ABI,
  functionName: 'registerModule',
  args: [safe, module, implementation],
});

await preflight();

if (format === 'data') {
  console.log(data);
  process.exit(0);
}

const protocolSafe = process.env.PROTOCOL_SAFE_ADDRESS;
const batch = {
  version: '1.0',
  chainId: CHAIN_ID,
  createdAt: Date.now(),
  meta: {
    name: `Adopt publication ${safe}`,
    description: `registerModule(${safe}, ${module}, ${implementation})`,
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: protocolSafe && isAddress(protocolSafe) ? getAddress(protocolSafe) : '',
    createdFromOwnerAddress: '',
  },
  transactions: [{ to: factory, value: '0', data }],
};

console.log(JSON.stringify(batch, null, 2));
console.error(`\nTo:           ${factory}  (the factory, not the proxy)`);
console.error(`Data:         ${data}`);
console.error(`Safe:         ${safe}`);
console.error(`Module:       ${module}`);
console.error(`Implementation: ${implementation}  (the slot value before the upgrade)`);
