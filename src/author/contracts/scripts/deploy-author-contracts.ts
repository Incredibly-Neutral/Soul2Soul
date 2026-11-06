/**
 * Deploy the whole author-contracts surface: `DraftsModuleV1`,
 * `OwnerHistoryModuleV1`, then `AuthorContractsFactory` over both.
 *
 * Three contracts, because the factory takes the two implementation addresses
 * as constructor arguments and records them as version 1 of two separate
 * histories. Nothing else is deployed here: a per-Safe module proxy (and, for
 * the history, its guard) comes from `createDraftsModule` / `createOwnerHistoryModule`
 * on the factory, one per author Safe.
 *
 * Usage:
 *   cd src/author/contracts && pnpm deploy:authorcontracts
 *
 * Set in .env afterwards:
 *   AUTHOR_CONTRACTS_FACTORY_ADDRESS=<factory>
 *   AUTHOR_DRAFTS_IMPLEMENTATION_ADDRESS=<drafts impl>
 *   AUTHOR_OWNER_HISTORY_IMPLEMENTATION_ADDRESS=<history impl>
 *
 * ── What this script does not do ─────────────────────────────────────────────
 *
 * It does not install anything on a Safe. `createOwnerHistoryModule` deploys a
 * proxy and a guard but leaves the Safe's guard slot at zero; adoption is the
 * Safe's own transaction (`setGuard(guard)`, which is `onlySelf` and enforces
 * the guard's ERC-165 answer — a guard that does not answer `0xe6d7a83a`
 * reverts `GS300`). `enableModule` is not part of the install and is not
 * recommended: an enabled module can `execTransactionFromModule`, i.e. execute
 * anything as the author Safe, and this module needs no module powers.
 *
 * ── The operating rule for rotations on a guarded Safe ───────────────────────
 *
 * The guard is the safety net, not the primary path. `checkAfterExecution`
 * forwards at most 600k of gas to `sync()` and keeps 20k back so the Safe itself
 * can never fail; a Safe transaction whose gas limit is the estimated cost
 * starves the hook, which then emits `SyncFailed(blockNumber)` and records
 * nothing. So: propose a rotation with at least `600_000 + 40_000` of headroom
 * above the estimate, or include an explicit `sync()` in the batch; afterwards
 * check that `SyncFailed` did not appear and that `lastSyncedBlock()` moved.
 * Anyone can repair a miss with a permissionless `sync()`.
 */

import { createPublicClient, createWalletClient, getContractAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '../../../.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));
const artifactsRoot = resolve(__dirname, '../artifacts');

/** Hardhat 3 writes `artifacts/src/<Name>.sol/<Name>.json`. */
function artifactPath(name: string): string {
  const candidates = [
    resolve(artifactsRoot, `src/${name}.sol/${name}.json`),
    resolve(artifactsRoot, `${name}.sol/${name}.json`),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(`❌ Artifact not found. Looked in:\n   ${candidates.join('\n   ')}`);
    console.error('   Run `pnpm compile` first.');
    process.exit(1);
  }
  return found;
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  }).then((r) => r.json());
  if (response.error) {
    throw new Error(`${method}: ${response.error.message ?? JSON.stringify(response.error)}`);
  }
  return response.result as T;
}

async function waitForAddress(rpcUrl: string, hash: `0x${string}`): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const receipt = await rpc<{ contractAddress?: string } | null>(
      rpcUrl,
      'eth_getTransactionReceipt',
      [hash],
    );
    if (receipt?.contractAddress) return receipt.contractAddress;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error('❌ Timed out waiting for deploy receipt');
  process.exit(1);
}

/**
 * No explicit `gas`: the node estimates. A hard-coded limit is how a deploy
 * lands under the cost of its own constructor one day — and the old drafts
 * script carried a `3_000_000n` that was already a guess.
 */
async function deployContract(
  client: ReturnType<typeof createWalletClient>,
  account: `0x${string}`,
  name: string,
  args: any[],
  rpcUrl: string,
): Promise<string> {
  const artifact = JSON.parse(readFileSync(artifactPath(name), 'utf-8'));
  if (!artifact.bytecode || artifact.bytecode === '0x') {
    console.error(`❌ No bytecode for ${name} — is it abstract?`);
    process.exit(1);
  }

  const hash = await client.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    account,
    chain: base,
    args,
  });
  console.log(`   Deploy tx: ${hash}`);

  const address = await waitForAddress(rpcUrl, hash);
  return address;
}

/**
 * Refuse to start if any address this run would deploy to already has code.
 *
 * All three deploys are CREATE from the same account at consecutive nonces, so
 * every target address is known before the first transaction is sent. A
 * non-empty one means the plan is wrong (wrong chain, a stale nonce, an address
 * meant for reuse) — and a factory pointed at someone else's contract is a
 * permanent, immutable mispoint, so this is checked up front rather than after.
 */
async function assertDeployTargetsAreEmpty(
  rpcUrl: string,
  from: `0x${string}`,
  firstNonce: number,
  names: readonly string[],
): Promise<void> {
  for (const [i, name] of names.entries()) {
    const address = getContractAddress({ from, nonce: BigInt(firstNonce + i) });
    const code = await rpc<string>(rpcUrl, 'eth_getCode', [address, 'latest']);
    if (code !== '0x') {
      console.error(`❌ Refusing to continue: ${name} would deploy to ${address}, which already has code.`);
      process.exit(1);
    }
    console.log(`   ${name} will deploy to ${address}`);
  }
  console.log('');
}

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) {
    console.error('❌ PROTOCOL_PRIVATE_KEY not set');
    process.exit(1);
  }

  // The author contracts live on Base, next to the publication contracts.
  const rpcUrl = process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
    : 'https://mainnet.base.org';

  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  const transport = http(rpcUrl);
  const client = createWalletClient({ account, chain: base, transport });
  const publicClient = createPublicClient({ chain: base, transport });

  console.log(`Deploying from ${account.address}\n   Network: ${rpcUrl}\n`);

  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
  await assertDeployTargetsAreEmpty(rpcUrl, account.address, nonce, [
    'DraftsModuleV1',
    'OwnerHistoryModuleV1',
    'AuthorContractsFactory',
  ]);

  console.log('1/3 Deploying DraftsModuleV1 (implementation)...');
  const draftsImplementation = await deployContract(client, account.address, 'DraftsModuleV1', [], rpcUrl);
  console.log(`   ✅ Implementation at ${draftsImplementation}\n`);

  console.log('2/3 Deploying OwnerHistoryModuleV1 (implementation)...');
  const ownerHistoryImplementation = await deployContract(client, account.address, 'OwnerHistoryModuleV1', [], rpcUrl);
  console.log(`   ✅ Implementation at ${ownerHistoryImplementation}\n`);

  for (const [name, address] of [
    ['DraftsModuleV1', draftsImplementation],
    ['OwnerHistoryModuleV1', ownerHistoryImplementation],
  ] as const) {
    const code = await rpc<string>(rpcUrl, 'eth_getCode', [address, 'latest']);
    if (code === '0x') {
      console.error(`❌ ${name} deployed to ${address} but has no code`);
      process.exit(1);
    }
  }

  console.log('3/3 Deploying AuthorContractsFactory...');
  const factory = await deployContract(
    client,
    account.address,
    'AuthorContractsFactory',
    [draftsImplementation, ownerHistoryImplementation],
    rpcUrl,
  );

  const factoryCode = await rpc<string>(rpcUrl, 'eth_getCode', [factory, 'latest']);
  if (factoryCode === '0x') {
    console.error(`❌ AuthorContractsFactory deployed to ${factory} but has no code`);
    process.exit(1);
  }
  console.log(`   ✅ Factory at ${factory}\n`);

  console.log('Deployed:\n');
  console.log(`  AUTHOR_CONTRACTS_FACTORY_ADDRESS=${factory}`);
  console.log(`  AUTHOR_DRAFTS_IMPLEMENTATION_ADDRESS=${draftsImplementation}`);
  console.log(`  AUTHOR_OWNER_HISTORY_IMPLEMENTATION_ADDRESS=${ownerHistoryImplementation}\n`);
  console.log('Next, per author Safe (nothing is installed by the deploys above):');
  console.log('  createDraftsModule(safe)          → drafts proxy');
  console.log('  createOwnerHistoryModule(safe)    → history proxy + guard');
  console.log('  then ONE Safe transaction: setGuard(guard)');
  console.log('  do NOT enableModule: an enabled module can execute as the Safe.');
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
