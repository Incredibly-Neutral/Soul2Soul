/**
 * Deploy new S2SPublicationModule implementation + factory.
 *
 * Run after contract changes. Deploys both the implementation and
 * a new factory — the old factory at 0x9c7937 cannot be updated
 * (it predates the setImplementation method).
 *
 * Usage:
 *   npx tsx contracts/scripts/update-impl.ts
 *
 * After deploying, update:
 *   - PUBLICATION_FACTORY_V2_ADDRESS in .env
 *   - safe_publication_factory in 0xobsidian settings
 */

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '../.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(__dirname, '../artifacts/contracts/contracts');

async function deployContract(client: ReturnType<typeof createWalletClient>, name: string, args: any[], rpcUrl: string): Promise<string> {
  const artifactPath = resolve(artifactDir, `${name}.sol/${name}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`❌ Artifact not found at ${artifactPath}`);
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

  const hash = await client.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args,
    gas: 3_000_000n,
  });

  console.log(`   Deploy tx: ${hash}`);

  for (let i = 0; i < 30; i++) {
    const receipt = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'eth_getTransactionReceipt',
        params: [hash], id: 1,
      }),
    }).then(r => r.json());

    if (receipt?.result?.contractAddress) {
      return receipt.result.contractAddress;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.error('❌ Timed out waiting for deploy receipt');
  process.exit(1);
}

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) { console.error('❌ PROTOCOL_PRIVATE_KEY not set'); process.exit(1); }

  const rpcUrl = process.env.BASE_RPC_URL ||
    (process.env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
      : 'https://mainnet.base.org');

  const payerHex = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(payerHex);
  const client = createWalletClient({ account, transport: http(rpcUrl) });

  console.log(`Deploying from ${account.address}`);
  console.log(`   RPC: ${rpcUrl}\n`);

  // Step 1: deploy implementation
  console.log('1/2 Deploying S2SPublicationModule...');
  const impl = await deployContract(client, 'S2SPublicationModule', [], rpcUrl);
  console.log(`   ✅ Implementation at ${impl}\n`);

  // Step 2: deploy factory with new implementation
  console.log('2/2 Deploying S2SPublicationModuleFactory...');
  const factory = await deployContract(client, 'S2SPublicationModuleFactory', [impl], rpcUrl);
  console.log(`   ✅ Factory at ${factory}\n`);

  console.log(`========================================`);
  console.log(` Set these in .env:`);
  console.log(`   PUBLICATION_FACTORY_V2_ADDRESS=${factory}`);
  console.log(`========================================`);
  console.log(`\nAlso update verify-contracts.ts with these addresses.`);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});