// protocol/scripts/filecoin/terminate-datasets.ts
import { Synapse } from "@filoz/synapse-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "@filoz/synapse-sdk";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), "../.env") });


const PK = '0x' + process.env.PROTOCOL_PRIVATE_KEY as `0x${string}`;
const DATASET_IDS = [1321n, 1322n, 1323n];

const synapse = Synapse.create({
  account: privateKeyToAccount(PK),
  source: "oxo-core",
  chain: mainnet,
});

for (const dataSetId of DATASET_IDS) {
  console.log(`\n=== dataset ${dataSetId} ===`);
  try {
    const result = await synapse.storage.terminateService({ dataSetId });
    console.log(`terminated (provider-mediated), ends at epoch ${result.endEpoch}`);
  } catch (err) {
    console.warn(`provider path failed:`, (err as Error).message);
    console.log(`retrying with skipProvider…`);
    const result = await synapse.storage.terminateService({
      dataSetId,
      skipProvider: true,
      onSubmitted: (txHash) => console.log("submitted:", txHash),
    });
    console.log(`terminated (on-chain), ends at epoch ${result.endEpoch}`);
  }
}