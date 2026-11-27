/**
 * Deploy the whole author-contracts surface: `DraftsModuleV1`,
 * `OwnerHistoryModuleV1`, then `AuthorFactory` over both, then the records
 * implementation from the publication package and `setRecordsImplementation` on
 * the factory.
 *
 * Four contracts. The factory takes the two author implementation addresses and
 * the protocol Safe as constructor arguments and records the drafts and history
 * implementations as version 1 of two separate histories. The records
 * implementation is not compiled in this package: its artifact is the one
 * `@s2s/publication-contracts` already exports, deployed with `(authorFactory,
 * protocolSafe)` so its constructor can read `protocolSafe()` back. Nothing
 * else is deployed here: a per-Safe module proxy (and, for the history, its
 * guard) comes from `createDraftsModule` / `createOwnerHistoryModule` /
 * `createRecordsModule` on the factory, one per author Safe.
 *
 * Usage:
 *   cd src/author/contracts && pnpm deploy:authorcontracts
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY   deployer key, pays gas, is the factory's only admin
 *   PROTOCOL_SAFE_ADDRESS  the Safe the records implementation compares and
 *                          the third factory constructor argument
 *
 * Write the factory address into the two places the CLI reads, afterwards:
 *   src/author/author-cli/src/core/author-contracts.ts  DEFAULT_AUTHOR_CONTRACTS_FACTORY
 *   src/author/author-cli/src/core/configschema.ts      contracts.authorFactory (env + default)
 * or override per environment with S2S_AUTHOR_CONTRACTS_FACTORY, or
 * `contracts.authorFactory` in the config file. The three implementation
 * addresses are read from the factory, not from the environment: nothing
 * carries them.
 *
 * ── What this script does not do ─────────────────────────────────────────────
 *
 * It does not install anything on a Safe. `createOwnerHistoryModule` deploys a
 * proxy and a guard but leaves the Safe's guard slot at zero; `createRecordsModule`
 * deploys and initializes a records proxy and leaves it unenabled. Adoption is
 * the Safe's own transaction (`setGuard(guard)` is `onlySelf` and enforces the
 * guard's ERC-165 answer — a guard that does not answer `0xe6d7a83a` reverts
 * `GS300`).
 *
 * Adoption is `s2s author init` / `s2s author migrate`, and it enables the
 * modules as well as setting the guard. Enabling is what makes the Safe's own
 * enabled-module list the role index a gate reads. It costs the Safe no
 * authority: none of the modules calls `execTransactionFromModule`, each writes
 * only its own storage and answers views (ADR-004).
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

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  getContractAddress,
  http,
  isAddress,
  parseAbi,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { Artifact_S2SRecordsModuleV0_1 as RecordsArtifact } from '@s2s/publication-contracts/artifacts/S2SRecordsModuleV0_1';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '../../../.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));
const artifactsRoot = resolve(__dirname, '../artifacts');

/** The factory write this script makes, and the reads it verifies. */
const FACTORY_ABI = parseAbi([
  'function setRecordsImplementation(address implementation)',
  'function recordsImplementation() view returns (address)',
  'function protocolSafe() view returns (address)',
]);

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
 * The wallet client, with its chain and local signer baked into the type.
 *
 * A bare `ReturnType<typeof createWalletClient>` is the generic default, which
 * makes `deployContract` reject a chain-and-account-bound client — and, worse,
 * tempts the account back in as an address string. An address string makes
 * viem ask the RPC to sign (`eth_sendTransaction`), which no hosted Base node
 * offers. The account must travel as an object so the key signs locally.
 */
type DeployClient = ReturnType<
  typeof createWalletClient<
    ReturnType<typeof http>,
    typeof base,
    ReturnType<typeof privateKeyToAccount>
  >
>;

/**
 * Deploy one contract from an artifact and wait for its receipt.
 *
 * No explicit `gas`: the node estimates. A hard-coded limit is how a deploy
 * lands under the cost of its own constructor one day — and the old drafts
 * script carried a `3_000_000n` that was already a guess.
 */
async function deployArtifact(
  client: DeployClient,
  account: Account,
  label: string,
  artifact: { abi: unknown; bytecode: `0x${string}` },
  args: any[],
  rpcUrl: string,
): Promise<string> {
  if (!artifact.bytecode || artifact.bytecode === '0x') {
    console.error(`❌ No bytecode for ${label} — is it abstract?`);
    process.exit(1);
  }

  const hash = await client.deployContract({
    abi: artifact.abi as any,
    bytecode: artifact.bytecode,
    account,
    chain: base,
    args,
  });
  console.log(`   Deploy tx: ${hash}`);

  return waitForAddress(rpcUrl, hash);
}

/** Deploy one contract compiled in this package, from Hardhat's artifact. */
async function deployContract(
  client: DeployClient,
  account: Account,
  name: string,
  args: any[],
  rpcUrl: string,
): Promise<string> {
  const artifact = JSON.parse(readFileSync(artifactPath(name), 'utf-8'));
  return deployArtifact(client, account, name, artifact, args, rpcUrl);
}

