/**
 * Deploy S2SPublicationModuleV2 + S2SPublicationModuleV2Factory.
 *
 * Two-step: deploy the implementation first, then the factory which
 * accepts the impl address as a constructor argument. This keeps the
 * factory bytecode small enough to fit within contract size limits.
 *
 * Usage:
 *   cd protocol && npx tsx contracts/scripts/deploy-v2-factory.ts
 *
 * Set PUBLICATION_FACTORY_V2_ADDRESS in .env after deploying.
 */

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
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

  // Poll for receipt
  for (let i = 0; i < 30; i++) {
    const receipt = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  // The publication module is a Safe module on Base — always deploy to Base
  const rpcUrl = process.env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
      : 'https://mainnet.base.org';

  const payerHex = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(payerHex);
  const client = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

  console.log(`Deploying from ${account.address}\n   Network: ${rpcUrl}\n`);

  // Step 1: deploy implementation
  console.log('1/2 Deploying S2SPublicationModule...');
  const impl = await deployContract(client, 'S2SPublicationModule', [], rpcUrl);
  console.log(`   ✅ Implementation at ${impl}\n`);

  // Step 2: deploy factory with implementation address
  console.log('2/2 Deploying S2SPublicationModuleFactory...');
  const factory = await deployContract(client, 'S2SPublicationModuleFactory', [impl], rpcUrl);
  console.log(`   ✅ Factory at ${factory}\n`);

  console.log(`Set in .env:\n`);
  console.log(`  PUBLICATION_FACTORY_V2_ADDRESS=${factory}`);
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});