/**
 * retrieve-test.ts
 *
 * Test Filecoin retrieval for a specific PieceCID and show deal context.
 *
 * Usage:
 *   tsx ./scripts/filecoin/retrieve-test.ts <pieceCid>
 *
 * Example:
 *   tsx ./scripts/filecoin/retrieve-test.ts bafkzcibdt4damuikjijbo5k3ramhqycdgkswqkqjftkl2xp4en3bb6v6jmsbcvry
 */

import { Synapse, mainnet, TOKENS } from "@filoz/synapse-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { http, formatUnits } from "viem";
import type { Hex } from "viem";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), "../.env") });

const PAYER_KEY = process.env.PROTOCOL_PRIVATE_KEY;
const PIECE_CID = process.argv[2];

const RPC_URL =
  process.env.FILECOIN_RPC_URL ||
  (process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/filecoin/${process.env.VITE_DRPC_API_KEY}`
    : "https://api.node.glif.io/rpc/v1");

async function main() {
  if (!PAYER_KEY) {
    console.error("❌ PROTOCOL_PRIVATE_KEY not set in ../.env");
    process.exit(1);
  }
  if (!PIECE_CID) {
    console.error("❌ Pass a PieceCID: tsx retrieve-test.ts bafkzcib...");
    process.exit(1);
  }

  const payerHex = (PAYER_KEY.startsWith("0x") ? PAYER_KEY : `0x${PAYER_KEY}`) as Hex;

  const synapse = Synapse.create({
    account: privateKeyToAccount(payerHex),
    source: "oxo-core",
    chain: mainnet,
    transport: http(RPC_URL),
  });

  console.log("🔍 Filecoin Retrieval Test\n");
  console.log(`   PieceCID: ${PIECE_CID}\n`);

  // ── 1. Try downloading from Filecoin ─────────────────────────────

  console.log("⏳ Retrieving from Filecoin SPs...");
  console.time("retrieve");

  try {
    const bytes: Uint8Array = await synapse.storage.download({
      pieceCid: PIECE_CID,
    });
    console.timeEnd("retrieve");

    const text = new TextDecoder().decode(bytes);
    const data = JSON.parse(text);

    console.log(`\n✅ Retrieved!`);
    console.log(`   Size: ${bytes.length} bytes`);

    // Show content metadata (not full body — just titles etc.)
    if (data.objectId) console.log(`   ObjectId: ${data.objectId}`);
    if (data.public?.title) console.log(`   Title: ${data.public.title}`);
    if (data.public?.author) console.log(`   Author: ${data.public.author}`);
    if (data.public?.postType) console.log(`   Type: ${data.public.postType}`);

  } catch (err) {
    console.timeEnd("retrieve");
    console.error(`\n❌ Retrieval failed: ${err}`);
  }

  // ── 2. Show provider and pricing context ─────────────────────────

  console.log(`\n--- Storage Context ---\n`);

  const info = await synapse.storage.getStorageInfo();

  console.log(`Approved providers:`);
  for (const p of info.providers) {
    console.log(`   ${p.name ?? "unknown"} (ID: ${p.providerId})`);
    console.log(`      Address: ${p.serviceProvider}`);
    if (p.pdp?.serviceURL) console.log(`      PDP URL: ${p.pdp.serviceURL}`);
  }

  console.log(`\nPricing (per TiB / month):`);
  console.log(`   No CDN: ${formatUnits(info.pricing.noCDN.perTiBPerMonth, 18)} USDFC`);
  console.log(`   With CDN: ${formatUnits(info.pricing.withCDN.perTiBPerMonth, 18)} USDFC`);

  console.log(`\nYour deposit / allowance:`);
  if (info.allowances) {
    console.log(`   Rate used:    ${formatUnits(info.allowances.rateUsed ?? 0n, 18)} USDFC/mo`);
    console.log(`   Rate limit:   ${formatUnits(info.allowances.rateAllowance ?? 0n, 18)} USDFC/mo`);
    console.log(`   Lockup used:  ${formatUnits(info.allowances.lockupUsed ?? 0n, 18)} USDFC`);
    console.log(`   Lockup limit: ${formatUnits(info.allowances.lockupAllowance ?? 0n, 18)} USDFC`);
  }

  console.log(`\n   Your piece (1233 bytes) cost at ${formatUnits(info.pricing.noCDN.perTiBPerMonth, 18)} USDFC/TiB/mo:`);
  const costPerMonth = info.pricing.noCDN.perTiBPerMonth * BigInt(1233) / (BigInt(1) << BigInt(40));
  // This is ₿ tiny — 1233 bytes out of 1 TiB (1,099,511,627,776 bytes)
  console.log(`   ~${formatUnits(costPerMonth, 18)} USDFC/mo for this piece`);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});