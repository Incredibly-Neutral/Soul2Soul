/**
 * Verify deployed contracts on Etherscan V2 API (works for BaseScan).
 *
 * Usage:
 *   cd protocol && pnpm verify
 *
 * Reads ETHERSCAN_API_KEY from the root .env.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

// Load <repo>/.env, the same file hardhat.config.ts loads. Resolved from this
// file, not from cwd: `pnpm` runs with cwd = the package dir, where `../.env`
// is src/publication/.env and does not exist, so the documented
// `cd src/publication/contracts && pnpm deploy:pubfac` silently found nothing.
// Four levels up: scripts -> contracts -> publication -> src -> repo.
config({path: fileURLToPath(new URL('../../../../.env', import.meta.url))});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = resolve(__dirname, '../artifacts/src');
const BUILD_INFO_DIR = resolve(__dirname, '../artifacts/build-info');

interface ContractToVerify {
  name: string;
  address: string;
}

const CONTRACTS: ContractToVerify[] = [
  { name: 'S2SPublicationModuleV2', address: '0x4d05a336700644De60F09aF8104DC96047023C1f' },
  { name: 'S2SPublicationModuleV3Factory', address: process.env.PUBLICATION_FACTORY_ADDRESS || '' },
].filter((c) => {
  if (!c.address) {
    console.log(`  ⏭  ${c.name}: no address yet (set PUBLICATION_FACTORY_ADDRESS after deploying)`);
    return false;
  }
  return true;
});

function readBuildInfo(id: string): any {
  const files = readdirSync(BUILD_INFO_DIR);
  for (const f of files) {
    if (f.endsWith('.json') && !f.endsWith('.output.json')) {
      const bi = JSON.parse(readFileSync(resolve(BUILD_INFO_DIR, f), 'utf-8'));
      if (bi.id === id) return bi;
    }
  }
  return null;
}

async function verifyContract({ name, address }: ContractToVerify, apiKey: string) {
  const solFiles = readdirSync(ARTIFACT_DIR);
  const solDir = solFiles.find(f =>
    f.endsWith('.sol') && existsSync(resolve(ARTIFACT_DIR, f, `${name}.json`))
  );
  if (!solDir) {
    console.error(`  ❌ Artifact for ${name} not found`);
    return false;
  }

  const artifact = JSON.parse(
    readFileSync(resolve(ARTIFACT_DIR, solDir, `${name}.json`), 'utf-8')
  );
  const buildInfo = artifact.buildInfoId ? readBuildInfo(artifact.buildInfoId) : null;
  if (!buildInfo) {
    console.error(`  ❌ Build info not found for ${name}`);
    return false;
  }

  const { input, solcLongVersion } = buildInfo;

  // Strip outputSelection — Etherscan doesn't want it
  const settings = { ...input.settings };
  delete settings.outputSelection;

  const standardJsonInput = JSON.stringify({
    language: input.language,
    sources: input.sources,
    settings,
  });

  // V2 API expects contractname as "SourceFile.sol:ContractName"
  const sourceFile = artifact.sourceName.split('/').pop() || artifact.sourceName;
  const contractName = `${sourceFile}:${artifact.contractName}`;

  const body = new URLSearchParams({
    apikey: apiKey,
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: address,
    sourceCode: standardJsonInput,
    codeformat: 'solidity-standard-json-input',
    contractname: contractName,
    compilerversion: `v${solcLongVersion}`,
    optimizationUsed: '1',
    runs: '200',
    evmVersion: settings.evmVersion || 'default',
    licenseType: '1',
  });

  console.log(`  Submitting ${name} (${address})...`);
  console.log(`    contractname: ${contractName}`);
  console.log(`    compilerversion: v${solcLongVersion}`);

  const res = await fetch('https://api.etherscan.io/v2/api?chainid=8453', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json() as any;

  if (json.status === '1') {
    console.log(`  ✅ ${name} — GUID: ${json.result}`);
    // Poll for verification status
    console.log(`    Polling verification status...`);
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(
        `https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=checkverifystatus&guid=${json.result}&apikey=${apiKey}`
      );
      const statusJson = await statusRes.json() as any;
      if (statusJson.status === '1') {
        console.log(`  ✅ ${name} — Verified!`);
        return true;
      }
      if (statusJson.result !== 'Pending in queue' && !statusJson.result?.includes('Pending')) {
        console.error(`  ❌ ${name} — ${statusJson.result}`);
        return false;
      }
      console.log(`    ... pending (${i + 1}/10)`);
    }
    console.log(`  ⏳ ${name} — Still pending after 50s, check manually`);
    return true;
  }

  // If already verified, that's fine
  if (json.result?.includes('Already Verified') || json.result?.includes('already verified')) {
    console.log(`  ✅ ${name} — Already verified`);
    return true;
  }

  console.error(`  ❌ ${name}: ${json.result}`);
  return false;
}

async function main() {
  const apiKey = process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY;
  if (!apiKey) {
    console.error('❌ No API key found. Set ETHERSCAN_API_KEY in .env');
    process.exit(1);
  }

  console.log(`Verifying ${CONTRACTS.length} contracts via Etherscan API V2...\n`);
  let ok = 0;
  for (const c of CONTRACTS) {
    if (await verifyContract(c, apiKey)) ok++;
    else process.exitCode = 1;
    console.log();
  }
  console.log(`— ${ok}/${CONTRACTS.length} verified`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });