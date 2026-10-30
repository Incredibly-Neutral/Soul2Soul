import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { encodeFunctionData } from "viem";
// @ts-ignore
import { OperationType } from "@safe-global/types-kit";
import { loadMonorepoEnv } from "@s2s/soul2soul-shared/chain-secured";

import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadMonorepoEnv(__filename);

// ── ABI ────────────────────────────────────────────────────────────────────
const recordsModuleAbi = [
  {
    name: "setRecord",
    type: "function",
    inputs: [
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
  },
] as const;

const RECORDS_MODULE_ADDRESS = "0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29";

const proposeToSafe = async (account: any, transactions: any[]) => {
  const protocolKit = await Safe.init({
    provider: `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`,
    signer: process.env.PROTOCOL_PRIVATE_KEY!,
    safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!,
  });

  const apiKit = new SafeApiKit({ chainId: 8453n });

  const safeTransaction = await protocolKit.createTransaction({ transactions });
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const senderSignature = await protocolKit.signHash(safeTxHash);

  await apiKit.proposeTransaction({
    safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress: account.address,
    senderSignature: senderSignature.data,
  });

  console.log("✅ Transaction proposed to Safe");
  console.log("Safe Tx Hash:", safeTxHash);
  return safeTxHash;
};

/**
 * repoint-record.ts — targeted reconciliation of the lit_action_repointArchive
 * record. Writes ONLY that one key so the on-chain records module matches the
 * repoint-archive action actually registered in Lit group 1.
 *
 * The value is read from config.json (source of truth), so it can never drift
 * from what the tooling thinks the repoint action is.
 *
 * Usage:
 *   pnpm tsx press/scripts/lit/repoint-record.ts
 *   (or: pnpm repoint-record  — not wired yet, run via tsx directly)
 *   LIT_DRY_RUN=1 ... to preview the batch without proposing.
 */
const main = async () => {
  const dryRun = process.env.LIT_DRY_RUN === '1' || process.argv.includes('--dry-run');

  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'),
  );
  const group = config.groups.find((g: any) => g.name === 's2s');
  if (!group) throw new Error("Group 's2s' not found in config.json");
  const repoint = group.actions.find((a: any) => a.name === 'repoint-archive');
  if (!repoint?.cid) throw new Error('repoint-archive cid missing from config.json');

  const key = 'lit_action_repointArchive';
  const value = repoint.cid;

  const transactions = [
    {
      to: RECORDS_MODULE_ADDRESS,
      data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: 'setRecord',
        args: [key, value],
      }),
      value: '0',
      operation: OperationType.Call,
    },
  ];

  console.log(`\n=== setRecord(${key}, ${value}) ===`);
  console.log(`to:     ${RECORDS_MODULE_ADDRESS}`);
  console.log(`data:   ${transactions[0].data}`);

  if (dryRun) {
    console.log('\ndry-run: STOPPING before proposing to Safe.');
    return;
  }

  const account = privateKeyToAccount(
    `0x${process.env.PROTOCOL_PRIVATE_KEY!}` as `0x${string}`,
  );
  await proposeToSafe(account, transactions);
  console.log('\nApprove in the Safe UI. No config change needed (already synced).');
};

main()
  .catch((error: any) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
