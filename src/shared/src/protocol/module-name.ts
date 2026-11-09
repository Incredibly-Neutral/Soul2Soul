// ============================================================================
// Module identity — the one place that decides whether a Safe module's `NAME()`
// is a publication module.
//
// The live implementations answer three different strings for the same role:
//
//   "S2S Publication Module"      V1, still serving publications
//   "S2S Publication Module V2"
//   "S2S Publication Module V3"
//
// Comparing against one literal made every other version invisible, so a
// publication on an older implementation lost its module (and with it every
// read and author write). Discovery asks this predicate instead, and the
// version suffix stays open-ended: V4 needs no edit here.
//
// The records module keeps its own exact name and is not matched by this.
// ============================================================================

/**
 * A publication module's `NAME()`:
 * `S2S Publication Module`, optionally followed by ` V<digits>`.
 *
 * Anchored at both ends so the factories (no `NAME()` at all) and any future
 * `S2S Publication Module V2 Factory` cannot match.
 */
const PUBLICATION_MODULE_NAME = /^S2S Publication Module(?: V[0-9]+)?$/;

/** True iff `name` is a publication module's `NAME()`, at any version. */
export const isPublicationModuleName = (name: string | undefined | null): boolean =>
  typeof name === 'string' && PUBLICATION_MODULE_NAME.test(name);
