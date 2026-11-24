// ============================================================================
// Gate reads over viem — the CLI half of shared's gate predicates.
//
// Shared's gates take the EVM interface as an injected `GateRead` /
// `GateValueRead`; this file is the binding. The CLI has no ethers, so it reads
// view functions through the viem client the rest of the CLI already uses.
//
// `read` answers a boolean because the gates combine booleans; `readValue`
// answers whatever the contract decoded to, because module resolution narrows
// addresses and tuples itself.
// ============================================================================

import type { GateRead, GateValueRead } from '@s2s/soul2soul-shared/gates';

/**
 * One view call, as the caller's client implements it. The ABI is
 * human-readable (`['function canPreview(...) view returns (bool)']`), which
 * viem accepts alongside a JSON ABI.
 */
export type GateView = (
  target: string,
  abi: string[],
  fn: string,
  args: unknown[],
) => Promise<unknown>;

export interface GateReads {
  read: GateRead;
  readValue: GateValueRead;
}

/** Bind the two gate read shapes to one view-call function. */
export function createGateReads(view: GateView): GateReads {
  return {
    read: async (target, abi, fn, args) => (await view(target, abi, fn, args)) === true,
    readValue: (target, abi, fn, args) => view(target, abi, fn, args),
  };
}
