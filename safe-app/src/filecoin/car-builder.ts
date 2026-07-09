/**
 * Browser-only CAR builder for FilecoinStorage.
 * Uses filecoin-pin's createCarFromFile() which takes a File object
 * (no Node fs APIs required).
 *
 * This module is NOT bundled into 0xobsidian — it's only used
 * in the safe-app browser context.
 */

import { createCarFromFile } from "filecoin-pin/dist/core/unixfs/browser.js";
import type { FilecoinCarBuilder } from "@s2s/soul2soul-shared/filecoin";

export const browserFilecoinBuilder: FilecoinCarBuilder = {
  async buildCarFromBytes(bytes: Uint8Array): Promise<{
    rootCid: string;
    carBytes: Uint8Array;
  }> {
    const file = new File([bytes as BlobPart], "payload.json", {
      type: "application/json",
    });
    const { carBytes, rootCid } = await createCarFromFile(file);
    return { rootCid: rootCid.toString(), carBytes };
  },
};
