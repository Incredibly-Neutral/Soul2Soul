/**
 * FilecoinStorage — upload/retrieve JSON objects via Filecoin
 * Onchain Cloud, using filecoin-pin's CAR builder for deterministic
 * IPFS Root CID ↔ Filecoin PieceCID matching.
 *
 * This class is shared (Node + browser). The actual CAR builder
 * is environment-specific:
 *   - Node (0xobsidian): 0xobsidian/src/filecoin/car-builder.ts
 *   - Browser (safe-app): safe-app/src/filecoin/car-builder.ts
 *
 * The shared class accepts a `buildCarFromBytes` implementation via
 * init() or constructor injection. See the respective modules.
 *
 * ## Pipeline (Node)
 *
 *   jsonBytes ──→ CAR builder ──→ rootCid (IPFS, matches Kubo)
 *                                   └─→ carBytes ──→ Synapse upload ──→ pieceCid
 *
 * The rootCid uses the unixfs-v1-2025 profile (1 MiB chunks, raw leaves,
 * CIDv1, balanced layout) — the same spec Kubo applies with:
 *   ipfs config profile apply unixfs-v1-2025
 *
 * ## Two init modes (same as before)
 *   init()                  — author's own EOA pays
 *   initWithSessionKey()    — protocol payer pays via session key
 *
 * ## Upload results
 *   uploadJson(data) returns { rootCid, pieceCid, size, complete, copies }
 */

import { Synapse, mainnet, calibration } from "@filoz/synapse-sdk";
import type { EnhancedDataSetInfo, StorageInfo } from "@filoz/synapse-sdk";
import { WarmStorageService } from "@filoz/synapse-sdk/warm-storage";
import { METADATA_KEYS } from "@filoz/synapse-sdk";
import { StorageContext } from "@filoz/synapse-sdk/storage";
import * as SessionKey from "@filoz/synapse-core/session-key";
import * as Piece from "@filoz/synapse-core/piece";
import { privateKeyToAccount } from "viem/accounts";
import { formatUnits, http, createWalletClient, custom } from "viem";
import type { Hex } from "viem";
import { findPieceIdsByCid } from "@filoz/synapse-core/pdp-verifier";
import { uploadToSynapse } from "filecoin-pin/core/upload";
import type { SynapseUploadResult } from "filecoin-pin/core/upload";
import { CarReader } from "@ipld/car";
import { CID } from "multiformats/cid";

// ── Types ───────────────────────────────────────────────────────────


export interface FilecoinBalance {
  raw: bigint;
  formatted: string;
  formattedUsdfc: string;
}

export interface FilecoinCosts {
  depositNeeded: bigint;
  perMonth: bigint;
  ready: boolean;
}

export interface FilecoinUploadResult {
  /** IPFS CID (unixfs-v1-2025 profile) — matches what Kubo produces. */
  rootCid: string;
  /** Filecoin PieceCID — used for on-chain deal audit. */
  pieceCid: string;
  /** Raw bytes uploaded (before padding). */
  size: number;
  /** True when all copies were stored + committed. */
  complete: boolean;
  /** Number of provider copies. */
  copyCount: number;
  /** Number of failed copy attempts. */
  failedCount: number;
  /** Per-copy info. */
  copies: Array<{ provider: string; dealId?: string }>;
}

export interface FilecoinSessionKeyData {
  sessionPrivateKey: string;
  sessionAddress: string;
  rootAddress: string;
  expiresAt: string;
  permissions: string[];
}

/**
 * Minimal shape that FilecoinStorage needs from the host (0xobsidian).
 * Kept intentionally small — only the private_key read path uses it,
 * and that path is only reached by init(), not initWithSessionKey().
 */
