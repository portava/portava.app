/**
 * layoverObjective — spec §9.1's candidate-ranking objective (census-layover L78).
 *
 *   HARD GATE: eligibility + entry + time + safety
 *   Then optimize:
 *     preference_fit + local_uniqueness + opportunity_scarcity + social_value
 *     + experience_density + memory_value
 *     − monetary_cost − energy_cost − uncertainty − stress/complexity − return_risk
 *
 * PURE. No database, no clock, no logger, no flag. The rollout mode that decides
 * whether this order is served, compared or ignored lives in
 * `layoverRankingMode.ts`; this file only answers "in what order, and why".
 *
 * ── AFTER THE HARD GATE, AND ONLY WITHIN A SAFETY RATING ────────────────────
 * The input is the list `rankActivities` returned: every card that survived the
 * landside gates, the §8 envelope's BLOCKED filter, the live drop and the
 * engine's rating. This module can NEITHER ADD NOR REMOVE a card:
 * `orderWithinRatings` returns a permutation of the very objects it was given,
 * and it permutes only inside a run of cards that share a safety rating. The
 * rating sequence — `safe` before `possible_but_risky` before `not_recommended`
 * before `airport_only` — is `rankActivities`' and stays primary, so no term
 * can lift a card above a safer one. Within a run, ties keep the legacy order,
 * so every ordering decision made upstream survives as the tiebreak.
 * A self-check refuses (returns the legacy list untouched) if the result is ever
 * not such a permutation.
 *
 * ── A TERM IS A REAL INPUT WITH ITS PROVENANCE, OR IT IS UNKNOWN ────────────
 * Every KNOWN term is a value in [-1, 1] read from an input the request already
 * holds, with a provenance string naming it. 0 means "no evidence either way",
 * which is exactly what an UNKNOWN term contributes: it is listed in
 * `unknownTerms` and adds 0 — never an invented value, never a default. The
 * score is the spec's signed sum over the KNOWN terms, equally weighted.
 *
 * Which terms can be KNOWN on this tree, and from what:
 *
 *   preference_fit        the live reading's intent-relative `experienceValue`
 *                         (Sensing §11; `lib/layoverLiveIntersection.ts`) — the
 *                         traveller's own vibe-chip crowd preference against
 *                         observed claims. KNOWN only with a reading AND a
 *                         stated intent; the live pass runs only under
 *                         `layover_live_intersection_enabled` (2851, FALSE).
 *   opportunity_scarcity  the same reading's horizon against the arrival:
 *                         +1 a time-limited window the traveller arrives inside,
 *                         -1 one that closes first. Unknowable without a leg.
 *   uncertainty           two facts every card carries: the leg's provenance
 *                         (airside 0 and a ROUTED figure are known; anything else
 *                         is not — `TRAVEL_TIME_SOURCE_IS_ROUTED`) and the
 *                         place's `verified` flag. Averaged.
 *   return_risk           airside: -1, there is no landside leg to return on (a
 *                         fact). Landside: the stated out-and-back (2 × leg +
 *                         dwell, the figures `assess` used) as a share of the
 *                         certified usable minutes. A term nobody stated makes
 *                         that a lower bound, and a lower bound cannot size a
 *                         risk (L293): UNKNOWN.
 *
 * UNKNOWN by construction (`ALWAYS_UNKNOWN`, each with its reason):
 * local_uniqueness, social_value, experience_density, memory_value,
 * monetary_cost, energy_cost, stress. Owner question OQ-6 is OPEN and its
 * default is built: NO PRICE and NO PRESENCE is read here — monetary_cost and
 * social_value stay UNKNOWN until the owner answers. `check:no-money-in-ranking`
 * scans this file (services/airport is in its SCOPE).
 *
 * ── H4: NO CATEGORY-DEFAULT MINUTES ─────────────────────────────────────────
 * Nothing here reads a category default. The ExperiencePrimitive's typical
 * minutes and energy cost (census L75, `layoverExperiencePrimitive.ts`) are a
 * descriptor that census §71.3 keeps out of the rating AND the order, and its
 * suite pins that the order is byte-identical whatever its defaults say; so
 * energy_cost and experience_density are UNKNOWN rather than typical-for-type.
 * The only minutes read are the ones `assess` itself rated with.
 */
