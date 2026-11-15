/**
 * Deploy S2SPublicationModuleV4Create2Factory on Base.
 *
 * Two-step: deploy the implementation first, then the factory, which takes
 * `[protocolSafe, implementation]` as constructor arguments and checks both
 * have code. The protocol safe must already exist — passing an EOA would make
 * the factory's only privileged key an ordinary private key.
 *
 * The factory deploys each publication's module with CREATE2 at an address
 * computed from the safe, and returns the recorded module if one already
 * exists. A redeploy here is a new factory address and therefore a new set of
 * predicted addresses: modules already deployed stay where they are, addressed
 * in the `publication_factory` record and still reachable through the Safe's
 * module list.
 *
 * Usage:
 *   cd src/publication/contracts && pnpm deploy:pubfac
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY    deployer key (pays gas, needs no privilege)
 *   PROTOCOL_SAFE_ADDRESS   the address that will be the only one able to call
 *                           setImplementation — must be a contract
 *
 * The implementation and the factory are a pair: the V4 factory approves every
 * implementation it has been set to, and a V4 module reads that approval through
 * the factory it recorded at birth. The factory's constructor and
 * `setImplementation` refuse an implementation that does not answer `factory()`
 * with `ImplementationWithoutUpgradeGate`, so the pair cannot be mismatched.
 *
 * This deploys S2SPublicationModuleV4Create2Factory. There is no factory choice:
 * the plain-CREATE V3 factory has no `isApprovedImplementation`, and a V4 module
 * deployed through it would revert every upgrade on an unknown selector.
 *
 * Before the factory deploy, the implementation is asked whether it answers
 * `factory()` (see `implementation-gate.ts`).
 *
 * Optional:
 *   PUBLICATION_IMPL_CONTRACT     implementation to deploy (default
 *                                 S2SPublicationModuleV4; must answer factory())
 *   BASE_RPC_URL / VITE_DRPC_API_KEY
 */

import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  http,
  isAddress,
} from 'viem';
import type {Account, HttpTransport, PublicClient, WalletClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {base} from 'viem/chains';
import {readFileSync, existsSync, readdirSync, statSync} from 'fs';
import {resolve, dirname, join} from 'path';
import {fileURLToPath} from 'url';
import {config} from 'dotenv';

import {hasUpgradeGate} from './implementation-gate.ts';

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

const IMPL_NAME = process.env.PUBLICATION_IMPL_CONTRACT || 'S2SPublicationModuleV4';
const FACTORY_NAME = 'S2SPublicationModuleV4Create2Factory';

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

  // The factory's constructor refuses this, but only after the factory's deploy
  // gas is spent. Ask first, so a wrong PUBLICATION_IMPL_CONTRACT fails with a
  // sentence instead of a bare revert. A revert on the staticcall means the
  // selector is absent; empty or short data means the same thing.
  const gated = await hasUpgradeGate(publicClient, impl).catch(() => false);
  if (!gated) {
    console.error(`❌ ${IMPL_NAME} does not answer factory() — that is not a gated implementation.`);
    console.error('   S2SPublicationModuleV4Create2Factory refuses it with ImplementationWithoutUpgradeGate.');
    process.exit(1);
  }

  console.log(`2/2 Deploying ${FACTORY_NAME} [protocolSafe, implementation]...`);
  const factory = await deployContract(client, publicClient, FACTORY_NAME, [protocolSafe, impl]);
  console.log(`   ✅ Factory at ${factory}\n`);

  console.log('Set in .env:\n');
  console.log(`  PUBLICATION_FACTORY_ADDRESS=${factory}`);
  console.log(`  PUBLICATION_IMPLEMENTATION_ADDRESS=${impl}`);
  console.log(`\nPROTOCOL_SAFE_ADDRESS stays ${protocolSafe} — the only address that can call setImplementation.`);
  console.log('Module addresses for this factory are computed from the safe, not read back from logs.');
  console.log('Existing publication proxies are UUPS and are not affected by this deploy.');
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
