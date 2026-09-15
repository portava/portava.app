/**
 * discoveryLiveRank — Sensing §8's ranking inputs, as a PURE engine.
 *
 * §8 (`docs/specs/…Sensing…v1.txt:132-133,136`): "Discovery becomes 'what is
 * worth considering now or soon,' not merely static relevance/popularity" and
 * "Rank using live ExperienceState, forecast, travel time, friction,
 * compatibility, freshness, safety and Opportunity value", with "intent modes
 * using the same shared intelligence: Right Now, Tonight, Explore, Quiet,
 * Social, High Energy, Nearby, Trip."
 *
 * ── THE SAME INTELLIGENCE, NOT A SECOND COPY OF IT ───────────────────────────
 * Every world fact this module uses arrives as `LiveClaimEnvelope`s from
 * lib/liveClaimRead — the one gated, decision-exposure read path — and is
 * summarised by `summariseLiveState` and valued by `experienceValue` from
 * lib/compassDecision. Those are literally the functions Compass's §10
 * decision runs on, imported rather than restated, so Discovery cannot rank on
 * a reading Compass would refuse, and the two surfaces cannot drift. §1: "do
 * not replace working systems with parallel substitutes."
 *
 * ── WHAT A LIVE READING MAY AND MAY NOT DO TO AN ORDER ───────────────────────
 * The engine does not produce the order. It produces a BOUNDED MOVE over the
 * order the personal ranker already produced (lib/discoveryPde), because §8's
 * other bullet — "keep search/retrieval truth separate from recommendation
 * ranking" — and §1's compatibility rule both say the live layer extends the
 * existing ranker rather than replacing it. Each grade carries an `influence`
 * in −1..1 and `rankDiscoveryLive` spends it in POSITIONS:
 * `LIVE_RANK_MAX_POSITIONS` is the most a row may move on live evidence, in
 * either direction. A place nobody has ever reported on cannot be pushed off
 * page one by one that has been, and a fully-evidenced place cannot travel
 * from nowhere to the top.
 *
 * Five refusals are the load-bearing part, each one a §2 separation:
 *
 *   1. SAFETY OUTRANKS OPPORTUNITY (§7, §16, §20). A Live-qualified
 *      `unsafe_density` reading sets `safety.unsafe` and DEMOTES: the row is
 *      forced behind every non-demoted row in the window and its opportunity
 *      value is 0. There is no weight, no mode and no evidence combination
 *      that can promote it. This is the census's S66 gap — the Map strips
 *      promotion near a notice and Compass answers SKIP, and until this module
 *      existed Discovery's ranker read no safety state at all.
 *
 *   2. NO COVERAGE ≠ QUIET (§2). A candidate with no live evidence gets
 *      `influence = 0` and keeps its incoming position. Absence is never scored;
 *      an unobserved place is not ranked as though it had been observed and
 *      found empty.
 *
 *   3. "COULD NOT LOOK" ≠ "SAW NOTHING" (§20). When the live gates are closed
 *      the subject is `readable: false`, the evidence label is `unreadable`
 *      rather than `none`, and — as in case 2 — nothing moves. The two states
 *      are distinguishable on the wire.
 *
 *   4. BUSY ≠ GOOD (§2). Crowd level reaches the score ONLY through
 *      `experienceValue`, which is intent-relative and answers null without a
 *      declared crowd preference. Under `explore`, `nearby`, `right_now`,
 *      `tonight` and `trip` — the five modes with no crowd preference — the
 *      compatibility axis is null, and two rows that differ ONLY in how
 *      crowded they are receive the IDENTICAL influence. Nothing makes a
 *      crowded place rank higher for a viewer who never said they wanted one.
 *      (Freshness and travel time still contribute under those modes: they are
 *      two of §8's eight named inputs and neither is a claim about whether a
 *      place is good.)
 *
 *   5. PROMOTIONAL CLAIM ≠ OBSERVED REALITY, PREDICTION ≠ CURRENT TRUTH (§2).
 *      Only READINGS — Live-qualified AND observational by the §5.1 derivation
 *      (lib/compassDecision.isReading) — populate the crowd, friction and
 *      freshness axes. A sponsored or materially-conflicting claim is not a
 *      reading. A trajectory that is merely EMERGING (below the live floor)
 *      reaches the forecast axis at `FORECAST_EMERGING_WEIGHT` and is labelled
 *      `forecast`, never counted as a current observation.
 *
 * ── whyNow ───────────────────────────────────────────────────────────────────
 * Every `whyNow` entry names a claim value that qualified, in the claim's own
 * vocabulary, with the truth class of the evidence. It is built from the
 * summarised state and nothing else: with no reading the list is EMPTY, which
 * is "nothing was observed", never "nothing worth mentioning". This is the
 * producer census row S70 recorded as absent.
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected), no identity. The
 * gated read and the flag live in lib/discoveryLiveRankRead.
 */
