/**
 * Deploy S2SPublicationModulesFactoryV6 on Base.
 *
 * The factory takes one constructor argument, the protocol safe, and checks it
 * has code. That address is the only caller `setImplementation` and
 * `revokeImplementation` accept, so it must be the Safe and not the key that
 * pays for this deploy: a hot key in that slot hands the protocol's upgrade
 * pointer to whoever holds the key, and no setter can repair it afterwards,
 * because `protocolSafe` is immutable.
 *
 * This script only deploys. It sets no implementation and creates no module.
 * A fresh factory has an empty history for both kinds, so `latestImplementation`
 * answers zero and `createModule` reverts `NoImplementation(kind)` until the
 * protocol safe calls `setImplementation` for that kind. The order is deploy
 * factory, deploy implementations, approve them, then create modules.
 *
 * The factory's address is the whole address space of its modules: a module's
 * address is a function of (factory, safe, kind) and nothing else, so a second
 * factory is a second set of module addresses. Re-running this script does not
 * move anything already deployed; it starts a new set.
 *
 * Usage:
 *   cd src/publication/contracts && pnpm deploy:factory
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY    deployer key (pays gas, carries no privilege)
 *   PROTOCOL_SAFE_ADDRESS   the Safe that will be the only address able to set
 *                           or revoke an implementation — must have code
 *   BASE_RPC_URL / VITE_DRPC_API_KEY   optional RPC override
 *
 * The printed address belongs in `PUBLICATION_FACTORY_ADDRESS`, one name across
 * the repo: update-protocol.ts, check-module.ts and the verify scripts read it.
 * .env is not what clients read. They read the `publication_factory` record on
 * the records module, and only update-protocol.ts writes it.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  http,
  isAddress,
  parseAbi,
} from 'viem';
import type { Account, HttpTransport, PublicClient, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

// Load <repo>/.env, the same file hardhat.config.ts loads. Resolved from this
// file, not from cwd: `pnpm` runs with cwd = the package dir, where `../.env`
// is src/publication/.env and does not exist.
// Four levels up: scripts -> contracts -> publication -> src -> repo.
config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = resolve(__dirname, '../artifacts');

type Wallet = WalletClient<HttpTransport, typeof base, Account>;
type Pub = PublicClient<HttpTransport, typeof base>;

const FACTORY_NAME = 'S2SPublicationModulesFactoryV6';

const FACTORY_ABI = parseAbi(['function protocolSafe() view returns (address)']);

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

async function deployFactory(
  client: Wallet,
  publicClient: Pub,
  protocolSafe: `0x${string}`,
): Promise<`0x${string}`> {
  const artifactPath = findArtifact(FACTORY_NAME);
  if (!artifactPath) {
    console.error(
      `❌ No artifact for ${FACTORY_NAME} under ${ARTIFACT_ROOT} — run pnpm compile first.`,
    );
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  const abi = artifact.abi;
  const bytecode = artifact.bytecode as `0x${string}`;

  // Estimate per deploy and add a quarter. The factory's init code embeds the
  // proxy's creation code hash, so its size moves with that proxy and a flat
  // limit would silently stop covering it.
  const estimate = await publicClient.estimateGas({
    account: client.account,
    data: encodeDeployData({ abi, bytecode, args: [protocolSafe] }),
  });
  const gas = estimate + estimate / 4n;
  console.log(`   Gas estimate: ${estimate} (limit ${gas})`);

  const hash = await client.deployContract({ abi, bytecode, args: [protocolSafe], gas });
  console.log(`   Deploy tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    console.error(`❌ Deploy failed (status: ${receipt.status}).`);
    process.exit(1);
  }
  return getAddress(receipt.contractAddress);
}

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) {
    console.error('❌ PROTOCOL_PRIVATE_KEY is not set — it pays for the deploy.');
    process.exit(1);
  }

  const safeEnv = process.env.PROTOCOL_SAFE_ADDRESS;
  if (!safeEnv) {
    console.error(
      '❌ PROTOCOL_SAFE_ADDRESS is not set — the factory takes its only privileged address at construction.',
    );
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
  const client = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId().catch(() => 0);
  if (chainId !== base.id) {
    console.error(
      `❌ RPC ${rpcUrl} is chain ${chainId}, not Base (${base.id}) — the factory and its modules live on Base only.`,
    );
    process.exit(1);
  }

  if (account.address === protocolSafe) {
    console.error(
      '❌ PROTOCOL_SAFE_ADDRESS equals the deployer: the upgrade pointer would sit on the hot key that pays gas.',
    );
    process.exit(1);
  }
  const safeCode = await publicClient.getCode({ address: protocolSafe });
  if (!safeCode || safeCode === '0x') {
    console.error(
      `❌ PROTOCOL_SAFE_ADDRESS ${protocolSafe} has no code: the deploy would bind the upgrade pointer to a key that no multisig can revoke, and the constructor reverts NotAContract.`,
    );
    process.exit(1);
  }

  console.log(`Deploying from ${account.address}`);
  console.log(`   Network:       ${rpcUrl}`);
  console.log(`   Protocol safe: ${protocolSafe}\n`);

  console.log(`Deploying ${FACTORY_NAME} [protocolSafe]...`);
  const factory = await deployFactory(client, publicClient, protocolSafe);

  const code = await publicClient.getCode({ address: factory });
  if (!code || code === '0x') {
    console.error(`❌ No code at ${factory} — the deploy reported success but nothing is there.`);
    process.exit(1);
  }
  const recordedSafe = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'protocolSafe',
  });
  if (getAddress(recordedSafe) !== protocolSafe) {
    console.error(
      `❌ ${factory} answers protocolSafe() ${recordedSafe}, not ${protocolSafe} — do not use it.`,
    );
    process.exit(1);
  }

  console.log(`\n✅ ${FACTORY_NAME} at ${factory}\n`);
  console.log(`Add PUBLICATION_FACTORY_ADDRESS=${factory} to .env\n`);
  console.log('Nothing is approved yet. Deploy the implementations next:');
  console.log('  pnpm deploy:impl -- --kind publication');
  console.log('  pnpm deploy:impl -- --kind records\n');
  console.log('Then approve them with pnpm set:impl.');
  console.log('createModule reverts NoImplementation(kind) until set:impl executes.\n');
  console.log(
    'Clients read the protocol records, not .env. Once the implementations are approved,',
  );
  console.log('write them with `pnpm update-protocol`. The same factory serves both kinds, so set');
  console.log('RECORDS_FACTORY_ADDRESS to this address too — otherwise records_factory keeps the');
  console.log('retired factory, or is written empty.');
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
