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
 * CORRECTED AGAIN 2026-10-18 (lane B2-LIVE): `liveConditions` now HAS a producer —
 * services/airport/layoverLiveSignals.ts, behind `layover_live_signals_enabled`
 * (3885, seeded FALSE); with it OFF no observation moves a deadline, as before.
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
import type { LayoverReasonCode, LiveConditions } from "./LayoverSafetyEngine.js"; import type { SupabaseClient } from "@supabase/supabase-js"; import { isMissingSchemaError } from "../../lib/capability/schemaCapability.js"; // census L180 (lane 5): the one I/O function, at the foot

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
  return reconcileValidated(corpus, { nowMs: atTime, factType, airportRef: subject }).truth; // census L180 (lane B2-LIVE): validated before it can reach a safety calculation (foot of file)
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

// ── §18 `AirportTruthService.getTruth(subject, factType, atTime)` over the STORE ─
//
// census L180. Appended at the foot so no line above moves (this file is cited
// by line). `getTruth` above takes its corpus as an argument and says why —
// "there is no store to read". That stopped being true: `airport_fact_observations`
// (2860) IS APPLIED to production. This is the spec's version: it READS the store
// as of `atTime` and reconciles with the same §10.1 policy, untouched.
//
// THE ONE I/O FUNCTION IN THIS FILE. Everything above stays pure; this only
// fetches a corpus and hands it to `reconcile`. The client is the first argument,
// as every service on this tree takes it; the spec's three arguments follow.
//
// CORRECTED 2026-10-18 (lane B2-LIVE): the owner DECIDED L81 — stored observations
// may move a deadline, VALIDATED first. This now folds through `reconcileValidated`
// (foot of file), and the safety path reads the store through the same window in
// services/airport/layoverLiveSignals.ts, behind `layover_live_signals_enabled`.
//
// HISTORICAL `atTime` IS HONOURED, NOT APPROXIMATED. The read bounds both ends —
// observed at or before `atTime`, and not expired at `atTime` — so a question
// about an earlier instant is not answered with readings taken after it, and the
// bounded page (newest first) is never crowded out by later rows.

/** The most rows one truth read folds; newest first, so a bounded page is the freshest. */
export const STORED_TRUTH_READ_LIMIT = 500;

export type StoredTruthRefusal =
  /** `airport_fact_observations` is not in this database. */
  | "storage_unavailable"
  /** The read failed for any other reason. NEVER reported as an empty corpus. */
  | "read_failed";

export type StoredTruthRead =
  /** `truth` is null when nothing credible survived screening — an absence, never a zero. */
  | { ok: true; truth: TruthValue<number> | null; outcome: ReconciliationOutcome & { validation: ValidatedObservationWindow } } // lane B2-LIVE (L180): the outcome carries the validation window it was decided over
  | { ok: false; reason: StoredTruthRefusal };

