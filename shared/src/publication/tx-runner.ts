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
