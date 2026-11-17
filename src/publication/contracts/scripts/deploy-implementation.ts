/**
 * Deploy one implementation for S2SPublicationModulesFactoryV6.
 *
 * `--kind publication` deploys S2SPublicationModuleV6, `--kind records` deploys
 * S2SRecordsModuleV2, and the default is publication. Both take
 * `(factory, protocolSafe)` as constructor arguments but keep only the factory:
 * the safe is read once, compared with the factory's own `protocolSafe()`, and
 * dropped, and neither implementation has a `protocolSafe()` getter. The safe is
 * therefore fixed transitively, through the factory that is stored. One
 * implementation serves every module of its kind: no per proxy state, nothing to
 * re-initialise, the same `factory()` on the first hop for any module that ever
 * moves onto it.
 *
 * Deploy only. A fresh implementation is not approved: `setImplementation` is a
 * protocol-safe call, and until it runs, no module can upgrade to this address
 * and `createModule` of this kind keeps deploying whatever
 * `latestImplementation` already names.
 *
 * The factory is checked before the deploy, not after. A V4 factory answers
 * `protocolSafe()` and holds an approved set, but under different selectors:
 * `latestImplementation()` takes no argument there and the set is read as
 * `isApprovedImplementation(address)`. The two V6 reads below,
 * `latestImplementation(bytes32)` and `isApproved(bytes32,address)`, are
 * selectors it never implemented. Deploying over it would burn the gas and
 * produce an implementation that can never hold a module, so each read ends the
 * run with the fix instead.
 *
 * Usage:
 *   cd src/publication/contracts
 *   pnpm deploy:impl --kind publication
 *   pnpm deploy:impl --kind records
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY             deployer key, pays gas, carries no privilege
 *   PROTOCOL_SAFE_ADDRESS            the safe the factory answers, and the second
 *                                    constructor argument
 *   PUBLICATION_FACTORY_ADDRESS      the V6 factory, as printed by pnpm deploy:factory
 *   BASE_RPC_URL / VITE_DRPC_API_KEY optional RPC override
 *
 * The factory address has one name, PUBLICATION_FACTORY_ADDRESS: it is what
 * src/press/scripts/lit/update-protocol.ts reads for the on-chain
 * `publication_factory` record, so the printed value goes in .env and then into
 * that record with `tsx src/press/scripts/lit/update-protocol.ts`.
 */

import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

// Load <repo>/.env, the same file hardhat.config.ts loads. Resolved from this
// file, not from cwd: `pnpm` runs with cwd = the package dir, where `../.env`
// is src/publication/.env and does not exist.
// Four levels up: scripts -> contracts -> publication -> src -> repo.
config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const ARTIFACT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts');

const ERC1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

type KindName = 'publication' | 'records';

const KINDS: Record<KindName, { contract: string; label: string; env: string }> = {
  publication: {
    contract: 'S2SPublicationModuleV6',
    label: 's2s.module.publication',
    env: 'PUBLICATION_IMPLEMENTATION_ADDRESS',
  },
  records: {
    contract: 'S2SRecordsModuleV2',
    label: 's2s.module.records',
    env: 'RECORDS_IMPLEMENTATION_ADDRESS',
  },
};

const FACTORY_ABI = parseAbi([
  'function protocolSafe() view returns (address)',
  'function latestImplementation(bytes32 kind) view returns (address)',
  'function isApproved(bytes32 kind, address implementation) view returns (bool)',
]);

const MODULE_ABI = parseAbi([
  'function factory() view returns (address)',
  'function moduleKind() view returns (bytes32)',
  'function proxiableUUID() view returns (bytes32)',
]);

/** Hardhat writes `<artifactRoot>/<sourceDir>/<Name>.sol/<Name>.json`. */
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

function parseKind(argv: string[]): KindName {
  const index = argv.indexOf('--kind');
  if (index < 0) {
    const inline = argv.find((a) => a.startsWith('--kind='));
    if (!inline) return 'publication';
    const value = inline.slice('--kind='.length);
    if (value === 'publication' || value === 'records') return value;
    console.error(`❌ Unknown --kind "${value}". Legal values: publication, records.`);
    process.exit(1);
  }
  const value = argv[index + 1];
  if (value === undefined) {
    console.error('❌ --kind needs a value. Legal values: publication, records.');
    process.exit(1);
  }
  if (value === 'publication' || value === 'records') return value;
  console.error(`❌ Unknown --kind "${value}". Legal values: publication, records.`);
  process.exit(1);
}

function fail(message: string, fix: string): never {
  console.error(`❌ ${message}`);
  console.error(`   ${fix}`);
  process.exit(1);
}

/**
 * A failed fetch, even when viem wrapped it in a contract-call error: the two
 * look alike at the catch site, and only one of them is evidence about the
 * contract.
 */