export interface FilecoinUser {
  user?: { private_key?: string };
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Minimal pino-compatible logger that delegates to console. */
const noopLogger = {
  info: (...args: any[]) => {}, // console.log("[filecoin]", ...args),
  warn: (...args: any[]) => {}, //console.warn("[filecoin]", ...args),
  error: (...args: any[]) => console.error("[filecoin]", ...args),
  debug: () => {},
  trace: () => {},
  fatal: (...args: any[]) => console.error("[filecoin:FATAL]", ...args),
  child: () => noopLogger,
  level: "info",
  silent: () => noopLogger,
  msgPrefix: "",
};

/**
 * Shared upload logic for Filecoin. The actual CAR builder is
 * environment-specific — see 0xobsidian/src/filecoin/car-builder.ts
 * (Node) and safe-app/src/filecoin/car-builder.ts (browser).
 */

export interface FilecoinCarBuilder {
  buildCarFromBytes(bytes: Uint8Array): Promise<{
    rootCid: string;
    carBytes: Uint8Array;
  }>;
}

// ── Controller ──────────────────────────────────────────────────────

/** Providers verified to support HTTP/2 + CORS (browser-usable).
 *  Re-run protocol/scripts/filecoin/probe-providers.ts to refresh. */
const BROWSER_USABLE_PROVIDERS = [1n, 13n, 15n, 16n, 29n, 30n, 32n];

/**
 * Thrown when fewer than two Filecoin copies could be committed across the
 * available provider pool. The message is a single concise line naming the
 * providers attempted; the nested SDK error chain is intentionally omitted.
 */
export class FilecoinMinCopiesError extends Error {
  /** Provider IDs attempted (as strings) before the pool was exhausted. */
  readonly providers: string[];

  constructor(providers: string[]) {
    super(
      `could not store 2 Filecoin copies (providers attempted: ${
        providers.length > 0 ? providers.join(", ") : "none"
      })`,
    );
    this.name = "FilecoinMinCopiesError";
    this.providers = providers;
  }
}

function toProviderBigInt(value: unknown): bigint | undefined {
  if (value == null) return undefined;
  try {
    return BigInt(value as bigint | number | string);
  } catch {
    return undefined;
  }
}

/**
 * Try to reach `minCopies` committed copies by issuing upload attempts against
 * pairs of providers drawn in order from `providerPool`. Providers reported as
 * failed by an attempt (`failedProviders`) are excluded from subsequent pairs.
 * Stops on the first attempt that reports `complete` and returns its `result`.
 * Throws {@link FilecoinMinCopiesError} once fewer than `minCopies` providers
 * remain in the pool.
 */
export async function uploadWithMinCopies<T>(
  providerPool: bigint[],
  minCopies: number,
  attempt: (pair: bigint[]) => Promise<{
    complete: boolean;
    failedProviders: bigint[];
    result?: T;
  }>,
): Promise<T> {
  const excluded = new Set<bigint>();
  const attempted: string[] = [];

  for (;;) {
    const remaining = providerPool.filter((id) => !excluded.has(id));
    if (remaining.length < minCopies) {
      throw new FilecoinMinCopiesError(attempted);
    }

    const pair = remaining.slice(0, minCopies);
    attempted.push(...pair.map((id) => id.toString()));

    const outcome = await attempt(pair);
    if (outcome.complete && outcome.result !== undefined) {
      return outcome.result;
    }

    for (const id of outcome.failedProviders) excluded.add(id);
  }
}

export class FilecoinStorage {
  private main: FilecoinUser;
  private synapse: any;
  private warm: WarmStorageService | null = null;
  private builder: FilecoinCarBuilder | null = null;
  private initialized = false;
  private usingSessionKey = false;
  walletAddress!: string;
  sessionAddress!: string;

  constructor(main: FilecoinUser, builder?: FilecoinCarBuilder) {
    this.main = main;
    this.builder = builder ?? null;
  }

  async init(chain: "mainnet" | "calibration" = "mainnet"): Promise<void> {
    if (this.initialized) return;
    const pk = this.main.user?.private_key;
    if (!pk) throw new Error("FilecoinStorage.init: no active user with a private key");
    const chainConfig = chain === "mainnet" ? mainnet : calibration;
    const account = privateKeyToAccount(pk as Hex);
    this.synapse = Synapse.create({
      account,
      source: "oxo-core",
      chain: chainConfig,
    });
    this.warm = (this.synapse as any)._warmStorageService;
    this.initialized = true;
  }

