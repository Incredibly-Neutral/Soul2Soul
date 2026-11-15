/**
 * Deploy a new S2SPublicationModule implementation, then point the factory at it.
 *
 * The implementation is V5 by default. It takes the approving factory and the
 * protocol safe as constructor arguments, so both come from .env rather than
 * from the module's storage: every proxy over that implementation, including one
 * born under V2, answers the same factory on its first hop. The scripts compare
 * the factory's own `protocolSafe()` against `PROTOCOL_SAFE_ADDRESS` and refuse
 * a pair that disagrees, because neither argument can be corrected afterwards.
 * That comparison is a deploy-time guard, not a proof of ownership: what binds
 * this implementation to the protocol is the protocol safe's `setImplementation`
 * on that factory, which is step 2 below.
 *
 * If PUBLICATION_IMPLEMENTATION_ADDRESS is set, the deploy is skipped and that
 * implementation is adopted instead — that is the address `pnpm deploy:pubimpl`
 * prints. Only its code is checked; the factory's approval of it is still the
 * privileged step below.
 *
 * The factory half is privileged. S2SPublicationModuleV4Create2Factory only accepts
 * setImplementation from the protocol safe, so this script does not sign that
 * call unless the configured key *is* the protocol safe. Default behaviour is
 * to print a ready-to-paste Safe transaction for the protocol safe's owners to
 * execute; no key can stand in for the safe.
 *
 * Deployment of the implementation still needs PROTOCOL_PRIVATE_KEY — that key
 * pays gas and carries no privilege.
 *
 * Note: this only changes what FUTURE createModule() calls deploy. Existing
 * publication proxies are UUPS and upgrade independently (upgradeTo on each
 * proxy, authorised by its safe) — updating the factory does not touch them.
 *
 * The factory must be the V4 one. A V5 module reads its upgrade approval
 * through the factory in its immutable, so before deploying anything this script
 * asks `isApprovedImplementation` on that factory and refuses one that does not
 * answer — the plain-CREATE V3 factory answers protocolSafe() but keeps no set.
 *
 * Usage:
 *   cd src/publication/contracts && pnpm deploy:pub
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY             deployer key for the implementation
 *   PUBLICATION_FACTORY_ADDRESS      the V4 CREATE2 factory, as printed by pnpm deploy:pubfac
 *   PROTOCOL_SAFE_ADDRESS            the protocol safe that factory answers, and V5's
 *                                    second constructor argument
 *   PUBLICATION_IMPLEMENTATION_ADDRESS optional: an implementation to adopt, not deploy
 *   BASE_RPC_URL / VITE_DRPC_API_KEY optional RPC override
 */

