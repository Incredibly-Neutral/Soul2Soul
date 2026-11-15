// ============================================================================
// Publication factories — what a module scan has to look at, and what a
// deterministic factory can answer without being scanned.
//
// A publication's module address is not a record, and the Safe only knows that
// the modules are enabled, not which factory deployed them. Two generations of
// factory answer the question differently:
//
//   S2SPublicationModuleV4Create2Factory deploys through CREATE2, so it knows
//   the address before it deploys it. `moduleAddress(safe)` is where
//   `createModule(safe, …)` under the latest implementation will land, and
//   `moduleAddressForVersion(safe, version)` is where it landed under the
//   implementation that was latest at `version` (1-based). `setImplementation`
//   moves the first and leaves the second alone, which is why old publications
//   answer at their own version.
//
//   S2SPublicationModuleFactory (V2, `PUBLICATION_FACTORY_V2`) deployed through
//   plain CREATE, so it cannot answer either call: the selector is absent and
//   the read reverts. Those modules are found by the Safe's `NAME()` scan, or by
//   the factory's own `ModuleCreated` log.
//
// `publication_factory` names one factory at a time. When it moves to a new
// implementation (V2 → V3), every publication created before the move has its
// log on the old factory only, so a scan of the record alone finds nothing and
// the flow proposes a second module pair for a publication that already has
// one. The factories below are the retired deployments still holding those
// logs; the scan unions them with the address from the record.
//
// This is a read list, not a migration: nothing is rewritten, no record field
// is added, and a scan that finds a module here adopts it exactly as if the
// record had pointed at that factory.
// ============================================================================

import type { Address, PublicClient } from 'viem';

/**
 * The V2 publication factory: `S2SPublicationModuleFactory`, the deployment that
 * created every publication that exists today.
 *
 * Its `ModuleCreated(address indexed safe, address indexed moduleProxy, address
 * implementation)` signature is shared with the V3 factory, so one topic0
 * matches logs from either generation. This constant is the one home for the
 * address: the settings default that still points at it imports it rather than
 * repeating the literal.
 */
export const PUBLICATION_FACTORY_V2 = '0xe948735151c43183accd8e85b992952b2711d554';

/**
 * Retired publication factories whose `ModuleCreated` logs still describe live
 * publications — read together with the factory in the protocol record, because
 * a factory can only answer for the modules it deployed.
 */
export const LEGACY_PUBLICATION_FACTORIES: readonly string[] = [PUBLICATION_FACTORY_V2];

/**
 * The three reads only a CREATE2 factory answers. Passed as an ABI to a
 * `PublicClient` here, and JSON-stringified by callers that read through a
 * `TxRunner`. A factory from the V2 generation has no such selectors, so every
 * one of these calls reverts on it; that revert is the signal to fall back.
 */
export const PUBLICATION_FACTORY_CREATE2_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'safe', type: 'address' }],
    name: 'moduleAddress',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'safe', type: 'address' },
      { internalType: 'uint256', name: 'version', type: 'uint256' },
    ],
    name: 'moduleAddressForVersion',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'implementationCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * The zero address, which a factory answers when it has no implementation to
 * name. It is not a publication module and never a prediction.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * How many implementations back a walk will go. A publication created under an
 * implementation older than this is found by the `NAME()` scan; the cap is what
 * makes a hostile or corrupt `implementationCount()` cost a bounded number of
 * reads instead of an unbounded loop.
 */
export const MAX_PUBLICATION_FACTORY_VERSIONS = 8;

/**
 * A usable address in a factory answer. The zero address is not one: a factory
 * that has not named an implementation returns it, and treating it as a
 * prediction would break `createModule`'s address check later.
 */
export const isPredictedModuleAddress = (value: unknown): value is Address =>
  typeof value === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(value) &&
  value.toLowerCase() !== ZERO_ADDRESS;

