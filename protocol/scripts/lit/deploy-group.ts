/**
 * deploy-group.ts — CHAIN-SECURED (sovereign) re-provision of the s2s Lit account.
 *
 * Replaces the API-mode deploy-group.ts. Under the new chain-secured account the
 * on-chain admin is the Gnosis Safe 0x24936f87442673B7c057BF3f5dCCB726baF20c6B
 * (= PROTOCOL_SAFE_ADDRESS) on Base (8453). There is NO account API key: every
 * admin write is a Safe-signed transaction to the AccountConfig diamond
 * 0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa (msg.sender == Safe).
 *
 * Flow (real run):
 *   1. verify the account is chain-secured (diamond views; warn non-fatally)
 *   2. predict the next group id (listGroups max + 1; 1 on a fresh account)
 *   3. POST /core/v1/prepare_wallet -> { wallet_address, derivation_path }  (no auth)
 *   4. mint a usage key locally ('lk_' + 32 CSPRNG bytes); only its keccak256 goes on-chain
 *   5. build + propose ONE Safe batch:
 *        registerWalletDerivation(new PKP)  (FIRST — addGroup binds the new PKP in pkpIds,
 *                                            so its derivation must be registered first)
 *        addGroup                (binds the 5 action hashes + new PKP to the group)
 *        addAction x5
 *        addActionToGroup x5
 *        addPkpToGroup
 *        setUsageApiKey          (scoped to the new group)
 *   6. the operator approves the Safe tx, then runs:
 *        pnpm deploy-group --finalize <safeTxHash>
 *      which reads the ACTUAL group id from the addGroup receipt (GroupAdded
 *      log, never hardcoded), writes protocol/scripts/lit/config.json, and
 *      prints .env / update-protocol instructions.
 *
 * Dry-run: LIT_DRY_RUN=1 or --dry-run builds the full batch, pretty-prints each
 * { to, value, data } with the decoded function + args, prints 'dry-run: would
 * mint', and stops BEFORE proposing and BEFORE calling /prepare_wallet.
 *
 * Usage (repo root, npm wiring unchanged):
 *   pnpm deploy-group                      # propose the provision batch
 *   pnpm deploy-group -- --finalize <hash> # finalize after Safe execution
 *   LIT_DRY_RUN=1 pnpm deploy-group        # dry-run
 */
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
  encodeAddGroup,
  encodeAddPkpToGroup,
  encodeRegisterWalletDerivation,
  encodeSetUsageApiKey,
  findS2SGroup,
  generateUsageKey,
  loadLitConfig,
  loadMonorepoEnv,
  prepareWallet,
  predictNextGroupId,
  prettyPrintBatch,
  proposeToSafe,
  readExecutedGroupId,
  requireProtocolPrivateKey,
  resolveLitRpcUrl,
  saveLitConfig,
  usageHash,
  verifyAccountChainSecured,
} from '@s2s/soul2soul-shared/chain-secured';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from the monorepo root (robust to any cwd).
loadMonorepoEnv(__filename);

const configPath = path.join(__dirname, 'config.json');
const pendingPath = path.join(__dirname, 'config.chain-secured-pending.json');

const groupName = 's2s';
const GROUP_DESCRIPTION = 's2s protocol group (chain-secured re-provision 2026-10-05)';

// The 5 actions re-registered under the new group. CIDs are REUSED from the
// pinned values already in config.json (no re-upload). hashedCid is recomputed
// as keccak256(toBytes(cid)) — the exact hash that must go on-chain.
const ACTION_DEFS = ['encrypt', 'prep', 'render', 'update', 'maintain-cache'];

const isDryRun = () => process.env.LIT_DRY_RUN === '1' || process.argv.includes('--dry-run');

const finalizeArg = (): string | null => {
  const idx = process.argv.indexOf('--finalize');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.LIT_FINALIZE_TX || null;
};

// Placeholder values used ONLY in dry-run so the batch structure/args are
// human-visible without minting anything real.
const DRY_RUN_PKP = '0x0000000000000000000000000000000000000000' as const;
const DRY_RUN_DERIVATION_PATH =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const DRY_RUN_USAGE_KEY = `lk_${'00'.repeat(32)}`;

