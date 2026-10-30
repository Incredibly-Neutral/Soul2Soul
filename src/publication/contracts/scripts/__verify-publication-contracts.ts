/**
 * Verify deployed contracts on BaseScan via their API.
 *
 * Reads the compiled artifact for each contract and submits it
 * for verification. Run after deployment.
 *
 * Usage:
 *   npx tsx contracts/scripts/verify-contracts.ts
 *
 * Requires BASESCAN_API_KEY in the root .env. The deployed
 * addresses are hardcoded below — update them on each deploy.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '../.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ContractToVerify {
  name: string;
  address: string;
  file: string; // relative path from artifact root
}

const CONTRACTS: ContractToVerify[] = [
  {
    name: 'S2SPublicationModuleV2',
    address: '0xbae8877eaeec61f4c443bff04e42bd04fc9b6a73',
    file: 'contracts/contracts/S2SPublicationModuleV2.sol/S2SPublicationModuleV2.json',
  },
  {
    name: 'S2SPublicationModuleV2Factory',
    address: '0xe948735151c43183accd8e85b992952b2711d554',
    file: 'contracts/contracts/S2SPublicationModuleV2Factory.sol/S2SPublicationModuleV2Factory.json',
  },
];

const BASESCAN_API = 'https://api.basescan.org/api';

async function verifyContract(contract: ContractToVerify, apiKey: string) {
  const artifactPath = resolve(__dirname, '../artifacts', contract.file);
  if (!existsSync(artifactPath)) {
    console.error(`  ❌ Artifact not found: ${artifactPath}`);
    console.error('     Run pnpm compile first.');
    return false;
  }

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

  // Build the standard-json-input format that BaseScan expects
  const metadata = artifact.metadata;
  const sources: Record<string, { content: string }> = {};
  for (const [path, info] of Object.entries(metadata.sources)) {
    sources[path] = { content: (info as any).content };
  }

  const standardJsonInput = JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'shanghai',
      metadata: { bytecodeHash: 'none' },
    },
  });

  const body = new URLSearchParams({
    module: 'contract',
    action: 'verifysourcecode',
    contractaddresses: contract.address,
    sourceCode: standardJsonInput,
    codeformat: 'solidity-standard-json-input',
    contractname: contract.name,
    compilerversion: `v${metadata.compiler.version}`,
    constructorArguements: '',
    apikey: apiKey,
  });

  console.log(`  Submitting ${contract.name} (${contract.address})...`);

  try {
    const res = await fetch(BASESCAN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json() as any;

    if (json.status === '1') {
      console.log(`  ✅ ${contract.name} submitted — GUID: ${json.result}`);
      console.log(`     Check status: ${BASESCAN_API}?module=contract&action=checkverifystatus&guid=${json.result}&apikey=${apiKey}`);
      return true;
    } else {
      console.error(`  ❌ ${contract.name}: ${json.result}`);
      return false;
    }
  } catch (err) {
    console.error(`  ❌ ${contract.name}: Network error — ${err}`);
    return false;
  }
}

async function main() {
  const apiKey = process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    console.error('❌ BASESCAN_API_KEY not set in .env');
    process.exit(1);
  }

  console.log(`Verifying ${CONTRACTS.length} contracts on BaseScan...\n`);

  let ok = 0;
  let fail = 0;
  for (const contract of CONTRACTS) {
    if (await verifyContract(contract, apiKey)) {
      ok++;
    } else {
      fail++;
    }
  }

  console.log(`\nDone — ${ok} verified, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});