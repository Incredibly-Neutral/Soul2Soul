// ============================================================================
// ethers v5 `utils`, taken from the AMBIENT global — never a static import.
//
// Everything in this directory is bundled into the Lit Actions
// (press/actions/build-actions.cjs), which marks `ethers` external. A
// `import { utils } from 'ethers'` therefore compiles to a top-level
// `__require("ethers")`, and the action isolate has no `require` — the whole
// bundle dies at load with
//
//   Dynamic require of "ethers" is not supported
//
// returned by the node as a bare `{error}` body, before a single line of the
// action runs. The global is not missing: the Lit runtime injects ethers v5 as
// `ethers` (that is the API these modules are written against — `utils`,
// `utils._TypedDataEncoder`), and contract-id.ts has always relied on it.
//
// Node callers (CLI, tests) have no ambient ethers, so they publish it once:
//   - CLI: shared/src/rendering/sequence.ts sets `globalThis.ethers` on import
//   - tests: vitest.setup.ts
// ============================================================================

/** ethers v5 `utils` from `globalThis.ethers`. Throws if nobody published it. */
export function ethersUtils(): any {
  const ambient = (globalThis as { ethers?: { utils?: unknown } }).ethers;
  if (ambient?.utils) return ambient.utils;
  throw new Error(
    'ethers.utils is not available: a Lit Action gets `ethers` as a runtime global, ' +
      'a Node caller must publish it once (see shared/src/rendering/sequence.ts)',
  );
}
