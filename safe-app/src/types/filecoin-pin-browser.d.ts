// Type declarations for filecoin-pin browser barrel
// The package uses conditional exports, so we need to declare the module explicitly
// to help TypeScript resolve it during compilation

declare module "filecoin-pin/core/unixfs" {
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
    options?: CreateCarOptions
  ): Promise<CreateCarResult>;

  export function createCarFromFiles(
    files: File[],
    options?: CreateCarOptions
  ): Promise<CreateCarResult>;

  export function createCarFromFileList(
    files: File[],
    options?: CreateCarOptions
  ): Promise<CreateCarResult>;
}
