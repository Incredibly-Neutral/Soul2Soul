/**
 * The pre-check `deploy-publication-factory.ts` runs before it spends the
 * factory's deploy gas: does the implementation answer `factory()`?
 *
 * The factory's constructor and `setImplementation` both refuse an
 * implementation that does not (`ImplementationWithoutUpgradeGate`), but only
 * after the factory's deploy gas is spent. Asking first turns a bare revert
 * into a sentence.
 *
 * The implementation contract is compiled `viaIR` with no fallback and no
 * receive, so a call to a selector it does not have reverts on the dispatcher
 * rather than returning empty data. Both signals are failure: a revert means
 * the selector is absent, and so does an empty or short return. Only 32 bytes
 * of return data means the getter exists.
 */

import { toFunctionSelector } from 'viem';

/** `factory()` — the getter the V4 factory requires of every implementation it approves. */
export const UPGRADE_GATE_SELECTOR = toFunctionSelector('function factory() view returns (address)');

/** The minimum `0x`-prefixed length of one ABI-encoded word: 2 + 64 hex characters. */
const ONE_WORD = 66;

type Hex = `0x${string}`;

/** The minimum a caller needs: a `call` that resolves to `{data}` or rejects. */
export interface GateClient {
  call(args: { to: Hex; data: Hex }): Promise<{ data?: string } | undefined>;
}

/** Thrown when the implementation reverts on `factory()` — it has no such getter. */
export class MissingUpgradeGateError extends Error {
  constructor(
    readonly implementation: Hex,
    options?: { cause?: unknown },
  ) {
    super(`${implementation} does not answer factory()`, options);
    this.name = 'MissingUpgradeGateError';
  }
}

/**
 * True only when the implementation answers `factory()` with a full word.
 *
 * Throws `MissingUpgradeGateError` when the call itself reverts; returns false
 * when it succeeds without usable data. Both are refusals, kept apart so the
 * caller can say which happened.
 */
export async function hasUpgradeGate(client: GateClient, implementation: Hex): Promise<boolean> {
  let result;
  try {
    result = await client.call({ to: implementation, data: UPGRADE_GATE_SELECTOR });
  } catch (error) {
    throw new MissingUpgradeGateError(implementation, { cause: error });
  }
  const data = result?.data;
  return typeof data === 'string' && data.length >= ONE_WORD;
}