  async initWithSessionKey(
    skData: FilecoinSessionKeyData,
    rpcUrl: string,
    chain: "mainnet" | "calibration" = "mainnet",
  ): Promise<void> {
    if (this.initialized) return;
    const chainConfig = chain === "mainnet" ? mainnet : calibration;

    const sessionKey = SessionKey.fromSecp256k1({
      privateKey: skData.sessionPrivateKey as Hex,
      root: skData.rootAddress as Hex,
      chain: chainConfig,
      transport: http(rpcUrl),
    });
    await sessionKey.syncExpirations();

    const sessionSigner = privateKeyToAccount(skData.sessionPrivateKey as Hex);
    const fcTransport = custom({
      request: async ({ method, params }) => {
        if (method === "eth_signTypedData_v4") {
          const typedData = JSON.parse(params![1] as string);
          return await sessionSigner.signTypedData({
            domain: typedData.domain,
            types: typedData.types,
            message: typedData.message,
            primaryType: typedData.primaryType,
          });
        }
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error.message);
        return json.result;
      },
    });

    const client = createWalletClient({
      account: skData.rootAddress as Hex,
      chain: chainConfig,
      transport: fcTransport,
    });

    this.synapse = new Synapse({
      client,
      sessionClient: sessionKey.client as any,
      source: "oxo-core",
    });
    this.walletAddress = skData.rootAddress;        // ← the payer/client address
    this.sessionAddress = skData.sessionAddress; 
    this.warm = (this.synapse as any)._warmStorageService;
    this.initialized = true;
    this.usingSessionKey = true;
    console.log("[filecoin] Initialised with session key → root:", skData.rootAddress);
  }

  /**
   * Upload pre-built CAR bytes to Filecoin.
   * The CAR bytes should be from Kubo (dag/export) or built with
   * the same unixfs-v1-2025 profile for CID match.
   */
  async uploadTree(carBytes: Uint8Array, owners: string[] = [], kind: string = ''): Promise<FilecoinUploadResult> {
    this.ensureInit();
    if (!this.builder) throw new Error("FilecoinStorage: no CAR builder configured");

    // Extract root CID from the CAR bytes
    const rootCid = await this.extractRootCidFromCar(carBytes);

    // Upload the CAR to Filecoin SPs via filecoin-pin's uploader, retrying
    // in provider pairs until at least two copies are committed.
    return this.uploadCarWithMinCopies(
      carBytes,
      rootCid,
      this.buildPieceMetadata(owners, kind),
    );
  }

  /**
   * Upload CAR bytes to Filecoin, skipping if the PieceCID already exists
   * in the given dataset. Computes the PieceCID locally (no RPC needed)
   * and checks the PDP verifier contract before uploading.
   *
   * @returns Normal upload result on first upload, or skipped=true if already stored.
   */
  async uploadIfNew(
    carBytes: Uint8Array,
    dataSetId: bigint,
    attributedTo: string,
  ): Promise<FilecoinUploadResult & { skipped: boolean; pieceId?: bigint }> {
    this.ensureInit();
    const parsedCid = await Piece.calculate(carBytes);

    // Check PDP verifier — does this PieceCID already exist in the dataset?
    const existing = await findPieceIdsByCid(this.synapse.client, {
      dataSetId,
      pieceCid: parsedCid,
      startPieceId: 0n,
      limit: 1n,
    });

    if (existing && existing.length > 0) {
      // console.log(`[filecoin] piece already stored (pieceId ${existing[0]}), skipping upload`);
      return {
        pieceCid: parsedCid.toString(),
        rootCid: "",
        size: parsedCid.size,
        complete: true,
        copyCount: 0,
        failedCount: 0,
        copies: [],
        skipped: true,
        pieceId: existing[0],
      };
    }

    // Not there — upload as normal
    const result = await this.uploadTree(carBytes, attributedTo ? [attributedTo] : []);
    return { ...result, skipped: false };
  }