import {
  TRAVEL_TIME_SOURCE_IS_ROUTED,
  travelTimeSourceFor,
  type SafetyAssessment,
  type SafetyRating,
  type TravelTimeSource,
} from "./LayoverSafetyEngine.js";

/** Bump when a term's input, its scale or the combination changes. Stored with every comparison. */
export const LAYOVER_OBJECTIVE_VERSION = "2026.10.14-1";

/** The spec's eleven terms, in the spec's order (§9.1). */
export const OBJECTIVE_TERMS = [
  "preference_fit",
  "local_uniqueness",
  "opportunity_scarcity",
  "social_value",
  "experience_density",
  "memory_value",
  "monetary_cost",
  "energy_cost",
  "uncertainty",
  "stress",
  "return_risk",
] as const;
export type ObjectiveTerm = (typeof OBJECTIVE_TERMS)[number];

/** +1: the spec adds the term; -1: the spec subtracts it. */
export const TERM_SIGN: Readonly<Record<ObjectiveTerm, 1 | -1>> = {
  preference_fit: 1,
  local_uniqueness: 1,
  opportunity_scarcity: 1,
  social_value: 1,
  experience_density: 1,
  memory_value: 1,
  monetary_cost: -1,
  energy_cost: -1,
  uncertainty: -1,
  stress: -1,
  return_risk: -1,
};

/**
 * The seven terms no input on this tree can make KNOWN, and why. Not a
 * placeholder list: each reason is the missing input, and a term leaves this
 * map only when that input exists and is read with its provenance.
 */
export const ALWAYS_UNKNOWN: Readonly<Partial<Record<ObjectiveTerm, string>>> = {
  local_uniqueness:
    "no uniqueness input: `verified` is a curation fact and feeds uncertainty; no layover producer writes a hidden_gem card",
  social_value:
    "owner question OQ-6 (open): no presence or crew aggregate is read in ranking (D-PRESENCE-K..K-3 govern presence counts)",
  experience_density:
    "no per-place density input; the ExperiencePrimitive's typical minutes are a category default census §71.3 keeps out of the order (H4)",
  memory_value:
    "no memory input on the layover path: the traveller's memories are not read to order cards",
  monetary_cost:
    "owner question OQ-6 (open): what the traveller would pay is not read in ranking (check:no-money-in-ranking)",
  energy_cost:
    "no per-place energy input; the ExperiencePrimitive's energy cost is typical-for-type, a category default census §71.3 keeps out of the order",
  stress:
    "no per-card stress/complexity input: transfers, modes and reservations are not read, and the record's risk band is one value per request",
};

export type TermValue =
  | { state: "KNOWN"; value: number; provenance: string }
  | { state: "UNKNOWN"; reason: string };

/** The fields of a live verdict this reads (`LayoverLiveVerdict`). Nothing else. */
export interface ObjectiveLiveReading {
  evidence: "reading" | "none" | "unreadable";
  experienceValue: number | null;
  interception: { reachable: boolean | null };
}

/** The fields of a ranked card this reads. No price, no presence, no category default. */
export interface ObjectiveCard {
  insideAirport: boolean;
  verified?: boolean;
  travelTimeMin: number | null;
  travelTimeSource?: TravelTimeSource;
  assessment: Pick<SafetyAssessment, "rating" | "statedTravelMin" | "statedActivityMin" | "usableMinutes">;
}

export interface ObjectiveContext<T> {
  /** The card's stable key — the service's `recommendationKey`. */
  keyOf: (card: T) => string;
  /** The live pass's verdicts by key, when it ran. Absent / empty ⇒ the live terms are UNKNOWN. */
  live?: ReadonlyMap<string, ObjectiveLiveReading>;
}