import {
  experienceValue,
  summariseLiveState,
  interceptPeak,
  type DecisionIntent,
  type DecisionSubject,
  type LiveStateSummary,
  type PeakInterception,
} from "./compassDecision.js";
import { isEmergingInfluenceEligible } from "../compass/CompassLiveConstraints.js";
import type { TruthMetadata } from "./experienceTruth.js";
import type { FreshnessState } from "./mapObjects.js";
import type { LiveClaimEnvelope } from "./liveClaimRead.js";

/** The envelope fields this module reads. Structural, so a test double cannot drift. */
type LiveClaimEnvelopeLike = Pick<LiveClaimEnvelope, "claimType" | "value">;

/** §8's eight intent modes, in the spec's own order and wording. */
export const DISCOVERY_INTENT_MODES = [
  "right_now", "tonight", "explore", "quiet", "social", "high_energy", "nearby", "trip",
] as const;
export type DiscoveryIntentMode = (typeof DISCOVERY_INTENT_MODES)[number];

/**
 * The most positions a row may move on live evidence, in either direction. A
 * TUNABLE, recorded here as a knob rather than an owner ruling — the SHAPE
 * (bounded, additive over an existing order, never authoritative) is what §1
 * and §8 require.
 */
export const LIVE_RANK_MAX_POSITIONS = 15;
/** How many head rows the live layer may re-rank. Beyond it the order is untouched. */
export const LIVE_RANK_WINDOW = 60;
/** Minutes at which the travel-time axis reaches zero. */
export const TRAVEL_HORIZON_MINUTES = 45;
/** An EMERGING trajectory is below the live floor: it counts, at this fraction, as forecast. */
export const FORECAST_EMERGING_WEIGHT = 0.5;
/** Default queue tolerance when the mode and the viewer state none. */
export const DEFAULT_QUEUE_TOLERANCE_MINUTES = 30;

/**
 * Freshness → axis, over mapObjects' whole `FreshnessState` vocabulary. A
 * historical pattern is not current evidence and contributes nothing, and an
 * UNKNOWN freshness contributes nothing either — it is not a middling
 * freshness, it is the absence of one.
 */
const FRESHNESS_AXIS: Readonly<Record<FreshnessState, number>> = {
  live: 1, recent: 0.6, aging: 0.4, stale: 0.2, historical: 0, unknown: 0,
};

/**
 * One mode's weights over the SAME axes. A mode is a parameterisation, never a
 * second engine — that is what §8's "the same shared intelligence" asks for.
 *
 * `intent` is the crowd preference this mode declares to `experienceValue`;
 * null means the mode has no crowd preference and the compatibility axis is
 * null for it (see refusal 4).
 */
export interface IntentModeProfile {
  intent: DecisionIntent | null;
  weights: {
    compatibility: number;
    forecast: number;
    travel: number;
    friction: number;
    freshness: number;
    interception: number;
    durability: number;
  };
  queueToleranceMinutes: number;
}

