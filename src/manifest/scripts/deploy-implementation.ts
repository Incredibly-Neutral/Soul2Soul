/**
 * Deploy the manifest implementation.
 *
 * `S2SManifestModule` is deployed once per factory and shared by every proxy of
 * its kind: it keeps no per-proxy state, so nothing is re-initialised when a new
 * module is created over it. The address of a module is a function of
 * `(factory, safe, kind)` and of the factory's proxy creation code, none of which
 * this deploy changes. Deploying a new implementation therefore moves nothing;
 * the pointer moves when `set:impl` runs, and every existing proxy stays where it
 * is until its Safe calls `upgradeToAndCall`.
 *
 * Two constructor arguments, both checks rather than state: the factory must have
 * code, and its `protocolSafe()` must be the safe named here. The factory is kept
 * (immutable) because it is the set that approves upgrades; the safe is dropped,
 * because what binds this implementation to the protocol is the protocol safe's
 * `setImplementation`, not a constructor argument.
 *
 * Usage:
 *   cd src/manifest
 *   pnpm compile
 *   pnpm deploy:impl
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY        deployer key, pays gas, carries no privilege
 *   PROTOCOL_SAFE_ADDRESS       the safe the factory answers
 *   PUBLICATION_FACTORY_ADDRESS the V6 factory this implementation belongs to
 *   BASE_RPC_URL                optional RPC override
 *
 * stdout is `MANIFEST_IMPLEMENTATION_ADDRESS=0x…`, one line, to paste into .env.
 * The narrative is on stderr. The next steps are printed, not run.
 */

import { encodeFunctionData } from 'viem';
import {
  FACTORY_ABI,
  MANIFEST_KIND,
  MODULE_ABI,
  addressEnv,
  artifact,
  emit,
  publicClient,
  say,
  wallet,
} from './lib.js';

const factory = addressEnv('PUBLICATION_FACTORY_ADDRESS');
const protocolSafe = addressEnv('PROTOCOL_SAFE_ADDRESS');

const factoryAnswers = (await publicClient.readContract({
  address: factory,
  abi: FACTORY_ABI,
  functionName: 'protocolSafe',
})) as `0x${string}`;
if (factoryAnswers.toLowerCase() !== protocolSafe.toLowerCase()) {
  say(
    `The factory at ${factory} answers protocolSafe() = ${factoryAnswers}, not ${protocolSafe}.`,
    'A constructor argument that disagrees with the factory is refused by the module itself, so nothing was sent.',
  );
  process.exit(1);
}

const { abi, bytecode } = artifact('S2SManifestModule');
const account = wallet();
if (!account.account) {
  say('PROTOCOL_PRIVATE_KEY produced no account.');
  process.exit(1);
}

const hash = await account.deployContract({ abi, bytecode, args: [factory, protocolSafe] });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success' || !receipt.contractAddress) {
  say(`Deploy reverted in ${hash}. Nothing to record.`);
  process.exit(1);
}

const address = receipt.contractAddress;
const module = { address, abi: MODULE_ABI } as const;
const [name, kind, answers, owner] = await Promise.all([
  publicClient.readContract({ ...module, functionName: 'NAME' }),
  publicClient.readContract({ ...module, functionName: 'moduleKind' }),
  publicClient.readContract({ ...module, functionName: 'factory' }),
  publicClient.readContract({ ...module, functionName: 'safe' }),
]);

if (kind !== MANIFEST_KIND) {
  say(`The build declares kind ${kind}, not ${MANIFEST_KIND}. The factory would refuse it.`);
  process.exit(1);
}
if ((answers as string).toLowerCase() !== factory.toLowerCase()) {
  say(`The build answers factory() = ${answers}, not ${factory}.`);
  process.exit(1);
}
if (owner !== '0x0000000000000000000000000000000000000000') {
  say(`The implementation answers safe() = ${owner} before any proxy exists. That is a bug, not a module.`);
  process.exit(1);
}

say(
  `Deployed ${name} at ${address} in ${hash}.`,
  `kind ${kind}, factory ${answers}, safe unset until a proxy initialises it.`,
  '',
  'Next, in this order:',
  '  1. put the line below in .env',
  '  2. pnpm set:impl            (protocol Safe approves and points the kind at it)',
  '  3. pnpm create:module       (protocol Safe creates the module, address is predictable)',
  '  4. publish the first document with the writer, not by hand',
  '',
  `setImplementation calldata, if you would rather do step 2 by hand: ${
    encodeFunctionData({ abi: FACTORY_ABI, functionName: 'setImplementation', args: [MANIFEST_KIND, address] })
  }`,
);

emit(`MANIFEST_IMPLEMENTATION_ADDRESS=${address}`);
