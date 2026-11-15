/**
 * Print the Safe transaction that upgrades one publication proxy.
 *
 * The upgrade is a UUPS `upgradeToAndCall` sent **to the proxy**. `_authorizeUpgrade`
 * is `onlySafe`, so only the publication's own Safe can send it — this script
 * never signs anything, it only prints what to paste.
 *
 * The payload is derived from the proxy, not chosen. OpenZeppelin 4.9
 * force-calls the new implementation even when the payload is empty
 * (`_upgradeToAndCallUUPS(..., true)`), and this module has no `receive` and no
 * `fallback`, so `0x` reverts the whole upgrade on a delegatecall to nothing.
 * Two payloads answer on a V5 module, and which one is right is a fact about
 * the proxy, so this script reads that fact:
 *
 *   1. the proxy's current implementation, from the ERC-1967 slot;
 *   2. that implementation's `NAME()`;
 *   3. the proxy's initialisation nonce, slot 0, and slot 119 — the backfill
 *      sentinel `initialize` sets.
 *
 *   sentinel zero, nonce < 2  → reinitializeV3(). The backfill has not run, and
 *                              `reinitializeV3` recomputes each owner's count
 *                              from `agreementList` rather than adding to it, so
 *                              it is right on a proxy that arrived from V2 and on
 *                              one born under V3, whose `_addAgreement` already
 *                              counted. Nothing here has to tell them apart.
 *   sentinel set              → NAME(). This proxy is at or past the backfill:
 *                              it was born as V5 or has already run the call.
 *
 * Three refusals, by name:
 *
 *   The proxy runs V4. Its `_authorizeUpgrade` reads a factory slot that
 *   `initialize` never wrote on an upgraded proxy, so it reverts `NoFactory()`
 *   before any payload runs: nothing in this tree can upgrade it.
 *
 *   The sentinel is zero and nonce 2 is spent. An earlier `reinitializeV3` ran
 *   under a module version that wrote no sentinel, so the counts are whatever
 *   that run left and this call cannot run again to recompute them. Classifying
 *   that state is not this script's to guess.
 *
 *   The target is not V5. A V4 target is the trap: it is permanently in the
 *   factory's approved set, a V2 or V3 proxy's `onlySafe` accepts it, and the
 *   result is a proxy whose factory slot is zero for good — the brick V5 exists
 *   to prevent. The target must also be approved on the factory in its own
 *   immutable; until the protocol safe runs `setImplementation`, every upgrade
 *   to it reverts `ImplementationNotApproved`.
 *
 * Read-only: view calls against one RPC, no key, no transaction. It reads and
 * prints.
 *
 * Usage:
 *   cd src/publication/contracts
 *   pnpm upgrade:pub -- <proxy> <implementation> [--format batch|data]
 *
 *   # or take the implementation from .env (PUBLICATION_IMPLEMENTATION_ADDRESS)
 *   pnpm upgrade:pub -- <proxy>
 *
 * Requires in .env:
 *   BASE_RPC_URL / VITE_DRPC_API_KEY optional RPC override
 */

import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  parseAbi,
} from 'viem';
import type { Hex } from 'viem';
import { base } from 'viem/chains';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';

config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const UPGRADE_ABI = parseAbi([
  'function upgradeToAndCall(address newImplementation, bytes data) payable',
  'function reinitializeV3()',
]);

const MODULE_ABI = parseAbi([
  'function NAME() view returns (string)',
  'function factory() view returns (address)',
]);

const FACTORY_ABI = parseAbi([
  'function isApprovedImplementation(address implementation) view returns (bool)',
]);

/** `keccak256("eip1967.proxy.implementation") - 1`. */
const ERC1967_IMPLEMENTATION_SLOT: Hex =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const CHAIN_ID = '8453'; // Base

const V5_NAME = 'S2S Publication Module V5';
const V4_NAME = 'S2S Publication Module V4';
const V3_NAME = 'S2S Publication Module V3';
const V2_NAME = 'S2S Publication Module V2';

type Payload = { call: Hex; label: string; why: string };

const NAME_CALL: Payload = {
  call: encodeFunctionData({ abi: MODULE_ABI, functionName: 'NAME' }),
  label: 'NAME()',
  why: 'slot 119 holds the backfill sentinel, so this proxy has already counted its agreements',
};

const REINIT_V3_CALL: Payload = {
  call: encodeFunctionData({ abi: UPGRADE_ABI, functionName: 'reinitializeV3' }),
  label: 'reinitializeV3()',
  why: 'slot 119 is zero: the backfill has not run, and it recomputes each count from agreementList',
};

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error('Usage: pnpm upgrade:pub -- <proxy> [implementation] [--format batch|data]');
  console.error('  implementation defaults to PUBLICATION_IMPLEMENTATION_ADDRESS in .env');
  console.error('  the payload is read from the proxy: reinitializeV3() on a V2/V3 proxy');
  console.error('  whose backfill has not run, NAME() otherwise. V4 targets are refused.');
  process.exit(1);
}