export const INTENT_MODE_PROFILES: Readonly<Record<DiscoveryIntentMode, IntentModeProfile>> = {
  // "Right Now": reachable before the window closes, and reachable soon.
  right_now: { intent: null, weights: { compatibility: 0, forecast: 0.1, travel: 0.3, friction: 0.3, freshness: 0.3, interception: 1, durability: 0 }, queueToleranceMinutes: 15 },
  // "Tonight": a building trajectory is the point; a fading one is not.
  tonight:   { intent: null, weights: { compatibility: 0, forecast: 1, travel: 0.1, friction: 0.2, freshness: 0.2, interception: 0.2, durability: 0.3 }, queueToleranceMinutes: 45 },
  // "Explore": no crowd preference at all; live evidence may only lower.
  explore:   { intent: "explore", weights: { compatibility: 0, forecast: 0.1, travel: 0.1, friction: 0.3, freshness: 0.1, interception: 0.3, durability: 0 }, queueToleranceMinutes: 30 },
  quiet:      { intent: "quiet",       weights: { compatibility: 1, forecast: 0.3, travel: 0.2, friction: 0.4, freshness: 0.3, interception: 0.3, durability: 0 }, queueToleranceMinutes: 10 },
  social:     { intent: "social",      weights: { compatibility: 1, forecast: 0.3, travel: 0.2, friction: 0.3, freshness: 0.3, interception: 0.3, durability: 0 }, queueToleranceMinutes: 30 },
  high_energy:{ intent: "high_energy", weights: { compatibility: 1, forecast: 0.4, travel: 0.2, friction: 0.2, freshness: 0.3, interception: 0.3, durability: 0 }, queueToleranceMinutes: 45 },
  // "Nearby": travel time dominates; nothing else may outrank distance.
  nearby:    { intent: null, weights: { compatibility: 0, forecast: 0, travel: 1, friction: 0.3, freshness: 0.1, interception: 0.2, durability: 0 }, queueToleranceMinutes: 30 },
  // "Trip": prefers what will STILL be true later over what is momentary.
  trip:      { intent: null, weights: { compatibility: 0, forecast: 0.2, travel: 0.2, friction: 0.3, freshness: 0.1, interception: 0.2, durability: 1 }, queueToleranceMinutes: 45 },
};

/** The label a mode declares to `experienceValue`; null ⇒ no crowd preference. */
export function intentForMode(mode: DiscoveryIntentMode): DecisionIntent | null {
  return INTENT_MODE_PROFILES[mode].intent;
}

/** Why a candidate has (or has not) live evidence. `unreadable` ≠ `none` (§20). */
export type LiveEvidenceLabel = "reading" | "forecast" | "none" | "unreadable";

export interface DiscoveryLiveRankAxes {
  /** Intent-relative experience value, 0..1; null when the mode declares no crowd preference. */
  compatibility: number | null;
  /** −1 fading · 0 steady · +1 building, scaled by `FORECAST_EMERGING_WEIGHT` when merely emerging. Null when no trajectory. */
  forecast: number | null;
  /** 1 at zero minutes decaying to 0 at `TRAVEL_HORIZON_MINUTES`; null when the ETA is unknown. */
  travel: number | null;
  /** −1..0. A refused walk-in is −1; a queue at or past tolerance scales to −1. Null when no friction claim. */
  friction: number | null;
  /** 0..1 from the §5.1 freshness of the evidence; null when there is none. */
  freshness: number | null;
  /** 0 when arrival precedes the horizon or the question is unanswerable, −1 when the window would have decayed. */
  interception: number | null;
  /** 0..1: how much of the mode's own horizon the window still covers. Null when there is no horizon. */
  durability: number | null;
}

export interface DiscoveryLiveRank {
  /** The row id this grades — the DISCOVERY id space, as served. */
  id: string;
  mode: DiscoveryIntentMode;
  evidence: LiveEvidenceLabel;
  axes: DiscoveryLiveRankAxes;
  /** The composite in 0..1, or null when no axis is known. Never a measurement. */
  opportunityValue: number | null;
  /**
   * The signed live influence in −1..1, which `rankDiscoveryLive` spends in
   * positions. 0 whenever `opportunityValue` is null, and 0 for a demoted row
   * (safety moves it by a different rule, not by a bigger number).
   */
  influence: number;
  /** Live-qualified `unsafe_density`: demoted behind every other row, never promoted. */
  safety: { unsafe: boolean; demoted: boolean };
  /** §5.1 block of the evidence the grade rests on; null when there is none. */
  truth: TruthMetadata | null;
  interception: PeakInterception;
  /** Grounded reasons, claim vocabulary only, ≤ `WHY_NOW_MAX`. Empty ⇒ nothing was observed. */
  whyNow: string[];
  /** Ids of the envelopes the grade rests on. No contributor, no count, no coordinate. */
  claimRefs: string[];
}

