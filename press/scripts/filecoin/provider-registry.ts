// press/scripts/filecoin/provider-registry.ts
import { Synapse } from "@filoz/synapse-sdk";
import * as SPRegistry from "@filoz/synapse-core/sp-registry";
import { asClient, mainnet } from "@filoz/synapse-core/chains";
import { privateKeyToAccount } from "viem/accounts";
import { http } from "viem";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), "../.env") });

const PK = ("0x" + process.env.PROTOCOL_PRIVATE_KEY) as `0x${string}`;
const account = privateKeyToAccount(PK);

// ── 1. What WarmStorage will actually select from ──────────────
const synapse = Synapse.create({ account, source: "oxo-core", chain: mainnet });
const info = await synapse.storage.getStorageInfo();

console.log(`\n=== selectable (getStorageInfo): ${info.providers.length} ===`);
for (const p of info.providers) {
  console.log(
    `  ${p.id}  ${p.name}  ${p.pdp?.serviceURL}  ` +
    `min=${p.pdp?.minPieceSizeInBytes}  max=${p.pdp?.maxPieceSizeInBytes}`,
  );
}

// ── 2. The SP registry itself (client built the SDK's way) ─────
const client = asClient({ chain: mainnet, transport: http() });

try {
  const total = await SPRegistry.getProviderCount({ client });
  console.log(`\n=== SP registry — total registered: ${total} ===`);
} catch (e) {
  console.warn("getProviderCount failed:", (e as Error).message);
}

try {
  const all = await SPRegistry.getPDPProviders({ client });
  console.log(`\n=== all PDP providers in registry: ${all.length} ===`);
  for (const p of all) {
    console.log(
      `  ${p.id}  ${p.name}  ${p.pdp?.serviceURL}  active=${p.isActive}`,
    );
  }
} catch (e) {
  console.warn("getPDPProviders failed:", (e as Error).message);
}

try {
  const approved = await SPRegistry.getApprovedPDPProviders({ client });
  console.log(`\n=== approved for FWSS: ${approved.length} ===`);
  console.log("  ids:", approved.map((p: any) => p.id ?? p).join(", "));
} catch (e) {
  console.warn("getApprovedPDPProviders failed:", (e as Error).message);
}