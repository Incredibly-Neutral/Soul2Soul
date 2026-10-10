import {
  actionHash,
  adminHash,
  buildAddActionBatch,
  printBatch,
  S2SIPFSMethods,
} from '@s2s/soul2soul-shared';
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
import {
  assertValidAction,
  buildAction,
  compact,
  computeActionCid,
} from './chain-secured-action.js';
import { proposeToSafe } from './chain-secured-safe.js';

// ── Constants ───────────────────────────────────────────────────────────────

const groupName = 's2s';
const rpcUrl = resolveRpcUrl();

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = isDryRun(args);

const action_name = args[0];
if (!action_name) {
  console.error('Usage: pnpm add-action <action_name> [--dry-run]');
  console.error('Valid actions: prep, render, update, maintain-cache, encrypt');
  process.exit(1);
}
assertValidAction(action_name);

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const group = findGroup(config, groupName);
  const accountApiKeyHash = adminHash(SAFE_ADDRESS);

  const existing = group.actions.find((a) => a.name === action_name);
  if (existing) {
    console.warn(
      `WARN: action "${action_name}" already exists in config.json (cid ${existing.cid}).`,
    );
    console.warn('Use swap-action instead to replace it.');
  }

  console.log(`ChainSecured add-action for "${action_name}" (group ${group.id})`);
  console.log(
    `safe ${SAFE_ADDRESS} · diamond ${diamondAddress} · accountApiKeyHash 0x${accountApiKeyHash.toString(16)}`,
  );
  if (dryRun) console.log('\n=== DRY RUN (no pin, no proposal) ===');

  // 1) Build + compact the action, compute its CID locally (== server IpfsHasher).
  console.log(`\n→ building action "${action_name}" (esbuild)...`);
  const code = await buildAction(action_name);
  const _action = compact(code);
  const cid = await computeActionCid(_action);
  const hashedCid = actionHash(cid);
  console.log(`  cid        : ${cid}`);
  console.log(`  hashedCid  : 0x${hashedCid.toString(16)}`);

  // 2) Real mode: pin the new code so it is fetchable by its CID.
  if (!dryRun) {
    console.log('\n→ pinning to Pinata...');
    const ipfs = new S2SIPFSMethods(
      process.env.IPFS_URL!,
      process.env.PINATA_JWT!,
      process.env.PINATA_GATEWAY!,
      process.env.VITE_FILEBASE_TOKEN || '',
    );
    const pinnedCid = await ipfs.uploadToPinata(_action, action_name);
    if (pinnedCid !== cid) {
      console.warn(`WARN: pinned CID (${pinnedCid}) != locally computed CID (${cid})`);
    } else {
      console.log(`  pinned : ${pinnedCid}`);
    }
  } else {
    console.log('\ndry-run: would pin the compacted code to Pinata.');
  }

  // 3) Build + print the Safe batch.
  const batch = buildAddActionBatch({
    accountApiKeyHash,
    groupId: BigInt(group.id),
    action: { name: action_name, cid, hashedCid, description: action_name },
  });
  printBatch(batch);

  if (dryRun) {
    console.log('\ndry-run: would propose the above batch to the Safe.');
    console.log('dry-run: STOPPING here — nothing was pinned, nothing was proposed.');
    console.log('\nFINISHED (dry-run)');
    return;
  }

  // 4) Propose the batch to the Safe.
  console.log('\n→ proposing Safe batch...');
  const safeTxHash = await proposeToSafe({
    transactions: batch,
    safeAddress: SAFE_ADDRESS,
    signerPrivateKey: requirePrivateKey(),
    rpcUrl: rpcUrl ?? 'https://mainnet.base.org',
  });
  console.log('Safe Tx Hash:', safeTxHash);

  // 5) Update config.json actions map (append; dedupe on name).
  const actionIndex = group.actions.findIndex((a) => a.name === action_name);
  const entry = { name: action_name, cid, hashedCid: `0x${hashedCid.toString(16)}` };
  if (actionIndex !== -1) {
    group.actions[actionIndex] = entry;
  } else {
    group.actions.push(entry);
  }
  writeConfig(config);
  console.log(`\n✓ Updated ${configPath} with "${action_name}"`);
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
