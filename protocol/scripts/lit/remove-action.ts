/**
 * remove-action.ts — CHAIN-SECURED removal of stale actions from a group.
 *
 * Builds + proposes ONE Safe batch of removeActionFromGroup calls against the
 * AccountConfig diamond 0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa
 * (msg.sender == the Safe 0x24936f87442673B7c057BF3f5dCCB726baF20c6B).
 *
 * Unlike add-action.ts this does NOT build/upload code. Two modes:
 *   - default: removeActionFromGroup — unbind an already-registered action
 *     hash from a group (REVERTS if absent, so hashes are pre-flighted with
 *     the on-chain isActionInGroup view);
 *   - --full:  removeAction — deregister the action from the ACCOUNT entirely
 *     (idempotent; also strips it from every group).
 *
 * Defaults (no args) to the two stale hashes left over in group 1 from
 * earlier registrations that were superseded but never removed:
 *   - old prep  0xff4c3b1127ba642fccef8f2f8921aa15120969b69b1ae7b5a8e7a6d4b75ea657
 *   - old render 0x63390deadb976c0d3d905c0efebad0d56148540b28c524d4b892528ee826a21c (QmUmW4a9)
 *
 * Modes:
 *   default     removeActionFromGroup — unbind from the group only (the action
 *               stays registered to the account).
 *   --full      removeAction — deregister from the ACCOUNT entirely (also
 *               strips the hash from every group that references it; reverts
 *               only on hash 0x0, so it is safe/idempotent).
 *
 * Usage (pass hex hashes to remove arbitrary ones):
 *   pnpm actions:remove
 *   pnpm actions:remove --full
 *   pnpm actions:remove 0x<hashA> 0x<hashB>
 *   pnpm actions:remove --full 0x<hashA>
 *   LIT_DRY_RUN=1 pnpm actions:remove --full
 *
 * NOTE: config.json is NOT touched — the stale hashes are on-chain-only
 * leftovers (config already reflects the current prep/render), so there is
 * nothing to upsert.
 */
import {
  ACCOUNT_CONFIG_ADDRESS,
  PROTOCOL_SAFE_ADDRESS,
  adminHash,
  buildSafeBatch,
  encodeRemoveAction,
  encodeRemoveActionFromGroup,
  findS2SGroup,
  isActionInGroup,
  loadLitConfig,
  loadMonorepoEnv,
  prettyPrintBatch,
  proposeToSafe,
  requireProtocolPrivateKey,
  resolveLitRpcUrl,
} from '@s2s/soul2soul-shared/chain-secured';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadMonorepoEnv(__filename);

const configPath = path.join(__dirname, 'config.json');
const groupName = 's2s';

const isDryRun = () => process.env.LIT_DRY_RUN === '1' || process.argv.includes('--dry-run');
const isFull = () => process.argv.includes('--full');

// Known stale hashes → human-readable labels for the report.
const KNOWN: Record<string, string> = {
  '0xff4c3b1127ba642fccef8f2f8921aa15120969b69b1ae7b5a8e7a6d4b75ea657': 'old prep (superseded)',
  '0x63390deadb976c0d3d905c0efebad0d56148540b28c524d4b892528ee826a21c': 'old render QmUmW4a9 (superseded)',
  '0xb08495c95c105b63df35ebbfee427d72540080ab1b9b91255507f460f4ebcd2e': 'repoint-archive QmZr42 (group-registered)',
  '0x596c1602b615d722d2fdd78e64ecaaded1f8c3fa199872480745428f7ee53ea2': 'repoint-archive QmWNxw6 (config/records)',
};

const DEFAULT_REMOVALS = [
  { hash: '0xff4c3b1127ba642fccef8f2f8921aa15120969b69b1ae7b5a8e7a6d4b75ea657' as const },
  { hash: '0x63390deadb976c0d3d905c0efebad0d56148540b28c524d4b892528ee826a21c' as const },
];

async function main(): Promise<void> {
  const dryRun = isDryRun();

  const config = loadLitConfig(configPath);
  const group = findS2SGroup(config, groupName);
  if (typeof group.id !== 'number' || group.id <= 0) {
    throw new Error(`Group "${groupName}" has no valid on-chain id in ${configPath}`);
  }

  const argHashes = process.argv
    .slice(2)
    .filter((a) => a.startsWith('0x') && !a.startsWith('--'));
  const removals =
    argHashes.length > 0 ? argHashes.map((hash) => ({ hash })) : DEFAULT_REMOVALS;
  const full = isFull();

  const adminHashVal = adminHash(PROTOCOL_SAFE_ADDRESS);

  // Pre-flight every hash. For group-unbind, removeActionFromGroup reverts if
  // the action is absent from the group, so we confirm it is present. For a
  // full account deregistration, removeAction is idempotent (only reverts on
  // hash 0x0) — the check below is informational.
  const writes = [];
  for (const { hash } of removals) {
    const inGroup = await isActionInGroup({
      adminHash: adminHashVal,
      groupId: group.id,
      actionHash: hash,
      rpcUrl: resolveLitRpcUrl(),
    });
    if (full) {
      console.log(
        `pre-flight ${hash.slice(0, 18)}… ${KNOWN[hash] ?? ''} → registered-to-account (group: ${inGroup === true ? 'yes' : inGroup === false ? 'no' : 'read-unavailable'}); removeAction is idempotent`,
      );
      writes.push(
        encodeRemoveAction({ apiKeyHash: adminHashVal, actionHash: hash }),
      );
      continue;
    }
    console.log(
      `pre-flight ${hash.slice(0, 18)}… ${KNOWN[hash] ?? ''} → ${
        inGroup === true ? 'IN GROUP (removable)' : inGroup === false ? 'NOT in group — SKIPPED' : 'read unavailable — INCLUDED'
      }`,
    );
    if (inGroup === false) continue;
    writes.push(
      encodeRemoveActionFromGroup({ apiKeyHash: adminHashVal, groupId: group.id, action: hash }),
    );
  }

  if (writes.length === 0) {
    console.log('Nothing to remove — all requested hashes are already absent from the group.');
    return;
  }

  const transactions = buildSafeBatch(writes, ACCOUNT_CONFIG_ADDRESS);

  console.log(`\n=== Safe batch (${transactions.length} calls) ${full ? 'removeAction (account-level)' : 'removeActionFromGroup'} ===`);
  console.log(`group id: ${group.id} (from ${configPath})`);
  console.log(prettyPrintBatch(transactions));

  if (dryRun) {
    console.log('\ndry-run: STOPPING before proposing to Safe.');
    return;
  }

  await proposeToSafe({
    transactions,
    safeAddress: PROTOCOL_SAFE_ADDRESS,
    signerPrivateKey: requireProtocolPrivateKey(),
    rpcUrl: resolveLitRpcUrl(),
  });

  console.log('\n=== NEXT STEPS ===');
  console.log('1. Approve the Safe transaction in the Safe UI (owners must confirm).');
  console.log('2. No config.json / records change needed (stale hashes were on-chain-only).');
  console.log('FINISHED');
}

main()
  .catch((error: any) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
