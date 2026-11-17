// ============================================================================
// Module identity — the one place that decides whether a Safe module's `NAME()`
// is a publication module.
//
// Two shapes are live, because a publication served by an older build still
// answers reads and author writes:
//
//   "S2S Publication Module"         the name this build answers, and V1's
//   "S2S Publication Module V<n>"    the older builds, V2 through V6
//
// Comparing against one literal made every other version invisible, so a
// publication on an older implementation lost its module (and with it every
// read and author write). Discovery asks this predicate instead, and the
// suffix stays open-ended: the next name needs no edit here.
//
// A name says what a module is; `VERSION()` says which build it is. So the
// name carries no version any more, nothing derives a surface from the string,
// and a new build never renames anything. The versioned names below only match
// modules that were deployed under them.
//
// The records module keeps its own exact name and is not matched by this.
// ============================================================================

/**
 * A publication module's `NAME()`: `S2S Publication Module`, optionally
 * followed by ` V<n>` on the builds that were deployed with one.
 *
 * Anchored at both ends so the factories (no `NAME()` at all) and any future
 * `S2S Publication Module V2 Factory` cannot match.
 */
const PUBLICATION_MODULE_NAME = /^S2S Publication Module(?: V[0-9]+)?$/;

/** True iff `name` is a publication module's `NAME()`, at any version. */
export const isPublicationModuleName = (name: string | undefined | null): boolean =>
  typeof name === 'string' && PUBLICATION_MODULE_NAME.test(name);
