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

import { Synapse, mainnet, calibration, TOKENS } from "@filoz/synapse-sdk";
import * as SessionKey from "@filoz/synapse-core/session-key";
import { privateKeyToAccount } from "viem/accounts";
import { formatUnits, http, createWalletClient, custom } from "viem";
import type { Hex } from "viem";
import { uploadToSynapse } from "filecoin-pin/core/upload";

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
  info: (...args: any[]) => console.log("[filecoin]", ...args),
  warn: (...args: any[]) => console.warn("[filecoin]", ...args),
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

export class FilecoinStorage {
  private main: FilecoinUser;
  private synapse: any;
  private builder: FilecoinCarBuilder | null = null;
  private initialized = false;
  private usingSessionKey = false;

  constructor(main: FilecoinUser, builder?: FilecoinCarBuilder) {
    this.main = main;
    this.builder = builder ?? null;
  }

  async init(chain: "mainnet" | "calibration" = "mainnet"): Promise<void> {
    if (this.initialized) return;
    const pk = this.main.user?.private_key;
    if (!pk) throw new Error("FilecoinStorage.init: no active user with a private key");
    const chainConfig = chain === "mainnet" ? mainnet : calibration;
    this.synapse = Synapse.create({
      account: privateKeyToAccount(pk as Hex),
      source: "oxo-core",
      chain: chainConfig,
    });
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
      sessionClient: sessionKey.client,
      source: "oxo-core",
    });
    this.initialized = true;
    this.usingSessionKey = true;
    console.log("[filecoin] Initialised with session key → root:", skData.rootAddress);
  }

  // ── Upload / download ──────────────────────────────────────────

  /**
   * Upload JSON to Filecoin. Builds a CAR (unixfs-v1-2025 profile),
   * gets the Root CID (IPFS-compatible), uploads to Filecoin SPs,
   * and returns both the Root CID and PieceCID.
   */
  async uploadJson(data: unknown): Promise<FilecoinUploadResult> {
    this.ensureInit();
    if (!this.builder) throw new Error("FilecoinStorage: no CAR builder configured");

    const json = JSON.stringify(data, null, 2);
    const bytes = new TextEncoder().encode(json);

    // 1. Build CAR → get Root CID
    const { rootCid, carBytes } = await this.builder.buildCarFromBytes(bytes);

    // 2. Upload the CAR to Filecoin SPs via filecoin-pin's uploader
    //    (which calls Synapse internally and attaches rootCid as piece metadata)
    const result = await uploadToSynapse(
      this.synapse,
      carBytes,
      rootCid as any,   // uploadToSynapse expects CID type from multiformats
      noopLogger as any,
      { excludeProviderIds: [7n, 5n] },  // infrafolio-mainnet-pdp: only accepts HTTP/1.1, ALPN handshake fails
    );
    return {
      rootCid,
      pieceCid: result.pieceCid.toString(),
      size: result.size,
      complete: result.complete,
      copyCount: result.copies?.length ?? 0,
      failedCount: result.failedAttempts?.length ?? 0,
      copies:
        result.copies?.map((c: any) => ({
          provider: c.providerId?.toString() ?? "unknown",
          dealId: c.dataSetId?.toString(),
        })) ?? [],
    };
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

  // ── Internals ───────────────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) throw new Error("FilecoinStorage not initialised — call .init() or .initWithSessionKey() first");
  }
}
