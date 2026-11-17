/**
 * Approve the manifest implementation for its kind.
 *
 * `setImplementation(bytes32 kind, address impl)` is accepted only from the
 * factory's own `protocolSafe`, so this script cannot send it. It runs the checks
 * the factory runs, prints the calldata, and prints a Safe Transaction Builder
 * batch for the owners to sign. One signature, one call: approving a build and
 * pointing the kind at it are the same transaction.
 *
 * The checks, in the order the factory applies them:
 *
 *   - the implementation has code,
 *   - `factory()` is this factory,
 *   - `moduleKind()` is `s2s.module.manifest`,
 *   - `proxiableUUID()` is the ERC-1967 slot (an implementation whose storage
 *     layout the proxy cannot follow would break on the first write),
 *   - the implementation is not revoked (a withdrawal is for good).
 *
 * A kind already at this implementation, and approving it, is reported and not
 * proposed: setting it again writes the same pointer and emits an event that
 * would look like a deploy.
 *
 * Usage:
 *   cd src/manifest
 *   pnpm set:impl [--data]
 *
 * Requires in .env:
 *   MANIFEST_IMPLEMENTATION_ADDRESS  printed by pnpm deploy:impl
 *   PUBLICATION_FACTORY_ADDRESS      the V6 factory
 *   PROTOCOL_SAFE_ADDRESS            the safe that must sign
 *   BASE_RPC_URL                     optional RPC override
 *
 * stdout is the Safe batch (or the calldata with `--data`). Nothing is sent.
 */

import { encodeFunctionData } from 'viem';
import {
  FACTORY_ABI,
  MANIFEST_KIND,
  MODULE_ABI,
  addressEnv,
  artifact,
  batchTx,
  emit,
  publicClient,
  refuse,
  say,
} from './lib.js';

const wantData = process.argv.includes('--data');

const factory = addressEnv('PUBLICATION_FACTORY_ADDRESS');
const protocolSafe = addressEnv('PROTOCOL_SAFE_ADDRESS');
const implementation = addressEnv('MANIFEST_IMPLEMENTATION_ADDRESS');

const answers = (await publicClient.readContract({
  address: factory,
  abi: FACTORY_ABI,
  functionName: 'protocolSafe',
})) as `0x${string}`;
if (answers.toLowerCase() !== protocolSafe.toLowerCase()) {
  refuse(`The factory answers protocolSafe() = ${answers}, not ${protocolSafe}. A proposal signed by that safe would revert.`);
}

if ((await publicClient.getCode({ address: implementation })) === undefined) {
  refuse(`${implementation} has no code. A deploy that never mined looks exactly like this.`);
}

const asModule = { address: implementation, abi: MODULE_ABI } as const;
const [declaredKind, declaredFactory] = await Promise.all([
  publicClient.readContract({ ...asModule, functionName: 'moduleKind' }),
  publicClient.readContract({ ...asModule, functionName: 'factory' }),
]);
if (declaredKind !== MANIFEST_KIND) {
  refuse(
    `${implementation} declares kind ${declaredKind}, not ${MANIFEST_KIND}. The factory would refuse it with ImplementationKindMismatch.`,
  );
}
if ((declaredFactory as string).toLowerCase() !== factory.toLowerCase()) {
  refuse(`${implementation} answers factory() = ${declaredFactory}, not ${factory}. It belongs to another factory.`);
}
if (!('proxiableUUID' in artifact('S2SManifestModule').abi)) {
  refuse('The build has no proxiableUUID in its ABI, so it is not a UUPS implementation.');
}
const slot = await publicClient.readContract({
  address: implementation,
  abi: [
    {
      type: 'function',
      name: 'proxiableUUID',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ type: 'bytes32' }],
    },
  ],
  functionName: 'proxiableUUID',
});
const ERC1967 =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
if (slot !== ERC1967) refuse(`${implementation} answers proxiableUUID() = ${slot}, not the ERC-1967 slot.`);

const [latest, approved, revoked] = await Promise.all([
  publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'latestImplementation', args: [MANIFEST_KIND] }) as Promise<`0x${string}`>,
  publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'isApproved', args: [MANIFEST_KIND, implementation] }) as Promise<boolean>,
  publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'isRevoked', args: [MANIFEST_KIND, implementation] }) as Promise<boolean>,
]);

if (revoked) refuse(`${implementation} was withdrawn from the manifest kind. A withdrawal cannot be undone; deploy a new build.`);

const data = encodeFunctionData({
  abi: FACTORY_ABI,
  functionName: 'setImplementation',
  args: [MANIFEST_KIND, implementation],
});

if (latest.toLowerCase() === implementation.toLowerCase() && approved) {
  say(
    `The manifest kind is already at ${implementation} and approves it.`,
    'Nothing to propose. New modules of the kind are built over it now.',
  );
  process.exit(0);
}

if (!approved) {
  say(
    `Proposing one call: approve ${implementation} for the manifest kind.`,
    latest.toLowerCase() === implementation.toLowerCase()
      ? 'The pointer is already there; this adds the approval an upgrade target needs.'
      : `The pointer moves from ${latest === '0x0000000000000000000000000000000000000000' ? 'nothing' : latest}. Existing modules keep their address and storage.`,
    '',
    `to      ${factory}`,
    `from    ${protocolSafe} (the factory accepts this call from no one else)`,
    '',
    'Until the safe executes it, createModule for this kind reverts NoImplementation.',
  );
}

emit(wantData ? data : batchTx(factory, data));
