/**
 * Print the Safe transaction that upgrades one module proxy to a new implementation.
 *
 * The call is `upgradeToAndCall` sent **to the proxy**, never to the implementation,
 * and the module's `_authorizeUpgrade` is `onlySafe`: only the Safe the module was
 * initialised with can send it. This script prints that transaction and nothing
 * else. It holds no key, signs nothing and sends nothing — every step is a view
 * call or one `eth_getStorageAt`.
 *
 * The payload is not optional. OpenZeppelin 4.9 force-calls the new implementation
 * even when the payload is empty (`_upgradeToAndCallUUPS(..., true)`), and this
 * module declares no `receive` and no `fallback`, so `0x` reverts the whole upgrade
 * on a delegatecall to nothing. The data has to be a call the new implementation
 * answers. `moduleKind()` is a pure view: it returns the same word before and after
 * the upgrade, it changes no storage, and every module of the V6 shape answers it.
 * So the payload is `moduleKind()` and the wrapper is
 * `upgradeToAndCall(target, moduleKind())`.
 *
 * The kind is read from the proxy, not chosen. The proxy's ERC-1967 slot names its
 * current implementation, that implementation answers `moduleKind()`, and the kind
 * decides which .env variable supplies the target when the argument is omitted:
 *
 *   publication  keccak256("s2s.module.publication")  PUBLICATION_IMPLEMENTATION_ADDRESS
 *   records      keccak256("s2s.module.records")      RECORDS_IMPLEMENTATION_ADDRESS
 *
 * A proxy whose current implementation does not answer `moduleKind()` predates this
 * shape, and the script refuses it rather than guess a payload for it.
 *
 * The target is checked against the proxy before anything is printed: it must have
 * code, name the same factory the current implementation names, declare the same
 * kind, answer `proxiableUUID()` with the ERC-1967 slot, and be approved and not
 * revoked for that kind on that factory. Approval is the protocol safe's job —
 * `pnpm set:impl` — and a target that is not approved reverts
 * `ImplementationNotApproved` at the proxy.
 *
 * `PUBLICATION_FACTORY_ADDRESS`, when set, is the address everything else in the
 * repo reads: `pnpm deploy:factory` prints it, `tsx
 * src/press/scripts/lit/update-protocol.ts` writes it into the on-chain
 * `publication_factory` record, and the client reads that record. A proxy gated by
 * a different factory means one of the two addresses is the wrong one, so that pair
 * is refused rather than printed.
 *
 * Usage:
 *   cd src/publication/contracts
 *   pnpm upgrade:module -- <proxy> [implementation] [--format batch|data]
 *
 *   # target from .env, chosen by the kind read from the proxy
 *   pnpm upgrade:module -- <proxy>
 *
 * Requires in .env:
 *   PUBLICATION_FACTORY_ADDRESS         the factory `pnpm deploy:factory` printed, for
 *                                       the `publication_factory` record: put it in
 *                                       .env and write the record with
 *                                       `tsx src/press/scripts/lit/update-protocol.ts`
 *   PUBLICATION_IMPLEMENTATION_ADDRESS  target for a publication-kind proxy when
 *                                       the argument is omitted
 *   RECORDS_IMPLEMENTATION_ADDRESS      the same for a records-kind proxy
 *   BASE_RPC_URL / VITE_DRPC_API_KEY    optional RPC override
 */

import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
} from 'viem';
import type { Hex } from 'viem';
import { base } from 'viem/chains';
import { config } from 'dotenv';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

// Load <repo>/.env, the same file hardhat.config.ts loads. Resolved from this
// file, not from cwd: `pnpm` runs with cwd = the package dir, where `../.env`
// is src/publication/.env and does not exist. Four levels up:
// scripts -> contracts -> publication -> src -> repo.
config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = resolve(__dirname, '../artifacts');

/** `keccak256("eip1967.proxy.implementation") - 1`. */
const ERC1967_IMPLEMENTATION_SLOT: Hex =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const MODULE_ABI = parseAbi([
  'function moduleKind() view returns (bytes32)',
  'function factory() view returns (address)',
  'function NAME() view returns (string)',
  'function proxiableUUID() view returns (bytes32)',
  'function safe() view returns (address)',
]);

