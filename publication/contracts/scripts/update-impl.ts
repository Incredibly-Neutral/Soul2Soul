/**
 * Deploy a new S2SPublicationModule implementation and point the EXISTING
 * factory at it via setImplementation().
 *
 * Run after contract changes. Unlike the old flow, this does NOT deploy a new
 * factory — the current factory (S2SPublicationModuleV2Factory) exposes
 * setImplementation(), so we just register the new implementation on it. The
 * factory address is therefore stable across upgrades.
 *
 * Note: this only changes what FUTURE createModule() calls deploy. Existing
 * publication module proxies are UUPS and upgrade independently (upgradeTo on
 * each proxy, authorized by its Safe) — updating the factory does not touch them.
 *
 * Usage:
 *   npx tsx contracts/scripts/update-impl.ts
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY           deployer key
 *   PUBLICATION_FACTORY_V2_ADDRESS the existing factory to update
 *   BASE_RPC_URL (or VITE_DRPC_API_KEY)   optional RPC override
 */

import { createWalletClient, createPublicClient, http, getAddress } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '../.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(__dirname, '../artifacts/contracts/contracts');

// Must match the compiled artifact name (contracts/contracts/<NAME>.sol/<NAME>.json)
const IMPL_NAME = 'S2SPublicationModuleV2';

// Minimal factory ABI — only what this script calls.
const FACTORY_ABI = [
  {
    type: 'function',
    name: 'setImplementation',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_implementation', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'latestImplementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'implementationCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

async function deployImplementation(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  name: string,
): Promise<`0x${string}`> {
  const artifactPath = resolve(artifactDir, `${name}.sol/${name}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`❌ Artifact not found at ${artifactPath}`);
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args: [],
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

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) { console.error('❌ PROTOCOL_PRIVATE_KEY not set'); process.exit(1); }

  const factoryEnv = process.env.PUBLICATION_FACTORY_V2_ADDRESS;
  if (!factoryEnv) {
    console.error('❌ PUBLICATION_FACTORY_V2_ADDRESS not set — nothing to update.');
    console.error('   (Bootstrap the factory once with the deploy-factory script, then re-run this.)');
    process.exit(1);
  }
  const factory = getAddress(factoryEnv);

  const rpcUrl = process.env.BASE_RPC_URL ||
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

  // Step 1: deploy the new implementation
  console.log(`1/2 Deploying ${IMPL_NAME}...`);
  const impl = await deployImplementation(walletClient, publicClient, IMPL_NAME);
  console.log(`   ✅ Implementation at ${impl}\n`);

  // Step 2: point the existing factory at the new implementation
  console.log('2/2 Updating factory implementation (setImplementation)...');

  const prevImpl = await publicClient.readContract({
    address: factory, abi: FACTORY_ABI, functionName: 'latestImplementation',
  });
  console.log(`   Previous implementation: ${prevImpl}`);

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

  // Confirm
  const [newImpl] = await Promise.all([
    publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'latestImplementation' }),
  ]);

  if (getAddress(newImpl) !== impl) {
    console.error(`❌ Mismatch: factory reports ${newImpl}, expected ${impl}`);
    process.exit(1);
  }

  console.log(`   ✅ Factory now points at ${newImpl}\n`);

  console.log(`========================================`);
  console.log(` Factory unchanged: ${factory}`);
  console.log(` New implementation: ${impl}`);
  console.log(`========================================`);
  console.log(`\nNew publications (createModule) will use the new implementation.`);
  console.log(`Existing publications are UUPS — upgrade each proxy separately if needed.`);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});