/** One row the engine grades. `subjectId` null ⇒ the row has no canonical live subject. */
export interface LiveRankRow {
  id: string;
  subjectId: string | null;
  envelopes: readonly import("./liveClaimRead.js").LiveClaimEnvelope[];
  /** False ⇒ the live gates refused the read; an empty `envelopes` then means "could not look". */
  readable: boolean;
  distanceKm: number | null;
  /** Minutes to reach the row; null ⇒ derived from `distanceKm`, or unknown. */
  etaMinutes?: number | null;
}

export interface LiveRankOptions {
  mode: DiscoveryIntentMode;
  nowMs: number;
  /** Walking speed used to derive an ETA from `distanceKm`. */
  walkingSpeedKmh?: number;
  queueToleranceMinutes?: number | null;
  ttlSecondsFor?: (claimType: string) => number | null;
  /** Mode horizon for the durability axis, minutes. */
  durabilityHorizonMinutes?: number;
}

const WHY_NOW_MAX = 3;
const DEFAULT_WALKING_SPEED_KMH = 5;
const DEFAULT_DURABILITY_HORIZON_MINUTES = 180;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp11 = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x);

/**
 * The trajectory of the one envelope the EMERGING rule admits, or null. Reuses
 * `isEmergingInfluenceEligible` — Compass's own soft-influence rule — so a
 * claim Discovery treats as a forecast is exactly a claim Compass would.
 */
function trajectoryOfEmerging(envelopes: readonly LiveClaimEnvelopeLike[], nowMs: number): string | null {
  for (const e of envelopes) {
    if (e.claimType !== "crowd.trajectory") continue;
    if (!isEmergingInfluenceEligible(e as never, nowMs)) continue;
    const v = e.value;
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const t = (v as Record<string, unknown>).trajectory;
      if (typeof t === "string") return t;
    }
    return null;
  }
  return null;
}

/** Trajectory → forecast axis. The vocabulary is intelContracts', never re-spelt here. */
function trajectoryAxis(trajectory: string | null): number | null {
  if (trajectory === "building" || trajectory === "rising") return 1;
  if (trajectory === "fading" || trajectory === "falling") return -1;
  if (trajectory === "steady" || trajectory === "stable") return 0;
  return null;
}

/**
 * The friction axis from the summarised state. A walk-in explicitly refused is
 * the strongest negative there is short of safety; a queue is scaled against
 * the mode's tolerance and saturates at twice it.
 */
function frictionAxis(state: LiveStateSummary, toleranceMinutes: number): number | null {
  const parts: number[] = [];
  if (state.walkIn === false) parts.push(-1);
  if (state.queueMinMinutes !== null && toleranceMinutes > 0) {
    const over = state.queueMinMinutes - toleranceMinutes;
    if (over > 0) parts.push(-clamp01(over / toleranceMinutes));
    else parts.push(0);
  }
  if (parts.length === 0) return null;
  return Math.min(...parts);
}

/** How much of the mode's horizon the evidence window still covers, 0..1. */
function durabilityAxis(horizonAt: string | null, nowMs: number, horizonMinutes: number): number | null {
  if (!horizonAt || horizonMinutes <= 0) return null;
  const h = Date.parse(horizonAt);
  if (!Number.isFinite(h)) return null;
  return clamp01((h - nowMs) / (horizonMinutes * 60_000));
}

/** ETA in whole minutes: the caller's own estimate wins; otherwise walking over `distanceKm`. */
export function etaMinutesOf(row: LiveRankRow, walkingSpeedKmh: number): number | null {
  if (row.etaMinutes !== undefined && row.etaMinutes !== null && Number.isFinite(row.etaMinutes) && row.etaMinutes >= 0) {
    return Math.ceil(row.etaMinutes);
  }
  if (row.distanceKm !== null && Number.isFinite(row.distanceKm) && row.distanceKm >= 0 && walkingSpeedKmh > 0) {
    return Math.ceil((row.distanceKm / walkingSpeedKmh) * 60);
  }
  return null;
}