const FACTORY_ABI = parseAbi([
  'function isApproved(bytes32 kind, address implementation) view returns (bool)',
  'function isRevoked(bytes32 kind, address implementation) view returns (bool)',
]);

const UPGRADE_ABI = parseAbi([
  'function upgradeToAndCall(address newImplementation, bytes data) payable',
]);

const PAYLOAD_ABI = parseAbi(['function moduleKind() view returns (bytes32)']);

type KindInfo = { label: string; env: string; artifact: string };

const KINDS: Record<Hex, KindInfo> = {
  [keccak256(stringToHex('s2s.module.publication'))]: {
    label: 'publication',
    env: 'PUBLICATION_IMPLEMENTATION_ADDRESS',
    artifact: 'S2SPublicationModuleV6',
  },
  [keccak256(stringToHex('s2s.module.records'))]: {
    label: 'records',
    env: 'RECORDS_IMPLEMENTATION_ADDRESS',
    artifact: 'S2SRecordsModuleV2',
  },
};

const rpcUrl =
  process.env.BASE_RPC_URL ||
  (process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
    : 'https://mainnet.base.org');

const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error('Usage: pnpm upgrade:module -- <proxy> [implementation] [--format batch|data]');
  console.error('  implementation defaults to PUBLICATION_IMPLEMENTATION_ADDRESS or');
  console.error('  RECORDS_IMPLEMENTATION_ADDRESS, chosen by the kind the proxy reports');
  console.error('  --format data prints the calldata only; batch prints a Safe batch');
  process.exit(1);
}

function refuse(line: string): never {
  console.error(`❌ ${line}`);
  process.exit(1);
}

/**
 * Did the call itself revert, or return nothing?
 *
 * viem wraps every failure in a `CallExecutionError`, so the class says nothing: a
 * dead RPC and a reverting getter arrive as the same type. Only the cause chain
 * separates them, and a transport failure must not be reported as "this proxy has
 * no kind".
 */
function isNoAnswer(error: unknown): boolean {
  let node: unknown = error;
  for (let depth = 0; node && depth < 6; depth++) {
    if (node instanceof Error) {
      if (node.name === 'ExecutionRevertedError') return true;
      if (node.name === 'ContractFunctionZeroDataError') return true;
    }
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

/** Hardhat writes `<artifactRoot>/<sourceDir>/<Name>.sol/<Name>.json`; find it wherever it landed. */
function findArtifact(name: string): string | null {
  const stack = [ARTIFACT_ROOT];
  while (stack.length) {
    const dir = stack.pop()!;
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry === `${name}.json`) return path;
      if (statSync(path).isDirectory()) stack.push(path);
    }
  }
  return null;
}

function parseAddress(value: string): Hex {
  if (!isAddress(value, { strict: false })) usage(`Not an address: ${value}`);
  return getAddress(value);
}

