/**
 * setup-payment.ts
 *
 * One-time Filecoin payment setup: deposits USDFC into the Filecoin Pay
 * contract and approves the warm storage operator (FWSS).
 *
 * This must be run once with the PROTOCOL_PRIVATE_KEY (the root wallet)
 * BEFORE any author can upload via the session key. The root wallet must
 * already hold USDFC tokens on FEVM mainnet.
 *
 * ## Usage
 *
 *   pnpm filecoin:setup-payment
 *
 * ## What it does
 *
 *   1) Connects to Filecoin mainnet via the DRPC or Glif RPC
 *   2) Calls Synapse.storage.prepare(), which checks your USDFC balance
 *      and returns a single deposit + approve transaction if needed
 *   3) Executes the transaction (costs a small amount of FIL for gas)
 */

import { Synapse, mainnet, TOKENS } from "@filoz/synapse-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { http, formatUnits } from "viem";
import type { Hex } from "viem";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), "../.env") });

const PAYER_KEY = process.env.PROTOCOL_PRIVATE_KEY;
const RPC_URL =
  process.env.FILECOIN_RPC_URL ||
  (process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/filecoin/${process.env.VITE_DRPC_API_KEY}`
    : "https://api.node.glif.io/rpc/v1");

async function main() {
  if (!PAYER_KEY) {
    console.error(
      "❌ PROTOCOL_PRIVATE_KEY not set in ../.env\n" +
        "   Add it: PROTOCOL_PRIVATE_KEY=0x<your-funded-wallet>",
    );
    process.exit(1);
  }

  const payerHex = (PAYER_KEY.startsWith("0x")
    ? PAYER_KEY
    : `0x${PAYER_KEY}`) as Hex;

  console.log("📦 Filecoin payment setup\n");
  console.log(`   RPC:   ${RPC_URL}`);

  // ── 1. Init Synapse with the root wallet ────────────────────────

  const synapse = Synapse.create({
    account: privateKeyToAccount(payerHex),
    source: "oxo-core",
    chain: mainnet,
    transport: http(RPC_URL),
  });

  const payerAddress = privateKeyToAccount(payerHex).address;
  console.log(`   Payer: ${payerAddress}`);

  // ── 2. Check USDFC balance ──────────────────────────────────────

  const balance = await synapse.payments.walletBalance({
    token: TOKENS.USDFC,
  });
  const formatted = formatUnits(balance, 18);
  console.log(`   USDFC balance: ${formatted} USDFC\n`);

  if (balance === 0n) {
    console.error(
      "❌ No USDFC in this wallet. Fund it first (via CEX or swap),\n" +
        "   then run this script again.",
    );
    process.exit(1);
  }

  // ── 3. Prepare account ──────────────────────────────────────────
  //
  // Use 1 MiB as the prep size — enough to cover real uploads.
  // prepare() checks deposit needs and operator approval status,
  // returning a single transaction if either is needed.

  console.log("⏳ Checking storage account setup...");

  const DATA_SIZE = BigInt(100 << 20); // 100 MiB — covers real uploads
  const prep = await synapse.storage.prepare({ dataSize: DATA_SIZE });

  console.log(`   Deposit needed:     ${formatUnits(prep.costs.depositNeeded, 18)} USDFC`);
  console.log(`   Monthly rate:       ${formatUnits(prep.costs.rates.perMonth, 18)} USDFC/mo`);
  console.log(`   Account ready:      ${prep.costs.ready}\n`);

  if (!prep.transaction) {
    console.log("✅ Account is already fully set up — no transaction needed.\n");
    console.log("   Authors can now upload via the session key.");
    return;
  }

  // ── 4. Execute deposit + approve ────────────────────────────────

  console.log(
    `⏳ Executing deposit + operator approval...` +
      `\n   Deposit: ${formatUnits(prep.transaction.depositAmount, 18)} USDFC` +
      `\n   Includes operator approval: ${prep.transaction.includesApproval}`,
  );

  const { hash, receipt } = await prep.transaction.execute({
    onHash(h: string) {
      console.log(`   Tx submitted: ${h}`);
    },
  });

  console.log(`\n✅ Payment setup complete!`);
  console.log(`   Tx:  ${hash}`);
  console.log(`   Block: ${receipt?.blockNumber?.toString() ?? "pending"}`);
  console.log("\n   Authors can now upload via the session key.");
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