interface PendingProvision {
  safeTxHash: string;
  proposedAt: string;
  groupName: string;
  adminHash: string;
  predictedGroupId: number;
  pkp: { address: string; derivationPath: string };
  usage: { key: string; hash: string };
  actions: Array<{ name: string; cid: string; hashedCid: string }>;
}

function loadPending(): PendingProvision {
  if (!fs.existsSync(pendingPath)) {
    throw new Error(
      `No pending provision found at ${pendingPath}. Run \`pnpm deploy-group\` first to propose the batch.`,
    );
  }
  return JSON.parse(fs.readFileSync(pendingPath, 'utf-8')) as PendingProvision;
}

/** Build the full chain-secured provision batch. */
function buildProvisionBatch(opts: {
  adminHash: string;
  pkpAddress: string;
  derivationPath: string;
  usageHash: string;
  groupId: bigint | number;
  actions: Array<{ name: string; cid: string; hashedCid: string }>;
}) {
  const { adminHash: ah, pkpAddress, derivationPath, usageHash: uh, groupId, actions } = opts;

  const writes = [
    // Register the freshly minted PKP FIRST (derivation_path passed VERBATIM).
    // Must precede addGroup: addGroup binds the new PKP in pkpIds, and the
    // facet validates the derivation is registered before binding it — an
    // atomic Safe-batch revert would occur if this came after addGroup.
    encodeRegisterWalletDerivation({
      apiKeyHash: ah,
      pkpId: pkpAddress as `0x${string}`,
      derivationPath: derivationPath as `0x${string}`,
      name: `${groupName} pkp`,
      description: 's2s protocol PKP (chain-secured re-provision)',
    }),
    // Create the group, binding the 5 action hashes + the new PKP to it.
    encodeAddGroup({
      apiKeyHash: ah,
      name: groupName,
      description: GROUP_DESCRIPTION,
      cidHashes: actions.map((a) => a.hashedCid as `0x${string}`),
      pkpIds: [pkpAddress as `0x${string}`],
    }),
    // Re-register action metadata + bind each action to the group.
    ...actions.flatMap((a) => [
      encodeAddAction({
        apiKeyHash: ah,
        name: a.name,
        description: a.name,
        actionHash: a.hashedCid as `0x${string}`,
      }),
      encodeAddActionToGroup({
        apiKeyHash: ah,
        groupId,
        action: a.hashedCid as `0x${string}`,
      }),
    ]),
    encodeAddPkpToGroup({
      apiKeyHash: ah,
      groupId,
      pkpId: pkpAddress as `0x${string}`,
    }),
    // Mint the usage key scoped to the new group (only its hash is on-chain).
    encodeSetUsageApiKey({
      apiKeyHash: ah,
      usageApiKeyHash: uh,
      expiration: 0,
      balance: 0,
      name: 's2s usage key',
      description: `Executes the s2s Lit actions in group ${String(groupId)} (chain-secured)`,
      createGroups: false,
      deleteGroups: false,
      createPKPs: false,
      manageIPFSIdsInGroups: [groupId],
      addPkpToGroups: [],
      removePkpFromGroups: [],
      executeInGroups: [groupId],
    }),
  ];

  return buildSafeBatch(writes, ACCOUNT_CONFIG_ADDRESS);
}

