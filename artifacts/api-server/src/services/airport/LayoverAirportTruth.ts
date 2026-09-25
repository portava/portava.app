/**
 * LayoverAirportTruth — §10 Airport Intelligence and truth reconciliation.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §10   the five fact classes and their typical freshness; `TruthValue<T>`
 *   §10.1 source hierarchy and contradiction handling (five rules)
 *   §22   airport maturity — L3 "Portava observed", L4 "calibrated"
 *   §23   rate-limit and trust-weight community observations; outlier detection
 *   App A DATA_STALE, SOURCE_CONFLICT, SECURITY_WAIT_HIGH, TRAFFIC_DEGRADED
 *
 * ── WHAT THIS MODULE IS ──────────────────────────────────────────────────────
 * A pure reconciler. It takes a bag of `AirportObservation`s and returns
 * `TruthValue<number>`s, and it is the ONLY way a `LiveConditions` — the shape
 * `LayoverSafetyEngine` will add to the buffer — can be built. There is no
 * clock in this file, no I/O, no randomness: every function takes `nowMs`.
 *
 * ── WHAT THIS MODULE IS NOT — CORRECTED 2026-09-22 ───────────────────────────
 * THIS BLOCK USED TO SAY NOTHING ON THIS TREE PRODUCES AN OBSERVATION, and that
 * `airport_fact_observations` (migration 2860) was WRITTEN AND NOT APPLIED.
 * Both halves are FALSE now: 2860 IS APPLIED to production, so is 2982's
 * `submission_token`, and `POST /airport/sessions/:id/observations` is a live
 * route whose only gate is `airport_mode_enabled` (TRUE in production).
 *
 * WHAT IS STILL TRUE, and it is what every §10 census row rests on: NOTHING
 * SUPPLIES `liveConditions` OUTSIDE TESTS, so no observation moves a deadline
 * and this module's arithmetic is term-for-term what it was before it existed.
 *
 * ── WHY THE POLICY LIVES HERE AND NOT IN THE ENGINE ──────────────────────────
 * The safety engine must not learn how to weigh a stranger's queue report
 * against an airport's official feed. It takes three decided minute figures and
 * a list of reason codes. Everything upstream of that — decay, corroboration,
 * outliers, contradiction, the conservative choice — is §10.1 policy and lives
 * in this file, where it can be swept exhaustively without a session in scope.
 */
import type {
  EstimateConfidence,
  EstimateFallbackLevel,
  EstimateSourceClass,
} from "./LayoverFeasibility.js";
import { ESTIMATE_CONFIDENCES } from "./LayoverFeasibility.js";
import type { LayoverReasonCode, LiveConditions } from "./LayoverSafetyEngine.js";

/**
 * Version of this module's POLICY — the weights, thresholds and tie-breaks
 * below, not merely its shape. A `TruthValue` produced under a different
 * policy version was decided by different rules and must not be compared to
 * one produced under this.
 *
 * History:
 *   2026.09.13-1  first reconciler: five fact classes, decay, corroboration,
 *                 outlier rejection, rate limiting, conservative contradiction.
 */
export const LAYOVER_TRUTH_VERSION = "2026.09.13-1";

// ── §10 fact classes ─────────────────────────────────────────────────────────

/**
 * The spec's five fact classes, in the order its table lists them. Ordered
 * static-first because that is also the order of increasing volatility, which
 * is what the TTLs below encode.
 */
export const AIRPORT_FACT_CLASSES = [
  "STATIC_TOPOLOGY",
  "OPERATIONAL_SEMI_LIVE",
  "FAST_LIVE",
  "TRAVELER_OBSERVATION",
  "HISTORICAL_MODEL",
] as const;
export type AirportFactClass = (typeof AIRPORT_FACT_CLASSES)[number];

/**
 * §10 "Typical freshness", in minutes, as the TTL an observation of that class
 * is given when it carries none of its own.
 *
 * These are POLICY CONSTANTS, not measurements — the spec says "weeks/months",
 * "hours/days", "minutes", and a number has to be chosen to make an expiry
 * computable. They are named and versioned (`LAYOVER_TRUTH_VERSION`) rather
 * than inlined so that changing one is a visible change to the policy.
 */