function refuse(...lines: string[]): never {
  console.error(`❌ ${lines[0]}`);
  for (const line of lines.slice(1)) console.error(`   ${line}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let format: 'batch' | 'data' = 'batch';
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
    usage(
      '--reinit-v3 is gone: the payload is read from the proxy, so the flag only let the\n' +
        'caller assert a state the script had not checked.',
    );
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

const rpcUrl =
  process.env.BASE_RPC_URL ||
  (process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
    : 'https://mainnet.base.org');

const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

async function nameOf(address: Hex): Promise<string> {
  return publicClient.readContract({ address, abi: MODULE_ABI, functionName: 'NAME' });
}

/** The implementation the proxy delegates to, per the ERC-1967 slot. */
async function implementationOf(proxy: Hex): Promise<Hex> {
  const word = await publicClient.getStorageAt({
    address: proxy,
    slot: ERC1967_IMPLEMENTATION_SLOT,
  });
  if (!word || word === '0x')
    refuse(
      `${proxy} has no implementation in the ERC-1967 slot.`,
      'It is not a proxy this script can upgrade.',
    );
  return getAddress(`0x${word.slice(-40)}`);
}

/** One storage word, as a number: 0 for an unset slot. */
async function readSlotWord(address: Hex, slot: number): Promise<bigint> {
  const word = await publicClient.getStorageAt({
    address,
    slot: `0x${slot.toString(16)}`,
  });
  return word && word !== '0x' ? BigInt(word) : 0n;
}

/** OZ `Initializable` keeps the reinitializer nonce in slot 0, low byte. */
async function nonceOf(proxy: Hex): Promise<number> {
  const word = await publicClient.getStorageAt({ address: proxy, slot: '0x0' });
  if (!word || word === '0x') return 0;
  return Number(BigInt(word) & 0xffn);
}

async function main() {
  const proxyCode = await publicClient.getCode({ address: proxy });
  if (!proxyCode || proxyCode === '0x') refuse(`No contract at ${proxy}.`);

  const currentImplementation = await implementationOf(proxy);
  const currentName = await nameOf(currentImplementation);
  const nonce = await nonceOf(proxy);
  const backfilled = (await readSlotWord(proxy, 119)) !== 0n;

  console.error(`Proxy:            ${proxy}`);
  console.error(`Current impl:     ${currentImplementation}  ("${currentName}")`);
  console.error(`Initializer nonce: ${nonce}`);
  console.error(`Backfill sentinel: ${backfilled ? 'set (slot 119)' : 'zero (slot 119)'}`);

  if (currentName === V4_NAME) {
    refuse(
      `The proxy already runs V4 ("${V4_NAME}").`,
      'V4 reads a factory slot that `initialize` never wrote on an upgraded proxy, so',
      'its _authorizeUpgrade reverts NoFactory() before any payload runs. Registering it',
      'does not help and is not a way round: registerModule writes a factory record and',
      'never touches _authorizeUpgrade, and for this proxy it reverts',
      'ModuleNotRecognised(address) anyway, because a module running V4 answers factory()',
      'with zero and is judged on the frozen legacy set, which does not name what a V4',
      'proxy runs. A V4 proxy is stranded for good, and this script will not print a',
      'transaction that will revert.',
    );
  }

  const known = [V2_NAME, V3_NAME, V5_NAME].includes(currentName);
  if (!known) {
    refuse(
      `The proxy runs "${currentName}", which is not a module version this script knows.`,
      `Expected one of "${V2_NAME}", "${V3_NAME}", "${V5_NAME}".`,
      'Decide the payload by hand before upgrading.',
    );
  }

  if (!backfilled && nonce >= 2) {
    refuse(
      `Slot 119 is zero but the initializer nonce is ${nonce}: a reinitializeV3 already ran.`,
      'That run happened under a module version that wrote no sentinel, and it either',
      'counted from agreementList (V5) or added to what was there (V3). The nonce is',
      'spent, so this call cannot run again to recompute, and the script will not guess',
      'which shape the counts are in.',
    );
  }

  const initializer = backfilled ? NAME_CALL : REINIT_V3_CALL;

  const targetName = await nameOf(implementation);
  if (targetName === V4_NAME) {
    refuse(
      `The target ${implementation} is V4 ("${V4_NAME}").`,
      'V4 is permanently in the factory approved set, so a V2 or V3 proxy would accept it',
      'and spend its only upgrade on a module whose own upgrades revert NoFactory():',
      'that is the brick V5 exists to prevent. Refusing.',
    );
  }
  if (targetName !== V5_NAME) {
    refuse(
      `The target ${implementation} answers NAME() "${targetName}", not "${V5_NAME}".`,
      'Only a V5 module can take the proxy from here: it reads the approving factory',
      'from its code, so a proxy that never recorded one still passes its check.',
    );
  }

  const approvingFactory = await publicClient.readContract({
    address: implementation,
    abi: MODULE_ABI,
    functionName: 'factory',
  });
  const approved = await publicClient.readContract({
    address: approvingFactory,
    abi: FACTORY_ABI,
    functionName: 'isApprovedImplementation',
    args: [implementation],
  });
  console.error(`Target impl:      ${implementation}  ("${targetName}")`);
  console.error(`Approving factory: ${approvingFactory}`);
  console.error(`Approved there:   ${approved ? 'yes' : 'no'}`);
  if (!approved) {
    refuse(
      `${approvingFactory} has not approved ${implementation}.`,
      'Its approved set is filled by the protocol safe setImplementation(pnpm deploy:pub).',
      'Until that executes, _authorizeUpgrade reverts ImplementationNotApproved and the',
      'upgrade below cannot land.',
    );
  }

  const data = encodeFunctionData({
    abi: UPGRADE_ABI,
    functionName: 'upgradeToAndCall',
    args: [implementation, initializer.call],
  });

  if (format === 'data') {
    console.log(data);
    return;
  }

  const batch = {
    version: '1.0',
    chainId: CHAIN_ID,
    createdAt: Date.now(),
    meta: {
      name: `Upgrade publication ${proxy} to ${implementation} with ${initializer.label}`,
      description:
        `upgradeToAndCall(${implementation}, ${initializer.label}) — from "${currentName}" ` +
        `(impl ${currentImplementation}), initializer nonce ${nonce}: ${initializer.why}`,
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
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