/**
 * The grounded reasons. Every entry names a value that QUALIFIED — the crowd
 * level, the trajectory, the vibe as reported, the queue, the refused walk-in —
 * in the claim's own vocabulary. Nothing is generated from a weight, a score or
 * an absence.
 */
export function whyNowFrom(
  state: LiveStateSummary,
  axes: DiscoveryLiveRankAxes,
  forecastTrajectory: string | null,
): string[] {
  const out: string[] = [];
  if (!state.live) {
    // Below the live floor a trajectory is the one thing that may be said, and
    // it is said as a FORECAST — never as something observed to be the case.
    if (forecastTrajectory) out.push(`forecast_${forecastTrajectory}`);
    return out.slice(0, WHY_NOW_MAX);
  }
  if (state.unsafe) out.push("crowd_unsafe_density");
  else if (state.crowdLevel) out.push(`crowd_${state.crowdLevel}`);
  if (state.trajectory) out.push(`trajectory_${state.trajectory}`);
  if (state.walkIn === false) out.push("walk_in_refused");
  else if (state.queueMinMinutes !== null && axes.friction !== null && axes.friction < 0) out.push(`queue_${state.queueMinMinutes}m`);
  if (state.vibe) out.push(`reported_vibe_${state.vibe}`);
  return out.slice(0, WHY_NOW_MAX);
}

/** The weighted composite, mapped from the signed axis space into 0..1. Null when no axis is known. */
export function opportunityValueOf(axes: DiscoveryLiveRankAxes, profile: IntentModeProfile): number | null {
  const w = profile.weights;
  const terms: Array<[number | null, number, boolean]> = [
    // [axis, weight, axisIsSigned]
    [axes.compatibility, w.compatibility, false],
    [axes.forecast,      w.forecast,      true],
    [axes.travel,        w.travel,        false],
    [axes.friction,      w.friction,      true],
    [axes.freshness,     w.freshness,     false],
    [axes.interception,  w.interception,  true],
    [axes.durability,    w.durability,    false],
  ];
  let num = 0;
  let den = 0;
  let known = 0;
  for (const [axis, weight, signed] of terms) {
    if (axis === null || weight <= 0) continue;
    known += 1;
    // An unsigned axis lives in 0..1 and is centred so that "no information"
    // (a null) and "middling" (0.5) cannot be confused in the composite.
    const v = signed ? clamp11(axis) : clamp11(axis * 2 - 1);
    num += v * weight;
    den += weight;
  }
  if (known === 0 || den === 0) return null;
  return clamp01((num / den + 1) / 2);
}

