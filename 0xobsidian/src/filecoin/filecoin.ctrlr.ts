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
import { nodeFilecoinBuilder } from "./car-builder.js";
import { addJson } from "../ipfs/remotekubo.service.js";

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

  async uploadJson(data: unknown): Promise<FilecoinUploadResult> {
    return this.storage.uploadJson(data);
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
}

export type {
  FilecoinSessionKeyData,
  FilecoinBalance,
  FilecoinCosts,
  FilecoinUploadResult,
} from "@s2s/soul2soul-shared/filecoin";
