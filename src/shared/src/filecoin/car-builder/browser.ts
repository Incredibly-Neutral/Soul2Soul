/**
 * Browser-only CAR builder for FilecoinStorage.
 * Uses filecoin-pin's browser barrel (createCarFromFile) which takes
 * a browser File object — no Node fs APIs required.
 *
 * Consumed by browser hosts via
 * `@s2s/soul2soul-shared/filecoin/car-builder/browser` — never bundled into
 * Node/Electron targets.
 */

import * as unixfs from 'filecoin-pin/core/unixfs';
import type { FilecoinCarBuilder } from '../index.js';

// createCarFromFile is only exported under filecoin-pin's "browser" condition;
// shared builds with the node condition, so the named export is absent from
// the types here. Grab it off the namespace — browser bundlers (Vite) resolve
// it at runtime via the browser condition. This module is browser-only.
const createCarFromFile = (unixfs as unknown as {
  createCarFromFile: (file: File) => Promise<{
    rootCid: { toString(): string };
    carBytes: Uint8Array;
  }>;
}).createCarFromFile;

export const browserFilecoinBuilder: FilecoinCarBuilder = {
  async buildCarFromBytes(bytes: Uint8Array): Promise<{
    rootCid: string;
    carBytes: Uint8Array;
  }> {
    // Create a browser File from the bytes — same bytes, just wrapped
    const file = new File([bytes as BlobPart], 'payload.json', {
      type: 'application/json',
    });
    const { carBytes, rootCid } = await createCarFromFile(file);
    return { rootCid: rootCid.toString(), carBytes };
  },
};
