/**
 * neutralpress TxRunner adapter — wraps oxo-core's safeInstance (PermissionlessSafeService)
 * as a shared TxRunner. The PermissionlessSafeService already matches TxRunner's shape;
 * this adapter provides type-safety and any arg-shape reconciliations needed.
 */

import type { TxRunner } from "@s2s/soul2soul-shared";

const L1 = "ETH_MAINNET";
const L2 = "BASE";

/**
 * Build a TxRunner from oxo-core's safeInstance for the given chain.
 * safeInstance returns a PermissionlessSafeService which already
 * implements every TxRunner method with compatible signatures.
 */
export function createTxRunner(oxo: any, chain: string): TxRunner {
  const service = oxo.ctrlr.safeInstance(chain);
  return service as unknown as TxRunner;
}

/** Pre-built L1 runner for convenience. */
export function createL1Runner(oxo: any): TxRunner {
  return createTxRunner(oxo, L1);
}

/** Pre-built L2 runner for convenience. */
export function createL2Runner(oxo: any): TxRunner {
  return createTxRunner(oxo, L2);
}
