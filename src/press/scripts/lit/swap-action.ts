/**
 * swap-action.ts — CHAIN-SECURED action swap for the s2s Lit account.
 *
 * Replaces the API-mode swap-action.ts. Under the chain-secured account every
 * admin write is a Safe-signed transaction to the AccountConfig diamond
 * 0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa (msg.sender == the Safe
 * 0x24936f87442673B7c057BF3f5dCCB726baF20c6B). There is no account API key.
 *
 * Flow:
 *   1. build src/press/actions/dist/<action>/main.js, compact, compute CID,
 *      upload to Pinata (unchanged — no auth)
 *   2. build + propose ONE Safe batch against the EXISTING group id from
 *      config.json:
 *        addAction(newHash)                     (idempotent metadata register)
 *        addActionToGroup(groupId, newHash)     (idempotent bind)
 *        removeAction(oldHash)                  ALWAYS when the old hash differs
 *          — removes the prev action from the account registry AND every group
 *            (idempotent, never reverts), so a superseded action can never
 *            linger registered to the account.
 *        removeActionFromGroup(groupId, oldHash)  only when the on-chain
 *          membership check confirms it is still in the group (it REVERTS if
 *          absent), placed BEFORE removeAction (which empties the group set).
 *   3. update the action entry in config.json
 *   4. remind: pnpm update-protocol afterwards (on-chain records CIDs)
 *
 * Dry-run: LIT_DRY_RUN=1 or --dry-run builds the full batch, pretty-prints each
 * { to, value, data } with the decoded function + args, and stops before
 * proposing.
 *
 * Usage (repo root, npm wiring unchanged):
 *   pnpm actions:swap <prep|render|update|maintain-cache|encrypt>
 */
import { LitService, compactAction, S2SIPFSMethods } from '@s2s/soul2soul-shared';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  ACCOUNT_CONFIG_ADDRESS,
  PROTOCOL_SAFE_ADDRESS,
  actionHash,
  adminHash,
  buildSafeBatch,
  encodeAddAction,
  encodeAddActionToGroup,
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
  saveLitConfig,
} from '@s2s/soul2soul-shared/chain-secured';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadMonorepoEnv(__filename);

const configPath = path.join(__dirname, 'config.json');
const groupName = 's2s';
const validActions = ['prep', 'render', 'update', 'maintain-cache', 'repoint-archive', 'encrypt'];

const actionName = process.argv[2];
if (!actionName || !validActions.includes(actionName)) {
  console.error(`Usage: pnpm actions:swap <action_name>`);
  console.error(`Valid actions: ${validActions.join(', ')}`);
  process.exit(1);
}

const isDryRun = () => process.env.LIT_DRY_RUN === '1' || process.argv.includes('--dry-run');

// Anchored to this file, not the CWD: the tree sits under src/ and run order
// must not decide where the build output is found.
const actionPath = path.resolve(__dirname, '../../actions/dist', actionName, 'main.js');
const code = fs.readFileSync(actionPath, 'utf-8');

const ipfs = new S2SIPFSMethods(
  process.env.IPFS_URL!,
  process.env.PINATA_JWT!,
  process.env.PINATA_GATEWAY!,
  process.env.VITE_FILEBASE_TOKEN || '',
);

