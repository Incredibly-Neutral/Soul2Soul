/**
 * remove-group.ts — delete a group that was created by mistake.
 *
 * A version is created once; a second `actions:group` for the same version opens
 * a second group with the same name and the same hashes, because addGroup is not
 * idempotent. The duplicate is harmless to serve but wrong to keep, so this
 * removes it by id:
 *
 *   pnpm actions:remove-group <groupId>
 *
 * It removes the group only. The actions stay registered to the account and stay
 * bound to the groups that legitimately carry them, so a publication already
 * pinned to that version keeps running. Removing the actions themselves is what
 * this must never do: removeAction strips a hash from every group.
 */
import { createPublicClient, http, parseAbi, encodeFunctionData } from 'viem';
import {
  ACCOUNT_CONFIG_ADDRESS,
  PROTOCOL_SAFE_ADDRESS,
  adminHash,
  buildSafeBatch,
  loadMonorepoEnv,
  prettyPrintBatch,
  proposeToSafe,
  requireProtocolPrivateKey,
  resolveLitRpcUrl,
} from '@s2s/soul2soul-shared/chain-secured';
import { fileURLToPath } from 'url';

loadMonorepoEnv(fileURLToPath(import.meta.url));

const groupId = process.argv[2];
if (!groupId || !/^\d+$/.test(groupId)) {
  console.error('Usage: pnpm actions:remove-group <groupId> [--dry-run]');
  process.exit(1);
}

const removeGroupAbi = parseAbi(['function removeGroup(uint256 apiKeyHash, uint256 groupId)']);

const lit = parseAbi([
  'function listGroups(uint256,uint256,uint256) view returns ((uint256 id,string name,string description)[])',
]);

async function main(): Promise<void> {
  const admin = adminHash(PROTOCOL_SAFE_ADDRESS);
  const client = createPublicClient({ transport: http(resolveLitRpcUrl()) });
  const groups = await client.readContract({
    address: ACCOUNT_CONFIG_ADDRESS,
    abi: lit,
    functionName: 'listGroups',
    args: [BigInt(admin), 0n, 100n],
  });
  const target = groups.find((g) => g.id === BigInt(groupId));
  if (!target) throw new Error(`no group ${groupId} on ${ACCOUNT_CONFIG_ADDRESS}`);
  console.log(`group ${groupId}: ${target.name}`);

  const transactions = buildSafeBatch([
    {
      to: ACCOUNT_CONFIG_ADDRESS,
      data: encodeFunctionData({
        abi: removeGroupAbi,
        functionName: 'removeGroup',
        args: [BigInt(admin), BigInt(groupId)],
      }),
    },
  ]);
  console.log(prettyPrintBatch(transactions));

  if (process.argv.includes('--dry-run')) {
    console.log('\ndry-run: STOPPING before proposing to the Safe.');
    return;
  }

  const { safeTxHash } = await proposeToSafe({
    transactions,
    safeAddress: PROTOCOL_SAFE_ADDRESS,
    signerPrivateKey: requireProtocolPrivateKey(),
    rpcUrl: resolveLitRpcUrl(),
  });
  console.log(`\nApproved ${safeTxHash} in the Safe UI to remove group ${groupId}.`);
}

main().catch((error: any) => {
  console.error(error);
  process.exitCode = 1;
});
