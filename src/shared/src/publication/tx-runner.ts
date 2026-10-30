/**
 * TxRunner — the abstraction boundary between publication orchestration and
 * chain execution. Implementations: PermissionlessSafeService (neutralpress,
 * smart-account), SafeAppsSDK (safe-app, propose-to-queue).
 *
 * // TODO(safe-app): revisit lifecycle — safe-app's Safe already exists;
 * // updateSigner / connectToFreshSafe may become no-ops.
 */

export interface TxCall {
  address: `0x${string}`;
  abi: string; // JSON.stringify'd ABI
  method: string;
  args: any[];
  deploy?: boolean;
}

export interface TxRunner {
  // --- signer / connection lifecycle ---
  updateSigner(pk: string): Promise<string>;
  connectToFreshSafe(salt: string): Promise<string>;
  connectToExistingSafe(safeAddress: `0x${string}`): Promise<string>;

  // --- core surface ---
  genericRead(
    address: `0x${string}`,
    abi: string,
    method: string,
    args: any[],
  ): Promise<any>;

  genericTx(
    address: `0x${string}`,
    abi: string,
    method: string,
    args: any[],
    deploy: boolean,
  ): Promise<string>;

  batchGenericTx(calls: TxCall[]): Promise<string[]>;
}

// =============================================================================
// oxo-core → TxRunner bridge
//
// Builds a TxRunner from a 0xobsidian controller's `safeInstance`
// (PermissionlessSafeService already implements every TxRunner method). The
// controller object is passed in — no imports, no plugin coupling — so any
// host with an oxo-style controller (neutralpress, smart-account) reuses this.
// =============================================================================

const CHAIN_L1 = "ETH_MAINNET";
const CHAIN_L2 = "BASE";

/** Build a TxRunner from oxo-core's safeInstance for the given chain. */
export function createTxRunner(oxo: any, chain: string): TxRunner {
  const service = oxo.ctrlr.safeInstance(chain);
  return service as unknown as TxRunner;
}

/** Pre-built L1 (ETH_MAINNET) runner for convenience. */
export function createL1Runner(oxo: any): TxRunner {
  return createTxRunner(oxo, CHAIN_L1);
}

/** Pre-built L2 (BASE) runner for convenience. */
export function createL2Runner(oxo: any): TxRunner {
  return createTxRunner(oxo, CHAIN_L2);
}