async function main(): Promise<void> {
  const dryRun = isDryRun();
  const lit = new LitService({ environment: 'prod' }); // only no-auth helpers used

  const config = loadLitConfig(configPath);
  const groupIndex = config.groups.findIndex((g) => g.name === groupName);
  if (groupIndex === -1) {
    throw new Error(`Group "${groupName}" not found in ${configPath}`);
  }
  const group = config.groups[groupIndex];
  if (typeof group.id !== 'number' || group.id <= 0) {
    throw new Error(`Group "${groupName}" has no valid on-chain id in ${configPath}`);
  }

  // 1. Compact + compute CID (same as the API-mode script).
  const _action = compactAction(code);
  const cid = await lit.getActionCid(_action);

  // Dry-run gate BEFORE the live Pinata upload: LIT_DRY_RUN=1 must not pin.
  let pinnedCid: string | null = null;
  if (dryRun) {
    console.log(
      `dry-run: would upload "${actionName}" (${_action.length} chars compact) to Pinata`,
    );
  } else {
    pinnedCid = await ipfs.uploadToPinata(_action, actionName);
  }
  if (pinnedCid !== null && cid !== pinnedCid)
    console.warn(`CID mismatch for ${actionName}: ${cid} vs pinned ${pinnedCid}`);

  const newHashedCid = actionHash(cid);
  const adminHashVal = adminHash(PROTOCOL_SAFE_ADDRESS);

  const oldAction = group.actions.find((a) => a.name === actionName);

  // 2. Build the batch.
  const writes = [
    encodeAddAction({
      apiKeyHash: adminHashVal,
      name: actionName,
      description: actionName,
      actionHash: newHashedCid,
    }),
    encodeAddActionToGroup({
      apiKeyHash: adminHashVal,
      groupId: group.id,
      action: newHashedCid,
    }),
  ];

  if (oldAction && oldAction.hashedCid && oldAction.hashedCid !== newHashedCid) {
    // Correctly remove the PREVIOUS action "both ways" (account + groups):
    //   - removeAction(old) strips it from the account registry AND every group
    //     that references it (idempotent — only reverts for hash 0x0), so it is
    //     included UNCONDITIONALLY: a superseded action can never linger
    //     registered to the account.
    //   - removeActionFromGroup(old) is redundant with removeAction and REVERTS
    //     if the hash is not in the group, so it is only included when the
    //     on-chain membership check confirms presence, purely so the
    //     ActionRemovedFromGroup event fires for observability. It MUST be
    //     placed before removeAction, because removeAction already empties the
    //     group set.
    const oldHashedCid = oldAction.hashedCid as `0x${string}`;
    const inGroup = await isActionInGroup({
      adminHash: adminHashVal,
      groupId: group.id,
      actionHash: oldHashedCid,
    });
    if (inGroup === true) {
      writes.push(
        encodeRemoveActionFromGroup({
          apiKeyHash: adminHashVal,
          groupId: group.id,
          action: oldHashedCid,
        }),
      );
    } else {
      console.warn(
        `Old hash ${oldHashedCid} for "${actionName}" is not in group ${group.id}` +
          (inGroup === null ? ' (membership read unavailable)' : '') +
          ' — skipping removeActionFromGroup only; removeAction still strips it from all groups.',
      );
    }
    writes.push(
      encodeRemoveAction({
        apiKeyHash: adminHashVal,
        actionHash: oldHashedCid,
      }),
    );
  } else if (oldAction && oldAction.hashedCid === newHashedCid) {
    console.log(`New CID for "${actionName}" is unchanged — only re-adding (idempotent).`);
  }

  const transactions = buildSafeBatch(writes, ACCOUNT_CONFIG_ADDRESS);

  console.log(`\n=== Safe batch (${transactions.length} calls) for "${actionName}" ===`);
  console.log(`new cid:      ${cid}`);
  console.log(`new hashedCid: ${newHashedCid}`);
  console.log(`group id:     ${group.id} (from ${configPath})`);
  console.log(prettyPrintBatch(transactions));

  if (dryRun) {
    console.log('\ndry-run: STOPPING before proposing to Safe.');
    return;
  }

  // 3. Propose to the Safe.
  await proposeToSafe({
    transactions,
    safeAddress: PROTOCOL_SAFE_ADDRESS,
    signerPrivateKey: requireProtocolPrivateKey(),
    rpcUrl: resolveLitRpcUrl(),
  });

  // 4. Update config.json (upsert the action entry).
  const actionIndex = group.actions.findIndex((a) => a.name === actionName);
  if (actionIndex !== -1) {
    config.groups[groupIndex].actions[actionIndex] = {
      ...group.actions[actionIndex],
      cid,
      hashedCid: newHashedCid,
    };
  } else {
    config.groups[groupIndex].actions.push({ name: actionName, cid, hashedCid: newHashedCid });
  }
  saveLitConfig(configPath, config);
  console.log(`📝 Updated ${configPath}`);

  console.log('\n=== NEXT STEPS ===');
  console.log('1. Approve the Safe transaction in the Safe UI (owners must confirm).');
  console.log('2. Then point the on-chain records at the new CID:');
  console.log('     pnpm update-protocol');
  console.log(
    '   (reads the new CID from config.json and proposes the records batch through the Safe)',
  );
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