  /**
   * Extract root CID from CAR bytes.
   * Uses @ipld/car CarReader to parse the CAR header.
   */
  private async extractRootCidFromCar(carBytes: Uint8Array): Promise<string> {
    const reader = await CarReader.fromBytes(new Uint8Array(carBytes.buffer, carBytes.byteOffset, carBytes.byteLength));
    const roots = await reader.getRoots();
    if (!roots || roots.length === 0) throw new Error("uploadTree: unable to extract root CID from CAR bytes");
    return roots[0].toString();
  }

  // ── Upload / download ──────────────────────────────────────────

  /**
   * Upload JSON to Filecoin. Builds a CAR (unixfs-v1-2025 profile),
   * gets the Root CID (IPFS-compatible), uploads to Filecoin SPs,
   * and returns both the Root CID and PieceCID.
   * 
   * @param data - The JSON data to upload
   * @param attributedTo - Identifier for attribution (e.g. publication address, uploader identity)
   */
  async uploadJson(data: unknown, owners: string[] = [], kind: string = ''): Promise<FilecoinUploadResult> {
    this.ensureInit();
    if (!this.builder) throw new Error("FilecoinStorage: no CAR builder configured");

    const json = JSON.stringify(data, null, 2);
    const bytes = new TextEncoder().encode(json);

    // 1. Build CAR → get Root CID
    const { rootCid, carBytes } = await this.builder.buildCarFromBytes(bytes);

    // 2. Upload the CAR to Filecoin SPs via filecoin-pin's uploader
    //    (which calls Synapse internally and attaches rootCid as piece
    //    metadata), retrying in provider pairs until at least two copies
    //    are committed.
    return this.uploadCarWithMinCopies(
      carBytes,
      rootCid,
      this.buildPieceMetadata(owners, kind),
    );
  }

  /**
   * Retrieve a JSON object by PieceCID (via Filecoin SPs).
   */
  async retrieveJson(pieceCid: string): Promise<unknown> {
    this.ensureInit();
    const bytes: Uint8Array = await this.synapse.storage.download({ pieceCid });
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  }

