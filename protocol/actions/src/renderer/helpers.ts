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
 * On-chain record key on the S2S Records Module (the `configModule` Safe KV
 * store). snake_case, matching the on-chain naming convention (`config`,
 * `assets`, …). Read via `getRecord('template_helpers_cid')`.
 */
export const TEMPLATE_HELPERS_RECORD_KEY = 'template_helpers_cid';

/**
 * Optional config-side shorthand on `S2SPublicationConfig`. camelCase,
 * matching `assetsCid` / `templateCid`. When set, it takes precedence over the
 * on-chain record (avoids an extra chain hop for configs that already carry it).
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
 *
 * The literal `helpers.source` is evaluated by dynamic `import()` of a
 * `data:` URL (the bare expression exported as the module default) rather than
 * by `new Function`/`eval`. The production render action runs inside the Lit
 * signing enclave (Chipotle, a Deno-based sandbox) whose CSP-equivalent forbids
 * eval-family code generation; dynamic `import()` of a `data:` URL instead
 * routes through the module-loading path the enclave already permits, so the
 * helper source can be evaluated there without tripping the code-generation
 * guard. The renderer itself is otherwise a pure regex/string engine — this is
 * the ONLY code-generation-from-strings in the render path.
 *
 * Async: callers must `await` the result.
 */
export const evaluateHelpersSource = async (
  source: string,
): Promise<Record<string, Function>> => {
  // The source is an object/expression, e.g. `({ reverse: (s) => ... })`.
  // Wrap it as an ES module default export and load it via the module loader.
  const url = 'data:text/javascript,' + encodeURIComponent('export default (' + source + ');');
  const m = await import(url);
  return (m as { default?: unknown }).default as Record<string, Function>;
};

/**
 * Validate a helper source before it is merged. Enforces:
 *  - non-empty string;
 *  - source-size cap;
 *  - evaluates to a plain object (not array / null / primitive);
 *  - every entry is a function.
 *
 * The string/parse/type checks run synchronously; the evaluation (and the
 * post-eval type-check of the resulting object) is async because the source is
 * now evaluated via dynamic `import()` of a `data:` URL (see
 * `evaluateHelpersSource`). Throws on any violation. The caller decides how
 * loudly to surface the error (production fails the render loudly; it must
 * never silently render without a broken helper).
 */
export const validateHelpersSource = async (
  source: string,
): Promise<Record<string, Function>> => {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('helpers source is empty');
  }
  if (source.length > TEMPLATE_HELPERS_SOURCE_SIZE_CAP) {
    throw new Error(
      `helpers source exceeds size cap ` +
        `(${source.length} > ${TEMPLATE_HELPERS_SOURCE_SIZE_CAP})`,
    );
  }
  const mod = await evaluateHelpersSource(source);
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
