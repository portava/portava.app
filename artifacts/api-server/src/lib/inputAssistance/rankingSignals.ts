/**
 * §15 ranking signals that had no producer (Phase 9).
 *
 * §15 names the signals a suggestion's confidence is supposed to combine:
 * ExactMatch, PrefixMatch, GeographicFit, TemporalFit, RecencyOfUse,
 * TrustConfidence, PrivacyRisk, SpamRisk. Three of those were already computed
 * elsewhere — ExactMatch/PrefixMatch by `matchTier` (`routes/discoverySearchHelpers.ts`),
 * GeographicFit by the city boost in `rankCombined`, RecencyOfUse by
 * `applyPriorSelectionBoost` (`personalization.ts`). Two of the remaining five
 * had NO producer anywhere in the layer:
 *
 *   TemporalFit    — `semanticParser.extractTemporal` computed a real ISO window
 *                    and the window was projected into a search STRING and then
 *                    thrown away. Nothing ranked on it.
 *   TrustConfidence — `searchTravelers` selects `verified` and `is_official`,
 *                    and the projection whitelist dropped both. Nothing read
 *                    them into `confidence`, and no suggestion could carry them.
 *
 * This module is the producer for those two. It is PURE (no Supabase, no
 * network, no clock beyond the ISO strings handed to it) so each term is
 * unit-testable and mutation-testable on its own.
 *
 * ── WHY A RANKING TERM AND NOT A QUERY FILTER ────────────────────────────────
 *
 * The obvious alternative was to push the parsed window into
 * `SearchQueryContext.startsAfter/startsBefore`, which `discoverySearch`
 * already honours as a HARD filter on events (`routes/discoverySearch.ts:714`)
 * and trips (`:885`). That was measured and rejected: the input-assistance
 * parser is far broader than the one `/discovery/search` uses. Its
 * `extractTemporal` fires on every weekday name, so "Saturday Night Market" and
 * "Friday Harbor" would parse as time intents and the hard filter would DELETE
 * the very rows the user typed the name of. A ranking term cannot delete a row:
 * a place, a city or a user carries no `startsAt` at all and scores exactly
 * `NEUTRAL`, so a false-positive parse costs nothing.
 *
 * ── THE CEILING ON BOTH TERMS ────────────────────────────────────────────────
 *
 * Neither term may lift a row to or past the exact-match band
 * (`tierConfidence(3)`), because §9's trust order says a canonical exact match
 * leads. Both are therefore clamped by {@link SIGNAL_CEILING} and both are
 * monotone-non-decreasing on their input: `applyTrustConfidence` and
 * `applyTemporalFit` never return LESS than the base for a row they do not
 * apply to, so an unranked row is byte-identical to its pre-Phase-9 value.
 */

/** A normalized UTC window, exactly the shape `TemporalIntent` carries. */
export interface TemporalWindow {
  /** ISO 8601 UTC lower bound, or null when unbounded. */
  startsAfter: string | null;
  /** ISO 8601 UTC upper bound (exclusive), or null when unbounded. */
  startsBefore: string | null;
}

/**
 * The highest confidence any §15 signal here may produce. Strictly below
 * `tierConfidence(3)` (0.99, the exact-match band in `projection.ts`) so a
 * boosted row can never tie or beat a canonical exact match (§9).
 */
export const SIGNAL_CEILING = 0.98;

/** TemporalFit: a row that starts inside the parsed window. */
export const TEMPORAL_FIT_BOOST = 0.06;
/** TemporalFit: a row that carries a start time and falls OUTSIDE the window. */
export const TEMPORAL_MISS_PENALTY = 0.08;
/** TrustConfidence: a verified traveler/buddy. */
export const TRUST_VERIFIED_BOOST = 0.03;
/** TrustConfidence: an @Portava Official account. */
export const TRUST_OFFICIAL_BOOST = 0.05;

/**
 * TemporalFit as a three-valued classification (§15).
 *
 * `'fit'`    — the row starts inside the window.
 * `'miss'`   — the row HAS a start time and it is outside the window.
 * `'neutral'`— there is no window, or the row has no start time at all. A
 *              place/city/user is always neutral: a time signal must not
 *              demote a row that has no time dimension.
 */
export function temporalFit(
  startsAt: string | null | undefined,
  window: TemporalWindow | null | undefined,
): 'fit' | 'miss' | 'neutral' {
  if (!window) return 'neutral';
  if (window.startsAfter === null && window.startsBefore === null) return 'neutral';
  if (typeof startsAt !== 'string' || startsAt.length === 0) return 'neutral';
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t)) return 'neutral';
  if (window.startsAfter !== null) {
    const lo = Date.parse(window.startsAfter);
    if (Number.isFinite(lo) && t < lo) return 'miss';
  }
  if (window.startsBefore !== null) {
    const hi = Date.parse(window.startsBefore);
    if (Number.isFinite(hi) && t >= hi) return 'miss';
  }
  return 'fit';
}

/**
 * Apply TemporalFit to a base confidence. A `fit` is boosted (clamped by
 * {@link SIGNAL_CEILING} and never below the base), a `miss` is demoted but
 * never below zero, and `neutral` returns the base unchanged.
 */
export function applyTemporalFit(
  base: number,
  startsAt: string | null | undefined,
  window: TemporalWindow | null | undefined,
): number {
  switch (temporalFit(startsAt, window)) {
    case 'fit':
      return Math.max(base, Math.min(base + TEMPORAL_FIT_BOOST, SIGNAL_CEILING));
    case 'miss':
      return Math.max(0, base - TEMPORAL_MISS_PENALTY);
    default:
      return base;
  }
}

/** TrustConfidence as an additive weight (§15). 0 when the row carries neither flag. */
export function trustConfidence(verified?: boolean, isOfficial?: boolean): number {
  return (verified === true ? TRUST_VERIFIED_BOOST : 0) + (isOfficial === true ? TRUST_OFFICIAL_BOOST : 0);
}

/**
 * Apply TrustConfidence to a base confidence. Clamped by {@link SIGNAL_CEILING}
 * and never below the base — an unverified row is byte-identical to its
 * pre-Phase-9 confidence, and a verified exact match (already 0.99) is NOT
 * pulled down to the ceiling.
 */
export function applyTrustConfidence(base: number, verified?: boolean, isOfficial?: boolean): number {
  const w = trustConfidence(verified, isOfficial);
  if (w === 0) return base;
  return Math.max(base, Math.min(base + w, SIGNAL_CEILING));
}

/**
 * §24/§29 Hidden Gem protection label.
 *
 * `gemSearchPosition` already decides whether a gem may carry an approximate
 * centroid at all, and writes the answer into `metadata.coordsPrecision`
 * ("approximate" | "hidden"). The projection dropped the whole metadata bag, so
 * a protected gem — one whose sensitivity level denies placement — rendered
 * identically to an unprotected one in a suggestion row.
 *
 * This reads that ALREADY-PUBLIC vocabulary (the map surface badges "approx.
 * location" off the same value) into a display-safe enum. It never reads,
 * derives or approximates a coordinate: the input is a precision word, not a
 * position, and `'exact'` is deliberately not in the return type because the
 * gem search path never emits it.
 */
export function gemLocationPrecision(
  metadata: Record<string, unknown> | null | undefined,
): 'approximate' | 'hidden' | undefined {
  const p = metadata?.coordsPrecision;
  return p === 'approximate' || p === 'hidden' ? p : undefined;
}
