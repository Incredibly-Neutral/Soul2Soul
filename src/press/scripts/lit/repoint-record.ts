import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { createPublicClient, encodeFunctionData, http } from "viem";
import { base } from "viem/chains";
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
  {
    name: "getRecord",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "string" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const MANIFEST_KEY = "manifest";

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
 * repoint-record.ts — targeted reconciliation of one action CID in the manifest
 * document, for the repoint-archive action registered in Lit group 1.
 *
 * There is no per-action record to write: the document holds every CID under
 * `litActions`. This reads the live document, replaces `litActions.repointArchive`
 * with the CID in config.json, and writes the document back under `manifest` and
 * `manifest@<version>` — the same two writes `update-protocol.ts` makes, with every
 * other field carried through untouched.
 *
 * The CID is read from config.json (source of truth), so it can never drift from
 * what the tooling thinks the repoint action is.
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

  const client = createPublicClient({
    chain: base,
    transport: http(`https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`),
  });

  const raw = await client.readContract({
    address: RECORDS_MODULE_ADDRESS,
    abi: recordsModuleAbi,
    functionName: 'getRecord',
    args: [MANIFEST_KEY],
  });
  if (!raw) {
    throw new Error(`no '${MANIFEST_KEY}' record on ${RECORDS_MODULE_ADDRESS}: write the document first (pnpm update-protocol)`);
  }

  const document = JSON.parse(raw);
  if (typeof document.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(document.version)) {
    throw new Error(`document version is not x.y.z: ${JSON.stringify(document.version)}`);
  }
  const before = document.litActions?.repointArchive;
  document.litActions = { ...document.litActions, repointArchive: repoint.cid };
  const patched = JSON.stringify(document);

  const transactions = [MANIFEST_KEY, `${MANIFEST_KEY}@${document.version}`].map((key) => ({
    to: RECORDS_MODULE_ADDRESS,
    data: encodeFunctionData({
      abi: recordsModuleAbi,
      functionName: 'setRecord' as const,
      args: [key, patched] as [string, string],
    }),
    value: '0',
    operation: OperationType.Call,
  }));

  console.log(`\n=== litActions.repointArchive: ${before || '(unset)'} -> ${repoint.cid} ===`);
  console.log(`document version: ${document.version}`);
  for (const key of [MANIFEST_KEY, `${MANIFEST_KEY}@${document.version}`]) {
    console.log(`setRecord(${key}) on ${RECORDS_MODULE_ADDRESS}`);
  }

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
