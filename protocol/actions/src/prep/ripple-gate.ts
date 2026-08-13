import { S2SBody, S2SRipple } from '@s2s/soul2soul-shared/lit-actions';

/**
 * Trigger-side gate for a ripple: decides whether the ripple FIRES at all for
 * the given triggering body, independent of which destination the ripple would
 * render.
 *
 * A ripple fires only if BOTH hold:
 *   1. `ripple.origins` includes `body.postType` (the pre-existing origin filter),
 *   2. every predicate in `ripple.trigger_filters` matches the body.
 *
 * `trigger_filters` is a list of predicate objects `{ key: value }` — a ripple
 * fires only if, for every predicate, `body[key] === value` for every key/value
 * pair in that predicate. Predicates are matched against the canonical signed
 * fields on the body (e.g. `locale`); production bodies carry `locale` and NO
 * `language` key. An absent or empty `trigger_filters` array preserves today's
 * behaviour (the ripple fires purely on `origins` match). `filters` is
 * destination-side (which destination content renders) and is untouched here.
 *
 * The caller applies this gate BEFORE it builds the destination render job, so
 * it gates both the genesis and non-genesis destination branches.
 */
export const rippleFiresForBody = (ripple: S2SRipple, body: S2SBody): boolean => {
  if (!ripple.origins.includes(body.postType)) return false;

  const triggerFilters = ripple.trigger_filters;
  if (!triggerFilters || triggerFilters.length === 0) return true;

  return triggerFilters.every((predicate) =>
    Object.entries(predicate).every(
      ([key, value]) => (body as unknown as Record<string, unknown>)[key] === value,
    ),
  );
};