/** Finalize: read the ACTUAL group id from the addGroup receipt + persist config.json. */
async function finalize(safeTxHash: string): Promise<void> {
  const pending = loadPending();
  if (pending.safeTxHash !== safeTxHash) {
    console.warn(
      `Note: provided safeTxHash ${safeTxHash} differs from pending ${pending.safeTxHash} — finalizing with the provided hash.`,
    );
  }

  const rpcUrl = resolveLitRpcUrl();
  console.log(`Reading Safe tx ${safeTxHash}...`);
  const { isExecuted, executionTxHash, groupId } = await readExecutedGroupId({
    safeTxHash,
    adminHash: pending.adminHash as `0x${string}`,
    safeAddress: PROTOCOL_SAFE_ADDRESS,
    rpcUrl,
  });

  if (!isExecuted || groupId === null) {
    console.error('❌ Safe transaction is not executed yet (or no GroupAdded log found).');
    console.error(`   executionTxHash: ${executionTxHash ?? '(none)'}`);
    console.error('   Approve the Safe tx in the Safe UI, then re-run finalize.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ Safe tx executed (${executionTxHash}). GroupAdded id = ${groupId.toString()} (predicted ${pending.predictedGroupId})`,
  );
  if (pending.predictedGroupId !== Number(groupId)) {
    console.warn(
      '⚠️ Predicted group id differed from the receipt — the batch that executed was bound to the predicted id; verify the group contents on-chain.',
    );
  }

  // Write config.json: replace the s2s group entry with the new values.
  const config = loadLitConfig(configPath);
  const groupIndex = config.groups.findIndex((g) => g.name === groupName);
  const newGroup = {
    name: groupName,
    id: Number(groupId),
    actions: pending.actions,
    pkps: [pending.pkp.address],
    usage_key: pending.usage.key,
  };
  if (groupIndex === -1) config.groups.push(newGroup);
  else config.groups[groupIndex] = newGroup;
  saveLitConfig(configPath, config);
  console.log(`📝 Wrote ${configPath} (group id ${String(groupId)}, pkp ${pending.pkp.address})`);

  // Remove the pending sidecar now that config.json is persisted.
  fs.rmSync(pendingPath, { force: true });
  console.log(`🧹 Removed ${pendingPath}`);

  printEnvInstructions(pending, Number(groupId));
}

function printEnvInstructions(pending: PendingProvision, actualGroupId?: number): void {
  console.log('');
  console.log('=== NEXT STEPS ===');
  console.log('Add to root .env:');
  console.log(`  VITE_LIT_USAGE_KEY=${pending.usage.key}`);
  console.log(
    '  LIT_ACCOUNT_KEY is OBSOLETE for the chain-secured account (scripts no longer read it).',
  );
  console.log(`  PROTOCOL_SAFE_ADDRESS=${PROTOCOL_SAFE_ADDRESS}  (unchanged)`);
  console.log('');
  console.log('Then run:');
  console.log('  pnpm update-protocol');
  console.log('    (writes the new pkp_ethAddress + action CIDs to on-chain records via the Safe,');
  console.log('     and re-authorizes the new PKP on the ENS records contract — INV-12)');
  console.log('');
  console.log('Reminders:');
  console.log(`  - New PKP address: ${pending.pkp.address} (save it)`);
  console.log(
    `  - New group id:    ${String(actualGroupId ?? pending.predictedGroupId)} (from the finalize receipt)`,
  );
  console.log('  - If the Safe batch is rejected/reverts, re-run `pnpm deploy-group` — it mints a');
  console.log('    fresh PKP + usage key (the unregistered keypair is compute cost only).');
  console.log(
    '  - 0xobsidian / neutralpress per-user `litUsageKey` settings should also rotate to the new key.',
  );
}

async function main(): Promise<void> {
  const finalizeTx = finalizeArg();
  if (finalizeTx) {
    return finalize(finalizeTx);
  }

  const dryRun = isDryRun();
  const adminHashVal = adminHash(PROTOCOL_SAFE_ADDRESS);

  // 1. Verify the account is chain-secured (warn non-fatally).
  const verification = await verifyAccountChainSecured({
    adminHash: adminHashVal,
    safeAddress: PROTOCOL_SAFE_ADDRESS,
  });
  console.log('Account chain-secured verification:', verification);
  if (!verification.ok) {
    console.warn(
      '⚠️  Could not confirm the account is chain-secured and owned by the Safe. ' +
        'Proceeding anyway — review the warnings above; a chain-secured account has NO account API key.',
    );
  }

  // 2. Predict the next group id (best-effort).
  let predictedGroupId = 1n;
  const predicted = await predictNextGroupId({ adminHash: adminHashVal });
  if (predicted !== null) {
    predictedGroupId = predicted;
  } else {
    console.warn(
      '⚠️  Could not read existing groups from the diamond — assuming a fresh account (group id 1).',
    );
  }
  console.log(`Predicted new group id: ${predictedGroupId.toString()}`);

  // 3–4. Mint PKP + usage key.
  let pkpAddress: string;
  let derivationPath: string;
  let usage: { usageKey: string; usageHash: string };
  if (dryRun) {
    console.log('dry-run: would mint PKP via POST /core/v1/prepare_wallet (no auth)');
    pkpAddress = DRY_RUN_PKP;
    derivationPath = DRY_RUN_DERIVATION_PATH;
    console.log(`dry-run: would mint usage key ('lk_' + 32 random bytes)`);
    usage = { usageKey: DRY_RUN_USAGE_KEY, usageHash: usageHash(DRY_RUN_USAGE_KEY) };
  } else {
    const wallet = await prepareWallet();
    pkpAddress = wallet.walletAddress;
    derivationPath = wallet.derivationPath;
    usage = generateUsageKey();
  }

  // 5. Reuse the pinned action CIDs from config.json (no re-upload).
  const config = loadLitConfig(configPath);
  const existingGroup = findS2SGroup(config, groupName);
  const pinned = existingGroup?.actions ?? [];
  const actions = ACTION_DEFS.map((name) => {
    const pinnedAction = pinned.find((a) => a.name === name);
    if (!pinnedAction) {
      throw new Error(
        `config.json has no pinned CID for action "${name}". Existing actions: ${pinned.map((a) => a.name).join(', ')}`,
      );
    }
    const hashedCid = actionHash(pinnedAction.cid);
    if (hashedCid !== pinnedAction.hashedCid) {
      console.warn(
        `⚠️  hashedCid for "${name}" in config.json (${pinnedAction.hashedCid}) does not match keccak256(cid) (${hashedCid}) — using the computed hash on-chain.`,
      );
    }
    return { name, cid: pinnedAction.cid, hashedCid };
  });

  // Build the batch.
  const transactions = buildProvisionBatch({
    adminHash: adminHashVal,
    pkpAddress,
    derivationPath,
    usageHash: usage.usageHash,
    groupId: predictedGroupId,
    actions,
  });

  console.log(`\n=== Safe batch (${transactions.length} calls) ===`);
  console.log(prettyPrintBatch(transactions));

  if (dryRun) {
    console.log('\ndry-run: would mint');
    console.log('dry-run: STOPPING before proposing to Safe and before calling /prepare_wallet.');
    return;
  }

  // Persist the provision state so finalize can write config.json after execution.
  const pending: PendingProvision = {
    safeTxHash: '', // filled after propose
    proposedAt: new Date().toISOString(),
    groupName,
    adminHash: adminHashVal,
    predictedGroupId: Number(predictedGroupId),
    pkp: { address: pkpAddress, derivationPath },
    usage: { key: usage.usageKey, hash: usage.usageHash },
    actions,
  };
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
  console.log(`💾 Pending provision saved to ${pendingPath}`);

  // Propose to the Safe.
  const { safeTxHash } = await proposeToSafe({
    transactions,
    safeAddress: PROTOCOL_SAFE_ADDRESS,
    signerPrivateKey: requireProtocolPrivateKey(),
    rpcUrl: resolveLitRpcUrl(),
  });
  pending.safeTxHash = safeTxHash;
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));

  console.log('\n=== NEXT STEPS ===');
  console.log('1. Approve the Safe transaction in the Safe UI (owners must confirm).');
  console.log('2. Then finalize (reads the ACTUAL group id from the addGroup receipt):');
  console.log(`     pnpm deploy-group -- --finalize ${safeTxHash}`);
  console.log(`   (or: LIT_FINALIZE_TX=${safeTxHash} pnpm deploy-group)`);
  console.log('3. ⚠️ SAVE the usage key now (shown once; only its hash is on-chain):');
  console.log(`     ${usage.usageKey}`);
  console.log(`   New PKP: ${pkpAddress}  (save it too)`);
  console.log(
    `   Derived from group id ${predictedGroupId.toString()} (verify == receipt at finalize).`,
  );
}

main()
  .catch((error: any) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
