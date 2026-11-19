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
 * The call is `upgradeTo`, not `upgradeToAndCall`: OZ 4.9's `upgradeToAndCall`
 * force-calls the new implementation even with empty data, and a module with no
 * `receive` or `fallback` refuses that delegatecall with `Address: low-level
 * delegate call failed`, which a Safe reports as GS013.
 *
 * Usage:
 *   cd src/manifest
 *   pnpm upgrade:module [proxy] [implementation]        propose it
 *   pnpm upgrade:module [proxy] [implementation] --json  print a batch instead
 *   pnpm upgrade:module [proxy] [implementation] --data  print the calldata
 *   pnpm upgrade:module [proxy] [implementation] --simulate
 *        run the call from the safe as a bare `eth_call` and print the revert
 *        reason. A Safe that executes a failing inner call reports only GS013,
 *        which names nothing; this is the same call without the wrapping.
 *
 * Requires in .env:
 *   PUBLICATION_FACTORY_ADDRESS  the factory
 *   PROTOCOL_SAFE_ADDRESS        the safe the module answers to
 *   PROTOCOL_PRIVATE_KEY         an owner or delegate of that safe, to propose
 *   BASE_RPC_URL                 optional RPC override
 *
 * Nothing is sent: the call is proposed, and the owners sign. stdout is the safe
 * transaction hash.
 */

import { decodeErrorResult, encodeFunctionData } from 'viem';
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
  name: 'upgradeTo',
  stateMutability: 'payable',
  inputs: [{ name: 'newImplementation', type: 'address' }],
  outputs: [],
} as const;

/** The reverts this call can produce, so a simulation names one instead of GS013. */
const REVERT_ABI = [
  {
    type: 'error',
    name: 'ImplementationNotApproved',
    inputs: [{ name: 'implementation', type: 'address' }],
  },
  { type: 'error', name: 'OnlySafe', inputs: [] },
  {
    type: 'error',
    name: 'ERC1967InvalidImplementation',
    inputs: [{ name: 'implementation', type: 'address' }],
  },
  { type: 'error', name: 'ERC1967NonPayable', inputs: [] },
] as const;

type Hex = `0x${string}`;

/** Revert data, from wherever viem nested it. */
function revertData(error: unknown): Hex | undefined {
  let current = error as { data?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 6; depth++) {
    if (typeof current.data === 'string' && current.data.startsWith('0x')) return current.data as Hex;
    current = current.cause as { data?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
}

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

// An approved address is a mapping entry, not a contract. A typo or a pasted
// proxy address is approved all the same, and the upgrade then reverts inside
// the proxy as ERC1967InvalidImplementation, which the Safe reports as GS013.
if ((await publicClient.getCode({ address: implementation })) === '0x') {
  refuse(`${implementation} has no code. An implementation is the deployed contract, not a copy of its address.`);
}

const data = encodeFunctionData({
  abi: [UPGRADE_ABI],
  functionName: 'upgradeTo',
  args: [implementation],
});

if (process.argv.includes('--simulate')) {
  try {
    await publicClient.call({ account: safe, to: proxy, data });
    say(`The call succeeds from ${safe}. Executing the proposal will upgrade ${proxy} to ${implementation}.`);
  } catch (error) {
    const bytes = revertData(error);
    const decoded = bytes
      ? (() => {
          try {
            return decodeErrorResult({ abi: REVERT_ABI, data: bytes });
          } catch {
            return null;
          }
        })()
      : null;
    const reason = decoded
      ? `${decoded.errorName}(${decoded.args?.join(', ') ?? ''})`
      : bytes
        ? `undecoded revert ${bytes}`
        : (error as Error).message;
    refuse(`${proxy} refuses the call from ${safe}: ${reason}`);
  }
  process.exit(0);
}

say(
  `Upgrading the manifest module at ${proxy} to ${implementation}.`,
  'The document, its version and its history are in the proxy and are untouched.',
  `Signer: ${safe}. No other address can start this call.`,
);

await deliver(proxy, data, `Upgrade the manifest module to ${implementation}`);
