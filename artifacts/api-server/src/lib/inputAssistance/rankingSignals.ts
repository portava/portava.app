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

// ─────────────────────────────────────────────────────────────────────────────
// §15 SpamRisk — the third signal that had no producer
// ─────────────────────────────────────────────────────────────────────────────
//
// §15 names SpamRisk and §36 asks for keyword-stuffing resistance in business /
// Buddy / user descriptions. Neither had any implementation: no term-frequency,
// repetition or stuffing heuristic existed anywhere in the layer or in the
// searchers it calls, so a listing that repeated "bangkok tour bangkok tour
// bangkok tour" ranked exactly like one that said it once.
//
// This is a DEMOTION-ONLY term, deliberately. Stuffing is a ranking problem, not
// a moderation verdict: a row is never deleted here, because a false positive
// that deletes a real venue is far worse than one that costs it two slots, and
// this layer has neither the evidence nor the mandate to remove a listing.

/** Maximum confidence a maximally-stuffed row can lose. */
export const SPAM_MAX_PENALTY = 0.3;
/** Below this repetition ratio a row is treated as clean (ordinary prose repeats). */
export const SPAM_REPETITION_FLOOR = 0.34;

function spamTokens(s: string): string[] {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * SpamRisk in [0,1] over a row's user-authored display text.
 *
 * Three independent stuffing signals, each bounded, combined by taking the
 * strongest rather than summing (so a row is not punished twice for one habit):
 *
 *   REPETITION — the share of tokens that are repeats of an earlier token.
 *     "bangkok tour bangkok tour bangkok tour" is 4/6 repeats. Ordinary prose
 *     sits well under {@link SPAM_REPETITION_FLOOR}; everything below the floor
 *     scores zero so a normal listing is untouched.
 *   SHOUTING   — the share of alphabetic characters that are upper case, once
 *     the text is long enough for that to mean anything. "BEST CHEAP TOURS
 *     BANGKOK" is a keyword banner, "BBQ" is not, which is why it is a ratio
 *     over a minimum length rather than a flag.
 *   SEPARATORS — runs of `|`, `-`, `•`, `/` or `,` used to chain keywords
 *     ("tours | bangkok | cheap | best | guide"). Three or more separators in a
 *     short display string is a list, not a sentence.
 *
 * Returns 0 for empty or short text: this must never fire on a two-word venue
 * name, which has no room to stuff anything.
 */
export function spamRisk(text: string | null | undefined): number {
  const s = (text ?? '').trim();
  if (s.length < 12) return 0;

  const tokens = spamTokens(s);
  let repetition = 0;
  if (tokens.length >= 4) {
    const seen = new Set<string>();
    let repeats = 0;
    for (const t of tokens) {
      if (seen.has(t)) repeats++;
      else seen.add(t);
    }
    const ratio = repeats / tokens.length;
    repetition = ratio <= SPAM_REPETITION_FLOOR ? 0 : Math.min(1, (ratio - SPAM_REPETITION_FLOOR) / (1 - SPAM_REPETITION_FLOOR));
  }

  let shouting = 0;
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12) {
    const upper = (s.match(/[A-Z]/g) ?? []).length;
    const ratio = upper / letters.length;
    shouting = ratio <= 0.7 ? 0 : Math.min(1, (ratio - 0.7) / 0.3);
  }

  const separators = (s.match(/[|•/]|\s-\s|,/g) ?? []).length;
  const chained = separators >= 3 ? Math.min(1, (separators - 2) / 4) : 0;

  return Math.max(repetition, shouting, chained);
}

/**
 * Apply SpamRisk to a base confidence. Monotone: a clean row (risk 0) is
 * byte-identical to its pre-signal confidence, so nothing that ranks correctly
 * today can move because of this term.
 */
export function applySpamRisk(base: number, text: string | null | undefined): number {
  const risk = spamRisk(text);
  if (risk <= 0) return base;
  return Math.max(0, base - risk * SPAM_MAX_PENALTY);
}

