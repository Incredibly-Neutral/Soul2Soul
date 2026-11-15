/**
 * Deploy one S2SPublicationModuleV5 implementation and print the address.
 *
 * Deploy only. The factory half of `pnpm deploy:pub` (setImplementation, and the
 * Safe transaction it prints when the key is not the protocol safe) is
 * privileged and is not needed to upgrade an existing publication: a proxy's
 * `_authorizeUpgrade` asks the factory whether the *target implementation* is
 * approved, and the target here is already approved. This script leaves the
 * factory alone.
 *
 * Why the factory is a constructor argument. V5 takes the approving factory as
 * an immutable, so one implementation serves every proxy and the upgrade needs
 * nothing in proxy storage. The address is fixed at deployment and cannot be
 * corrected, which is why the factory is checked before the deploy: it must have
 * code and answer `isApprovedImplementation`, the selector V5 reads.
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
  try {
    await publicClient.readContract({
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

  const artifactPath = findArtifact(IMPL_NAME);
  if (!artifactPath) {
    console.error(`❌ Artifact for ${IMPL_NAME} not found under ${ARTIFACT_ROOT}`);
    console.error('   Run pnpm compile first.');
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

  console.log(`Deploying ${IMPL_NAME} over ${factory}...`);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args: [factory],
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
  console.log(` Implementation:      ${implementation}`);
  console.log(` Factory (immutable): ${factory}`);
  console.log(`========================================`);
  console.log('\nAdd to .env:');
  console.log(`PUBLICATION_IMPLEMENTATION_ADDRESS=${implementation}`);
  console.log('\npnpm upgrade:pub -- <proxy> reads that line, and needs no --reinit-v3');
  console.log('on a proxy that has already run the backfill.');
  console.log('The factory is unchanged: createModule keeps deploying what it deployed.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