/** The implementation the proxy delegates to, per the ERC-1967 slot. */
async function implementationOf(proxy: Hex): Promise<Hex> {
  const word = await publicClient.getStorageAt({
    address: proxy,
    slot: ERC1967_IMPLEMENTATION_SLOT,
  });
  if (!word || word === '0x' || BigInt(word) === 0n) {
    refuse(
      `${proxy} has no implementation in the ERC-1967 slot: it is not a proxy this script can upgrade.`,
    );
  }
  return getAddress(`0x${word.slice(-40)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  let format: 'text' | 'batch' | 'data' = 'text';
  const positional: string[] = [];

  // pnpm forwards the `--` separator as an argument, and the documented form is
  // `pnpm upgrade:module -- <proxy>`, so drop it rather than parsing it as an address.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--format' || arg.startsWith('--format=')) {
      const value = arg === '--format' ? argv[++i] : arg.slice('--format='.length);
      if (value !== 'batch' && value !== 'data')
        usage(`--format must be batch or data, got ${value}`);
      format = value;
    } else {
      positional.push(arg);
    }
  }

  const [proxyArg, implArg] = positional;
  if (!proxyArg) usage('Missing the proxy address.');
  const proxy = parseAddress(proxyArg);

  const proxyCode = await publicClient.getCode({ address: proxy });
  if (!proxyCode || proxyCode === '0x') refuse(`No contract at ${proxy}.`);

  const currentImpl = await implementationOf(proxy);

  let kind: Hex;
  try {
    kind = await publicClient.readContract({
      address: currentImpl,
      abi: MODULE_ABI,
      functionName: 'moduleKind',
    });
  } catch (error) {
    if (!isNoAnswer(error)) throw error;
    refuse(
      `${proxy} predates the V6 proxy shape: its kind cannot be read, and the payload for it is not this script's to guess.`,
    );
  }

  const info = KINDS[kind];
  if (!info) {
    refuse(
      `${proxy} reports kind ${kind}, which is not a module kind this script knows, so it has no target variable and no payload.`,
    );
  }

  let factory: Hex;
  let name: string;
  try {
    factory = await publicClient.readContract({
      address: currentImpl,
      abi: MODULE_ABI,
      functionName: 'factory',
    });
    name = await publicClient.readContract({
      address: currentImpl,
      abi: MODULE_ABI,
      functionName: 'NAME',
    });
  } catch (error) {
    if (!isNoAnswer(error)) throw error;
    refuse(
      `${currentImpl} does not answer factory() and NAME(), so it is not a V6 module and this proxy cannot be checked against a factory.`,
    );
  }
  if (factory === '0x0000000000000000000000000000000000000000') {
    refuse(
      `${currentImpl} names no factory: its upgrades are judged by no approval set, and no target can be approved for it.`,
    );
  }

  // Optional here, because the implementation already names the factory that judges
  // its upgrades. When the key is set it has to agree: it is the address the deploy
  // prints and the client reads from the publication_factory record.
  const configuredFactory = process.env.PUBLICATION_FACTORY_ADDRESS;
  if (configuredFactory && !isAddress(configuredFactory, { strict: false })) {
    refuse(`PUBLICATION_FACTORY_ADDRESS is not an address: ${configuredFactory}.`);
  }
  if (configuredFactory && getAddress(configuredFactory) !== factory) {
    refuse(
      `PUBLICATION_FACTORY_ADDRESS is ${getAddress(configuredFactory)} but ${currentImpl} is gated by ${factory}: the protocol safe's pnpm set:impl must run on the factory that gates this module, so fix whichever address is wrong.`,
    );
  }

  const envTarget = process.env[info.env];
  const targetRaw = implArg || envTarget;
  if (!targetRaw) refuse(`No implementation given and ${info.env} is unset.`);
  const target = parseAddress(targetRaw);

  if (target === currentImpl) {
    refuse(`${target} is the implementation ${proxy} already runs: there is no upgrade to print.`);
  }

  const targetCode = await publicClient.getCode({ address: target });
  if (!targetCode || targetCode === '0x') {
    refuse(
      `No contract at ${target}: an upgrade target must be deployed code, and the protocol safe approves one with pnpm set:impl.`,
    );
  }

  let targetFactory: Hex;
  let targetKind: Hex;
  let targetUuid: Hex;
  try {
    [targetFactory, targetKind, targetUuid] = await Promise.all([
      publicClient.readContract({
        address: target,
        abi: MODULE_ABI,
        functionName: 'factory',
      }),
      publicClient.readContract({
        address: target,
        abi: MODULE_ABI,
        functionName: 'moduleKind',
      }),
      publicClient.readContract({
        address: target,
        abi: MODULE_ABI,
        functionName: 'proxiableUUID',
      }),
    ]);
  } catch (error) {
    if (!isNoAnswer(error)) throw error;
    refuse(
      `${target} does not answer moduleKind(), factory() and proxiableUUID(): it is not a V6 module, and the protocol safe approves only a module of that shape with pnpm set:impl.`,
    );
  }

  if (targetFactory !== factory) {
    refuse(
      `${target} is gated by ${targetFactory}, not ${factory}: the proxy's own factory judges its upgrades, so the protocol safe must run pnpm set:impl on that factory with a target built against it.`,
    );
  }

  if (targetKind !== kind) {
    const targetLabel = KINDS[targetKind]?.label ?? targetKind;
    refuse(
      `The target ${target} is a ${targetLabel} module and this proxy is a ${info.label} module: a cross-kind target runs another kind's storage layout, and the protocol safe approves targets per kind with pnpm set:impl.`,
    );
  }

  if (targetUuid !== ERC1967_IMPLEMENTATION_SLOT) {
    refuse(
      `${target} does not answer proxiableUUID() with the ERC-1967 slot: it has no upgrade door, and a proxy that moved to it could never move again.`,
    );
  }

  const [approved, revoked] = await Promise.all([
    publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'isApproved',
      args: [kind, target],
    }) as Promise<boolean>,
    publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'isRevoked',
      args: [kind, target],
    }) as Promise<boolean>,
  ]);

  if (revoked) {
    refuse(
      `${factory} has revoked ${target} for the ${info.label} kind: a revoked build can never be a target again, so the protocol safe must run pnpm set:impl with a different implementation.`,
    );
  }
  if (!approved) {
    refuse(
      `${factory} has not approved ${target} for the ${info.label} kind: the protocol safe must run pnpm set:impl first, or the upgrade reverts ImplementationNotApproved at the proxy.`,
    );
  }

  // The executor. `safe()` is the only read that can fail on a proxy this script
  // otherwise accepts, so it is not fatal: the batch is still the right call, but an
  // empty createdFromSafeAddress is a gap the operator has to see.
  const moduleSafe = await publicClient
    .readContract({ address: proxy, abi: MODULE_ABI, functionName: 'safe' })
    .catch(() => null);

  const payload = encodeFunctionData({ abi: PAYLOAD_ABI, functionName: 'moduleKind' });
  const data = encodeFunctionData({
    abi: UPGRADE_ABI,
    functionName: 'upgradeToAndCall',
    args: [target, payload],
  });

  const chainId = await publicClient.getChainId();
  const artifactPath = findArtifact(info.artifact);

  console.error(`Proxy:        ${proxy}`);
  console.error(`Current impl: ${currentImpl}  ("${name}")`);
  console.error(`Kind:         ${info.label}  (${kind})`);
  console.error(`Factory:      ${factory}`);
  console.error(`Target impl:  ${target}`);
  console.error(
    `Build in tree: ${artifactPath ? `${info.artifact} (${relative(resolve(__dirname, '..'), artifactPath)})` : `${info.artifact} not compiled (pnpm compile)`}`,
  );
  console.error(
    `Payload:      moduleKind() — a pure view the new implementation answers, so the force-call does not revert`,
  );
  if (!moduleSafe) {
    console.error(
      `Executor:     safe() did not answer, so the batch leaves createdFromSafeAddress blank: open the Safe this module was initialised with instead of trusting that field`,
    );
  }

  if (format === 'data') {
    console.log(data);
    return;
  }

  if (format === 'batch') {
    const batch = {
      version: '1.0',
      chainId: String(chainId),
      createdAt: Date.now(),
      meta: {
        name: `Upgrade ${info.label} module ${proxy} to ${target}`,
        description:
          `upgradeToAndCall(${target}, moduleKind()) — from "${name}" (impl ${currentImpl}), ` +
          `kind ${kind}, approved by ${factory}` +
          (moduleSafe ? '' : '; executor safe not read, createdFromSafeAddress is blank'),
        txBuilderVersion: '1.16.5',
        createdFromSafeAddress: moduleSafe ?? '',
        createdFromOwnerAddress: '',
      },
      transactions: [{ to: proxy, value: '0', data }],
    };
    console.log(JSON.stringify(batch, null, 2));
    return;
  }

  console.log('Safe transaction:');
  console.log(`  chainId:  ${chainId}`);
  console.log(`  to:       ${proxy}`);
  console.log(`  value:    0`);
  console.log(`  data:     ${data}`);
  console.log(
    `  onlySafe: only the module's own Safe${moduleSafe ? ` (${moduleSafe})` : ''} can send this, ` +
      `because the implementation's _authorizeUpgrade is onlySafe`,
  );
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