/**
 * The address a CREATE2 factory already deployed this Safe's publication module
 * to, or `undefined` when the factory cannot answer.
 *
 * `moduleAddress(safe)` is asked first, unconditionally: it is where a
 * publication created under the latest implementation sits, which is the common
 * case, and it costs one call whether or not the factory has rotated its
 * implementation.
 *
 * Older versions are only walked because `setImplementation` moves that answer,
 * leaving every older publication at its own version. That walk is bounded by
 * `MAX_PUBLICATION_FACTORY_VERSIONS`: `implementationCount()` reverts on a
 * V2-generation factory and is then the fallback signal, and a count above the
 * bound is walked only as far as the bound — `Math.min(count, 8) - 1` down to 1
 * — rather than refused, so a factory that has shipped more implementations than
 * this code knows about still answers for its latest publications.
 *
 * Proof of the answer depends on what the caller already knows:
 *   - `enabled` non-empty: the prediction has to be in the Safe's enabled-module
 *     list. A factory can name an address that was never deployed for this Safe,
 *     and only the Safe's own list proves it was.
 *   - `enabled` empty: the Safe listed no modules at all, so the only check left
 *     is that the predicted address has code.
 * A prediction with no proof is not an answer.
 */
export async function predictPublicationModule(
  l2: PublicClient,
  factory: Address,
  safe: Address,
  enabled: readonly Address[] = [],
): Promise<Address | undefined> {
  const enabledSet = new Set(enabled.map((address) => address.toLowerCase()));
  const membershipIsProof = enabledSet.size > 0;

  const proved = async (candidate: unknown): Promise<Address | undefined> => {
    if (!isPredictedModuleAddress(candidate)) return undefined;
    if (membershipIsProof) return enabledSet.has(candidate.toLowerCase()) ? candidate : undefined;
    try {
      const code = await l2.getCode({ address: candidate });
      return code && code !== '0x' ? candidate : undefined;
    } catch {
      // An unreadable code check is not a deployment.
      return undefined;
    }
  };

  const latest = await readModuleAddress(l2, factory, safe);
  const provedLatest = await proved(latest);
  if (provedLatest) return provedLatest;

  // Only now is the version list worth paying for: a factory that cannot state
  // its count has no older publications this code can name.
  let count: bigint;
  try {
    count = (await l2.readContract({
      address: factory,
      abi: PUBLICATION_FACTORY_CREATE2_ABI,
      functionName: 'implementationCount',
    })) as bigint;
  } catch {
    return undefined;
  }
  if (typeof count !== 'bigint' || count < 1n) return undefined;

  const oldestWalked = count < BigInt(MAX_PUBLICATION_FACTORY_VERSIONS)
    ? count
    : BigInt(MAX_PUBLICATION_FACTORY_VERSIONS);

  for (let version = oldestWalked - 1n; version >= 1n; version--) {
    const predicted = await readModuleAddressForVersion(l2, factory, safe, version);
    const provedVersion = await proved(predicted);
    if (provedVersion) return provedVersion;
  }

  return undefined;
}

/** `moduleAddress(safe)`, or `undefined` when the factory has no such selector. */
async function readModuleAddress(
  l2: PublicClient,
  factory: Address,
  safe: Address,
): Promise<unknown> {
  try {
    return await l2.readContract({
      address: factory,
      abi: PUBLICATION_FACTORY_CREATE2_ABI,
      functionName: 'moduleAddress',
      args: [safe],
    });
  } catch {
    return undefined;
  }
}

/** `moduleAddressForVersion(safe, version)`, or `undefined` when it reverts. */
async function readModuleAddressForVersion(
  l2: PublicClient,
  factory: Address,
  safe: Address,
  version: bigint,
): Promise<unknown> {
  try {
    return await l2.readContract({
      address: factory,
      abi: PUBLICATION_FACTORY_CREATE2_ABI,
      functionName: 'moduleAddressForVersion',
      args: [safe, version],
    });
  } catch {
    // `InvalidVersion`: the factory never named an implementation for it.
    return undefined;
  }
}
