/**
 * Node-only CAR builder for FilecoinStorage.
 * Uses filecoin-pin's createUnixfsCarBuilder() which requires
 * Node fs APIs (mkdtempSync, writeFileSync, readFileSync, unlinkSync).
 *
 * This module is NOT bundled into safe-app — it's only used
 * in the 0xobsidian Electron/Node context.
 */

import * as unixfs from "filecoin-pin/core/unixfs";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { FilecoinCarBuilder } from "@s2s/soul2soul-shared/filecoin";

export const nodeFilecoinBuilder: FilecoinCarBuilder = {
  async buildCarFromBytes(bytes: Uint8Array): Promise<{
    rootCid: string;
    carBytes: Uint8Array;
  }> {
    const builder = unixfs.createUnixfsCarBuilder();
    // Write bytes to temp file → CAR builder expects a source path
    const dir = mkdtempSync(join(tmpdir(), "fc-car-"));
    const srcPath = join(dir, "payload.json");
    writeFileSync(srcPath, bytes);

    const result = await builder.buildCar(srcPath);
    const carBytes = readFileSync(result.carPath);
    await builder.cleanup(result.carPath);
    unlinkSync(srcPath);

    return { rootCid: result.rootCid, carBytes: new Uint8Array(carBytes) };
  },
};