export interface CardObjective {
  key: string;
  rating: SafetyRating;
  /** Σ sign × value over the KNOWN terms, rounded to 1e-6 so float noise cannot reorder. */
  score: number;
  terms: Record<ObjectiveTerm, TermValue>;
  /** The terms that contributed 0 because nothing real could be read for them. */
  unknownTerms: ObjectiveTerm[];
}

const known = (value: number, provenance: string): TermValue => ({
  state: "KNOWN",
  value: Math.max(-1, Math.min(1, value)),
  provenance,
});
const unknown = (reason: string): TermValue => ({ state: "UNKNOWN", reason });
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isFiniteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function liveReadingOf<T>(card: T, ctx: ObjectiveContext<T>): ObjectiveLiveReading | null {
  const v = ctx.live?.get(ctx.keyOf(card));
  return v && v.evidence === "reading" ? v : null;
}

/** Every term for one card. Pure. */
export function objectiveTerms<T extends ObjectiveCard>(card: T, ctx: ObjectiveContext<T>): Record<ObjectiveTerm, TermValue> {
  const live = liveReadingOf(card, ctx);
  const a = card.assessment;

  // preference_fit — the traveller's stated intent, through a live reading.
  const preference_fit = live && isUnit(live.experienceValue)
    ? known(2 * live.experienceValue - 1, "live experienceValue: observed claims against the traveller's vibe-chip intent (Sensing §11)")
    : unknown(live
      ? "a live reading, but no stated crowd intent to measure it against"
      : "no stated preference reaches this card: the vibe-chip intent is read only through a live reading (layover_live_intersection_enabled)");

  // opportunity_scarcity — a time-limited window, caught or missed.
  const reachable = live?.interception?.reachable;
  const opportunity_scarcity = live && typeof reachable === "boolean"
    ? known(reachable ? 1 : -1, reachable
      ? "live horizon: the observed window is still open at the stated arrival"
      : "live horizon: the observed window closes before the stated arrival")
    : unknown(live
      ? "a live reading, but its horizon cannot be met against an unmeasured leg"
      : "no live reading for this card");

  // uncertainty — how much of what this card claims is a fact.
  const source = travelTimeSourceFor(card);
  const legKnown = card.insideAirport || TRAVEL_TIME_SOURCE_IS_ROUTED[source] === true;
  const parts: number[] = [legKnown ? -1 : 1];
  if (typeof card.verified === "boolean") parts.push(card.verified ? -1 : 1);
  const uncertainty = known(
    parts.reduce((s, x) => s + x, 0) / parts.length,
    `travel_time_source=${source}${legKnown ? " (known)" : " (not a measurement)"}; verified=${typeof card.verified === "boolean" ? String(card.verified) : "unstated"}`,
  );

  // return_risk — the share of the certified window the stated round trip uses.
  let return_risk: TermValue;
  if (card.insideAirport) {
    return_risk = known(-1, "inside_airport: there is no landside leg to return on");
  } else if (a.statedTravelMin === null || a.statedActivityMin === null) {
    return_risk = unknown("a leg or a dwell nobody stated: the round trip is a lower bound, and a lower bound cannot size a risk (L293)");
  } else if (!isFiniteNonNeg(a.statedTravelMin) || !isFiniteNonNeg(a.statedActivityMin) || !isFiniteNonNeg(a.usableMinutes) || a.usableMinutes === 0) {
    return_risk = unknown("no certified usable minutes to measure the round trip against");
  } else {
    const share = Math.min(1, (2 * a.statedTravelMin + a.statedActivityMin) / a.usableMinutes);
    return_risk = known(2 * share - 1, `stated 2 × ${a.statedTravelMin} + ${a.statedActivityMin} min of ${a.usableMinutes} certified usable min`);
  }

  const terms = { preference_fit, opportunity_scarcity, uncertainty, return_risk } as Partial<Record<ObjectiveTerm, TermValue>>;
  for (const [term, reason] of Object.entries(ALWAYS_UNKNOWN) as Array<[ObjectiveTerm, string]>) terms[term] = unknown(reason);
  return Object.fromEntries(OBJECTIVE_TERMS.map((t) => [t, terms[t]!])) as Record<ObjectiveTerm, TermValue>;
}

