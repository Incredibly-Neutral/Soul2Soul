declare module "filecoin-pin/dist/core/unixfs/browser.js" {
  import { CID } from "multiformats/cid";

  export interface CreateCarOptions {
    onProgress?: (bytesProcessed: number, totalBytes: number) => void;
  }

  export interface CreateCarResult {
    carBytes: Uint8Array;
    rootCid: CID;
    name: string | null;
  }

  export function createCarFromFile(
    file: File,
    options?: CreateCarOptions,
  ): Promise<CreateCarResult>;
}
