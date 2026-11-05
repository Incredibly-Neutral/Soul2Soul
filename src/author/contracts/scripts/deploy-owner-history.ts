/**
 * Deploy the owner-history module, its factory, and — when the two addresses it
 * needs are known — the guard for one author Safe.
 *
 * Steps:
 *   1. `OwnerHistoryModuleV1`   the shared UUPS implementation (one address, all
 *                               author Safes proxy onto it via the factory)
 *   2. `OwnerHistoryModuleV1Factory`  creates one proxy per Safe, and is the
 *                               index a gate uses to find them
 *   3. `OwnerHistoryGuard(safe, module)`  optional; only if
 *                               `AUTHOR_SAFE_ADDRESS` and
 *                               `OWNER_HISTORY_MODULE_ADDRESS` are set
 *
 * Usage:
 *   cd src/author/contracts && pnpm deploy:ownerhistory
 *
 * Set in .env afterwards:
 *   OWNER_HISTORY_FACTORY_ADDRESS=<factory>        (always)
 *   OWNER_HISTORY_MODULE_ADDRESS=<proxy per Safe>  (after createModule)
 *
 * ── The operating rule, which is the point of the guard section below ────────
 *
 * The guard is the *safety net*, not the primary path. `checkAfterExecution`
 * forwards at most 600k of gas to `sync()` and keeps 20k back so the Safe itself
 * can never fail; a Safe transaction whose gas limit is the estimated cost
 * starves the hook, which then emits `SyncFailed(blockNumber)` and records
 * nothing. Nobody can fix that from inside a contract — the cost of the sync is
 * not knowable before the transaction runs.
 *
 * So, for a rotation on a guarded author Safe:
 *   - propose the transaction with at least `600_000 + 40_000` of headroom above
 *     the estimate, **or** include an explicit `sync()` call in the batch (which
 *     needs no headroom, because it is the call itself);
 *   - afterwards, check that `SyncFailed` did not appear and that
 *     `lastSyncedBlock()` moved. If it did not, anyone can repair it with a
 *     plain `sync()` — the era is then stamped at the repair block, not at the
 *     rotation block.
 *
 * This script refuses to deploy a guard whose `module` has no code. That is not
 * defensive coding, it is the one mistake with a permanent price: `module` is
 * immutable on the guard, and a guard calls a codeless address successfully with
 * empty returndata. The guard is written to survive it (it calls low-level and
 * never decodes), but there is no reason to ship the mistake.
 */

import { createWalletClient, http } from 'viem';
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

/** No explicit `gas`: the node estimates. A hard-coded limit is how a deploy
 *  lands under the cost of its own constructor one day. */
async function deployContract(
  client: ReturnType<typeof createWalletClient>,
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
    args,
  });
  console.log(`   Deploy tx: ${hash}`);

  const address = await waitForAddress(rpcUrl, hash);
  const code = await rpc<string>(rpcUrl, 'eth_getCode', [address, 'latest']);
  if (code === '0x') {
    console.error(`❌ ${name} deployed to ${address} but has no code`);
    process.exit(1);
  }
  return address;
}

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) {
    console.error('❌ PROTOCOL_PRIVATE_KEY not set');
    process.exit(1);
  }

  // The author module lives on Base, next to the publication contracts.
  const rpcUrl = process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
    : 'https://mainnet.base.org';

  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  const client = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

  const safe = process.env.AUTHOR_SAFE_ADDRESS as `0x${string}` | undefined;
  const module = process.env.OWNER_HISTORY_MODULE_ADDRESS as `0x${string}` | undefined;

  console.log(`Deploying from ${account.address}\n   Network: ${rpcUrl}\n`);

  console.log('1/3 Deploying OwnerHistoryModuleV1 (implementation)...');
  const implementation = await deployContract(client, 'OwnerHistoryModuleV1', [], rpcUrl);
  console.log(`   ✅ Implementation at ${implementation}\n`);

  console.log('2/3 Deploying OwnerHistoryModuleV1Factory...');
  const factory = await deployContract(client, 'OwnerHistoryModuleV1Factory', [implementation], rpcUrl);
  console.log(`   ✅ Factory at ${factory}\n`);

  if (!safe || !module) {
    console.log('3/3 Guard skipped: set AUTHOR_SAFE_ADDRESS and');
    console.log('    OWNER_HISTORY_MODULE_ADDRESS (the per-Safe proxy, from createModule)');
    console.log('    and re-run to deploy OwnerHistoryGuard.\n');
  } else {
    // The check that matters: a guard wired to a codeless address is written to
    // survive it, but it would record nothing forever, and `module` is immutable.
    const moduleCode = await rpc<string>(rpcUrl, 'eth_getCode', [module, 'latest']);
    if (moduleCode === '0x') {
      console.error(`❌ Refusing to deploy: module ${module} has no code on this chain.`);
      console.error('   Pass the module *proxy* address, not a planned one.');
      process.exit(1);
    }

    console.log('3/3 Deploying OwnerHistoryGuard...');
    const guard = await deployContract(client, 'OwnerHistoryGuard', [safe, module], rpcUrl);
    console.log(`   ✅ Guard at ${guard}  (safe ${safe}, module ${module})\n`);
    console.log('   Install it with a Safe transaction:');
    console.log(`     setGuard(${guard})   ← onlySelf, so it must go through the Safe\n`);
    console.log('   Then verify: every Safe transaction must leave SyncFailed unemitted.');
    console.log('   See the header of this file for the gas rule.\n');
    console.log(`  OWNER_HISTORY_GUARD_ADDRESS=${guard}`);
  }

  console.log('Set in .env:\n');
  console.log(`  OWNER_HISTORY_FACTORY_ADDRESS=${factory}`);
  console.log(`  OWNER_HISTORY_IMPLEMENTATION_ADDRESS=${implementation}`);
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