/** The signed sum over the KNOWN terms; an UNKNOWN term contributes 0 and is named. */
export function scoreTerms(terms: Record<ObjectiveTerm, TermValue>): { score: number; unknownTerms: ObjectiveTerm[] } {
  let score = 0;
  const unknownTerms: ObjectiveTerm[] = [];
  for (const t of OBJECTIVE_TERMS) {
    const v = terms[t];
    if (v.state === "KNOWN") score += TERM_SIGN[t] * v.value;
    else unknownTerms.push(t);
  }
  return { score: Math.round(score * 1e6) / 1e6, unknownTerms };
}

export function cardObjective<T extends ObjectiveCard>(card: T, ctx: ObjectiveContext<T>): CardObjective {
  const terms = objectiveTerms(card, ctx);
  const { score, unknownTerms } = scoreTerms(terms);
  return { key: ctx.keyOf(card), rating: card.assessment.rating, score, terms, unknownTerms };
}

export interface ObjectiveOrder<T> {
  /** The same objects as the input, re-ordered only within runs of one safety rating. */
  served: T[];
  /** One per input card, in INPUT (legacy) order. */
  cards: CardObjective[];
  /** Cards whose position differs from the legacy order. */
  moved: number;
  /** Whether the first card differs. */
  topChanged: boolean;
  /** Per term, how many cards had it KNOWN. */
  knownByTerm: Record<ObjectiveTerm, number>;
  /** Set only when the self-check refused: `served` is then the legacy list as given. */
  refused: "not_a_permutation_within_ratings" | null;
}

/** The legacy list re-ordered by the objective within each run of one safety rating. Pure; the input is not mutated. */
export function orderWithinRatings<T extends ObjectiveCard>(legacy: readonly T[], ctx: ObjectiveContext<T>): ObjectiveOrder<T> {
  const cards = legacy.map((c) => cardObjective(c, ctx));
  const served: T[] = [];
  let start = 0;
  while (start < legacy.length) {
    let end = start + 1;
    while (end < legacy.length && legacy[end]!.assessment.rating === legacy[start]!.assessment.rating) end += 1;
    const run: number[] = [];
    for (let i = start; i < end; i += 1) run.push(i);
    run.sort((i, j) => (cards[j]!.score - cards[i]!.score) || (i - j));
    for (const i of run) served.push(legacy[i]!);
    start = end;
  }
  const knownByTerm = Object.fromEntries(OBJECTIVE_TERMS.map((t) => [t, cards.filter((c) => c.terms[t].state === "KNOWN").length])) as Record<ObjectiveTerm, number>;
  if (!isPermutationWithinRatings(legacy, served)) {
    return { served: [...legacy], cards, moved: 0, topChanged: false, knownByTerm, refused: "not_a_permutation_within_ratings" };
  }
  let moved = 0;
  for (let i = 0; i < legacy.length; i += 1) if (served[i] !== legacy[i]) moved += 1;
  return { served, cards, moved, topChanged: legacy.length > 0 && served[0] !== legacy[0], knownByTerm, refused: null };
}

/**
 * The eligibility boundary, checked rather than assumed: the same objects, each
 * exactly once, and the same rating at every position. Exported for the
 * property test.
 */
export function isPermutationWithinRatings<T extends ObjectiveCard>(legacy: readonly T[], served: readonly T[]): boolean {
  if (served.length !== legacy.length) return false;
  const remaining = new Map<T, number>();
  for (const c of legacy) remaining.set(c, (remaining.get(c) ?? 0) + 1);
  for (let i = 0; i < served.length; i += 1) {
    const c = served[i]!;
    const n = remaining.get(c);
    if (!n) return false;
    remaining.set(c, n - 1);
    if (c.assessment.rating !== legacy[i]!.assessment.rating) return false;
  }
  return true;
}
