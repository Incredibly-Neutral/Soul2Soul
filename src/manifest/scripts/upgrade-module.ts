/**
 * Move the manifest module to an approved implementation.
 *
 * `upgradeToAndCall(newImplementation, data)` is accepted only from the module's
 * own safe, and the module checks the factory's approved set at the moment of the
 * call: an implementation approved for another kind, or not approved at all, is
 * `ImplementationNotApproved` even if it is deployed and looks right.
 *
 * The proxy is `MANIFEST_MODULE_ADDRESS`: this deploy has one manifest, so the
 * address is a constant the readers already carry. The implementation defaults to
 * `latestImplementation(kind)`, which is the one thing only the factory knows.
 * Naming either overrides the default, which is how a rollback is done: approve an
 * earlier build and pass it here.
 *
 * The document and its history are storage, in the proxy. An upgrade moves the
 * code and nothing else, which is why the manifest survives one and why a build
 * that reordered the storage would lose it.
 *
 * Usage:
 *   cd src/manifest
 *   pnpm upgrade:module [proxy] [implementation]        propose it
 *   pnpm upgrade:module [proxy] [implementation] --json  print a batch instead
 *   pnpm upgrade:module [proxy] [implementation] --data  print the calldata
 *
 * Requires in .env:
 *   PUBLICATION_FACTORY_ADDRESS  the V6 factory
 *   PROTOCOL_SAFE_ADDRESS        the safe the module answers to
 *   PROTOCOL_PRIVATE_KEY         an owner or delegate of that safe, to propose
 *   BASE_RPC_URL                 optional RPC override
 *
 * Nothing is sent: the call is proposed, and the owners sign. stdout is the safe
 * transaction hash.
 */

import { encodeFunctionData } from 'viem';
import {
  FACTORY_ABI,
  MANIFEST_KIND,
  addressEnv,
  deliver,
  publicClient,
  refuse,
  say,
} from './lib.js';

const UPGRADE_ABI = {
  type: 'function',
  name: 'upgradeToAndCall',
  stateMutability: 'payable',
  inputs: [
    { name: 'newImplementation', type: 'address' },
    { name: 'data', type: 'bytes' },
  ],
  outputs: [],
} as const;

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

const factory = addressEnv('PUBLICATION_FACTORY_ADDRESS');
const safe = addressEnv('PROTOCOL_SAFE_ADDRESS');

// One manifest per deploy, so its address is a constant: named here or in
// `.env`, never resolved through the factory. The proxy is asked for its own
// safe below, which refuses an address that is not this module.
const proxy = (args[0] as `0x${string}` | undefined) ?? addressEnv('MANIFEST_MODULE_ADDRESS');

const implementation =
  (args[1] as `0x${string}` | undefined) ??
  ((await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'latestImplementation',
    args: [MANIFEST_KIND],
  })) as `0x${string}`);

const [approvedOnChain, revoked, proxyOwner, proxyKind] = await Promise.all([
  publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'isApproved',
    args: [MANIFEST_KIND, implementation],
  }) as Promise<boolean>,
  publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'isRevoked',
    args: [MANIFEST_KIND, implementation],
  }) as Promise<boolean>,
  publicClient.readContract({
    address: proxy,
    abi: [
      { type: 'function', name: 'safe', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    ],
    functionName: 'safe',
  }) as Promise<`0x${string}`>,
  publicClient.readContract({
    address: proxy,
    abi: [
      { type: 'function', name: 'moduleKind', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
    ],
    functionName: 'moduleKind',
  }) as Promise<`0x${string}`>,
]);

if (proxyKind !== MANIFEST_KIND) {
  refuse(`${proxy} declares kind ${proxyKind}, not ${MANIFEST_KIND}. That is another module, not this one.`);
}
if (proxyOwner.toLowerCase() !== safe.toLowerCase()) {
  refuse(`${proxy} answers safe() = ${proxyOwner}. Only that safe can upgrade it, so ${safe} cannot propose this.`);
}
if (revoked) refuse(`${implementation} was withdrawn from the manifest kind. Approving it again is not possible.`);
if (!approvedOnChain) {
  say(
    `${implementation} is not an approved target for the manifest kind.`,
    'Run pnpm set:impl, have the safe execute it, then run this again. The module checks the same set, so this call would revert ImplementationNotApproved.',
  );
  process.exit(1);
}

say(
  `Upgrading the manifest module at ${proxy} to ${implementation}.`,
  'The document, its version and its history are in the proxy and are untouched.',
  `Signer: ${safe}. No other address can start this call.`,
);

await deliver(
  proxy,
  encodeFunctionData({ abi: [UPGRADE_ABI], functionName: 'upgradeToAndCall', args: [implementation, '0x'] }),
  `Upgrade the manifest module to ${implementation}`,
);