// ─────────────────────────────────────────────────────────────────────────────
// §15 Diversity — a score term, not a side effect of slot allocation
// ─────────────────────────────────────────────────────────────────────────────
//
// The gateway already produces diversity ACROSS types: `perType = ceil(max /
// types)` fans the dispatch out, and §13 reserves a slot for the completion
// row. Neither is a diversity TERM, and neither does anything WITHIN a type —
// eight near-identical "Bangkok Street Food Tour" rows from one operator came
// back as eight rows, in a list capped at eight, and pushed every other kind of
// answer off the surface.
//
// This is the within-type term: each successive row that repeats an already-seen
// display signature is demoted a little further. Demotion, again, not removal:
// two genuinely different venues can share a name, and the user asking for the
// second one must still be able to reach it.

/** Confidence removed per repeat of an already-seen signature, before the cap. */
export const DIVERSITY_STEP = 0.04;
/** The most any one row can lose to repetition. */
export const DIVERSITY_MAX_PENALTY = 0.16;

/**
 * The comparison signature for diversity: the display text folded to
 * lower-case alphanumerics with the leading article dropped. Two rows with the
 * same signature are "the same answer again" as far as the surface is
 * concerned.
 */
export function diversitySignature(label: string, subtitle?: string | null): string {
  const fold = (s: string) =>
    (s ?? '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${fold(label)}|${fold(subtitle ?? '')}`;
}

/**
 * Apply the Diversity term to an already-projected list, IN PLACE of the caller
 * re-sorting: it returns new rows with adjusted confidence and leaves the order
 * to the ranker. Rows are compared only against EARLIER rows of the SAME
 * assistance type, so a `recent` row never suppresses an `entity` row and the §9
 * type order is untouched.
 *
 * Pure; a list with no repeated signature is returned byte-identical.
 */
export function applyDiversity<T extends { type: string; label: string; subtitle?: string; confidence?: number }>(
  rows: readonly T[],
): T[] {
  const seen = new Map<string, number>();
  let changed = false;
  const out = rows.map((r) => {
    const key = `${r.type}::${diversitySignature(r.label, r.subtitle)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) return r;
    const penalty = Math.min(n * DIVERSITY_STEP, DIVERSITY_MAX_PENALTY);
    changed = true;
    return { ...r, confidence: Math.max(0, (r.confidence ?? 0) - penalty) };
  });
  return changed ? out : (rows as T[]);
}

// ─────────────────────────────────────────────────────────────────────────────
// §16/§17/§18 Task feasibility — the demotion the main pipeline never applied
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confidence removed from a candidate the active task makes less appropriate —
 * a venue outside the Trip's city, or an event outside the Trip's dates.
 *
 * Large enough to reorder within a type, small enough that a demoted row can
 * still be reached: §18 says "remove or DEMOTE", and a user who types the name
 * of a place in another city must still be shown it.
 */
export const INFEASIBLE_DEMOTION = 0.22;

/** TripFit (§15): a candidate that IS inside the active Trip's city. */
export const TRIP_FIT_BOOST = 0.05;

/** Apply the task-feasibility demotion. Identity when the row is feasible. */
export function applyFeasibility(base: number, demoted: boolean): number {
  return demoted ? Math.max(0, base - INFEASIBLE_DEMOTION) : base;
}

/**
 * TripFit (§15). A typed query inside an active Trip previously got NO
 * Trip-derived rank term at all — Trip context reached only the zero-character
 * defaults and an exact `cityId` equality check. This is the term for the typed
 * case: a candidate in the Trip's city is lifted, clamped by
 * {@link SIGNAL_CEILING} and never below its base.
 */
export function applyTripFit(base: number, inTripCity: boolean): number {
  if (!inTripCity) return base;
  return Math.max(base, Math.min(base + TRIP_FIT_BOOST, SIGNAL_CEILING));
}
