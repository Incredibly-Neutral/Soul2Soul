/**
 * Shared publication-helper surface (Track 2, RFC A).
 *
 * Used by BOTH the dev render action (`render-dev/main.ts`) and the production
 * render action (`render/main.ts`). Kept PURE — no chain, no gateway, no fetch —
 * so every function here is unit-testable without a network/chain mock.
 *
 * Contract: a publication-supplied helper module is a bare pure JS expression
 * that evaluates to a `{ name: function }` object of PURE functions, mirroring
 * the built-in `helpers` contract from `renderer/handlebars-helpers`
 * (`[{ name, helper }, …]` collapsed to `{ [name]: helper }`).
 */
import { extendHelperMap, getBuiltinHelperNames } from './handlebars.factory';

/**
 * Optional config-side field on `S2SPublicationConfig` carrying the CID of a
 * publication-supplied helper module. camelCase, matching `assetsCid` /
 * `templateCid`. This is the SOLE source for publication helpers at render
 * time — there is no on-chain record fallback (the helper CID is captured into
 * the config by the safe-app `ConfigBuilder` at build time).
 */
export const TEMPLATE_HELPERS_CONFIG_FIELD = 'helpersCid';

/**
 * Upper bound on the helper source size in characters. A helper module is a
 * single in-process pure-expression file evaluated at render time; capping it
 * keeps the eval surface small and bounded. 64 KiB is generous for a set of
 * hand-written pure functions.
 */
export const TEMPLATE_HELPERS_SOURCE_SIZE_CAP = 64 * 1024;

/**
 * Evaluate a `helpersSource` JS expression that yields a `{ name: fn }` module
 * of PURE functions. Evaluated in-process only (no runner globals/ethers —
 * this is the bare pure-expression contract, NOT the runner's `main()`
 * contract).
 */
export const evaluateHelpersSource = (source: string): Record<string, Function> => {
  // The source is an object/expression, e.g. `({ reverse: (s) => ... })`.
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${source});`);
  return fn() as Record<string, Function>;
};

/**
 * Validate a helper source before it is merged. Enforces:
 *  - non-empty string;
 *  - source-size cap;
 *  - evaluates to a plain object (not array / null / primitive);
 *  - every entry is a function.
 *
 * Throws on any violation. The caller decides how loudly to surface the error
 * (production fails the render loudly; it must never silently render without
 * a broken helper).
 */
export const validateHelpersSource = (source: string): Record<string, Function> => {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('helpers source is empty');
  }
  if (source.length > TEMPLATE_HELPERS_SOURCE_SIZE_CAP) {
    throw new Error(
      `helpers source exceeds size cap ` +
        `(${source.length} > ${TEMPLATE_HELPERS_SOURCE_SIZE_CAP})`,
    );
  }
  const mod = evaluateHelpersSource(source);
  if (mod === null || typeof mod !== 'object' || Array.isArray(mod)) {
    throw new Error('helpers module must evaluate to a plain object of functions');
  }
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== 'function') {
      throw new Error(`helper '${name}' must be a function (got ${typeof fn})`);
    }
  }
  return mod;
};

/**
 * Merge publication helpers into the shared helper map, applying the
 * name-collision policy: BUILT-INS WIN.
 *
 * A publication helper whose name collides with a built-in is SKIPPED (not
 * merged), so a publication can never shadow or override a built-in. Returns a
 * summary for audit-logging.
 */
export const mergePublicationHelpers = (
  publicationHelpers: Record<string, Function>,
): { merged: number; skipped: string[] } => {
  const builtin = getBuiltinHelperNames();
  const toMerge: Record<string, Function> = {};
  const skipped: string[] = [];
  for (const [name, fn] of Object.entries(publicationHelpers)) {
    if (builtin.has(name)) {
      skipped.push(name); // built-ins win
      continue;
    }
    if (typeof fn === 'function') toMerge[name] = fn;
  }
  extendHelperMap(toMerge);
  return { merged: Object.keys(toMerge).length, skipped };
};
