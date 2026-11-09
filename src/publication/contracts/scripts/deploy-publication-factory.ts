/**
 * Deploy S2SPublicationModuleV3Factory on Base.
 *
 * Two-step: deploy the implementation first, then the factory, which takes
 * `[protocolSafe, implementation]` as constructor arguments and checks both
 * have code. The protocol safe must already exist — passing an EOA would make
 * the factory's only privileged key an ordinary private key.
 *
 * Usage:
 *   cd src/publication/contracts && pnpm deploy:pubfac
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY    deployer key (pays gas, needs no privilege)
 *   PROTOCOL_SAFE_ADDRESS   the address that will be the only one able to call
 *                           setImplementation — must be a contract
 *
 * Optional:
 *   PUBLICATION_IMPL_CONTRACT  implementation to deploy (default S2SPublicationModuleV3)
 *   BASE_RPC_URL / VITE_DRPC_API_KEY
 */

import {createPublicClient, createWalletClient, encodeDeployData, getAddress, http, isAddress} from 'viem';
import type {Account, HttpTransport, PublicClient, WalletClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {base} from 'viem/chains';
import {readFileSync, existsSync, readdirSync, statSync} from 'fs';
import {resolve, dirname, join} from 'path';
import {fileURLToPath} from 'url';
import {config} from 'dotenv';

// Load <repo>/.env, the same file hardhat.config.ts loads. Resolved from this
// file, not from cwd: `pnpm` runs with cwd = the package dir, where `../.env`
// is src/publication/.env and does not exist, so the documented
// `cd src/publication/contracts && pnpm deploy:pubfac` silently found nothing.
// Four levels up: scripts -> contracts -> publication -> src -> repo.
config({path: fileURLToPath(new URL('../../../../.env', import.meta.url))});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = resolve(__dirname, '../artifacts');

type Wallet = WalletClient<HttpTransport, typeof base, Account>;
type Pub = PublicClient<HttpTransport, typeof base>;

const IMPL_NAME = process.env.PUBLICATION_IMPL_CONTRACT || 'S2SPublicationModuleV3';
const FACTORY_NAME = 'S2SPublicationModuleV3Factory';

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

async function deployContract(
  client: Wallet,
  publicClient: Pub,
  name: string,
  args: unknown[],
): Promise<`0x${string}`> {
  const artifactPath = findArtifact(name);
  if (!artifactPath) {
    console.error(`❌ Artifact for ${name} not found under ${ARTIFACT_ROOT}`);
    console.error('   Run pnpm compile first.');
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  const abi = artifact.abi;
  const bytecode = artifact.bytecode as `0x${string}`;

  // Estimate per contract instead of carrying one flat limit. The fixed
  // 3_000_000n was sized for a 9.9 KB module; the V3 module's init code is
  // 12,040 bytes, whose floor alone is 2,466,902 gas on Base before the
  // constructor body runs (21,000 tx + 49,948 calldata + 32,000 CREATE + 754
  // EIP-3860 + 11,816 × 200 code deposit). That left 22% and no per-contract
  // check. A quarter on top of the estimate covers the L1 data fee drift.
  const estimate = await publicClient.estimateGas({
    account: client.account,
    data: encodeDeployData({abi, bytecode, args}),
  });
  const gas = estimate + estimate / 4n;
  console.log(`   Gas estimate: ${estimate} (limit ${gas})`);

  const hash = await client.deployContract({
    abi,
    bytecode,
    args,
    gas,
  });
  console.log(`   Deploy tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    console.error(`❌ Deploy failed (status: ${receipt.status})`);
    process.exit(1);
  }
  return getAddress(receipt.contractAddress);
}

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) {
    console.error('❌ PROTOCOL_PRIVATE_KEY not set');
    process.exit(1);
  }

  const safeEnv = process.env.PROTOCOL_SAFE_ADDRESS;
  if (!safeEnv) {
    console.error('❌ PROTOCOL_SAFE_ADDRESS not set — the factory needs its privileged address at construction.');
    process.exit(1);
  }
  if (!isAddress(safeEnv)) {
    console.error(`❌ PROTOCOL_SAFE_ADDRESS is not an address: ${safeEnv}`);
    process.exit(1);
  }
  const protocolSafe = getAddress(safeEnv);

  const rpcUrl =
    process.env.BASE_RPC_URL ||
    (process.env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
      : 'https://mainnet.base.org');

  const payerHex = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(payerHex);
  const client = createWalletClient({account, chain: base, transport: http(rpcUrl)});
  const publicClient = createPublicClient({chain: base, transport: http(rpcUrl)});

  // The publication module is a Safe module on Base — always deploy to Base.
  const chainId = await publicClient.getChainId().catch(() => 0);
  if (chainId !== base.id) {
    console.error(`❌ RPC is not Base (${base.id}). Refusing to deploy elsewhere.`);
    process.exit(1);
  }

  if (account.address === protocolSafe) {
    console.error('❌ PROTOCOL_SAFE_ADDRESS equals the deployer EOA.');
    console.error('   That would make a hot key the factory admin and re-open the V2 hole.');
    process.exit(1);
  }
  const safeCode = await publicClient.getCode({address: protocolSafe});
  if (!safeCode || safeCode === '0x') {
    console.error(`❌ PROTOCOL_SAFE_ADDRESS ${protocolSafe} has no code — it is an EOA, not a Safe.`);
    process.exit(1);
  }

  console.log(`Deploying from ${account.address}`);
  console.log(`   Network:      ${rpcUrl}`);
  console.log(`   Protocol safe: ${protocolSafe}\n`);

  console.log(`1/2 Deploying ${IMPL_NAME}...`);
  const impl = await deployContract(client, publicClient, IMPL_NAME, []);
  console.log(`   ✅ Implementation at ${impl}\n`);

  console.log(`2/2 Deploying ${FACTORY_NAME} [protocolSafe, implementation]...`);
  const factory = await deployContract(client, publicClient, FACTORY_NAME, [protocolSafe, impl]);
  console.log(`   ✅ Factory at ${factory}\n`);

  console.log('Set in .env:\n');
  console.log(`  PUBLICATION_FACTORY_ADDRESS=${factory}`);
  console.log(`  PUBLICATION_IMPLEMENTATION_ADDRESS=${impl}`);
  console.log(`\nPROTOCOL_SAFE_ADDRESS stays ${protocolSafe} — the only address that can call setImplementation.`);
  console.log('Existing publication proxies are UUPS and are not affected by this deploy.');
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