export const FACT_CLASS_TTL_MIN: Record<AirportFactClass, number> = {
  STATIC_TOPOLOGY: 30 * 24 * 60,   // a month — "weeks/months"
  OPERATIONAL_SEMI_LIVE: 12 * 60,  // half a day — "hours/days"
  FAST_LIVE: 20,                   // "minutes"
  TRAVELER_OBSERVATION: 45,        // "minutes", and weighted down by age before that
  HISTORICAL_MODEL: 90 * 24 * 60,  // "longer-lived but recalibrated"
};

/**
 * Every fact this module can hold a truth about, bound to exactly one class.
 * A fact type cannot be filed under two classes, which is what makes "the TTL
 * of this value" a property of the fact rather than of whoever reported it.
 *
 * The names come from the spec's own Examples column, one per example.
 */
export const AIRPORT_FACT_TYPES = {
  terminal_topology: "STATIC_TOPOLOGY",
  gate_assignment: "STATIC_TOPOLOGY",
  checkpoint_location: "STATIC_TOPOLOGY",
  walking_link_minutes: "STATIC_TOPOLOGY",

  security_layout: "OPERATIONAL_SEMI_LIVE",
  lounge_hours: "OPERATIONAL_SEMI_LIVE",
  transport_schedule: "OPERATIONAL_SEMI_LIVE",

  security_wait_minutes: "FAST_LIVE",
  immigration_wait_minutes: "FAST_LIVE",
  taxi_queue_minutes: "FAST_LIVE",
  disruption_level: "FAST_LIVE",

  checkpoint_timing_minutes: "TRAVELER_OBSERVATION",
  queue_report_minutes: "TRAVELER_OBSERVATION",
  closure_reported: "TRAVELER_OBSERVATION",

  time_of_day_distribution: "HISTORICAL_MODEL",
} as const satisfies Record<string, AirportFactClass>;

export type AirportFactType = keyof typeof AIRPORT_FACT_TYPES;

export const AIRPORT_FACT_TYPE_NAMES = Object.keys(AIRPORT_FACT_TYPES) as AirportFactType[];

export function factClassOf(t: AirportFactType): AirportFactClass {
  return AIRPORT_FACT_TYPES[t];
}

/**
 * §23 / §10.1 plausibility. A value outside this closed range is not a
 * low-confidence datum, it is a wrong one, and it is REJECTED rather than
 * weighted down — a 900-minute security queue reported by a trusted official
 * feed would otherwise sail through every weighting rule below and take the
 * conservative branch, adding fifteen hours of buffer.
 *
 * The upper bounds are deliberately generous (a four-hour immigration hall is
 * a real thing that happens) — the check is for impossible, not for unusual.
 */
export const PLAUSIBLE_RANGE: Record<AirportFactType, { min: number; max: number }> = {
  terminal_topology: { min: 0, max: 20 },
  gate_assignment: { min: 0, max: 999 },
  checkpoint_location: { min: 0, max: 999 },
  walking_link_minutes: { min: 0, max: 90 },

  security_layout: { min: 0, max: 99 },
  lounge_hours: { min: 0, max: 24 },
  transport_schedule: { min: 0, max: 24 * 60 },

  security_wait_minutes: { min: 0, max: 240 },
  immigration_wait_minutes: { min: 0, max: 300 },
  taxi_queue_minutes: { min: 0, max: 180 },
  disruption_level: { min: 0, max: 4 },

  checkpoint_timing_minutes: { min: 0, max: 240 },
  queue_report_minutes: { min: 0, max: 240 },
  closure_reported: { min: 0, max: 1 },

  time_of_day_distribution: { min: 0, max: 600 },
};

/**
 * Two credible readings of the same fact that differ by more than this are a
 * CONTRADICTION, not noise. Below it they are agreement and the conservative
 * one is taken silently; above it the result is flagged `conflict` and its
 * confidence drops. Per fact type, because five minutes means something
 * different for a taxi queue than for lounge opening hours.
 */
export const CONFLICT_TOLERANCE_MIN: Record<AirportFactType, number> = {
  terminal_topology: 0,
  gate_assignment: 0,
  checkpoint_location: 0,
  walking_link_minutes: 5,

  security_layout: 0,
  lounge_hours: 1,
  transport_schedule: 15,

  security_wait_minutes: 10,
  immigration_wait_minutes: 15,
  taxi_queue_minutes: 10,
  disruption_level: 0,

  checkpoint_timing_minutes: 10,
  queue_report_minutes: 10,
  closure_reported: 0,

  time_of_day_distribution: 10,
};

