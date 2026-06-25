/**
 * fund-account.ts
 *
 * Deposit a fixed lump sum of USDFC into the Filecoin Pay contract so
 * authors can upload without worrying about lockup funds.
 *
 * Unlike setup-payment.ts which uses prepare() (data-size-based), this
 * deposits exactly N USDFC (default: 6) directly via
 * synapse.payments.deposit().
 *
 * ## Usage
 *
 *   pnpm filecoin:fund-account           # deposit 6 USDFC
 *   pnpm filecoin:fund-account 10        # deposit 10 USDFC
 */

import { Synapse, mainnet, TOKENS } from "@filoz/synapse-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { http, formatUnits, parseUnits } from "viem";
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

const DEPOSIT_USDFC = Number(process.argv[2] || "6"); // CLI: default 6 UDSFC

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

  console.log("💰 Filecoin Account Fund\n");
  console.log(`   RPC:   ${RPC_URL}`);
  console.log(`   Amount: ${DEPOSIT_USDFC} USDFC`);

  const synapse = Synapse.create({
    account: privateKeyToAccount(payerHex),
    source: "oxo-core",
    chain: mainnet,
    transport: http(RPC_URL),
  });

  const payerAddress = privateKeyToAccount(payerHex).address;
  console.log(`   Payer: ${payerAddress}\n`);

  // ── Check current wallet balance ────────────────────────────────

  const balance = await synapse.payments.walletBalance({
    token: TOKENS.USDFC,
  });
  const formatted = formatUnits(balance, 18);
  console.log(`   Wallet balance: ${formatted} USDFC`);

  const depositAmount = parseUnits(DEPOSIT_USDFC.toString(), 18);

  if (balance < depositAmount) {
    console.error(
      `❌ Insufficient USDFC: need ${DEPOSIT_USDFC}, have ${formatted}`,
    );
    process.exit(1);
  }

  const walletAfter = formatUnits(balance - depositAmount, 18);

  console.log(`   Depositing:     ${DEPOSIT_USDFC} USDFC (${depositAmount} wei)`);
  console.log(`   Wallet after:   ${walletAfter} USDFC\n`);

  // ── Execute deposit ─────────────────────────────────────────────

  console.log("⏳ Depositing...");

  const txHash = await synapse.payments.deposit({
    amount: depositAmount,
    token: TOKENS.USDFC,
    onApprovalTransaction: (hash: string) => {
      console.log(`   Approval tx: ${hash}`);
    },
    onDepositStarting: () => {
      console.log("   Deposit tx submitted...");
    },
  });

  console.log(`\n✅ Deposit complete!`);
  console.log(`   Tx: ${txHash}`);
  console.log(`\n   Deposited ${DEPOSIT_USDFC} USDFC — should cover many uploads.`);
  console.log("   Run pnpm filecoin:check-status to verify.");
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});