import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { encodeFunctionData, getAddress, recoverMessageAddress } from "viem";
// @ts-ignore
import { OperationType } from "@safe-global/types-kit";

import * as dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: '../.env' });

// ── ABIs ────────────────────────────────────────────────────────────────────

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
    name: "deleteRecord",
    type: "function",
    inputs: [{ name: "key", type: "string" }],
  },
] as const;

const ensRecordsAbi = [
  {
    name: "authorizeCaller",
    type: "function",
    inputs: [
      { name: "caller", type: "address" },
      { name: "authorized", type: "bool" },
    ],
  },
] as const;

// ── Addresses ───────────────────────────────────────────────────────────────

const RECORDS_MODULE_ADDRESS = "0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29";
const ENS_RECORDS_ADDRESS = "0x5D42f9b016B4251FC6407d5e8154DA887F394900";

// Keys that were written under old names and must be removed from on-chain storage.
// Leaving them means any reader still asking for these keys gets stale data.
// deleteRecord removes them cleanly (emits RecordDeleted, frees the slot).
const STALE_KEYS : string[] = [
]



// ── Helpers ─────────────────────────────────────────────────────────────────

const setRecord = (key: string, value: string) => ({
  to: RECORDS_MODULE_ADDRESS,
  data: encodeFunctionData({
    abi: recordsModuleAbi,
    functionName: "setRecord",
    args: [key, value],
  }),
  value: "0",
  operation: OperationType.Call,
});

const deleteRecord = (key: string) => ({
  to: RECORDS_MODULE_ADDRESS,
  data: encodeFunctionData({
    abi: recordsModuleAbi,
    functionName: "deleteRecord",
    args: [key],
  }),
  value: "0",
  operation: OperationType.Call,
});


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

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Full protocol update: write new keys + delete stale ones + re-authorize PKP.
 * All in one Safe batch so it's atomic — owners confirm once for the whole set.
 *
 * Lit action naming (post-rename):
 *   prep         — was lit_action_prep      (unchanged)
 *   render       — was lit_action_single    (renamed; key: lit_action_render)
 *   update       — was lit_action_root_update + cbor merged in (key: lit_action_update)
 */
export const updateProtocol = async (
  account: any,
  pkpInfo: { ethAddress: string },
  prepActionCid: string,
  renderActionCid: string,
  updateActionCid: string,
  encryptActionCid: string,
  maintainCacheActionCid?: string
) => {
  const transactions = [
    // Write current values
    setRecord("pkp_ethAddress", pkpInfo.ethAddress),
    setRecord("lit_action_prep", prepActionCid),
    setRecord("lit_action_render", renderActionCid),
    setRecord("lit_action_update", updateActionCid),
    setRecord('lit_action_encrypt', encryptActionCid),
    // Optional: the dedicated maintain-cache action (parallel cache pointer
    // write). Only written when the action has been built + registered, so a
    // protocol update before this feature's deploy stays valid.
    ...(maintainCacheActionCid
      ? [setRecord("lit_action_maintainCache", maintainCacheActionCid)]
      : []),
    setRecord("ens_records", ENS_RECORDS_ADDRESS),
    setRecord("data_gateway", process.env.IPFS_URL || ""),
    setRecord("ens_registry", process.env.ENS_OPEN_SUBDOMAIN_REGISTRY || ""),
    setRecord("publication_factory", process.env.PUBLICATION_FACTORY_V2_ADDRESS || ""),
    setRecord("records_factory", process.env.RECORDS_FACTORY_ADDRESS || ""),
  


    // Delete stale keys from previous naming scheme
    ...STALE_KEYS.map(deleteRecord),

    // Re-authorize the PKP on the ENS records contract (INV-12)
    {
      to: ENS_RECORDS_ADDRESS,
      data: encodeFunctionData({
        abi: ensRecordsAbi,
        functionName: "authorizeCaller",
        args: [getAddress(pkpInfo.ethAddress), true],
      }),
      value: "0",
      operation: OperationType.Call,
    },
  ];

  return proposeToSafe(account, transactions);
};

/**
 * Actions-only update: rotate CIDs without touching the PKP or ENS auth.
 * Use when re-deploying Lit actions between protocol key rotations.
 */
export const updateActions = async (
  account: any,
  prepActionCid: string,
  renderActionCid: string,
  updateActionCid: string,
) => {
  const transactions = [
    setRecord("lit_action_prep", prepActionCid),
    setRecord("lit_action_render", renderActionCid),
    setRecord("lit_action_update", updateActionCid),

  ];

  return proposeToSafe(account, transactions);
};
1
/**
 * One-time cleanup: delete stale keys left over from the old naming scheme.
 * Run once after the first updateProtocol with the new keys is executed on-chain.
 * Safe to run again — deleteRecord on a non-existent key reverts with KeyNotFound,
 * so batch it only with keys you know exist (check recordExists first if unsure).
 */
export const cleanupStaleKeys = async (account: any) => {
  console.log("Deleting stale keys:", STALE_KEYS);
  const transactions = STALE_KEYS.map(deleteRecord);
  return proposeToSafe(account, transactions);
};

// ── Entry point ──────────────────────────────────────────────────────────────

const main = async () => {
  const config = fs.readFileSync('./protocol/scripts/lit/config.json', 'utf-8');
  const group = JSON.parse(config).groups.find((g: any) => g.name === 's2s');

  if (!group) throw new Error("Group 's2s' not found in config.json");

  const pkpInfo = { ethAddress: group.pkps[0] };
  console.log("PKP:", pkpInfo);

  const account = privateKeyToAccount(`0x${process.env.PROTOCOL_PRIVATE_KEY!}` as `0x${string}`);

  const encrypt = group.actions.find((a: any) => a.name === 'encrypt');
  const prep    = group.actions.find((a: any) => a.name === 'prep');
  const render  = group.actions.find((a: any) => a.name === 'render');
  const update  = group.actions.find((a: any) => a.name === 'update');
  const maintainCache = group.actions.find((a: any) => a.name === 'maintain-cache');

  if (!prep || !render || !update) {
    throw new Error(`Missing action CIDs. Found: ${JSON.stringify(group.actions.map((a: any) => a.name))}`);
  }

  console.log("Action CIDs:", {
    prep: prep.cid,
    render: render.cid,
    update: update.cid,
    maintainCache: maintainCache?.cid ?? '(not deployed)',
  });

  await updateProtocol(
    account,
    pkpInfo,
    prep.cid,
    render.cid,
    update.cid,
    encrypt.cid,
    maintainCache?.cid,
  );
};

main()
  .catch((error: any) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });