/**
 * setup-session-key.ts
 *
 * Generates an ephemeral session key for Filecoin Onchain Cloud storage
 * operations, authorized by a funded payer wallet.
 *
 * ## Flow
 *
 *   1) Loads the payer private key from PROTOCOL_PRIVATE_KEY env var
 *   2) Generates a new ephemeral secp256k1 key pair for the session key
 *   3) Authorises the session key on-chain via SessionKey.loginSync() —
 *      grants CreateDataSet + AddPieces permissions (long-lived)
 *   4) Writes the session key + root address to a JSON file for 0xobsidian
 *
 * ## Usage
 *
 *   # One-time: set the payer key in .env (funded with USDFC + FIL)
 *   PROTOCOL_PRIVATE_KEY=0x... pnpm filecoin:setup-key
 *
 *   # Or after adding to package.json
 *   pnpm filecoin:setup-key
 *
 * ## Output
 *
 *   Writes scripts/filecoin/session-key.json which the FilecoinController
 *   in 0xobsidian reads to initialise with the delegated session key.
 */

import * as SessionKey from "@filoz/synapse-core/session-key";
import { mainnet } from "@filoz/synapse-core/chains";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { config } from "dotenv";
import { resolve } from "path";
import { writeFileSync } from "fs";

// ── Config ──────────────────────────────────────────────────────────

config({ path: resolve(process.cwd(), "../../.env") });

const PAYER_KEY = process.env.PROTOCOL_PRIVATE_KEY;
const CHAIN = mainnet;
// 1 year from now (in seconds)
const EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
const OUTPUT_PATH = resolve(
  process.cwd(),
  "scripts/filecoin/session-key.json",
);

// Filecoin RPC endpoint (FEVM mainnet). Uses DRPC; fallback to public Glif.
const RPC_URL =
  process.env.FILECOIN_RPC_URL ||
  (process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/filecoin/${process.env.VITE_DRPC_API_KEY}`
    : "https://api.node.glif.io/rpc/v1");

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  if (!PAYER_KEY) {
    console.error(
      "❌ PROTOCOL_PRIVATE_KEY not set in ../.env\n" +
        "   Add it: PROTOCOL_PRIVATE_KEY=0x<your-funded-wallet>",
    );
    process.exit(1);
  }

  if (!process.env.FILECOIN_RPC_URL && !process.env.VITE_DRPC_API_KEY) {
    // Will fall back to public Glif endpoint — warn the user
    console.log(
      "⚠️  No FILECOIN_RPC_URL or VITE_DRPC_API_KEY in .env. Falling back to public Glif endpoint\n" +
        "   (https://api.node.glif.io/rpc/v1) — rate-limited, ok for testing.",
    );
  }

  console.log("🔑 Setting up Filecoin session key...\n");

  // ── 1. Payer wallet ──────────────────────────────────────────────

  const payerHex = (PAYER_KEY.startsWith("0x") ? PAYER_KEY : `0x${PAYER_KEY}`) as Hex;
  const payerAccount = privateKeyToAccount(payerHex);
  const rootClient = createWalletClient({
    account: payerAccount,
    chain: CHAIN,
    transport: http(RPC_URL),
  });

  console.log(`   Payer address: ${payerAccount.address}`);

  // ── 2. Generate session key ──────────────────────────────────────

  const sessionPrivateKey = generatePrivateKey();
  const sessionKey = SessionKey.fromSecp256k1({
    privateKey: sessionPrivateKey,
    root: payerAccount,
    chain: CHAIN,
    transport: http(RPC_URL),
  });

  console.log(`   Session key address: ${sessionKey.address}`);

  // ── 3. Authorise on-chain ────────────────────────────────────────

  console.log("\n⏳ Authorising session key on Filecoin mainnet...");

  const { receipt, event } = await SessionKey.loginSync(rootClient, {
    address: sessionKey.address,
    expiresAt: EXPIRY,
    permissions: [
      SessionKey.CreateDataSetPermission,
      SessionKey.AddPiecesPermission,
      SessionKey.TerminateServicePermission,
      SessionKey.SchedulePieceRemovalsPermission
    ],
    onHash(hash: any) {
      console.log(`   Tx submitted: ${hash}`);
    },
  });

  console.log(`   ✅ Authorised (tx: ${receipt.transactionHash})`);
  console.log(
    `   Expiry: ${new Date(Number(EXPIRY) * 1000).toISOString()}`,
  );

  // ── 4. Sync expirations from chain ───────────────────────────────

  await sessionKey.syncExpirations();
  console.log("   ✅ Expirations synced from chain");

  // ── 5. Verify permissions ────────────────────────────────────────

  const hasPerms = sessionKey.hasPermissions([
    SessionKey.CreateDataSetPermission,
    SessionKey.AddPiecesPermission,
    SessionKey.TerminateServicePermission,
    SessionKey.SchedulePieceRemovalsPermission
  ]);

  if (!hasPerms) {
    console.error("❌ Session key permissions not granted — aborting");
    process.exit(1);
  }

  console.log("   ✅ Required permissions verified\n");

  // ── 6. Write output ──────────────────────────────────────────────

  const output = {
    /** The session key private key — secrete; give to the author's plugin. */
    sessionPrivateKey,
    /** The session key address (public). */
    sessionAddress: sessionKey.address,
    /** The root (payer) wallet address — used as the identity/payer. */
    rootAddress: payerAccount.address,
    /** Epoch second at which the session key expires. */
    expiresAt: EXPIRY.toString(),
    /** ISO string of the expiry. */
    expiresAtISO: new Date(Number(EXPIRY) * 1000).toISOString(),
    /** Permission hashes granted. */
    permissions: ["CreateDataSet", "AddPieces", "TerminateService","SchedulePieceRemovals"],
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`📄 Session key written to: ${OUTPUT_PATH}\n`);
  console.log("📋 Summary");
  console.log("   ---------");
  console.log(`   Root (payer):     ${output.rootAddress}`);
  console.log(`   Session address:  ${output.sessionAddress}`);
  console.log(`   Session key:      ${output.sessionPrivateKey}`);
  console.log(`   Expires:          ${output.expiresAtISO}`);
  console.log(
    "\n💡 Give the session private key to each author's 0xobsidian plugin.",
  );
  console.log(
    "   The author uploads JSON to Filecoin; storage costs are paid",
  );
  console.log("   from the payer wallet's USDFC balance.");
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});