/**
 * Refuse to start if any address this run would deploy to already has code.
 *
 * All four deploys are CREATE from the same account at consecutive nonces, so
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

  const safeEnv = process.env.PROTOCOL_SAFE_ADDRESS;
  if (!safeEnv || !isAddress(safeEnv)) {
    console.error('❌ PROTOCOL_SAFE_ADDRESS not set or not an address');
    process.exit(1);
  }
  const protocolSafe = getAddress(safeEnv);

  // The author contracts live on Base, next to the publication contracts.
  const rpcUrl = process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
    : 'https://mainnet.base.org';

  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  const transport = http(rpcUrl);
  const client = createWalletClient({ account, chain: base, transport });
  const publicClient = createPublicClient({ chain: base, transport });

  console.log(`Deploying from ${account.address}`);
  console.log(`   Network: ${rpcUrl}`);
  console.log(`   Protocol safe: ${protocolSafe}\n`);

  // Not an authority in the factory, but immutable in the records
  // implementation and compared there on every deploy, so a no-code value is a
  // silent mispoint worth refusing.
  const safeCode = await rpc<string>(rpcUrl, 'eth_getCode', [protocolSafe, 'latest']);
  if (safeCode === '0x') {
    console.error(`❌ PROTOCOL_SAFE_ADDRESS ${protocolSafe} has no code`);
    process.exit(1);
  }

  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
  await assertDeployTargetsAreEmpty(rpcUrl, account.address, nonce, [
    'DraftsModuleV1',
    'OwnerHistoryModuleV1',
    'AuthorFactory',
    'S2SRecordsModuleV0_1',
  ]);

  console.log('1/4 Deploying DraftsModuleV1 (implementation)...');
  const draftsImplementation = await deployContract(client, account, 'DraftsModuleV1', [], rpcUrl);
  console.log(`   ✅ Implementation at ${draftsImplementation}\n`);

  console.log('2/4 Deploying OwnerHistoryModuleV1 (implementation)...');
  const ownerHistoryImplementation = await deployContract(client, account, 'OwnerHistoryModuleV1', [], rpcUrl);
  console.log(`   ✅ Implementation at ${ownerHistoryImplementation}\n`);

  console.log('3/4 Deploying AuthorFactory...');
  const factory = await deployContract(
    client,
    account,
    'AuthorFactory',
    [draftsImplementation, ownerHistoryImplementation, protocolSafe],
    rpcUrl,
  );
  console.log(`   ✅ Factory at ${factory}\n`);

  const recordedSafe = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'protocolSafe',
  });
  if (getAddress(recordedSafe) !== protocolSafe) {
    console.error(`❌ AuthorFactory ${factory} answers protocolSafe() ${recordedSafe}, not ${protocolSafe}`);
    process.exit(1);
  }

  console.log('4/4 Deploying S2SRecordsModuleV0_1 (implementation)...');
  console.log('   Artifact: @s2s/publication-contracts/artifacts/S2SRecordsModuleV0_1');
  const recordsImplementation = await deployArtifact(
    client,
    account,
    'S2SRecordsModuleV0_1',
    RecordsArtifact,
    [factory, protocolSafe],
    rpcUrl,
  );
  console.log(`   ✅ Implementation at ${recordsImplementation}\n`);

  console.log('   setRecordsImplementation(recordsImplementation) on the factory...');
  const setHash = await client.writeContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'setRecordsImplementation',
    args: [recordsImplementation],
    account,
    chain: base,
  });
  const setReceipt = await publicClient.waitForTransactionReceipt({ hash: setHash });
  if (setReceipt.status !== 'success') {
    console.error(`❌ setRecordsImplementation failed in ${setHash}`);
    process.exit(1);
  }

  const recordedImplementation = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'recordsImplementation',
  });
  if (getAddress(recordedImplementation) !== getAddress(recordsImplementation)) {
    console.error(
      `❌ AuthorFactory answers recordsImplementation() ${recordedImplementation}, not ${recordsImplementation}`,
    );
    process.exit(1);
  }
  console.log(`   ✅ Records implementation set\n`);

  for (const [name, address] of [
    ['DraftsModuleV1', draftsImplementation],
    ['OwnerHistoryModuleV1', ownerHistoryImplementation],
    ['AuthorFactory', factory],
    ['S2SRecordsModuleV0_1', recordsImplementation],
  ] as const) {
    const code = await rpc<string>(rpcUrl, 'eth_getCode', [address, 'latest']);
    if (code === '0x') {
      console.error(`❌ ${name} deployed to ${address} but has no code`);
      process.exit(1);
    }
  }

  console.log('Deployed:\n');
  console.log(`  AuthorFactory                        ${factory}`);
  console.log(`  DraftsModuleV1 (implementation)      ${draftsImplementation}`);
  console.log(`  OwnerHistoryModuleV1 (implementation) ${ownerHistoryImplementation}`);
  console.log(`  S2SRecordsModuleV0_1 (implementation) ${recordsImplementation}\n`);
  console.log('The CLI reads two things: the factory address, and nothing else.');
  console.log('  DEFAULT_AUTHOR_CONTRACTS_FACTORY  src/author/author-cli/src/core/author-contracts.ts');
  console.log('  contracts.authorFactory          src/author/author-cli/src/core/configschema.ts');
  console.log('  or S2S_AUTHOR_CONTRACTS_FACTORY in the environment (overrides both)\n');
  console.log('Next, per author Safe (nothing is installed by the deploys above):');
  console.log('  s2s author init                   → drafts proxy, history proxy + guard, records');
  console.log('                                      proxy, enableModule for all, setGuard');
  console.log('  s2s author migrate                → same set on new modules, keeping the Safe');
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