// ── who is talking ───────────────────────────────────────────────────────────

/**
 * Ordered LEAST trusted first. The order is load-bearing: `sourceClassOf` and
 * the corroboration rule both read it, so demoting a kind is one edit here.
 */
export const OBSERVER_KINDS = ["community", "portava_sensor", "operator_feed", "official"] as const;
export type ObserverKind = (typeof OBSERVER_KINDS)[number];

/**
 * The trust an observer of this kind starts with, before their own standing
 * score and before decay. A community reading is worth a third of an official
 * one and cannot on its own reach the corroboration floor below.
 */
export const OBSERVER_KIND_TRUST: Record<ObserverKind, number> = {
  community: 0.3,
  portava_sensor: 0.6,
  operator_feed: 0.85,
  official: 1.0,
};

/** §6.2 source class each observer kind maps onto, for the published estimate. */
export const OBSERVER_SOURCE_CLASS: Record<ObserverKind, EstimateSourceClass> = {
  community: "LIVE",
  portava_sensor: "LIVE",
  operator_feed: "LIVE",
  official: "LIVE",
};

/**
 * §23 "Rate-limit … community operational observations."
 *
 * At most this many accepted observations per (observer, fact type) inside the
 * window. The limit applies to EVERY observer kind, not only community ones: a
 * misconfigured operator feed replaying the same reading four hundred times is
 * the same denial-of-truth as a hostile traveller, and a rule that trusts
 * officials unconditionally is the rule §10.1's last line forbids.
 */
export const OBSERVATION_RATE_LIMIT = { maxPerWindow: 3, windowMinutes: 15 } as const;

/**
 * §10.1 "Community observations require plausibility checks, CORROBORATION and
 * decay." How many DISTINCT community observers must agree (within the fact's
 * conflict tolerance) before a community-only reading may move a
 * safety-critical value at all. One stranger cannot move a deadline.
 */
export const MIN_COMMUNITY_CORROBORATION = 2;

/**
 * The fact types whose value can reach the safety buffer. Corroboration is
 * required only for these: a single community report of a closed lounge is
 * worth publishing, a single community report of a 90-minute security queue is
 * not worth moving a flight deadline on.
 */
export const SAFETY_CRITICAL_FACTS: ReadonlySet<AirportFactType> = new Set<AirportFactType>([
  "security_wait_minutes",
  "immigration_wait_minutes",
  "taxi_queue_minutes",
  "queue_report_minutes",
  "checkpoint_timing_minutes",
]);

// ── the inputs ───────────────────────────────────────────────────────────────

export interface AirportObservation {
  /** Stable id from the producer. Used for dedup and for `sourceRefs`. */
  observationId: string;
  /** IATA code, or a profile id. Whatever it is, it must be the same string. */
  airportRef: string;
  factType: AirportFactType;
  /** Minutes for the timing facts; a small ordinal for the state facts. */
  value: number;
  observerKind: ObserverKind;
  /** Distinct per human/feed. Corroboration counts DISTINCT ids, not rows. */
  observerId: string;
  /**
   * Standing trust for this observer in [0,1]. Absent = the kind's floor, which
   * is the conservative reading — an unrated observer is not a trusted one.
   */
  observerTrust?: number;
  observedAt: string;
  /** Something a reader can open. Ends up in `TruthValue.sourceRefs`. */
  sourceRef: string;
}

/** Why an observation did not count. Every rejection has exactly one. */
export type ObservationRejection =
  | "unknown_fact_type"
  | "not_finite"
  | "implausible_value"
  | "bad_timestamp"
  | "future_dated"
  | "expired"
  | "rate_limited"
  | "duplicate_id";

export interface ScreenedObservation {
  observation: AirportObservation;
  /** null when accepted. */
  rejected: ObservationRejection | null;
  /** Age-decayed trust in [0,1]. 0 for anything rejected. */
  weight: number;
  ageMinutes: number;
  expiresAt: string;
}

// ── §10 TruthValue ───────────────────────────────────────────────────────────

/**
 * Spec §10's `TruthValue<T>`, every member present and every member set by
 * `reconcile` — none of them is a placeholder.
 *
 * `conflict` is the member the rest of §10.1 hangs off: it is TRUE whenever two
 * credible sources disagreed by more than the fact's tolerance, and when it is
 * TRUE the value is the CONSERVATIVE one rather than a merge, the confidence
 * has been reduced, and `sourceRefs` names BOTH sides so the disagreement is
 * recoverable instead of averaged away.
 */
