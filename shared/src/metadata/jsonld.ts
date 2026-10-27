// ============================================================================
// JSON-LD schema shape helpers shared by the renderer and the verifier.
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively drop object keys whose value is `undefined`.
 *
 * This matters because the two serialisers disagree: `JSON.stringify` DROPS an
 * undefined-valued key, while JCS (RFC 8785) has no `undefined` type and THROWS.
 * A caller that leaves an optional field undefined at runtime (types across the
 * Lit Action boundary are advisory) therefore made signing throw, the renderer's
 * outer catch swallowed it, and the page shipped with no JSON-LD block at all —
 * after which the update gate could only ever answer "No JSON-LD schema found",
 * so the page could never be updated again.
 *
 * Stripping first makes the signed bytes identical to the emitted bytes (which
 * is what `JSON.stringify` would have written anyway) instead of losing the
 * whole provenance block.
 *
 * Arrays keep their length and order; only object keys are dropped.
 */
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    const mapped: unknown[] = value.map((entry: unknown) => stripUndefinedDeep(entry));
    return mapped as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = stripUndefinedDeep(entry);
    }
    return out as T;
  }
  return value;
}

/**
 * True when a schema carries terms introduced by specVersion "1": the
 * `sdContent` node or the nested `author.proof` attestation.
 *
 * Signing those under the legacy canonicaliser would be worse than useless:
 * the legacy scheme is a recursive key whitelist, so it would sign a skeleton
 * of the new nodes and silently bless whatever the attacker put inside them.
 * The verifier uses this to fail closed instead of downgrading.
 */
export function hasSpecV1Terms(schemaWithoutProof: unknown): boolean {
  if (!isPlainObject(schemaWithoutProof)) return false;
  if (schemaWithoutProof.sdContent !== undefined) return true;
  const author = schemaWithoutProof.author;
  return isPlainObject(author) && author.proof !== undefined;
}