function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return Boolean(err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError));
}

async function main() {
  const kind = parseKind(process.argv);
  const spec = KINDS[kind];
  const kindHash = keccak256(toHex(spec.label));

  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) fail('PROTOCOL_PRIVATE_KEY not set.', 'Add it to .env; it only pays gas.');

  const safeEnv = process.env.PROTOCOL_SAFE_ADDRESS;
  if (!safeEnv) {
    fail(
      'PROTOCOL_SAFE_ADDRESS not set.',
      "Add it to .env: it is the implementation's second constructor argument and the address the factory must answer.",
    );
  }
  const protocolSafe = getAddress(safeEnv);

  const factoryEnv = process.env.PUBLICATION_FACTORY_ADDRESS;
  if (!factoryEnv) {
    fail(
      'PUBLICATION_FACTORY_ADDRESS not set.',
      'Deploy the V6 factory with pnpm deploy:factory, put the printed PUBLICATION_FACTORY_ADDRESS in .env, then write the publication_factory record with tsx src/press/scripts/lit/update-protocol.ts.',
    );
  }
  const factory = getAddress(factoryEnv);

  const rpcUrl =
    process.env.BASE_RPC_URL ||
    (process.env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
      : 'https://mainnet.base.org');

  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  let chainId: number;
  try {
    chainId = await publicClient.getChainId();
  } catch {
    fail(
      `RPC ${rpcUrl} did not answer getChainId().`,
      'Set BASE_RPC_URL or VITE_DRPC_API_KEY to a reachable Base node.',
    );
  }
  if (chainId !== base.id) {
    fail(
      `RPC is not Base (${base.id}); it answers ${chainId}.`,
      'Point BASE_RPC_URL at a Base node.',
    );
  }

  if (account.address === protocolSafe) {
    fail(
      `PROTOCOL_SAFE_ADDRESS ${protocolSafe} is the deployer EOA.`,
      'Use a Safe address; a hot key as protocol safe re-opens the hole the factory exists to close.',
    );
  }

  console.log(`Deploying from ${account.address}`);
  console.log(`   RPC:           ${rpcUrl}`);
  console.log(`   Factory:       ${factory}`);
  console.log(`   Protocol safe: ${protocolSafe}`);
  console.log(`   Kind:          ${kind} (${kindHash})\n`);

  // Read the factory's gate before spending gas. The V4 factory passes the first
  // two lines and fails the third: its own `latestImplementation()` takes no
  // argument, so the V6 read is an unknown selector. V4 does keep an approved
  // set, under `isApprovedImplementation(address)`; the V6 module reads
  // `isApproved(bytes32,address)`, which V4 also lacks. Either way a module bound
  // to a V4 factory reverts its own upgrade check.
  const factoryCode = await publicClient.getCode({ address: factory });
  if (!factoryCode || factoryCode === '0x') {
    fail(`No contract at ${factory}.`, 'Deploy the V6 factory with pnpm deploy:factory.');
  }

  let factorySafe: `0x${string}`;
  try {
    factorySafe = await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'protocolSafe',
    });
  } catch (err) {
    if (isTransportFailure(err)) {
      fail(
        `RPC ${rpcUrl} failed while reading protocolSafe().`,
        'Nothing was sent; retry the RPC.',
      );
    }
    fail(
      `${factory} does not answer protocolSafe().`,
      'Deploy the V6 factory with pnpm deploy:factory.',
    );
  }
  if (getAddress(factorySafe) !== protocolSafe) {
    fail(
      `${factory} answers protocolSafe() = ${factorySafe}, not PROTOCOL_SAFE_ADDRESS (${protocolSafe}).`,
      'Deploy the V6 factory with pnpm deploy:factory, or fix the address that is wrong.',
    );
  }

  let latest: `0x${string}`;
  try {
    latest = await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'latestImplementation',
      args: [kindHash],
    });
  } catch (err) {
    if (isTransportFailure(err)) {
      fail(
        `RPC ${rpcUrl} failed while reading latestImplementation(bytes32).`,
        'Nothing was sent; retry the RPC.',
      );
    }
    fail(
      `${factory} does not answer latestImplementation(bytes32): the V4 factory's takes no argument.`,
      'Deploy the V6 factory with pnpm deploy:factory.',
    );
  }

  try {
    await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'isApproved',
      args: [kindHash, latest],
    });
  } catch (err) {
    if (isTransportFailure(err)) {
      fail(
        `RPC ${rpcUrl} failed while reading isApproved(bytes32,address).`,
        'Nothing was sent; retry the RPC.',
      );
    }
    fail(
      `${factory} does not answer isApproved(bytes32,address): the V4 factory answers isApprovedImplementation(address).`,
      'Deploy the V6 factory with pnpm deploy:factory.',
    );
  }

  const artifactPath = findArtifact(spec.contract);
  if (!artifactPath) {
    fail(
      `Artifact for ${spec.contract} not found under ${ARTIFACT_ROOT}.`,
      'Run pnpm compile first.',
    );
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

  const args = [factory, protocolSafe];
  const estimate = await publicClient.estimateGas({
    account,
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }),
  });
  const gas = estimate + estimate / 4n;

  console.log(`Deploying ${spec.contract}...`);
  console.log(`   Gas estimate: ${estimate} (limit ${gas})`);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args,
    gas,
  });
  console.log(`   Deploy tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    fail(
      `Deploy failed (status: ${receipt.status}).`,
      'Check the tx in an explorer; nothing was recorded.',
    );
  }
  const implementation = getAddress(receipt.contractAddress);

  // The factory is an immutable fixed at construction and the safe is only
  // checked against it there, so the only way to know the deploy is usable is to
  // read the address back. A mismatched gate makes the factory refuse it with
  // ImplementationNotGated, and there is nothing to undo: the address is simply
  // not an implementation of this kind.
  let answersFactory: `0x${string}`;
  try {
    answersFactory = await publicClient.readContract({
      address: implementation,
      abi: MODULE_ABI,
      functionName: 'factory',
    });
  } catch (err) {
    if (isTransportFailure(err)) {
      fail(
        `RPC ${rpcUrl} failed while reading factory() from ${implementation}.`,
        'The deploy itself stands; re-read the address with a working RPC.',
      );
    }
    fail(
      `factory() reverted on the deployed address ${implementation}.`,
      'The deploy produced a contract that is not a module; setImplementation would refuse it.',
    );
  }
  if (getAddress(answersFactory) !== factory) {
    fail(
      `factory() answers ${answersFactory}, not ${factory}.`,
      'setImplementation refuses it with ImplementationNotGated; deploy again with the right factory.',
    );
  }

  let answersKind: `0x${string}`;
  try {
    answersKind = await publicClient.readContract({
      address: implementation,
      abi: MODULE_ABI,
      functionName: 'moduleKind',
    });
  } catch (err) {
    if (isTransportFailure(err)) {
      fail(
        `RPC ${rpcUrl} failed while reading moduleKind() from ${implementation}.`,
        'The deploy itself stands; re-read the address with a working RPC.',
      );
    }
    fail(
      `moduleKind() reverted on ${implementation}.`,
      'That is not an implementation of this kind.',
    );
  }
  if (answersKind !== kindHash) {
    fail(
      `moduleKind() answers ${answersKind}, not ${kindHash}.`,
      'setImplementation refuses it with ImplementationKindMismatch; deploy the other --kind instead.',
    );
  }

  let uuid: `0x${string}`;
  try {
    uuid = await publicClient.readContract({
      address: implementation,
      abi: MODULE_ABI,
      functionName: 'proxiableUUID',
    });
  } catch (err) {
    if (isTransportFailure(err)) {
      fail(
        `RPC ${rpcUrl} failed while reading proxiableUUID() from ${implementation}.`,
        'The deploy itself stands; re-read the address with a working RPC.',
      );
    }
    fail(
      `proxiableUUID() reverted on ${implementation}.`,
      'setImplementation refuses it with NotUUPS.',
    );
  }
  if (uuid !== ERC1967_IMPLEMENTATION_SLOT) {
    fail(
      `proxiableUUID() answers ${uuid}, not the ERC-1967 slot.`,
      'setImplementation refuses it with NotUUPS; a module that moved onto it would have no upgrade door.',
    );
  }

  console.log(`   ✅ Implementation at ${implementation}`);
  console.log('   Verified: factory(), moduleKind(), proxiableUUID() all answer as expected.\n');

  console.log('========================================');
  console.log(` Implementation:            ${implementation}`);
  console.log(` Kind:                      ${kind} (${kindHash})`);
  console.log(` Factory (immutable):       ${factory}`);
  console.log(` Protocol safe (via factory): ${protocolSafe}`);
  console.log(' Approved on that factory:  no');
  console.log('========================================');

  console.log('\nAdd to .env:');
  console.log(`${spec.env}=${implementation}`);

  console.log('\nNot approved yet. setImplementation is the next step, run by the protocol safe:');
  console.log(
    `  pnpm set:impl  ->  setImplementation(${kindHash}, ${implementation}) on ${factory}`,
  );
  console.log('Until that executes, no module can upgrade to this address.');

  const latestIsZero = /^0x0{40}$/i.test(latest);
  console.log(
    latestIsZero
      ? `latestImplementation(${kind}) is zero: createModule already reverts NoImplementation(${kind}) for new modules of this kind.`
      : `latestImplementation(${kind}) is ${latest}: createModule keeps deploying that until setImplementation moves the pointer.`,
  );
  console.log('Existing modules keep their address and their implementation either way.');
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
