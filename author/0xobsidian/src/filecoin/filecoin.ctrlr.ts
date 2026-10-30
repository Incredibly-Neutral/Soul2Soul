/**
 * FilecoinController — thin wrapper over the shared FilecoinStorage.
 *
 * This file exists in 0xobsidian (NOT shared) because:
 * 1. It depends on `addJson` from the local `remotekubo.service.js`
 *    (which uses electron/net/request), so it cannot live in shared.
 * 2. It preserves the original method names (`uploadJson`, `uploadToKubo`,
 *    `retrieveJson`) so the two call sites in main.ctrlr.ts and
 *    publishToPublication.ts don't change.
 *
 * The heavy lifting (CAR builder, Synapse, session keys, viem) is in
 * `@s2s/soul2soul-shared/filecoin`. This file is a one-line adapter.
 */

import { FilecoinStorage, FilecoinUser, FilecoinUploadResult, type FilecoinSessionKeyData } from "@s2s/soul2soul-shared/filecoin";
import { nodeFilecoinBuilder } from "@s2s/soul2soul-shared/filecoin/car-builder/node";
import { addJson } from "../ipfs/remotekubo.service.js";
import { installCorsFetch, restoreCorsFetch } from "./cors-fetch.js";
import * as https from "https";
import { URL } from "url";

/** Minimal shape we need from the main controller for FilecoinStorage. */
interface FilecoinMain {
  user?: { private_key?: string };
}

export class FilecoinController {
  private storage: FilecoinStorage;

  constructor(main: FilecoinMain) {
    this.storage = new FilecoinStorage(main as FilecoinUser, nodeFilecoinBuilder);
  }

  // ── FilecoinStorage passthroughs ─────────────────────────────────

  async init(chain?: "mainnet" | "calibration"): Promise<void> {
    return this.storage.init(chain);
  }

  async initWithSessionKey(
    sessionKeyData: FilecoinSessionKeyData,
    rpcUrl: string,
    chain?: "mainnet" | "calibration",
  ): Promise<void> {
    return this.storage.initWithSessionKey(sessionKeyData, rpcUrl, chain);
  }

  async uploadJson(data: unknown, owners?: string[], kind?: string): Promise<FilecoinUploadResult> {
    // Scope the CORS-free fetch to this Filecoin op: install before the
    // passthrough (iso-web picks up globalThis.fetch at call time) and
    // restore in a finally so native renderer fetch is untouched even on error.
    installCorsFetch();
    try {
      return await this.storage.uploadJson(data, owners, kind);
    } finally {
      restoreCorsFetch();
    }
  }

  async listStorageFor(identity: string): Promise<any[]> {
    return this.storage.listStorageFor(identity);
  }

  async retrieveJson(pieceCid: string): Promise<unknown> {
    return this.storage.retrieveJson(pieceCid);
  }

  async isRetrievable(pieceCid: string): Promise<boolean> {
    return this.storage.isRetrievable(pieceCid);
  }

  // ── Kubo upload (0xobsidian-local) ───────────────────────────────

  /**
   * Upload to Kubo IPFS. Uses the local `addJson` which serialises with
   * `JSON.stringify(data, null, 2)` — the same format filecoin-pin uses,
   * so the CID from Kubo matches the `rootCid` from Filecoin.
   */
  async uploadToKubo(data: unknown, kuboUrl: string): Promise<string> {
    return addJson(data, kuboUrl);
  }

  // ── Tree export + Filecoin upload ───────────────────────────────

  /**
   * Upload the full assets tree (config + templates + all assets) to Filecoin.
   *
   * 1. Exports the DAG from Kubo as CAR bytes via /api/v0/dag/export
   * 2. Uploads the CAR bytes to Filecoin SPs via FilecoinStorage.uploadTree
   *
   * The root CID from Kubo is used — this guarantees CID parity since
   * the CAR bytes from Kubo already have the correct unixfs-v1-2025
   * serialization.
   *
   * @param configCid - Root CID of the assets tree in Kubo
   * @param kuboUrl - Kubo RPC endpoint (e.g. "https://ipfs.transport-union.dev")
   */
  async uploadTree(
    configCid: string,
    kuboUrl: string,
    owners: string[] = [],
    kind: string = '',
  ): Promise<FilecoinUploadResult> {
    const carBytes = await this.exportTreeFromKubo(configCid, kuboUrl);
    // Scope the CORS-free fetch to the Filecoin upload only (kubo export above
    // uses node https and needs native fetch untouched). restore in finally.
    installCorsFetch();
    try {
      return await this.storage.uploadTree(carBytes, owners, kind);
    } finally {
      restoreCorsFetch();
    }
  }

  /**
   * Export a DAG from Kubo as CAR bytes via /api/v0/dag/export.
   */
  private async exportTreeFromKubo(cid: string, kuboUrl: string): Promise<Uint8Array> {
    const url = new URL(kuboUrl);
    const endpoint = `/api/v0/dag/export?arg=${cid}`;

    return new Promise<Uint8Array>((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: endpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
        },
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve(new Uint8Array(buf));
        });
      });

      req.on("error", reject);
      req.end();
    });
  }
}

export type {
  FilecoinSessionKeyData,
  FilecoinBalance,
  FilecoinCosts,
  FilecoinUploadResult,
} from "@s2s/soul2soul-shared/filecoin";