export interface TruthValue<T> {
  value: T;
  confidence: EstimateConfidence;
  conflict: boolean;
  sourceClass: EstimateSourceClass;
  sourceRefs: string[];
  observedAt: string | null;
  expiresAt: string | null;
  fallbackLevel: EstimateFallbackLevel;
}

/** What `reconcile` decided, beside the value itself. Diagnostics, not truth. */
export interface ReconciliationOutcome {
  truthVersion: string;
  airportRef: string;
  factType: AirportFactType;
  factClass: AirportFactClass;
  /** null when nothing survived screening — an honest absence, never a 0. */
  truth: TruthValue<number> | null;
  screened: ScreenedObservation[];
  /** Distinct accepted observer ids, by kind. */
  corroboration: Record<ObserverKind, number>;
  /** Set when a credible disagreement was found; names the two extremes. */
  conflictBetween: { low: number; high: number } | null;
  /** Every reason an observation did not count, in input order. */
  rejections: Array<{ observationId: string; reason: ObservationRejection }>;
  /** Why the value is what it is, in the order the rules fired. */
  rulesApplied: string[];
}

function isoMs(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function stepDownConfidence(c: EstimateConfidence, steps = 1): EstimateConfidence {
  const i = ESTIMATE_CONFIDENCES.indexOf(c);
  return ESTIMATE_CONFIDENCES[Math.max(0, i - steps)];
}

/**
 * Age decay. Linear from full weight at the instant of observation to zero at
 * the class TTL, and NEGATIVE ages (a future-dated observation) are handled
 * before this is reached — see `screenObservations`.
 *
 * Linear rather than exponential on purpose: an exponential curve has no point
 * at which a reading stops counting, so a stale value keeps a thin vote
 * forever and "expired" becomes a thing that never quite happens.
 */
export function decayFactor(ageMinutes: number, ttlMinutes: number): number {
  if (ageMinutes <= 0) return 1;
  if (ageMinutes >= ttlMinutes) return 0;
  return 1 - ageMinutes / ttlMinutes;
}

/**
 * §23 outlier detection, and it is deliberately NOT a standard-deviation test.
 *
 * A dispersion test needs a population, and the population here is three
 * readings on a good day; with n = 2 every value is within one sigma of the
 * mean and nothing is ever an outlier. So the test is against the fact's own
 * declared physical range (`PLAUSIBLE_RANGE`), which does not need a
 * population and cannot be defeated by a coordinated pair of liars.
 */
export function isImplausible(factType: AirportFactType, value: number): boolean {
  if (!Number.isFinite(value)) return true;
  const r = PLAUSIBLE_RANGE[factType];
  return value < r.min || value > r.max;
}

/**
 * Screen a bag of observations: reject what cannot count, rate-limit what
 * counts too often, and weight what remains by kind trust × age decay.
 *
 * Order matters and is fixed: structural rejects first (a malformed row is not
 * "rate limited"), then rate limiting (so a flood of valid rows from one
 * observer is trimmed rather than a flood of junk consuming the allowance),
 * then weighting.
 */
export function screenObservations(
  observations: AirportObservation[],
  opts: { nowMs: number; factType: AirportFactType; airportRef: string },
): ScreenedObservation[] {
  const ttl = FACT_CLASS_TTL_MIN[factClassOf(opts.factType)];
  const seenIds = new Set<string>();
  const perObserver = new Map<string, number[]>();
  const out: ScreenedObservation[] = [];

  for (const o of observations) {
    if (o.airportRef !== opts.airportRef || o.factType !== opts.factType) continue;

    const observedMs = isoMs(o.observedAt);
    const expiresAt = new Date((observedMs ?? opts.nowMs) + ttl * 60_000).toISOString();
    const ageMinutes = observedMs === null ? Number.NaN : (opts.nowMs - observedMs) / 60_000;
    const reject = (reason: ObservationRejection): void => {
      out.push({ observation: o, rejected: reason, weight: 0, ageMinutes, expiresAt });
    };

    if (!(o.factType in AIRPORT_FACT_TYPES)) { reject("unknown_fact_type"); continue; }
    if (seenIds.has(o.observationId)) { reject("duplicate_id"); continue; }
    seenIds.add(o.observationId);
    if (!Number.isFinite(o.value)) { reject("not_finite"); continue; }
    if (isImplausible(o.factType, o.value)) { reject("implausible_value"); continue; }
    if (observedMs === null) { reject("bad_timestamp"); continue; }
    // A future-dated reading is not "very fresh", it is wrong, and treating it
    // as fresh is how a clock-skewed feed outvotes everything real.
    if (observedMs > opts.nowMs) { reject("future_dated"); continue; }
    if (ageMinutes >= ttl) { reject("expired"); continue; }

    const window = perObserver.get(o.observerId) ?? [];
    const recent = window.filter((t) => observedMs - t <= OBSERVATION_RATE_LIMIT.windowMinutes * 60_000
      && t - observedMs <= OBSERVATION_RATE_LIMIT.windowMinutes * 60_000);
    if (recent.length >= OBSERVATION_RATE_LIMIT.maxPerWindow) { reject("rate_limited"); continue; }
    window.push(observedMs);
    perObserver.set(o.observerId, window);

    const declared = typeof o.observerTrust === "number" && Number.isFinite(o.observerTrust)
      ? Math.min(1, Math.max(0, o.observerTrust))
      : 1;
    const weight = OBSERVER_KIND_TRUST[o.observerKind] * declared * decayFactor(ageMinutes, ttl);
    out.push({ observation: o, rejected: null, weight, ageMinutes, expiresAt });
  }
  return out;
}

/**
 * §10.1, all five rules, applied to one (airport, fact) pair.
 *
 *   1. Never silently merge contradictory facts  — no average is ever taken;
 *      a disagreement past tolerance sets `conflict` and keeps both refs.
 *   2. Preserve source provenance and conflict flag — every accepted reading's
 *      `sourceRef` is on the result, and `conflict` is always set explicitly.
 *   3. Prefer conservative values when credible sources disagree — the
 *      LARGEST value wins for every fact type here, because every one of them
 *      is a delay and a larger delay is the safer belief.
 *   4. Community observations require plausibility, corroboration and decay —
 *      screened above, and for safety-critical facts a community-only reading
 *      needs MIN_COMMUNITY_CORROBORATION distinct observers.
 *   5. Official data is not automatically truth when fresh contradictory
 *      evidence exists; contradiction increases uncertainty — an official
 *      reading contradicted by corroborated fresher evidence does NOT win
 *      outright; the conservative value is taken and confidence steps down.
 */
export function reconcile(
  observations: AirportObservation[],
  opts: { nowMs: number; factType: AirportFactType; airportRef: string },
): ReconciliationOutcome {
  const factClass = factClassOf(opts.factType);
  const screened = screenObservations(observations, opts);
  const accepted = screened.filter((s) => s.rejected === null);
  const rulesApplied: string[] = [];
  const rejections = screened
    .filter((s) => s.rejected !== null)
    .map((s) => ({ observationId: s.observation.observationId, reason: s.rejected! }));

  const corroboration: Record<ObserverKind, number> = {
    community: 0, portava_sensor: 0, operator_feed: 0, official: 0,
  };
  for (const kind of OBSERVER_KINDS) {
    corroboration[kind] = new Set(
      accepted.filter((s) => s.observation.observerKind === kind).map((s) => s.observation.observerId),
    ).size;
  }

  const empty = (): ReconciliationOutcome => ({
    truthVersion: LAYOVER_TRUTH_VERSION,
    airportRef: opts.airportRef,
    factType: opts.factType,
    factClass,
    truth: null,
    screened,
    corroboration,
    conflictBetween: null,
    rejections,
    rulesApplied,
  });

  if (accepted.length === 0) {
    rulesApplied.push("no observation survived screening — absence, not zero");
    return empty();
  }

  // Rule 4: a safety-critical fact carried only by community reporters needs
  // corroboration before it may be believed at all. Below the floor the
  // observations are kept in `screened` (so a reader can see they existed) and
  // the truth is ABSENT — not a low-confidence value a caller might still act on.
  const nonCommunity = accepted.filter((s) => s.observation.observerKind !== "community");
  if (
    SAFETY_CRITICAL_FACTS.has(opts.factType) &&
    nonCommunity.length === 0 &&
    corroboration.community < MIN_COMMUNITY_CORROBORATION
  ) {
    rulesApplied.push(
      `community-only safety-critical fact with ${corroboration.community} distinct observer(s) — ` +
      `below the corroboration floor of ${MIN_COMMUNITY_CORROBORATION}`,
    );
    return empty();
  }

  // Rule 3: conservative. Every fact here is a delay, so the safe belief is the
  // largest credible one. `credible` means it survived screening — weighting
  // decides confidence, not eligibility, because down-weighting a reading to
  // near-zero and then ignoring it is a silent merge by another name.
  const values = accepted.map((s) => s.observation.value);
  const high = Math.max(...values);
  const low = Math.min(...values);
  const tolerance = CONFLICT_TOLERANCE_MIN[opts.factType];
  const conflict = high - low > tolerance;
  const chosen = high;
  rulesApplied.push(`conservative selection: max of ${values.length} credible reading(s) = ${chosen}`);

  if (conflict) {
    // Rule 1 + 2: recorded, never merged.
    rulesApplied.push(
      `contradiction: ${low} vs ${high} exceeds the ${tolerance}-minute tolerance for ${opts.factType} — ` +
      `both sources retained, no average taken`,
    );
  }

  // Confidence: start from the best-supported reading and step down for every
  // thing that should make a reader less sure.
  const bestWeight = Math.max(...accepted.map((s) => s.weight));
  let confidence: EstimateConfidence =
    bestWeight >= 0.75 ? "HIGH" : bestWeight >= 0.45 ? "MEDIUM" : bestWeight > 0 ? "LOW" : "INSUFFICIENT";
  rulesApplied.push(`base confidence ${confidence} from best weight ${bestWeight.toFixed(3)}`);

  if (conflict) {
    confidence = stepDownConfidence(confidence);
    rulesApplied.push(`rule 5: contradiction increases uncertainty — confidence -> ${confidence}`);
  }

  // ── RULE 5, SECOND HALF: THERE IS DELIBERATELY NO EXTRA BRANCH HERE ────────
  //
  // "Official data is not automatically truth when fresh contradictory evidence
  // exists" is satisfied by two mechanisms that are already above, and this is
  // recorded rather than left as an absence because the FIRST version of this
  // file did add a third:
  //
  //     if (fresherContradiction && confidence === "HIGH") confidence = "MEDIUM";
  //
  // That branch was DEAD and a mutation test proved it. Disabling it changed no
  // test result at all (40 pass / 0 fail, mutated and unmutated), and reading it
  // back shows why it could never fire: `fresherContradiction` requires two
  // readings differing by more than `tolerance`, which is the definition of
  // `conflict` five lines above, and the conflict branch has already stepped
  // HIGH down to MEDIUM by the time this test runs. A guard whose condition
  // implies a guard that already fired is decoration with a comment on it.
  //
  // What actually implements the rule:
  //   * the OFFICIAL READING DOES NOT WIN BY BEING OFFICIAL — `chosen` is the
  //     conservative value over every credible reading, and observer kind is
  //     nowhere in that selection. Proved by the mutation that takes the mean
  //     (6 failures) and by "the largest credible delay is chosen, whoever
  //     reported it", which sweeps every observer kind.
  //   * CONTRADICTION INCREASES UNCERTAINTY — the step-down above, proved by
  //     the mutation that removes it.
  //
  // Do not re-add a cap without a test that goes red without it.

  const oldest = accepted.reduce((a, b) => (a.ageMinutes >= b.ageMinutes ? a : b));
  const soonestExpiry = accepted
    .map((s) => s.expiresAt)
    .sort()[0]!;

  const truth: TruthValue<number> = {
    value: chosen,
    confidence,
    conflict,
    // Every observation this module accepts is a current reading of the world,
    // which is what LIVE means in §6.2's ladder. The confidence and the
    // fallback level carry how much to believe it; the class carries what kind
    // of thing it is, and demoting the class for a weak reading would make the
    // two say the same thing twice.
    sourceClass: OBSERVER_SOURCE_CLASS[oldest.observation.observerKind],
    sourceRefs: accepted.map((s) => s.observation.sourceRef),
    observedAt: oldest.observation.observedAt,
    expiresAt: soonestExpiry,
    fallbackLevel: 0,
  };

  return {
    truthVersion: LAYOVER_TRUTH_VERSION,
    airportRef: opts.airportRef,
    factType: opts.factType,
    factClass,
    truth,
    screened,
    corroboration,
    conflictBetween: conflict ? { low, high } : null,
    rejections,
    rulesApplied,
  };
}

/**
 * Spec §18 `AirportTruthService.getTruth(subject, factType, atTime)`.
 *
 * SIGNATURE DIVERGENCE, STATED RATHER THAN HIDDEN: the spec's method reads a
 * store; this one takes the corpus as an argument, because there is no store to
 * read (the observations table is unapplied and has no writer). It is the same
 * question with the I/O lifted out, and it is deterministic, which the spec's
 * version could not be. The census scores this BUILT-BUT-WRONG for exactly that
 * reason.
 */
export function getTruth(
  subject: string,
  factType: AirportFactType,
  atTime: number,
  corpus: AirportObservation[],
): TruthValue<number> | null {
  return reconcile(corpus, { nowMs: atTime, factType, airportRef: subject }).truth;
}

// ── §10 → the safety buffer ──────────────────────────────────────────────────

/**
 * The queue minutes the STATIC buffer is already assumed to cover.
 *
 * READ THIS BEFORE CHANGING EITHER NUMBER. `airport_profiles` has no
 * security-wait or immigration-wait column (0127:17-41), so there is no
 * per-airport baseline to subtract an observed queue from, and inventing one
 * per airport would be the fabricated certainty Appendix C1 forbids. What is
 * declared instead is a single, named, versioned assumption about what the
 * generic base buffer already includes — disclosed in the estimate's
 * `sourceRefs` and in this comment, not buried in an expression.
 *
 * The consequence, stated plainly: an observed queue BELOW the baseline adds
 * nothing and is not evidence that the buffer is too large. This module can
 * make a deadline earlier and can never make one later.
 */
export const SECURITY_WAIT_BASELINE_MIN = 20;
export const IMMIGRATION_WAIT_BASELINE_MIN = 20;
export const TAXI_QUEUE_BASELINE_MIN = 10;

/** Observed security queue at or above this emits Appendix A SECURITY_WAIT_HIGH. */
export const SECURITY_WAIT_HIGH_MIN = 45;

/** Observed taxi queue at or above this emits Appendix A TRAFFIC_DEGRADED. */
export const TAXI_QUEUE_DEGRADED_MIN = 25;

export interface LiveConditionSources {
  securityWait: TruthValue<number> | null;
  immigrationWait: TruthValue<number> | null;
  taxiQueue: TruthValue<number> | null;
}

/**
 * Fold reconciled truths into the ONE shape the safety engine accepts.
 *
 * Monotonicity, which is the property the whole §6.1 L51 invariant rests on:
 * each term is `max(0, observed − baseline)`, which is non-decreasing in
 * `observed`, and `LayoverSafetyEngine.liveExtraMinutes` sums them, so a larger
 * observed wait can only ever produce a larger buffer and therefore a smaller
 * `usableMinutes`. Swept in `src/test/layoverLiveConditions.test.ts` over the
 * whole plausible range rather than argued here.
 */
export function liveConditionsFrom(
  sources: LiveConditionSources,
  opts: { nowMs: number },
): LiveConditions {
  const codes: LayoverReasonCode[] = [];
  const contributing: Array<TruthValue<number>> = [];

  const over = (t: TruthValue<number> | null, baseline: number): number => {
    if (!t) return 0;
    contributing.push(t);
    return Math.max(0, t.value - baseline);
  };

  const securityWaitExtraMin = over(sources.securityWait, SECURITY_WAIT_BASELINE_MIN);
  const immigrationWaitExtraMin = over(sources.immigrationWait, IMMIGRATION_WAIT_BASELINE_MIN);
  const groundTransportExtraMin = over(sources.taxiQueue, TAXI_QUEUE_BASELINE_MIN);

  if ((sources.securityWait?.value ?? 0) >= SECURITY_WAIT_HIGH_MIN) codes.push("SECURITY_WAIT_HIGH");
  if ((sources.taxiQueue?.value ?? 0) >= TAXI_QUEUE_DEGRADED_MIN) codes.push("TRAFFIC_DEGRADED");
  if (contributing.some((t) => t.conflict)) codes.push("SOURCE_CONFLICT");
  if (contributing.some((t) => t.expiresAt !== null && Date.parse(t.expiresAt) <= opts.nowMs)) {
    codes.push("DATA_STALE");
  }

  const observedAts = contributing.map((t) => t.observedAt).filter((s): s is string => s !== null).sort();
  const expiries = contributing.map((t) => t.expiresAt).filter((s): s is string => s !== null).sort();

  return {
    securityWaitExtraMin,
    immigrationWaitExtraMin,
    groundTransportExtraMin,
    reasonCodes: codes,
    observedAt: observedAts[0] ?? null,
    expiresAt: expiries[0] ?? null,
  };
}

// ── §10 "Historical model", and §22 L4 calibration ───────────────────────────

/** One hour-of-day band in the airport's own local time. */
export interface HistoricalBand {
  /** Local hour, 0-23. */
  hour: number;
  samples: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface HistoricalModel {
  truthVersion: string;
  airportRef: string;
  factType: AirportFactType;
  bands: HistoricalBand[];
  /** Bands with fewer samples than this are NOT published. */
  minSamplesPerBand: number;
}

export const MIN_SAMPLES_PER_BAND = 5;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * §10 "Historical model — time-of-day distributions … recalibrated".
 *
 * Folds accepted observations into per-local-hour percentile bands. A band with
 * fewer than `MIN_SAMPLES_PER_BAND` readings IS NOT PUBLISHED — a p90 over two
 * samples is a number with the shape of a distribution and none of its content,
 * and publishing it is how a degenerate estimate acquires false authority (the
 * exact failure `LayoverFeasibility.Estimate` documents for its own flat
 * percentiles).
 *
 * `localHourOf` is injected rather than imported so this stays pure and the
 * caller keeps ownership of the airport's timezone.
 */
export function buildHistoricalModel(
  observations: AirportObservation[],
  opts: {
    nowMs: number;
    factType: AirportFactType;
    airportRef: string;
    localHourOf: (isoInstant: string) => number;
  },
): HistoricalModel {
  const byHour = new Map<number, number[]>();
  for (const s of screenObservations(observations, opts)) {
    if (s.rejected !== null) continue;
    const hour = opts.localHourOf(s.observation.observedAt);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const bucket = byHour.get(hour) ?? [];
    bucket.push(s.observation.value);
    byHour.set(hour, bucket);
  }

  const bands: HistoricalBand[] = [];
  for (const [hour, values] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    if (values.length < MIN_SAMPLES_PER_BAND) continue;
    const sorted = [...values].sort((a, b) => a - b);
    bands.push({
      hour,
      samples: sorted.length,
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p90: percentile(sorted, 90),
    });
  }
  return {
    truthVersion: LAYOVER_TRUTH_VERSION,
    airportRef: opts.airportRef,
    factType: opts.factType,
    bands,
    minSamplesPerBand: MIN_SAMPLES_PER_BAND,
  };
}

export interface CalibrationResult {
  /** Bands that had both a prediction and at least one outcome. */
  comparedBands: number;
  /** Mean signed error, predicted − actual, in minutes. Positive = pessimistic. */
  meanSignedErrorMin: number;
  /** Mean absolute error in minutes. */
  meanAbsoluteErrorMin: number;
  /** Share of outcomes at or under the band's p90. Target: >= 0.9. */
  p90CoverageRate: number;
}

/**
 * §22 L4 "Calibrated — prediction errors measured, model calibrated by airport
 * and time band".
 *
 * Measures the model against outcomes. It MEASURES ONLY — it does not adjust
 * the bands, because adjusting a model on this tree's zero observations would
 * be fitting to nothing. `comparedBands: 0` is the honest answer when there is
 * no evidence, and it is what every call on this tree returns.
 */
export function measureCalibration(
  model: HistoricalModel,
  outcomes: Array<{ hour: number; actualMinutes: number }>,
): CalibrationResult {
  const byHour = new Map(model.bands.map((b) => [b.hour, b]));
  let n = 0;
  let signed = 0;
  let absolute = 0;
  let covered = 0;
  const hoursSeen = new Set<number>();
  for (const o of outcomes) {
    const band = byHour.get(o.hour);
    if (!band) continue;
    hoursSeen.add(o.hour);
    n += 1;
    signed += band.p90 - o.actualMinutes;
    absolute += Math.abs(band.p90 - o.actualMinutes);
    if (o.actualMinutes <= band.p90) covered += 1;
  }
  return {
    comparedBands: hoursSeen.size,
    meanSignedErrorMin: n === 0 ? 0 : signed / n,
    meanAbsoluteErrorMin: n === 0 ? 0 : absolute / n,
    p90CoverageRate: n === 0 ? 0 : covered / n,
  };
}