  async isRetrievable(pieceCid: string): Promise<boolean> {
    try {
      await this.synapse.storage.download({ pieceCid });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all Filecoin pieces across all datasets that belong to `root`
   * and are attributed to `attributedTo` (publication address).
   *
   * The 5 pre-existing datasets were created by the author/plugin with
   * `metadata: { source: "oxo-core" }` only — they are shared and
   * attributed at the *piece* level via `pieceMetadata`.
   *
   * Pieces uploaded before this change are returned unattributed.
   */
  async listPublicationStorage(attributedTo: string): Promise<Array<{
    pieceCid: string;
    pieceId: string;
    rootCid: string | null;
    dataSetId: string;
    provider: string;
    attributed: boolean;
    size: number;
    metadata: Record<string, string>;
    pdpEndEpoch: bigint | null;
    isLive: boolean;
    dataSetMetadata: Record<string, string>;
    scheduledForRemoval: boolean;
  }>> {
    this.ensureInit();
    if (!this.warm) throw new Error("FilecoinStorage: warm storage service not initialised");

    const storage = this.synapse.storage as any;
    const dataSets = await this.findDataSets("root");
    const items: Array<{
      pieceCid: string;
      pieceId: string;
      rootCid: string | null;
      dataSetId: string;
      provider: string;
      attributed: boolean;
      size: number;
      metadata: Record<string, string>;
      pdpEndEpoch: bigint | null;
      isLive: boolean;
      dataSetMetadata: Record<string, string>;
      scheduledForRemoval: boolean;
    }> = [];

    for (const ds of dataSets) {
      const dataSetId = ds.dataSetId ?? (ds as any).id;
      if (!dataSetId) continue;

      let ctx;
      try {
        ctx = await storage.createContext({ dataSetId });
      } catch (e) {
        console.warn(`[storage] skip dataset ${dataSetId}: context resolve failed`, e);
        continue;
      }

      const provider = ds.providerId?.toString() ?? "unknown";
      const pdpEndEpoch = ds.pdpEndEpoch ?? null;
      const isLive = ds.isLive ?? false;
      const dataSetMetadata = ds.metadata ?? {};

      // Fetch scheduled removals once per dataset — pieces whose deletion
      // has been initiated but not yet executed.
      let scheduledRemovals: readonly bigint[] = [];
      try {
        scheduledRemovals = await ctx.getScheduledRemovals();
      } catch (e) {
        // Non-fatal — some contexts may not support it
      }
      for await (const piece of ctx.getPieces()) {
        try {
          // Full metadata object
          const metadata = await this.warm.getPieceMetadata({
            dataSetId,
            pieceId: piece.pieceId,
          });

          // Size from PieceCID parsing (no RPC call)
          let size = 0;
          try {
            const parsed = Piece.from(piece.pieceCid);
            size = parsed.size;
          } catch {
            // CID might not be parseable as PieceCID
          }

          const pieceCid = piece.pieceCid?.toString() ?? "";
          const attributed = metadata?.attributedTo ?? null;

          items.push({
            pieceCid,
            pieceId: piece.pieceId.toString(),
            rootCid: metadata?.[METADATA_KEYS.IPFS_ROOT_CID] ?? null,
            dataSetId: dataSetId.toString(),
            provider,
            attributed: Boolean(attributed),
            size,
            metadata: metadata ?? {},
            pdpEndEpoch,
            isLive,
            dataSetMetadata,
            scheduledForRemoval: scheduledRemovals.includes(piece.pieceId),
          });
        } catch (e) {
          console.warn(`[storage] skip piece ${piece.pieceId} in dataset ${dataSetId}:`, e);
          continue;
        }
      }
    }

    // console.log("[storage] pieces:", items.length);
    return items;
  }

  /**
   * List pieces attributed to a given identity (publication address or author DID).
   * Checks the `attributedTo` metadata field (a JSON stringified array) and
   * returns only pieces whose owners includes `identity`.
   */
  async listStorageFor(identity: string): Promise<Array<{
    pieceCid: string | undefined;
    pieceId: bigint;
    rootCid: string | null;
    kind: string | null;
    owners: string[];
    dataSetId: string;
    provider: string | undefined;
  }>> {
    this.ensureInit();
    if (!this.warm) throw new Error("FilecoinStorage: warm storage service not initialised");
    const storage = this.synapse.storage as any;
    const dataSets = await this.findDataSets("root");
    const items: Array<{
      pieceCid: string | undefined;
      pieceId: bigint;
      rootCid: string | null;
      kind: string | null;
      owners: string[];
      dataSetId: string;
      provider: string | undefined;
    }> = [];

    for (const ds of dataSets) {
      const dataSetId = ds.dataSetId ?? (ds as any).id;
      if (!dataSetId) continue;

      let ctx;
      try {
        ctx = await storage.createContext({ dataSetId });
      } catch (e) {
        console.warn(`[storage] skip dataset ${dataSetId}: context resolve failed`, e);
        continue;
      }

      for await (const piece of ctx.getPieces()) {
        try {
          // Read attributedTo — JSON stringified array of owner addresses/DIDs
          const rawAttributed = await this.warm.getPieceMetadataByKey({
            dataSetId,
            pieceId: piece.pieceId,
            key: "attributedTo",
          });
          const owners: string[] = rawAttributed ? JSON.parse(rawAttributed) : [];
          if (!owners.includes(identity)) continue;

          // Optional — read kind and rootCid for the row display
          const kind = await this.warm.getPieceMetadataByKey({
            dataSetId,
            pieceId: piece.pieceId,
            key: "kind",
          });
          const rootCid = await this.warm.getPieceMetadataByKey({
            dataSetId,
            pieceId: piece.pieceId,
            key: METADATA_KEYS.IPFS_ROOT_CID,
          });

          items.push({
            pieceCid: piece.pieceCid?.toString(),
            pieceId: piece.pieceId,
            rootCid,
            kind,
            owners,
            dataSetId: dataSetId.toString(),
            provider: ds.providerId?.toString(),
          });
        } catch (e) {
          console.warn(`[storage] skip piece ${piece.pieceId} in ${dataSetId}:`, e);
          continue;
        }
      }
    }

    return items;
  }

  /**
   * Delete a piece from a dataset permanently.
   * Cannot be undone.
   */
  async deletePiece(dataSetId: bigint, pieceId: bigint): Promise<`0x${string}`> {
    this.ensureInit();
    const storage = this.synapse.storage as any;
    const ctx = await storage.createContext({ dataSetId });
    return await ctx.deletePiece({ piece: pieceId });
  }

  /**
   * Query Filecoin for all datasets attached to the account
   * @returns Array of dataset info objects
   */
   async findDataSets(which: "root" | "session" = "root"): Promise<any[]> {
    this.ensureInit();
    const address = which === "session" ? this.sessionAddress : this.walletAddress;
    if (!address) throw new Error(`findDataSets: no ${which} address available`);
    const storage = this.synapse.storage as any;
    return await storage.findDataSets({ address });
  }

  /**
   * Get storage pricing info — cost per TiB/month, providers, etc.
   */
  async getStorageInfo(): Promise<StorageInfo> {
    this.ensureInit();
    return await (this.synapse.storage as any).getStorageInfo();
  }

  /**
   * List all datasets for the current wallet with piece counts and metadata.
   */
  async getPublicationDataSets(): Promise<Array<{
    dataSetId: string;
    provider: string;
    pieceCount: number;
    pdpEndEpoch: bigint | null;
    isLive: boolean;
    metadata: Record<string, string>;
  }>> {
    this.ensureInit();
    const storage = this.synapse.storage as any;
    const dataSets = await this.findDataSets("root");
    const result: Array<{
      dataSetId: string;
      provider: string;
      pieceCount: number;
      pdpEndEpoch: bigint | null;
      isLive: boolean;
      metadata: Record<string, string>;
    }> = [];

    for (const ds of dataSets) {
      const dataSetId = ds.dataSetId ?? (ds as any).id;
      if (!dataSetId) continue;

      let ctx;
      try {
        ctx = await storage.createContext({ dataSetId });
      } catch (e) {
        console.warn(`[storage] skip dataset ${dataSetId}: context resolve failed`, e);
        continue;
      }

      // Count pieces in this dataset
      let pieceCount = 0;
      try {
        for await (const _ of ctx.getPieces()) {
          pieceCount++;
        }
      } catch (e) {
        console.warn(`[storage] failed to count pieces in dataset ${dataSetId}:`, e);
      }

      result.push({
        dataSetId: dataSetId.toString(),
        provider: ds.providerId?.toString() ?? "unknown",
        pieceCount,
        pdpEndEpoch: ds.pdpEndEpoch ?? null,
        isLive: ds.isLive ?? false,
        metadata: ds.metadata ?? {},
      });
    }

    return result;
  }

  /**
   * Terminate a dataset's service. After termination the provider stops
   * proving for this dataset and pdpEndEpoch becomes non-zero.
   *
   * @param dataSetId - The dataset to terminate
   * @param onSubmitted - Optional callback fired when the tx is submitted
   * @returns The termination result including serviceTerminationEpoch
   */
  async terminateDataSet(
    dataSetId: bigint,
    onSubmitted?: (txHash: `0x${string}`) => void,
  ): Promise<{ serviceTerminationEpoch: bigint | null; txHash: `0x${string}` }> {
    this.ensureInit();
    const storage = this.synapse.storage as any;
    const result = await storage.terminateService({
      dataSetId,
      onSubmitted: onSubmitted
        ? (tx: any) => onSubmitted(tx.hash ?? tx.transactionHash ?? tx)
        : undefined,
    });
    return {
      serviceTerminationEpoch: result.serviceTerminationEpoch ?? null,
      txHash: result.txHash ?? result.hash ?? "0x",
    };
  }

  /**
   * Estimate monthly recurring cost across one or more datasets, based on
   * the published Filecoin Onchain Cloud pricing.
   *
   * Storage cost:   $2.50 / TiB / month  (charged per copy per piece)
   * Proving fee:    $0.024 / dataset / month
   *
   * Pass an empty or nullish array for a single-dataset estimate from raw bytes.
   */
  static estimateMonthlyCost(bytes: bigint | number, datasetCount: number): { storage: number; proving: number; total: number } {
    const TIB = 1024 ** 4; // 1,099,511,627,776
    const STORAGE_PRICE_PER_TIB = 2.5;
    const PROVING_FEE = 0.024;

    const tiB = Number(bytes) / TIB;
    const storage = tiB * STORAGE_PRICE_PER_TIB;
    const proving = datasetCount * PROVING_FEE;

    return {
      storage: Math.round(storage * 10000) / 10000,
      proving: Math.round(proving * 10000) / 10000,
      total: Math.round((storage + proving) * 10000) / 10000,
    };
  }

  /**
   * Same as estimateMonthlyCost but reads total bytes from the pieces data.
   * Pass the list of pieces returned by listPublicationStorage.
   */
  static estimateMonthlyCostFromPieces(
    pieces: Array<{ size: number; dataSetId: string }>,
  ): { storage: number; proving: number; total: number; totalBytes: number; datasetCount: number } {
    const totalBytes = pieces.reduce((s, p) => s + p.size, 0);
    const datasetCount = new Set(pieces.map(p => p.dataSetId)).size;
    const cost = FilecoinStorage.estimateMonthlyCost(totalBytes, datasetCount);
    return { ...cost, totalBytes, datasetCount };
  }

  private buildPieceMetadata(owners: string[], kind: string): Record<string, string> {
    return {
      attributedTo: JSON.stringify(owners.filter(Boolean)),
      ...(kind ? { kind } : {}),
    };
  }

  /**
   * Upload CAR bytes to Filecoin, retrying in pairs of browser-usable
   * providers until at least two copies are committed. Failed providers
   * (from a thrown StoreError's `providerId`, or from the SDK result's
   * `failedAttempts`) are excluded from subsequent pairs. Throws
   * {@link FilecoinMinCopiesError} if the pool is exhausted first.
   *
   * The success-path result shape is unchanged from the previous single-shot
   * upload — existing callers keep working.
   */
  private async uploadCarWithMinCopies(
    carBytes: Uint8Array,
    rootCid: string,
    pieceMetadata: Record<string, string>,
  ): Promise<FilecoinUploadResult> {
    const mapResult = (result: SynapseUploadResult): FilecoinUploadResult => ({
      rootCid,
      pieceCid: result.pieceCid.toString(),
      size: result.size,
      complete: result.complete,
      copyCount: result.copies?.length ?? 0,
      failedCount: result.failedAttempts?.length ?? 0,
      copies: (result.copies ?? []).map((c) => ({
        provider: c.providerId?.toString() ?? "unknown",
        dealId: c.dataSetId?.toString(),
      })),
    });

    return uploadWithMinCopies(BROWSER_USABLE_PROVIDERS, 2, async (pair) => {
      try {
        const result = await uploadToSynapse(
          this.synapse,
          carBytes,
          rootCid as any, // uploadToSynapse expects CID type from multiformats
          noopLogger as any,
          {
            providerIds: pair,
            copies: pair.length,
            pieceMetadata,
          },
        );
        const failedProviders = (result.failedAttempts ?? [])
          .map((f) => toProviderBigInt(f.providerId))
          .filter((v): v is bigint => v !== undefined);
        return { complete: result.complete, failedProviders, result: mapResult(result) };
      } catch (e) {
        // Primary-store failure — the SDK throws StoreError with the failing
        // provider's ID. Exclude it so the next pair skips it.
        const failedProviders: bigint[] = [];
        const pid = toProviderBigInt((e as { providerId?: unknown })?.providerId);
        if (pid !== undefined) failedProviders.push(pid);
        return { complete: false, failedProviders };
      }
    });
  }

  private ensureInit(): void {
    if (!this.initialized) throw new Error("FilecoinStorage not initialised — call .init() or .initWithSessionKey() first");
  }
}