import {
  createWalletClient,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import type { Account, HttpTransport, PublicClient, WalletClient } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

// Load <repo>/.env, the same file hardhat.config.ts loads. Resolved from this
// file, not from cwd: `pnpm` runs with cwd = the package dir, where `../.env`
// is src/publication/.env and does not exist, so the documented
// `cd src/publication/contracts && pnpm deploy:pubfac` silently found nothing.
// Four levels up: scripts -> contracts -> publication -> src -> repo.
config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = resolve(__dirname, '../artifacts');

// Must match the compiled artifact name.
type Wallet = WalletClient<HttpTransport, typeof base, Account>;
type Pub = PublicClient<HttpTransport, typeof base>;

const IMPL_NAME = process.env.PUBLICATION_IMPL_CONTRACT || 'S2SPublicationModuleV5';

const FACTORY_ABI = parseAbi([
  'function setImplementation(address _implementation)',
  'function latestImplementation() view returns (address)',
  'function implementationCount() view returns (uint256)',
  'function protocolSafe() view returns (address)',
  'function isApprovedImplementation(address implementation) view returns (bool)',
]);

const SAFE_ABI = parseAbi([
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);

/**
 * Constructor arguments, read from the artifact rather than hard-coded per
 * version: V4 has no constructor, V5 takes the factory and the protocol safe in
 * that order, and those two are the only addresses a deploy here supplies.
 */
function constructorArgs(
  abi: readonly unknown[],
  factory: `0x${string}`,
  protocolSafe: `0x${string}`,
): readonly unknown[] {
  const entry = (abi as { type?: string; inputs?: { type: string }[] }[]).find(
    (item) => item.type === 'constructor',
  );
  const inputs = entry?.inputs ?? [];
  if (inputs.length === 0) return [];
  if (inputs.length === 2 && inputs.every((i) => i.type === 'address')) {
    return [factory, protocolSafe];
  }
  throw new Error(`Unhandled constructor: ${inputs.map((i) => i.type).join(',')}`);
}

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

async function deployImplementation(
  walletClient: Wallet,
  publicClient: Pub,
  name: string,
  factory: `0x${string}`,
  protocolSafe: `0x${string}`,
): Promise<`0x${string}`> {
  const artifactPath = findArtifact(name);
  if (!artifactPath) {
    console.error(`❌ Artifact for ${name} not found under ${ARTIFACT_ROOT}`);
    console.error('   Run pnpm compile first.');
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args: constructorArgs(artifact.abi, factory, protocolSafe),
    gas: 3_000_000n,
  });
  console.log(`   Deploy tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    console.error(`❌ Implementation deploy failed (status: ${receipt.status})`);
    process.exit(1);
  }
  return getAddress(receipt.contractAddress);
}

async function safeThreshold(safe: `0x${string}`, publicClient: Pub) {
  try {
    const [threshold, owners] = await Promise.all([
      publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getThreshold' }),
      publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }),
    ]);
    return `${threshold} of ${owners.length}`;
  } catch {
    return 'n of m as configured on that safe';
  }
}

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) {
    console.error('❌ PROTOCOL_PRIVATE_KEY not set (needed to deploy the implementation)');
    process.exit(1);
  }

  // One name across every script and the deploy output. No V2 alias: this
  // only ever points at an existing factory, and a V2 one is refused below.
  const factoryEnv = process.env.PUBLICATION_FACTORY_ADDRESS;
  if (!factoryEnv) {
    console.error('❌ PUBLICATION_FACTORY_ADDRESS not set — nothing to update.');
    console.error('   (Deploy the factory once with pnpm deploy:pubfac, then re-run this.)');
    process.exit(1);
  }
  const factory = getAddress(factoryEnv);

  const expectedSafeEnv = process.env.PROTOCOL_SAFE_ADDRESS;
  if (!expectedSafeEnv) {
    console.error('❌ PROTOCOL_SAFE_ADDRESS not set — V5 takes it as its second constructor');
    console.error('   argument, and the factory is checked against it before the deploy.');
    process.exit(1);
  }
  const expectedSafe = getAddress(expectedSafeEnv);

  const rpcUrl =
    process.env.BASE_RPC_URL ||
    (process.env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
      : 'https://mainnet.base.org');

  const payerHex = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(payerHex);

  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  console.log(`Deploying from ${account.address}`);
  console.log(`   RPC:     ${rpcUrl}`);
  console.log(`   Factory: ${factory}\n`);

  // Read the gate before doing anything. A V2 factory has no protocolSafe().
  const factoryCode = await publicClient.getCode({ address: factory });
  if (!factoryCode || factoryCode === '0x') {
    console.error(`❌ No contract at ${factory}`);
    process.exit(1);
  }

  let protocolSafe: `0x${string}`;
  try {
    protocolSafe = await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'protocolSafe',
    });
  } catch {
    console.error(`❌ ${factory} has no protocolSafe() — that is the V2 factory.`);
    console.error('   V2 setImplementation is callable by anyone and cannot be patched.');
    console.error(
      '   Deploy S2SPublicationModuleV4Create2Factory (pnpm deploy:pubfac) and update that address instead.',
    );
    process.exit(1);
  }

  console.log(`   Protocol safe (factory answers): ${protocolSafe}`);
  console.log(`   Protocol safe (PROTOCOL_SAFE_ADDRESS): ${expectedSafe}`);
  if (getAddress(protocolSafe) !== expectedSafe) {
    console.error('❌ The factory and .env name different protocol safes.');
    console.error(
      `   ${factory} answers ${protocolSafe}; PROTOCOL_SAFE_ADDRESS is ${expectedSafe}.`,
    );
    console.error('   V5 takes both as constructor arguments, and the pair is fixed for good:');
    console.error('   a mismatch here would bind the implementation to a factory another safe');
    console.error('   governs. Correct the address that is wrong before deploying.');
    process.exit(1);
  }
  const prevImpl = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'latestImplementation',
  });

  // A V5 module reads its upgrade approval through the factory in its immutable,
  // the one passed to its constructor here. S2SPublicationModuleV3Factory
  // answers protocolSafe() as well, but it keeps no approval set: the selector is
  // absent and this call reverts. That revert is the whole signal — a V5 module
  // over a factory that cannot answer the upgrade check reverts every upgrade on
  // an unknown selector, with no custom error to say why. The returned value is
  // not the test; a factory that answers has the set, and setImplementation
  // fills it.
  //
  // The argument is immaterial for the probe: any address reverts on a factory
  // without the selector. Naming the implementation the factory already holds
  // keeps it concrete, and on a V4 factory the answer is true.
  try {
    await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'isApprovedImplementation',
      args: [prevImpl],
    });
  } catch {
    console.error(
      `❌ ${factory} has no isApprovedImplementation() — that factory keeps no approval set.`,
    );
    console.error(
      '   The plain-CREATE V3 factory answers protocolSafe() but records no approvals, so a',
    );
    console.error(
      '   V5 module bound to it cannot pass its own upgrade check and every upgrade reverts.',
    );
    console.error(
      '   Deploy S2SPublicationModuleV4Create2Factory (pnpm deploy:pubfac) and update that address instead.',
    );
    process.exit(1);
  }

  console.log(`   Previous implementation: ${prevImpl}\n`);

  const adopted = process.env.PUBLICATION_IMPLEMENTATION_ADDRESS;
  let impl: `0x${string}`;
  if (adopted) {
    impl = getAddress(adopted);
    const code = await publicClient.getCode({ address: impl });
    if (!code || code === '0x') {
      console.error(`❌ No contract at ${impl} (from PUBLICATION_IMPLEMENTATION_ADDRESS)`);
      process.exit(1);
    }
    console.log(`1/2 Adopting ${impl} from PUBLICATION_IMPLEMENTATION_ADDRESS — not deploying.`);
  } else {
    console.log(`1/2 Deploying ${IMPL_NAME}...`);
    impl = await deployImplementation(walletClient, publicClient, IMPL_NAME, factory, expectedSafe);
    console.log(`   ✅ Implementation at ${impl}`);
  }
  console.log('');

  const data = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: 'setImplementation',
    args: [impl],
  });

  if (account.address !== protocolSafe) {
    const threshold = await safeThreshold(protocolSafe, publicClient);
    console.log('2/2 setImplementation must be executed by the protocol safe — not sending.');
    console.log(`   Signing key ${account.address} is not the protocol safe ${protocolSafe}.\n`);
    console.log('Safe transaction:');
    console.log(`  chain id:  ${base.id}`);
    console.log(`  to:        ${factory}`);
    console.log(`  value:     0`);
    console.log(`  data:      ${data}`);
    console.log(`  safe:      ${protocolSafe}`);
    console.log(`  threshold: ${threshold}`);
    console.log(`\nExecute it from the protocol safe ${protocolSafe} (${threshold}).`);
    console.log('Only that safe can set the implementation; no key here can stand in for it.');
    console.log(`Until it executes, createModule keeps deploying ${prevImpl}.`);
    console.log('\nExisting publications are UUPS — upgrade each proxy separately if needed.');
    return;
  }

  console.log('2/2 Signing key is the protocol safe — sending setImplementation directly.');
  const txHash = await walletClient.writeContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'setImplementation',
    args: [impl],
  });
  console.log(`   setImplementation tx: ${txHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    console.error(`❌ setImplementation failed (status: ${receipt.status})`);
    process.exit(1);
  }

  const current = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'latestImplementation',
  });
  if (getAddress(current) !== impl) {
    console.error(`❌ Mismatch: factory reports ${current}, expected ${impl}`);
    process.exit(1);
  }
  const count = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'implementationCount',
  });

  console.log(`\n========================================`);
  console.log(` Factory unchanged:   ${factory}`);
  console.log(` New implementation:  ${impl}`);
  console.log(` Version count:       ${count}`);
  console.log(`========================================`);
  console.log('\nNew publications (createModule) use the implementation above.');
  console.log('Existing publications are UUPS — upgrade each proxy separately if needed.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
