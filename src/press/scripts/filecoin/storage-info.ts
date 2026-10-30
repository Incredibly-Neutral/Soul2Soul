// press/scripts/filecoin/storage-info.ts
import { Synapse, mainnet } from "@filoz/synapse-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), "../../.env") });

const PK = ('0x' + process.env.PROTOCOL_PRIVATE_KEY) as `0x${string}`;

const synapse = Synapse.create({
  account: privateKeyToAccount(PK),
  source: "oxo-core",
  chain: mainnet,
});

const info = await synapse.storage.getStorageInfo();

console.log(`\n=== providers (${info.providers.length}) ===\n`);
for (const p of info.providers) {
  console.log({
    id: p.id?.toString(),
    name: p.name,
    serviceURL: p.pdp?.serviceURL,
    active: p.isActive,
  });
}

console.log(`\n=== pricing ===`);
console.log("per TiB/month (noCDN):", info.pricing?.noCDN?.perTiBPerMonth?.toString());
console.log("per TiB/month (CDN):  ", info.pricing?.withCDN?.perTiBPerMonth?.toString());

// raw dump — field names vary, this shows what's actually there
console.log(`\n=== raw first provider ===`);
console.log(info.providers[0]);