/** Grade ONE row. Pure. */
export function gradeLiveRow(row: LiveRankRow, opts: LiveRankOptions): DiscoveryLiveRank {
  const profile = INTENT_MODE_PROFILES[opts.mode];
  const nowMs = opts.nowMs;
  const walking = opts.walkingSpeedKmh ?? DEFAULT_WALKING_SPEED_KMH;
  const tolerance = opts.queueToleranceMinutes ?? profile.queueToleranceMinutes ?? DEFAULT_QUEUE_TOLERANCE_MINUTES;
  const subject: DecisionSubject = { subjectId: row.subjectId ?? row.id, envelopes: row.envelopes ?? [], readable: row.readable };
  const state = summariseLiveState(subject, nowMs, opts.ttlSecondsFor);
  const eta = etaMinutesOf(row, walking);
  const interception = interceptPeak(eta, state.horizonAt, nowMs);

  // A trajectory below the live floor is a FORECAST. `summariseLiveState` only
  // fills `trajectory` from LIVE-qualified readings, so the emerging one is
  // read here, from the envelope the emerging rule admits and no other.
  const forecastTrajectory = state.live
    ? null
    : trajectoryOfEmerging(row.envelopes ?? [], nowMs);
  const emergingTrajectory = !state.live && forecastTrajectory !== null;
  const evidence: LiveEvidenceLabel =
    state.live ? "reading"
    : emergingTrajectory ? "forecast"
    : row.readable ? "none"
    : "unreadable";

  const trajAxisRaw = state.live ? trajectoryAxis(state.trajectory) : trajectoryAxis(forecastTrajectory);
  const axes: DiscoveryLiveRankAxes = {
    compatibility: profile.intent === null ? null : experienceValue(state, profile.intent),
    forecast: trajAxisRaw === null ? null : (state.live ? trajAxisRaw : trajAxisRaw * FORECAST_EMERGING_WEIGHT),
    travel: eta === null ? null : clamp01(1 - eta / TRAVEL_HORIZON_MINUTES),
    friction: state.live ? frictionAxis(state, tolerance) : null,
    freshness: state.live ? FRESHNESS_AXIS[state.truth.freshness] ?? null : null,
    interception: interception.reachable === null ? null : interception.reachable ? 0 : -1,
    durability: state.live ? durabilityAxis(state.horizonAt, nowMs, opts.durabilityHorizonMinutes ?? DEFAULT_DURABILITY_HORIZON_MINUTES) : null,
  };

  // No evidence at all — whether because nothing was observed or because the
  // gates refused the read — means nothing is scored and nothing moves. The
  // travel axis alone is NOT evidence about the world: a distance is a property
  // of the viewer, and letting it move the order here would be a second,
  // unaudited distance ranker beside the one lib/discoveryPde already runs.
  const hasWorldEvidence = state.live || emergingTrajectory;
  const opportunityValue = hasWorldEvidence ? opportunityValueOf(axes, profile) : null;

  const unsafe = state.unsafe;
  const influence = unsafe || opportunityValue === null ? 0 : clamp11(opportunityValue * 2 - 1);

  return {
    id: row.id,
    mode: opts.mode,
    evidence,
    axes,
    opportunityValue: unsafe ? 0 : opportunityValue,
    influence,
    safety: { unsafe, demoted: unsafe },
    truth: hasWorldEvidence || state.claimRefs.length > 0 ? state.truth : null,
    interception,
    whyNow: whyNowFrom(state, axes, forecastTrajectory),
    claimRefs: state.claimRefs,
  };
}

export interface LiveRankOutcome<T> {
  /** The window rows in their new order, followed by the untouched tail. */
  ranked: T[];
  /** Grade per row id, for the window only. */
  byId: Map<string, DiscoveryLiveRank>;
  /** How many head rows were graded. */
  windowSize: number;
  /** Rows a safety reading pushed to the back of the window. */
  demoted: number;
}

/**
 * Re-rank the head window of `rows` on live evidence. Rows outside the window,
 * and rows the engine could not grade, keep their incoming order; the sort is
 * stable on the incoming index, so an ungraded row never overtakes another
 * ungraded row.
 */
export function rankDiscoveryLive<T extends LiveRankRow>(rows: readonly T[], opts: LiveRankOptions): LiveRankOutcome<T> {
  const windowSize = Math.min(rows.length, LIVE_RANK_WINDOW);
  const byId = new Map<string, DiscoveryLiveRank>();
  const head = rows.slice(0, windowSize);
  const tail = rows.slice(windowSize);
  const scored = head.map((row, index) => {
    const grade = gradeLiveRow(row, opts);
    byId.set(row.id, grade);
    // The incoming position IS the base score, in positions. Live evidence may
    // spend at most `LIVE_RANK_MAX_POSITIONS` of them, in either direction.
    const base = windowSize - index;
    return { row, index, grade, score: base + grade.influence * LIVE_RANK_MAX_POSITIONS };
  });
  scored.sort((a, b) => {
    // Safety first, and only ever downward: a demoted row sits behind every
    // non-demoted row whatever its score.
    if (a.grade.safety.demoted !== b.grade.safety.demoted) return a.grade.safety.demoted ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });
  return {
    ranked: [...scored.map((s) => s.row), ...tail],
    byId,
    windowSize,
    demoted: scored.filter((s) => s.grade.safety.demoted).length,
  };
}
