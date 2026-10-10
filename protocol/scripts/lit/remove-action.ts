import { adminHash, buildRemoveActionBatch, printBatch } from '@s2s/soul2soul-shared';
import {
  configPath,
  diamondAddress,
  findGroup,
  isDryRun,
  loadConfig,
  printRunbookReminder,
  requirePrivateKey,
  resolveRpcUrl,
  SAFE_ADDRESS,
  writeConfig,
} from './chain-secured-common.js';
import { proposeToSafe } from './chain-secured-safe.js';

// ── Constants ───────────────────────────────────────────────────────────────

const groupName = 's2s';
const rpcUrl = resolveRpcUrl();

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = isDryRun(args);

const action_name = args[0];
if (!action_name) {
  console.error('Usage: pnpm remove-action <action_name> [--dry-run]');
  console.error('Valid actions: prep, render, update, maintain-cache, encrypt');
  process.exit(1);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const group = findGroup(config, groupName);
  const accountApiKeyHash = adminHash(SAFE_ADDRESS);

  const existing = group.actions.find((a) => a.name === action_name);
  if (!existing) {
    throw new Error(`No action "${action_name}" in config.json — nothing to remove.`);
  }
  const hashedCid = BigInt(existing.hashedCid);

  console.log(`ChainSecured remove-action for "${action_name}" (group ${group.id})`);
  console.log(
    `safe ${SAFE_ADDRESS} · diamond ${diamondAddress} · accountApiKeyHash 0x${accountApiKeyHash.toString(16)}`,
  );
  console.log(`  removing hashedCid 0x${hashedCid.toString(16)} (cid ${existing.cid})`);
  if (dryRun) console.log('\n=== DRY RUN (no proposal) ===');

  // 1) Build + print the Safe batch (removeActionFromGroup + removeAction).
  const batch = buildRemoveActionBatch({
    accountApiKeyHash,
    groupId: BigInt(group.id),
    hashedCid,
  });
  printBatch(batch);

  if (dryRun) {
    console.log('\ndry-run: would propose the above batch to the Safe.');
    console.log('dry-run: STOPPING here — nothing was proposed.');
    console.log('\nFINISHED (dry-run)');
    return;
  }

  // 2) Propose the batch to the Safe.
  console.log('\n→ proposing Safe batch...');
  const safeTxHash = await proposeToSafe({
    transactions: batch,
    safeAddress: SAFE_ADDRESS,
    signerPrivateKey: requirePrivateKey(),
    rpcUrl: rpcUrl ?? 'https://mainnet.base.org',
  });
  console.log('Safe Tx Hash:', safeTxHash);

  // 3) Remove the action from config.json (optimistic — the batch is deterministic).
  group.actions = group.actions.filter((a) => a.name !== action_name);
  writeConfig(config);
  console.log(`\n✓ Removed "${action_name}" from ${configPath}`);
  console.log(
    `  NOTE: config.json reflects the PROPOSED (not yet executed) state — confirm the Safe`,
  );
  console.log(`  transaction, then the on-chain records are updated by update-protocol.ts.`);

  printRunbookReminder();
  console.log('FINISHED');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
