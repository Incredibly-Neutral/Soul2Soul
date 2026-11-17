/**
 * Create the manifest module.
 *
 * `createModule(safe, kind, params)` deploys a proxy for that safe and kind,
 * initialises it with the safe the factory records, and reports the address it
 * got. The address is a function of `(factory, safe, kind)`, so it can be printed
 * before the call: `moduleAddress` is not a prediction the factory happens to
 * honour, it is the same computation the create performs. A second create for the
 * same pair returns the module that exists and does not reapply `params`, which is
 * why the first document is not seeded here.
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
 *   PUBLICATION_FACTORY_ADDRESS  the V6 factory
 *   PROTOCOL_SAFE_ADDRESS        the safe that will own the module
 *   BASE_RPC_URL                 optional RPC override
 *
 * stdout is the Safe batch (or the calldata with `--data`). Nothing is sent.
 * The narrative names the address the module will have, so it can be hardcoded in
 * the readers before the call is signed.
 */

import { encodeFunctionData } from 'viem';
import {
  FACTORY_ABI,
  MANIFEST_KIND,
  addressEnv,
  batchTx,
  emit,
  publicClient,
  refuse,
  say,
} from './lib.js';

const wantData = process.argv.includes('--data');

const factory = addressEnv('PUBLICATION_FACTORY_ADDRESS');
const safe = addressEnv('PROTOCOL_SAFE_ADDRESS');

const [predicted, existing, implementation] = await Promise.all([
  publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'moduleAddress',
    args: [safe, MANIFEST_KIND],
  }) as Promise<`0x${string}`>,
  publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'moduleOf',
    args: [safe, MANIFEST_KIND],
  }) as Promise<`0x${string}`>,
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
if (existing !== '0x0000000000000000000000000000000000000000') {
  say(`The manifest module for ${safe} already exists at ${existing}. No create needed.`);
  emit(existing);
  process.exit(0);
}

say(
  `The module will be at ${predicted}, owned by ${safe}, over the implementation ${implementation}.`,
  'That address is what the readers hardcode; nothing in this call chooses it.',
  '',
  'The first document is published afterwards by the writer, so the module is readable only',
  'once that runs: until then getManifest() reverts NoManifest and every action fails.',
);

emit(
  wantData
    ? encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createModule', args: [safe, MANIFEST_KIND, '0x'] })
    : batchTx(
        factory,
        encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createModule', args: [safe, MANIFEST_KIND, '0x'] }),
      ),
);