export async function getTruthFromStore(
  db: SupabaseClient,
  subject: string,
  factType: AirportFactType,
  atTime: number,
): Promise<StoredTruthRead> {
  const atIso = new Date(atTime).toISOString();
  const { data, error } = await db
    .from("airport_fact_observations")
    .select("id,airport_ref,fact_type,value,observer_kind,observer_id,observer_trust,source_ref,observed_at")
    .eq("airport_ref", subject)
    .eq("fact_type", factType)
    .lte("observed_at", atIso)
    .gt("expires_at", atIso)
    .order("observed_at", { ascending: false })
    .limit(STORED_TRUTH_READ_LIMIT);
  if (error) return { ok: false, reason: isMissingSchemaError(error) ? "storage_unavailable" : "read_failed" };
  if (!Array.isArray(data)) return { ok: false, reason: "read_failed" };

  const corpus: AirportObservation[] = (data as Array<Record<string, unknown>>).map((r) => {
    const trust = r.observer_trust === null || r.observer_trust === undefined ? undefined : Number(r.observer_trust);
    return {
      observationId: String(r.id),
      airportRef: String(r.airport_ref),
      factType: r.fact_type as AirportFactType,
      // NUMERIC arrives as a string; a value that will not parse becomes NaN and
      // `screenObservations` rejects it as `not_finite`, never coerces it to 0.
      value: Number(r.value),
      observerKind: r.observer_kind as ObserverKind,
      observerId: String(r.observer_id),
      ...(trust === undefined || !Number.isFinite(trust) ? {} : { observerTrust: trust }),
      observedAt: String(r.observed_at),
      sourceRef: String(r.source_ref),
    };
  });
  const outcome = reconcileValidated(corpus, { nowMs: atTime, factType, airportRef: subject }); // census L180 (lane B2-LIVE): the VALIDATED window — see the foot of this file
  return { ok: true, truth: outcome.truth, outcome };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOVER 165, lane B2-LIVE — census L180: STORED OBSERVATIONS ARE VALIDATED
// BEFORE THEY CAN INFLUENCE A SAFETY CALCULATION.
//
// Appended at the foot so every line cited above keeps its number. `reconcile`
// is unchanged and still serves the published conditions card (GET/POST
// /observations). What is added is the stricter window the SAFETY path reads —
// `getTruth` and `getTruthFromStore` above now fold through it, and so does the
// live-signal producer (layoverLiveSignals.ts). Owner decision 2026-10-18:
// "Official airport information; Licensed or approved live feeds; Verified
// traveler observations; Confidence calculations; Data provenance; Freshness
// checks; Conflict resolution; Trust weighting; Outlier detection. Traveler
// reports are supporting evidence, not authoritative proof of safety."
//
// THE WINDOW, in the order the rules fire. Every rejection names exactly one
// reason, and a rejected reading is kept in `rejections`, never silently gone.
//   1. `screenObservations`, unchanged — plausibility range, freshness (the
//      class TTL), future-dated, duplicate id, the per-observer rate limit, and
//      the trust × decay weight.
//   2. TRUST FLOOR — an observer whose own declared standing (`observer_trust`)
//      is below MIN_REPORTER_TRUST does not count at all: "untrusted_reporter".
//      Absent standing is the kind's floor, exactly as `screenObservations`
//      reads it; only a DECLARED low standing removes a reading.
//   3. ONE READING PER REPORTER — the newest accepted reading per observer id;
//      every older one is "superseded_by_reporter". One person is one witness,
//      and their own earlier reading is not a second one.
//   4. OUTLIERS, COMMUNITY ONLY — the median absolute deviation over the
//      community readings, once at least OUTLIER_MIN_REPORTERS distinct
//      reporters remain: |x − median| > max(K · 1.4826 · MAD, 2 · tolerance) is
//      "outlier". A dispersion test needs a population, which is why it waits
//      for three (with two, `isImplausible`'s range and rule 5 are the guards).
//      It is NEVER applied to an official or feed reading: a crowd of short
//      readings can never vote an authoritative long queue away.
//   5. INDEPENDENT REPORTERS — for a SAFETY_CRITICAL fact, community readings
//      count only when at least MIN_INDEPENDENT_REPORTERS distinct reporters
//      survive 2–4; otherwise each is "uncorroborated" — EVEN BESIDE AN
//      OFFICIAL READING. `reconcile`'s floor applies only to a community-ONLY
//      set, so there one stranger could still raise an official figure and
//      move a deadline; here they cannot.
// ═══════════════════════════════════════════════════════════════════════════

/** Version of the validation POLICY below; bump on any threshold change. */
export const LIVE_VALIDATION_VERSION = "2026.10.18-1";
/** A declared `observer_trust` below this removes the reading (rule 2). */
export const MIN_REPORTER_TRUST = 0.25;
/** Distinct community reporters before the dispersion test is meaningful (rule 4). */
export const OUTLIER_MIN_REPORTERS = 3;
/** Rule 4's multiplier on the MAD-derived sigma. */
export const OUTLIER_MAD_K = 3;
/** MAD → sigma for a normal population. */
export const MAD_TO_SIGMA = 1.4826;
/** Rule 4 never calls a reading an outlier within this many conflict tolerances of the median. */
export const OUTLIER_MIN_DEVIATION_TOLERANCES = 2;
/** Rule 5: distinct community reporters a safety-critical community reading needs. */
export const MIN_INDEPENDENT_REPORTERS = MIN_COMMUNITY_CORROBORATION;

export type ValidationRejection =
  | ObservationRejection
  | "untrusted_reporter"
  | "superseded_by_reporter"
  | "outlier"
  | "uncorroborated";

export interface ValidatedObservationWindow {
  validationVersion: string;
  airportRef: string;
  factType: AirportFactType;
  /** The survivors: one per reporter, inliers, corroborated. Weighted as `screenObservations` weighted them. */
  accepted: ScreenedObservation[];
  /** Every reading that did not survive, with its one reason, in the order the rules fired. */
  rejections: Array<{ observationId: string; reason: ValidationRejection }>;
  /** Distinct observer ids among `accepted`, all kinds. */
  independentReporters: number;
  /** Distinct community observer ids among `accepted`. */
  communityReporters: number;
  outlierTest: { applied: boolean; median: number | null; mad: number | null; threshold: number | null };
  rulesApplied: string[];
  /** Rule 1's own output for every input reading — what existed, before rules 2–5. */
  screened: ScreenedObservation[];
}

/** Median of a list; null for an empty one. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Rules 1–5 above over one (airport, fact) pair. Pure: `nowMs` is an argument. */
export function validateObservationWindow(
  observations: AirportObservation[],
  opts: { nowMs: number; factType: AirportFactType; airportRef: string },
): ValidatedObservationWindow {
  const rulesApplied: string[] = [];
  const rejections: Array<{ observationId: string; reason: ValidationRejection }> = [];
  const reject = (s: ScreenedObservation, reason: ValidationRejection) => rejections.push({ observationId: s.observation.observationId, reason });

  // 1. screening, unchanged
  const screened = screenObservations(observations, opts);
  for (const s of screened) if (s.rejected !== null) reject(s, s.rejected);
  let live = screened.filter((s) => s.rejected === null);

  // 2. trust floor — only a DECLARED low standing removes a reading
  live = live.filter((s) => {
    const t = s.observation.observerTrust;
    if (typeof t === "number" && Number.isFinite(t) && t < MIN_REPORTER_TRUST) { reject(s, "untrusted_reporter"); return false; }
    return true;
  });

  // 3. one reading per reporter: the newest (screening has already proved every timestamp parses)
  const newest = new Map<string, ScreenedObservation>();
  for (const s of live) {
    const prev = newest.get(s.observation.observerId);
    if (!prev || Date.parse(s.observation.observedAt) >= Date.parse(prev.observation.observedAt)) newest.set(s.observation.observerId, s);
  }
  live = live.filter((s) => {
    if (newest.get(s.observation.observerId) === s) return true;
    reject(s, "superseded_by_reporter");
    return false;
  });

  // 4. community outliers, by median absolute deviation
  const tolerance = CONFLICT_TOLERANCE_MIN[opts.factType];
  let outlierTest: ValidatedObservationWindow["outlierTest"] = { applied: false, median: null, mad: null, threshold: null };
  const communityBefore = live.filter((s) => s.observation.observerKind === "community");
  if (communityBefore.length >= OUTLIER_MIN_REPORTERS) {
    const values = communityBefore.map((s) => s.observation.value);
    const median = medianOf(values)!;
    const mad = medianOf(values.map((v) => Math.abs(v - median)))!;
    const threshold = Math.max(OUTLIER_MAD_K * MAD_TO_SIGMA * mad, OUTLIER_MIN_DEVIATION_TOLERANCES * tolerance);
    outlierTest = { applied: true, median, mad, threshold };
    live = live.filter((s) => {
      if (s.observation.observerKind !== "community") return true;
      if (Math.abs(s.observation.value - median) > threshold) { reject(s, "outlier"); return false; }
      return true;
    });
    rulesApplied.push(`outlier test over ${values.length} community reporter(s): median ${median}, MAD ${mad}, threshold ${threshold.toFixed(1)} min`);
  } else if (communityBefore.length > 0) {
    rulesApplied.push(`outlier test not applied: ${communityBefore.length} community reporter(s), below ${OUTLIER_MIN_REPORTERS}`);
  }

  // 5. independent community reporters for a safety-critical fact — beside an official reading too
  const community = live.filter((s) => s.observation.observerKind === "community");
  if (SAFETY_CRITICAL_FACTS.has(opts.factType) && community.length > 0 && community.length < MIN_INDEPENDENT_REPORTERS) {
    for (const s of community) reject(s, "uncorroborated");
    live = live.filter((s) => s.observation.observerKind !== "community");
    rulesApplied.push(`community evidence dropped: ${community.length} independent reporter(s), below ${MIN_INDEPENDENT_REPORTERS}`);
  }

  return {
    validationVersion: LIVE_VALIDATION_VERSION,
    airportRef: opts.airportRef,
    factType: opts.factType,
    accepted: live,
    rejections,
    independentReporters: new Set(live.map((s) => s.observation.observerId)).size,
    communityReporters: new Set(live.filter((s) => s.observation.observerKind === "community").map((s) => s.observation.observerId)).size,
    outlierTest,
    rulesApplied,
    screened,
  };
}

/**
 * `reconcile` over the VALIDATED window: the §10.1 rules, unchanged, applied to
 * what survived rules 1–5. What `getTruth` and `getTruthFromStore` answer.
 */
export function reconcileValidated(
  observations: AirportObservation[],
  opts: { nowMs: number; factType: AirportFactType; airportRef: string },
): ReconciliationOutcome & { validation: ValidatedObservationWindow } {
  const validation = validateObservationWindow(observations, opts);
  const outcome = reconcile(validation.accepted.map((s) => s.observation), opts);
  // The DIAGNOSTICS describe what was read (rule 1), so a reader still sees a lone
  // stranger's report existed; the TRUTH is decided over what survived rules 2–5.
  const screenedIn = validation.screened.filter((s) => s.rejected === null);
  const corroboration = { ...outcome.corroboration };
  for (const kind of OBSERVER_KINDS) corroboration[kind] = new Set(screenedIn.filter((s) => s.observation.observerKind === kind).map((s) => s.observation.observerId)).size;
  return {
    ...outcome,
    screened: validation.screened,
    corroboration,
    rejections: validation.screened.filter((s) => s.rejected !== null).map((s) => ({ observationId: s.observation.observationId, reason: s.rejected! })),
    rulesApplied: [...validation.rulesApplied, ...outcome.rulesApplied],
    validation,
  };
}

/** A 2860 row as an observation (NUMERIC arrives as a string; unparseable → NaN → `not_finite`). */
export function storedObservationOf(r: Record<string, unknown>): AirportObservation {
  const trust = r.observer_trust === null || r.observer_trust === undefined ? undefined : Number(r.observer_trust);
  return {
    observationId: String(r.id),
    airportRef: String(r.airport_ref),
    factType: r.fact_type as AirportFactType,
    value: Number(r.value),
    observerKind: r.observer_kind as ObserverKind,
    observerId: String(r.observer_id),
    ...(trust === undefined || !Number.isFinite(trust) ? {} : { observerTrust: trust }),
    observedAt: String(r.observed_at),
    sourceRef: String(r.source_ref),
  };
}

/**
 * The live-signal producer's ONE read of the store: every fact in `factTypes`
 * at `subject`, observed at or before `atTime` and still inside `holdMinutes`
 * past its stored expiry (so a reading that has just gone stale can be HELD
 * and named DATA_STALE rather than vanish). Each row is still screened by its
 * own class TTL downstream; the wider window only lets the caller SEE it.
 * A failed read is a named refusal, never an empty corpus.
 */
export async function readStoredObservations(
  db: SupabaseClient,
  subject: string,
  factTypes: readonly AirportFactType[],
  atTime: number,
  holdMinutes: number,
): Promise<{ ok: true; corpus: AirportObservation[] } | { ok: false; reason: StoredTruthRefusal }> {
  const { data, error } = await db
    .from("airport_fact_observations")
    .select("id,airport_ref,fact_type,value,observer_kind,observer_id,observer_trust,source_ref,observed_at")
    .eq("airport_ref", subject)
    .in("fact_type", [...factTypes])
    .lte("observed_at", new Date(atTime).toISOString())
    .gt("expires_at", new Date(atTime - holdMinutes * 60_000).toISOString())
    .order("observed_at", { ascending: false })
    .limit(STORED_TRUTH_READ_LIMIT * 2);
  if (error) return { ok: false, reason: isMissingSchemaError(error) ? "storage_unavailable" : "read_failed" };
  if (!Array.isArray(data)) return { ok: false, reason: "read_failed" };
  return { ok: true, corpus: (data as Array<Record<string, unknown>>).map(storedObservationOf) };
}
