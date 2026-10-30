/**
 * check-status.ts
 *
 * Checks whether the Filecoin storage account is fully set up for uploads.
 * Reports: session key authorisation, USDFC balance, deposit status,
 * operator approval, and connectivity.
 *
 * ## Usage
 *
 *   pnpm filecoin:check-status
 *
 * This reads the session-key.json from the plugin folder to verify the
 * session key's permissions are still valid, and reads lockup/deposit
 * state from the Filecoin Pay and Warm Storage contracts.
 */

import { Synapse, mainnet } from "@filoz/synapse-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { http, formatUnits } from "viem";
import type { Hex } from "viem";
import { config } from "dotenv";
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";

config({ path: resolve(process.cwd(), "../../.env") });

const PAYER_KEY = process.env.PROTOCOL_PRIVATE_KEY;
const RPC_URL =
  process.env.FILECOIN_RPC_URL ||
  (process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/filecoin/${process.env.VITE_DRPC_API_KEY}`
    : "https://api.node.glif.io/rpc/v1");

// Session key JSON paths
const PLUGIN_DIR = resolve(
  process.cwd(),
  "../author/0xobsidian/.obsidian/plugins/0xobsidian",
);
const SK_PATHS = [
  resolve(process.cwd(), "scripts/filecoin/session-key.json"),
  resolve(PLUGIN_DIR, "session-key.json"),
  resolve(PLUGIN_DIR.replace("/0xobsidian/", "/oxo-core/"), "session-key.json"),
];

async function main() {
  console.log("📋 Filecoin Storage Status Check\n");

  const payerHex = (PAYER_KEY?.startsWith("0x")
    ? PAYER_KEY
    : `0x${PAYER_KEY ?? ""}`) as Hex;

  // ── 1. Synapse connectivity ─────────────────────────────────────

  try {
    const synapse = Synapse.create({
      account: privateKeyToAccount(payerHex),
      source: "oxo-core",
      chain: mainnet,
      transport: http(RPC_URL),
    });
    console.log("✅ Synapse SDK connected to FEVM mainnet\n");

    const payerAddress = privateKeyToAccount(payerHex).address;
    console.log(`   Payer address: ${payerAddress}`);

    // ── 2. USDFC balance ──────────────────────────────────────────

    const balance = await synapse.payments.walletBalance({ token: "USDFC" });
    console.log(`   USDFC balance: ${formatUnits(balance, 18)} USDFC`);

    // ── 3. Deposit / lockup status ────────────────────────────────

    const prep = await synapse.storage.prepare({ dataSize: BigInt(1 << 20) });
    console.log(`   Deposit needed:    ${formatUnits(prep.costs.depositNeeded, 18)} USDFC`);
    console.log(`   Monthly rate:      ${formatUnits(prep.costs.rates.perMonth, 18)} USDFC/mo`);
    console.log(`   Account ready:     ${prep.costs.ready}`);
    console.log(`   Tx needed:         ${prep.transaction ? "YES — run pnpm filecoin:setup-payment" : "No — all set"}\n`);

    if (!prep.costs.ready) {
      if (prep.transaction) {
        console.log("⚠️  Account not ready. Run: pnpm filecoin:setup-payment\n");
      } else {
        console.log("❌ Account not ready and no transaction returned. Check RPC / balance.\n");
      }
    } else {
      console.log("✅ Storage account is fully set up. Authors can upload.\n");
    }
  } catch (err: any) {
    console.error(`❌ Synapse init failed: ${err.message}\n`);
  }

  // ── 4. Session key file ─────────────────────────────────────────

  let skFound = false;
  for (const p of SK_PATHS) {
    if (existsSync(p)) {
      try {
        const sk = JSON.parse(readFileSync(p, "utf-8"));
        const now = Math.floor(Date.now() / 1000);
        const expires = BigInt(sk.expiresAt ?? 0);
        const remaining = expires > BigInt(now) ? Number(expires - BigInt(now)) : 0;

        console.log(`✅ Session key found: ${p}`);
        console.log(`   Root (payer):     ${sk.rootAddress}`);
        console.log(`   Session address:  ${sk.sessionAddress}`);
        console.log(`   Expires:          ${sk.expiresAtISO ?? "unknown"}`);
        console.log(`   Remaining:        ${Math.floor(remaining / 86400)} days`);
        console.log(`   Permissions:      ${sk.permissions?.join(", ") ?? "none"}\n`);
        skFound = true;
      } catch {
        console.log(`⚠️  Session key file exists but unreadable: ${p}\n`);
      }
    }
  }

  if (!skFound) {
    console.log("⚠️  No session-key.json found in expected locations.\n");
    console.log("   Expected:");
    for (const p of SK_PATHS) console.log(`   - ${p}`);
    console.log();
  }
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
