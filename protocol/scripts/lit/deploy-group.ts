import {
  ACCOUNT_CONFIG_DIAMOND,
  adminHash,
  buildReProvisionBatch,
  generateUsageKey,
  prepareWallet,
  printBatch,
  verifyAccount,
} from '@s2s/soul2soul-shared';
import fs from 'fs';
import {
  actionDefsFromConfig,
  configPath,
  diamondAddress,
  isDryRun,
  loadConfig,
  pendingPath,
  printEnvInstructions,
  printRunbookReminder,
  requirePrivateKey,
  resolveRpcUrl,
  SAFE_ADDRESS,
  writeConfig,
} from './chain-secured-common.js';
import {
  proposeToSafe,
  resolveGroupIdFromSafeExecution,
  simulateAddGroup,
} from './chain-secured-safe.js';

// ── Constants ───────────────────────────────────────────────────────────────

const groupName = 's2s';
const groupDescription = '';
const rpcUrl = resolveRpcUrl();

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = isDryRun(args);
const finalize = args.includes('--finalize');

// ── Types ───────────────────────────────────────────────────────────────────

interface PendingReProvision {
  groupName: string;
  groupDescription: string;
  accountApiKeyHash: string;
  pkpAddress: string;
  derivationPath: string;
  usageKey: string;
  usageHash: string;
  simulatedGroupId: string;
  safeTxHash: string;
  proposedAt: string;
  actions: { name: string; cid: string; hashedCid: string }[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function verifyOrWarn(): Promise<void> {
  if (!rpcUrl) {
    console.warn(
      'WARN: no Base RPC configured (BASE_RPC_URL or VITE_DRPC_API_KEY) — skipping on-chain account verification.',
    );
    return;
  }
  const verification = await verifyAccount({
    rpcUrl,
    safeAddress: SAFE_ADDRESS,
    diamondAddress,
  });
  if (!verification.ok) {
    console.warn(`WARN: could not verify account on-chain (non-fatal): ${verification.message}`);
  } else if (!verification.chainSecured) {
    console.warn(`WARN: ${verification.message}`);
  } else {
    console.log(`✓ ${verification.message}`);
  }
}

async function finalizeStep(): Promise<void> {
  if (!fs.existsSync(pendingPath)) {
    throw new Error(
      `No pending re-provision found at ${pendingPath} — run deploy-group.ts (propose) first.`,
    );
  }
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8')) as PendingReProvision;
  if (!rpcUrl) {
    throw new Error(
      '--finalize requires a Base RPC (BASE_RPC_URL or VITE_DRPC_API_KEY) to read the receipt.',
    );
  }

  const resolved = await resolveGroupIdFromSafeExecution({
    safeTxHash: pending.safeTxHash,
    safeAddress: SAFE_ADDRESS,
    accountApiKeyHash: BigInt(pending.accountApiKeyHash),
    rpcUrl,
  });
  console.log(resolved.message);
  if (!resolved.executed || resolved.groupId === null) {
    console.log(
      '\nNothing written to config.json yet — the Safe has not executed the batch (or the',
    );
    console.log('GroupAdded event is missing). Confirm the proposal, then re-run --finalize.');
    return;
  }

  const groupId = Number(resolved.groupId);
  const config = loadConfig();
  const groupIndex = config.groups.findIndex((g) => g.name === groupName);
  if (groupIndex === -1) throw new Error(`Group "${groupName}" not found in ${configPath}`);

  config.groups[groupIndex] = {
    name: groupName,
    id: groupId,
    actions: pending.actions.map((a) => ({ name: a.name, cid: a.cid, hashedCid: a.hashedCid })),
    pkps: [pending.pkpAddress],
    usage_key: pending.usageKey,
  };
  writeConfig(config);
  console.log(`\n✓ Wrote ${configPath}`);
  console.log(`  group id : ${groupId}  (read from the addGroup receipt, NOT hardcoded)`);
  console.log(`  pkps[0]  : ${pending.pkpAddress}`);
  console.log(`  usage_key: <saved to config.json>`);

  // The pending file has served its purpose — the secret now lives in config.json.
  fs.rmSync(pendingPath, { force: true });

  printEnvInstructions(pending.usageKey, pending.pkpAddress);
  printRunbookReminder();
  console.log('FINISHED');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (finalize) {
    await finalizeStep();
    return;
  }

  const actions = actionDefsFromConfig(groupName);
  const accountApiKeyHash = adminHash(SAFE_ADDRESS);
  console.log(`ChainSecured re-provision for safe ${SAFE_ADDRESS}`);
  console.log(`AccountConfig diamond  : ${ACCOUNT_CONFIG_DIAMOND} (Base 8453)`);
  console.log(`accountApiKeyHash      : 0x${accountApiKeyHash.toString(16)}`);
  console.log(`reusing ${actions.length} pinned action CIDs from ${configPath}:`);
  for (const a of actions) console.log(`  - ${a.name}: ${a.cid} -> 0x${a.hashedCid.toString(16)}`);
  if (dryRun) console.log('\n=== DRY RUN (no mint, no proposal) ===');

  await verifyOrWarn();

  // 1) Mint PKP — prepare_wallet (no auth). Dry-run prints instead of calling.
  let pkpAddress: string;
  let derivationPath: string;
  if (dryRun) {
    pkpAddress = '0x1111111111111111111111111111111111111111';
    derivationPath = '0x1';
    console.log('\ndry-run: would mint PKP via POST /core/v1/prepare_wallet (no auth)');
    console.log(
      `dry-run: (placeholder pkp ${pkpAddress}, placeholder derivation path ${derivationPath} — real run mints a fresh wallet)`,
    );
  } else {
    console.log('\n→ minting PKP via /prepare_wallet (no auth)...');
    const wallet = await prepareWallet({});
    pkpAddress = wallet.walletAddress;
    derivationPath = wallet.derivationPath;
    console.log(`  wallet_address  : ${pkpAddress}`);
    console.log(`  derivation_path : ${derivationPath}`);
  }

  // 2) Generate usage key (pure on-chain; only the hash goes in the batch).
  const usageKey = generateUsageKey();
  console.log('\n→ minted usage key (cleartext shown once):');
  console.log(`  key        : ${usageKey.key}`);
  console.log(
    `  usageHash  : 0x${usageKey.usageHash.toString(16)}  (only this is written on-chain)`,
  );

  // 3) Resolve the group id the new group will get (NOT hardcoded).
  let groupId: bigint;
  if (dryRun) {
    groupId = 1n; // first group on a fresh chain-secured account starts at 1
    console.log(
      '\ndry-run: would simulate addGroup (staticCall) to resolve the new group id — assuming 1 (first group on a fresh account).',
    );
  } else {
    if (!rpcUrl)
      throw new Error(
        'A Base RPC (BASE_RPC_URL or VITE_DRPC_API_KEY) is required to simulate addGroup and resolve the group id.',
      );
    console.log('\n→ simulating addGroup to resolve the new group id...');
    groupId = await simulateAddGroup({
      rpcUrl,
      safeAddress: SAFE_ADDRESS,
      accountApiKeyHash,
      name: groupName,
      description: groupDescription,
      cidHashes: actions.map((a) => a.hashedCid),
      pkpIds: [pkpAddress as `0x${string}`],
    });
    console.log(`  new group id: ${groupId}`);
  }

  // 4) Build + print the Safe batch.
  const batch = buildReProvisionBatch({
    accountApiKeyHash,
    groupName,
    groupDescription,
    actionDefs: actions,
    pkpAddress: pkpAddress as `0x${string}`,
    derivationPath,
    usageKey,
    groupId,
  });
  printBatch(batch);

  if (dryRun) {
    console.log(
      '\ndry-run: would propose the above batch to the Safe (protocolKit + SafeApiKit on Base 8453).',
    );
    console.log('dry-run: STOPPING here — nothing was minted, nothing was proposed.');
    console.log('\nFINISHED (dry-run)');
    return;
  }

  // 5) Real mode: propose the batch to the Safe.
  console.log('\n→ proposing Safe batch...');
  const safeTxHash = await proposeToSafe({
    transactions: batch,
    safeAddress: SAFE_ADDRESS,
    signerPrivateKey: requirePrivateKey(),
    rpcUrl: rpcUrl ?? 'https://mainnet.base.org',
  });

  // 6) Stage the pending state so --finalize can read the real group id from the receipt.
  const pending: PendingReProvision = {
    groupName,
    groupDescription,
    accountApiKeyHash: accountApiKeyHash.toString(),
    pkpAddress,
    derivationPath,
    usageKey: usageKey.key,
    usageHash: usageKey.usageHash.toString(),
    simulatedGroupId: groupId.toString(),
    safeTxHash,
    proposedAt: new Date().toISOString(),
    actions: actions.map((a) => ({
      name: a.name,
      cid: a.cid,
      hashedCid: `0x${a.hashedCid.toString(16)}`,
    })),
  };
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
  console.log(
    `\n✓ Staged pending re-provision → ${pendingPath} (keeps the usage key cleartext safe until --finalize).`,
  );

  printEnvInstructions(usageKey.key, pkpAddress);
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
