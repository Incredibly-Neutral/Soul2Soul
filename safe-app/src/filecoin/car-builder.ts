/**
 * Browser-only CAR builder for FilecoinStorage.
 * Uses @helia/unixfs with CARWritingBlockstore directly — same approach
 * as Node (createUnixfsCarBuilder) but browser-compatible.
 *
 * This module is NOT bundled into 0xobsidian — it's only used
 * in the safe-app browser context.
 */

import { unixfs } from "@helia/unixfs";
import { CARWritingBlockstore } from "filecoin-pin/dist/core/car/browser-car-blockstore.js";
import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { importerOptions } from "filecoin-pin/dist/core/unixfs/importer-options.js";
import type { FilecoinCarBuilder } from "@s2s/soul2soul-shared/filecoin";

// Placeholder CID used during CAR creation
const PLACEHOLDER_CID = CID.parse("bafyaaiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

export const browserFilecoinBuilder: FilecoinCarBuilder = {
  async buildCarFromBytes(bytes: Uint8Array): Promise<{
    rootCid: string;
    carBytes: Uint8Array;
  }> {
    // Create blockstore with placeholder CID
    const blockstore = new CARWritingBlockstore({
      rootCID: PLACEHOLDER_CID,
    });

    // Initialize blockstore (writes CAR header with placeholder)
    await blockstore.initialize();

    // Create UnixFS instance with our blockstore
    const fs = unixfs({ blockstore });

    // Add content as async iterable (matches Node's addByteStream)
    async function* bytesIterator() {
      yield bytes;
    }

    const rootCid = await fs.addByteStream(bytesIterator(), importerOptions);

    // Finalize CAR (close writer, flush to memory)
    await blockstore.finalize();

    // Get the CAR bytes
    let carBytes = blockstore.getCarBytes();

    // Update the root CID in the CAR bytes
    carBytes = await updateRootCidInCar(carBytes, rootCid);

    return { rootCid: rootCid.toString(), carBytes };
  },
};

/**
 * Update the root CID in CAR bytes
 * This creates a new CAR with the correct root CID
 */
async function updateRootCidInCar(carBytes: Uint8Array, rootCid: CID): Promise<Uint8Array> {
  const { CarReader } = await import("@ipld/car");
  const reader = await CarReader.fromBytes(carBytes);

  // Create new CAR writer with correct root
  const { writer, out } = CarWriter.create([rootCid]);

  // Collect new CAR chunks
  const newChunks: Uint8Array[] = [];
  (async () => {
    for await (const chunk of out) {
      newChunks.push(chunk);
    }
  })();

  // Copy all blocks from old CAR to new CAR
  for await (const { cid, bytes } of reader.blocks()) {
    await writer.put({ cid, bytes });
  }

  // Close writer
  await writer.close();

  // Combine chunks
  return concatUint8Arrays(newChunks);
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
