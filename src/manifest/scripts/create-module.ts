/**
 * Create the manifest module.
 *
 * `createModule(safe, kind, params)` deploys a proxy for that safe and kind and
 * initialises it with the safe the factory records. The address is
 * `moduleAddress(factory, safe, kind)`, which is a pure function of those three, so
 * it is a constant of the deployment and is read from `MANIFEST_MODULE_ADDRESS`
 * rather than asked for: one manifest per deploy, not one per publication. The
 * script checks that address for code instead of asking the factory what exists,
 * which is one read instead of two and the same answer.
 *
 * Nothing is seeded. The document is published by the writer, once, with the
 * version and the CIDs it actually carries; a constructor argument would be a
 * second place for a manifest to come from, and the two would drift.
 *
 * Usage:
 *   cd src/manifest
 *   pnpm create:module [--data]
 *
 * Requires in .env:
 *   PUBLICATION_FACTORY_ADDRESS  the factory
 *   PROTOCOL_SAFE_ADDRESS        the safe that will own the module
 *   MANIFEST_MODULE_ADDRESS      the module's address, the constant the readers carry
 *   BASE_RPC_URL                 optional RPC override
 *
 * Nothing is sent: the call is proposed to the protocol safe, and its owners sign.
 * stdout is the safe transaction hash, or the address when the module already
 * exists.
 */

import { encodeFunctionData } from 'viem';
import {
  FACTORY_ABI,
  MANIFEST_KIND,
  addressEnv,
  deliver,
  emit,
  publicClient,
  refuse,
  say,
} from './lib.js';

const factory = addressEnv('PUBLICATION_FACTORY_ADDRESS');
const safe = addressEnv('PROTOCOL_SAFE_ADDRESS');
const moduleAddress = addressEnv('MANIFEST_MODULE_ADDRESS');

const [code, implementation] = await Promise.all([
  publicClient.getCode({ address: moduleAddress }),
  publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'latestImplementation',
    args: [MANIFEST_KIND],
  }) as Promise<`0x${string}`>,
]);

if (implementation === '0x0000000000000000000000000000000000000000') {
  refuse('The manifest kind has no implementation. Run pnpm set:impl and have the safe execute it first.');
}
if (code !== undefined) {
  say(`Something answers at ${moduleAddress} already. No create needed.`);
  emit(moduleAddress);
  process.exit(0);
}

say(
  `The module will be at ${moduleAddress}, owned by ${safe}, over the implementation ${implementation}.`,
  'That address is what the readers hardcode; nothing in this call chooses it.',
  '',
  'The first document is published afterwards by the writer, so the module is readable only',
  'once that runs: until then getManifest() reverts NoManifest and every action fails.',
);

await deliver(
  factory,
  encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createModule', args: [safe, MANIFEST_KIND, '0x'] }),
  `Create the manifest module at ${moduleAddress}`,
);
