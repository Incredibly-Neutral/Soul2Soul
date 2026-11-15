/**
 * Deploy one S2SPublicationModuleV5 implementation and print the address.
 *
 * Deploy only. The factory half of `pnpm deploy:pub` (setImplementation, and the
 * Safe transaction it prints when the key is not the protocol safe) is
 * privileged, so this script leaves the factory alone — and a freshly deployed
 * implementation is therefore **not approved yet**: the approved set is filled
 * by `setImplementation`. Until the protocol safe runs it, the `pnpm upgrade:pub`
 * line this prints reverts `ImplementationNotApproved` on every proxy.
 *
 * Why the factory is a constructor argument. V5 takes the approving factory as
 * an immutable, so one implementation serves every proxy and the upgrade needs
 * nothing in proxy storage. Two addresses are fixed at deployment and cannot be
 * corrected afterwards, so both are checked before the deploy: the factory must
 * have code and answer `isApprovedImplementation`, the selector V5 reads, and
 * its `protocolSafe()` must be the `PROTOCOL_SAFE_ADDRESS` in .env, which is the
 * second constructor argument.
 *
 * The printed line is the one `pnpm upgrade:pub` reads:
 *
 *   PUBLICATION_IMPLEMENTATION_ADDRESS=0x…
 *
 * Usage:
 *   cd src/publication/contracts
 *   pnpm deploy:pubimpl
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY             deployer key, pays gas, carries no privilege
 *   PUBLICATION_FACTORY_ADDRESS      the V4 CREATE2 factory (pnpm deploy:pubfac)
 *   PROTOCOL_SAFE_ADDRESS            the protocol safe that factory answers, and
 *                                    V5's second constructor argument
 *   BASE_RPC_URL / VITE_DRPC_API_KEY optional RPC override
 */

import { createWalletClient, createPublicClient, getAddress, http, parseAbi } from 'viem';
import type { Account, HttpTransport, PublicClient, WalletClient } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const ARTIFACT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts');

const IMPL_NAME = process.env.PUBLICATION_IMPL_CONTRACT || 'S2SPublicationModuleV5';

const FACTORY_ABI = parseAbi([
  'function protocolSafe() view returns (address)',
  'function isApprovedImplementation(address implementation) view returns (bool)',
]);

type Wallet = WalletClient<HttpTransport, typeof base, Account>;
type Pub = PublicClient<HttpTransport, typeof base>;

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

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) {
    console.error('❌ PROTOCOL_PRIVATE_KEY not set (needed to deploy the implementation)');
    process.exit(1);
  }

  const factoryEnv = process.env.PUBLICATION_FACTORY_ADDRESS;
  if (!factoryEnv) {
    console.error(
      '❌ PUBLICATION_FACTORY_ADDRESS not set — V5 takes it as a constructor argument.',
    );
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

  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  console.log(`Deploying from ${account.address}`);
  console.log(`   RPC:     ${rpcUrl}`);
  console.log(`   Factory: ${factory}\n`);

  // The immutable is final. A factory that cannot answer the approval check
  // bricks every upgrade on every proxy over this implementation, and no call
  // afterwards can point it elsewhere.
  const factoryCode = await publicClient.getCode({ address: factory });
  if (!factoryCode || factoryCode === '0x') {
    console.error(`❌ No contract at ${factory}`);
    process.exit(1);
  }
  let factorySafe: `0x${string}`;
  try {
    factorySafe = await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'protocolSafe',
    });
    await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'isApprovedImplementation',
      args: [account.address],
    });
  } catch {
    console.error(`❌ ${factory} does not answer protocolSafe() and isApprovedImplementation().`);
    console.error('   V5 reads the second selector on every upgrade. Deploy');
    console.error(
      '   S2SPublicationModuleV4Create2Factory (pnpm deploy:pubfac) and use that address.',
    );
    process.exit(1);
  }

  if (getAddress(factorySafe) !== expectedSafe) {
    console.error(`❌ ${factory} answers protocolSafe() = ${factorySafe},`);
    console.error(`   but PROTOCOL_SAFE_ADDRESS is ${expectedSafe}.`);
    console.error('   V5 takes both as constructor arguments and the pair is fixed for good.');
    console.error('   Point PUBLICATION_FACTORY_ADDRESS or PROTOCOL_SAFE_ADDRESS at the pair');
    console.error('   the protocol actually governs before deploying.');
    process.exit(1);
  }
  console.log(`   Protocol safe: ${expectedSafe} (read from the factory, as expected)\n`);

  const artifactPath = findArtifact(IMPL_NAME);
  if (!artifactPath) {
    console.error(`❌ Artifact for ${IMPL_NAME} not found under ${ARTIFACT_ROOT}`);
    console.error('   Run pnpm compile first.');
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

  console.log(`Deploying ${IMPL_NAME} over ${factory}, protocol safe ${expectedSafe}...`);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args: [factory, expectedSafe],
    gas: 3_000_000n,
  });
  console.log(`   Deploy tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    console.error(`❌ Implementation deploy failed (status: ${receipt.status})`);
    const { error }: any = receipt;
    if (error) console.error(`   ${error}`);
    process.exit(1);
  }
  const implementation = getAddress(receipt.contractAddress);

  console.log(`\n========================================`);
  console.log(` Implementation:                 ${implementation}`);
  console.log(` Factory (immutable):            ${factory}`);
  console.log(` Protocol safe (immutable):      ${expectedSafe}`);
  console.log(` Approved on that factory:       no`);
  console.log(`========================================`);
  console.log('\nAdd to .env:');
  console.log(`PUBLICATION_IMPLEMENTATION_ADDRESS=${implementation}`);
  console.log('\nNext: the protocol safe must run pnpm deploy:pub (or its printed batch),');
  console.log(`which calls setImplementation(${implementation}) on ${factory}.`);
  console.log('Until that executes, no proxy can upgrade to it: the module is not in the');
  console.log('approved set, so _authorizeUpgrade reverts ImplementationNotApproved.');
  console.log('The factory is otherwise unchanged: createModule keeps deploying what it deployed.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
