/**
 * LayoverFeasibility — the certified operational truth for one layover session.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §1   "one canonical operational truth … the Layover domain publishes
 *         certified outputs" (census L1)
 *   §2.1 "Every consequential recommendation is versioned, explainable and
 *         replayable"; "All surfaces consume the same certified snapshot; no
 *         duplicate time-budget logic" (census L2, L5)
 *   §6.2 Estimate representation (census L54, L55)
 *   §9   the recommendation contract's certification fields
 *
 * WHY THIS MODULE EXISTS. Before it, feasibility was derived independently at
 * four route call sites — `GET /:id/safety`, `POST /:id/return-deadline`,
 * `GET /:id/overview` and the `/stops` responder — each assembling its own
 * combination of `assess()`, `computeWindow()` and `adviseLeaving()`. They
 * agreed only because they happened to call the same helpers in the same
 * order; nothing held them to it, and the census's headline defect 2 was
 * exactly that agreement breaking (a `returnBufferMin` from one anchor beside
 * a `hardReturnTime` from another). This module is now the ONLY thing those
 * four sites consult, and every number they publish comes out of ONE record.
 *
 * WHAT "CERTIFIED" MEANS HERE, concretely and no more than this:
 *   - the input set is explicit and fully named (`FeasibilityInputs`) — the
 *     record cannot depend on a field nobody listed, because the narrowed
 *     `Pick<>` types below are all the arithmetic is given;
 *   - nothing is read from a global: `nowMs` is a required input, there is no
 *     `Date.now()` in this file and no `Date.now()` default;
 *   - the record carries `engineVersion` (the arithmetic), `feasibilityVersion`
 *     (this record's shape) and `inputHash` (a digest over the exact inputs);
 *   - `replayFeasibility(record.inputs)` reproduces the record byte-for-byte —
 *     pinned by `src/test/layoverFeasibilityRecord.test.ts`.
 *
 * WHAT IT IS NOT. It is not a snapshot table (nothing here writes), not a
 * confidence model beyond what the inputs support, and it does not decide what
 * a BLOCKED recommendation looks like on screen — that is an owner decision
 * (census L50) and this module deliberately leaves it open: it publishes the
 * verdict and the per-candidate rating, and no caller's filtering changed.
 */
import type { EntryEligibility } from "./layoverEntryGate.js";
import { createHash } from "node:crypto";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import {
  LAYOVER_ENGINE_VERSION,
  assess,
  adviseLeaving,
  computeWindow,
  computeReturnDeadline,
  travelTimeSourceFor,
  assessWindowOnly,
  TRAVEL_TIME_SOURCE_IS_ROUTED,
  type ActivityCandidate,
  type LayoverReasonCode,
  type LayoverWindow,
  type LeaveAdvice,
  type LiveConditions,
  type SafetyAssessment,
  type SafetyRating,
  type TravelTimeSource,
} from "./LayoverSafetyEngine.js";
// L47's classifier, reused for the same reason census L293 reuses it in the
// engine: a landside 0 is an absence, not a free journey.
import { statedTravelMin } from "./LayoverPlanFit.js";

/**
 * Version of the RECORD SHAPE, separate from `LAYOVER_ENGINE_VERSION` (the
 * arithmetic). A consumer that stored a record needs to know both: the engine
 * version says which rules produced the numbers, this one says which fields
 * were present to read them out of.
 *
 * History:
 *   2026.09.08-1  first certified record: single derivation for the four route
 *                 call sites, inputHash, §6.2 estimate representation.
 *   2026.09.13-1  §10 `liveConditions` becomes a named input (so it is inside
 *                 the hash and inside a replay) and a sixth `liveExtra`
 *                 estimate. `null` for every caller on this tree outside
 *                 tests; the shape changed, so the shape's version moved.
 *   2026.09.14-1  §8.1 L72: a seventh `returnTransport` estimate beside a
 *                 seventh breakdown term. The shape gained a field, so the
 *                 shape's version moved; the arithmetic gained a term, so
 *                 `LAYOVER_ENGINE_VERSION` moved too and for its own reason.
 */
export const LAYOVER_FEASIBILITY_VERSION = "2026.09.14-1";

// ── §6.2 Estimate representation ─────────────────────────────────────────────

/**
 * Where a minutes figure came from, most-trusted last. Only the two weakest
 * classes have producers on this tree; the rest are declared so a future
 * producer cannot invent a spelling, and so `worstConfidence` has a total
 * order to fold over.
 *
 *   STATIC_DEFAULT   a constant in this repository's source (the exit-delay
 *                    45/25/15/+20, the time-of-day band, a category travel
 *                    time). Nothing about the specific airport went into it.
 *   AIRPORT_PROFILE  an `airport_profiles` column for THIS airport. Measured
 *                    2026-09-07: 3,206 production rows, 0 with any non-default
 *                    buffer and 0 verified — so in production this class is
 *                    today a per-airport row holding the generic constants.
 *                    It is still a stronger class than STATIC_DEFAULT because
 *                    the value is addressable and can be curated per airport.
 *   HISTORICAL       an aggregate over past observations. No producer.
 *   LIVE             a current observation with a TTL. No producer.
 *   USER_DECLARED    the traveller asserted it. No producer.
 */
export const ESTIMATE_SOURCE_CLASSES = [
  "STATIC_DEFAULT",
  "AIRPORT_PROFILE",
  "HISTORICAL",
  "LIVE",
  "USER_DECLARED",
] as const;
export type EstimateSourceClass = (typeof ESTIMATE_SOURCE_CLASSES)[number];

/** Ordered weakest-first; `worstConfidence` folds with this order. */
export const ESTIMATE_CONFIDENCES = ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"] as const;
export type EstimateConfidence = (typeof ESTIMATE_CONFIDENCES)[number];

/**
 * How far the value fell back from a live measurement. Lower is better.
 * 0 live · 1 historical aggregate · 2 curated per-airport row · 3 code constant.
 * Everything this tree produces is 2 or 3.
 */
export type EstimateFallbackLevel = 0 | 1 | 2 | 3;

/**
 * Spec §6.2 `Estimate`. Every field the spec names is present.
 *
 * THE PERCENTILES ARE DEGENERATE AND MUST NOT BE PRESENTED AS A SPREAD.
 * `p50Minutes === p75Minutes === p90Minutes === valueMinutes` for every
 * estimate this tree can build, because no observation set exists to take a
 * percentile OF. Manufacturing a spread (say p90 = value × 1.3) would be
 * exactly the "fabricated freshness" §2.1 forbids — it would put a number in
 * front of a traveller that no measurement supports. So the shape is here, the
 * selection policy is here and applied, and the distribution is honestly flat.
 * `confidence` and `fallbackLevel` are what tell a consumer that.
 */
export interface Estimate {
  valueMinutes: number;
  p50Minutes: number;
  p75Minutes: number;
  p90Minutes: number;
  confidence: EstimateConfidence;
  sourceClass: EstimateSourceClass;
  /** Instant the underlying observation was made. `null` — nothing is observed. */
  observedAt: string | null;
  /** Instant the value stops being usable. `null` — constants do not expire. */
  expiresAt: string | null;
  fallbackLevel: EstimateFallbackLevel;
  /** What to look at to see where the number came from. */
  sourceRefs: string[];
}

export type EstimatePercentile = "p50" | "p75" | "p90";

/**
 * Spec §6.2: "Safety-critical calculations should use a configurable
 * conservative percentile … Do not collapse all estimates to a single average."
 *
 * The policy is configurable (this constant, overridable per call through
 * `FeasibilityInputs.bufferPercentile`) and it is conservative (p90, the
 * highest the spec names). It is a NO-OP ON THE NUMBERS TODAY because the
 * distributions are degenerate — see `Estimate`. Nothing here averages.
 */
export const SAFETY_CRITICAL_PERCENTILE: EstimatePercentile = "p90";

/** A single term at the chosen percentile, never below its own point value. */
export function estimateMinutesAt(e: Estimate, percentile: EstimatePercentile): number {
  const at = percentile === "p50" ? e.p50Minutes : percentile === "p75" ? e.p75Minutes : e.p90Minutes;
  return Math.max(e.valueMinutes, at);
}

/** Build a degenerate (single-point) estimate. The only kind this tree can make. */
function pointEstimate(
  valueMinutes: number,
  sourceClass: EstimateSourceClass,
  confidence: EstimateConfidence,
  fallbackLevel: EstimateFallbackLevel,
  sourceRefs: string[],
): Estimate {
  return {
    valueMinutes,
    p50Minutes: valueMinutes,
    p75Minutes: valueMinutes,
    p90Minutes: valueMinutes,
    confidence,
    sourceClass,
    observedAt: null,
    expiresAt: null,
    fallbackLevel,
    sourceRefs,
  };
}

/** Weakest confidence in a set — the confidence of anything built out of them. */
export function worstConfidence(estimates: Estimate[]): EstimateConfidence {
  let worst = ESTIMATE_CONFIDENCES.length - 1;
  for (const e of estimates) {
    const i = ESTIMATE_CONFIDENCES.indexOf(e.confidence);
    if (i >= 0 && i < worst) worst = i;
  }
  return ESTIMATE_CONFIDENCES[worst];
}

/**
 * The five terms `computeBuffer` adds up, as §6.2 estimates.
 *
 * These describe the buffer; they do not (yet) compute it. `computeBuffer` in
 * LayoverSafetyEngine remains the single arithmetic, and
 * `conservativeBufferMinutes` below is pinned by test to equal its
 * `totalBuffer`. THE SEAM: the day a real distribution exists for any term,
 * the selection here starts exceeding the point value and the buffer must be
 * taken from this function instead. Wiring that today would change nothing
 * except to add a second way to compute the number travellers act on.
 */
export interface BufferEstimates {
  baseBuffer: Estimate;
  immigrationExtra: Estimate;
  bagsExtra: Estimate;
  trafficExtra: Estimate;
  timeOfDayExtra: Estimate;
  /**
   * §10 live conditions as the sixth term. THE ONLY ESTIMATE ON THIS TREE THAT
   * CAN CARRY A NON-DEGENERATE PROVENANCE: when conditions are supplied it is
   * sourceClass LIVE at fallback level 0 with a real `observedAt`/`expiresAt`,
   * and when they are not it is a 0-minute STATIC_DEFAULT — which is what every
   * production request produces, because nothing supplies conditions.
   */
  liveExtra: Estimate;
  /**
   * §8.1 L72 — the return leg's ground-transport forecast, as the seventh term.
   *
   * It is a STATIC_DEFAULT at fallback level 3 and never claims better: the
   * band table behind it (`layoverRouting`, over `TripDepartureAssumptions`) is
   * an assumption about an hour, not a reading of a road. What makes it
   * different from the six above is that it is the only term whose value moves
   * with WHEN the traveller must be back, which is what census L72 asks for.
   */
  returnTransport: Estimate;
}

export interface FeasibilityEstimates extends BufferEstimates {
  /** Wheels-down → landside. Code constants, unrelated to the airport row. */
  exitDelay: Estimate;
  /**
   * One-way landside leg for the probe candidate, when there is one. Its
   * `sourceClass` follows `travelTimeSourceFor` — a category constant is
   * STATIC_DEFAULT, never AIRPORT_PROFILE and never better.
   */
  outboundTravel: Estimate | null;
}

/** Sum of the buffer terms at the configured conservative percentile. */
export function conservativeBufferMinutes(
  b: BufferEstimates,
  percentile: EstimatePercentile,
): number {
  return (
    estimateMinutesAt(b.baseBuffer, percentile) +
    estimateMinutesAt(b.immigrationExtra, percentile) +
    estimateMinutesAt(b.bagsExtra, percentile) +
    estimateMinutesAt(b.trafficExtra, percentile) +
    estimateMinutesAt(b.timeOfDayExtra, percentile) +
    estimateMinutesAt(b.returnTransport, percentile) +
    estimateMinutesAt(b.liveExtra, percentile)
  );
}

// ── The named input set ──────────────────────────────────────────────────────

/**
 * Exactly the airport fields the feasibility arithmetic reads. Narrowed on
 * purpose: an `AirportProfile` satisfies it, but the arithmetic cannot reach a
 * field that is not listed here, so the input set and the hash cannot silently
 * fall out of step with what is actually consumed.
 */
export type FeasibilityAirport = Pick<AirportProfile,
  | "iataCode" | "timezone" | "verified"
  | "domesticBufferMin" | "internationalBufferMin"
  | "immigrationExtraMin" | "checkedBagsExtraMin" | "trafficExtraMin"
> & { id: string | null };

/** Exactly the session fields the feasibility arithmetic reads. */
export type FeasibilitySession = Pick<LayoverSession,
  | "id" | "arrivalTime" | "departureTime" | "boardingTime"
  | "flightType" | "immigrationRequired" | "checkedBags" | "wantsToLeave"
>;

/**
 * A named landside journey to certify alongside the window.
 *
 * `GET /:id/safety` used to build one of these out of thin air — a 20-minute
 * leg and a 30-minute activity describing no real place, identical for every
 * session at every airport — purely so `assess` had something to score, and
 * published the score as the session's overall safety. §7 made the literal a
 * NAMED INPUT so it landed in the record's `inputHash`; census L293c is the
 * finding that naming a fabrication does not stop it being one, and the
 * route no longer passes a probe at all (`assessWindowOnly` answers instead).
 *
 * The shape survives because a caller that genuinely HAS a journey — a real
 * place with a real leg — should be able to certify it. Its terms are
 * therefore `number | null`: a probe may state that nobody measured the
 * journey, and `assess` then fails closed on it like any other candidate.
 */
export interface LandsideProbe {
  title: string;
  travelTimeMin: number | null;
  activityTimeMin: number | null;
  travelTimeSource: TravelTimeSource;
}

export interface FeasibilityInputs {
  /** Rules version required by the caller. Part of the hash. */
  engineVersion: string;
  feasibilityVersion: string;
  airport: FeasibilityAirport;
  session: FeasibilitySession;
  /** The instant the record is FOR. Required — this module reads no clock. */
  nowMs: number;
  /** §6.2 selection policy actually applied. */
  bufferPercentile: EstimatePercentile;
  /** Absent = the traveller's landside question is not being asked. */
  landsideProbe: LandsideProbe | null;
  /**
   * §10 reconciled live conditions behind the buffer. A NAMED INPUT rather
   * than an ambient read, for the same reason `landsideProbe` is one: it lands
   * in `inputHash`, so a record computed under an observed 40-minute security
   * queue is a different computation from the same session computed without
   * one, and `replayFeasibility` reproduces the right one. `null` for every
   * caller on this tree outside tests.
   */
  liveConditions: LiveConditions | null;
  /**
   * §6.1 entry permission. A NAMED INPUT for the same reason `liveConditions`
   * is one: this module reads no clock and does no I/O, and the corridor comes
   * from the database. The caller resolves it (`resolveLayoverEntry`) and hands
   * it in, so it lands in `inputHash` and `replayFeasibility` reproduces the
   * record that was actually certified rather than re-asking a table that may
   * since have been curated.
   *
   * `null` is UNRESOLVED, never permitted — see `adviseLeaving`.
   */
  entry: EntryEligibility | null;
}

/** Project the domain objects onto the named input set. */
export function feasibilityInputs(
  airport: FeasibilityAirport,
  session: FeasibilitySession,
  opts: {
    nowMs: number;
    landsideProbe?: LandsideProbe | null;
    bufferPercentile?: EstimatePercentile;
    liveConditions?: LiveConditions | null;
    entry?: EntryEligibility | null;
  },
): FeasibilityInputs {
  const live = opts.liveConditions ?? null;
  return {
    engineVersion: LAYOVER_ENGINE_VERSION,
    feasibilityVersion: LAYOVER_FEASIBILITY_VERSION,
    airport: {
      id: airport.id,
      iataCode: airport.iataCode,
      timezone: airport.timezone,
      verified: airport.verified,
      domesticBufferMin: airport.domesticBufferMin,
      internationalBufferMin: airport.internationalBufferMin,
      immigrationExtraMin: airport.immigrationExtraMin,
      checkedBagsExtraMin: airport.checkedBagsExtraMin,
      trafficExtraMin: airport.trafficExtraMin,
    },
    session: {
      id: session.id,
      arrivalTime: session.arrivalTime,
      departureTime: session.departureTime,
      boardingTime: session.boardingTime,
      flightType: session.flightType,
      immigrationRequired: session.immigrationRequired,
      checkedBags: session.checkedBags,
      wantsToLeave: session.wantsToLeave,
    },
    nowMs: opts.nowMs,
    bufferPercentile: opts.bufferPercentile ?? SAFETY_CRITICAL_PERCENTILE,
    landsideProbe: opts.landsideProbe ?? null,
    // Projected field by field, like `airport` and `session` above: a caller
    // handing in an object with extra keys must not change the hash, or two
    // structurally identical computations stop matching.
    liveConditions: live
      ? {
          securityWaitExtraMin: live.securityWaitExtraMin,
          immigrationWaitExtraMin: live.immigrationWaitExtraMin,
          groundTransportExtraMin: live.groundTransportExtraMin,
          reasonCodes: [...live.reasonCodes],
          observedAt: live.observedAt,
          expiresAt: live.expiresAt,
        }
      : null,
    // Projected field by field like everything above, so an extra key on the
    // caller's object cannot change the hash.
    entry: opts.entry
      ? opts.entry.state === "unresolved"
        ? { state: "unresolved", reason: opts.entry.reason }
        : {
            state: opts.entry.state,
            status: opts.entry.status,
            corridor: {
              passportCountry: opts.entry.corridor.passportCountry,
              destinationCountry: opts.entry.corridor.destinationCountry,
            },
          }
      : null,
  };
}

/**
 * Digest over the exact inputs, key order normalised so two structurally equal
 * input sets hash the same regardless of how they were built. Not a security
 * boundary — it is an identity for "which computation was this", so a stored
 * record can be matched against a recomputation (spec §18 replay, §20 ledger).
 */
export function feasibilityInputHash(inputs: FeasibilityInputs): string {
  return "sha256:" + createHash("sha256").update(stableStringify(inputs)).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort()
    .map((k) => JSON.stringify(k) + ":" + stableStringify(o[k]))
    .join(",") + "}";
}

// ── The record ───────────────────────────────────────────────────────────────

export interface LayoverFeasibilityRecord {
  feasibilityVersion: string;
  engineVersion: string;
  inputHash: string;
  /** ISO form of `inputs.nowMs`. */
  computedAt: string;
  /** Echoed verbatim: `replayFeasibility(record.inputs)` reproduces this record. */
  inputs: FeasibilityInputs;

  /** §9 the answer. */
  verdict: LeaveAdvice["verdict"];
  /**
   * Weakest confidence among the estimates behind the verdict. Spec §6.1 also
   * asks that a safety-critical unknown force INSUFFICIENT *and forbid landside
   * recommendations*. This record publishes the confidence; it does NOT forbid,
   * and the reason has CHANGED shape since this comment was written.
   *
   * Entry permission state (§6.1 L48) is now read — `resolveLayoverEntry`, fed
   * in as `inputs.entry` — so the forbid half no longer turns on a fact nothing
   * observes. What it turns on instead is a table with no INSERT in any
   * migration: every corridor is uncurated until somebody curates one, so
   * forbidding on an unconfirmed corridor would collapse landside for every
   * traveller on the app over a data gap. The verdict says `entry_unverified`
   * and the advice says why; the prohibition is still not invented here.
   * Reported, not decided.
   */
  confidence: EstimateConfidence;
  /** §7 freedom window / §8 envelope, as the engine computes it. */
  envelope: LayoverWindow;
  /** The one deadline computation every consumer sees. */
  deadline: {
    cutoffMs: number;
    hardReturnTime: Date;
    breakdown: SafetyAssessment["breakdown"];
  };
  /** §6.2 representation of every term above. */
  estimates: FeasibilityEstimates;
  /**
   * Buffer at the configured conservative percentile. Equal to
   * `deadline.breakdown.totalBuffer` while the distributions are degenerate —
   * pinned by test, and the assertion is the point: it is the tripwire for the
   * day the two stop agreeing.
   */
  bufferMinutesAtPercentile: number;

  /** §9 explanation, verbatim from the safety engine. */
  reasons: string[];
  unknowns: string[];
  reasonCodes: LayoverReasonCode[];
  disclaimer: string;

  /** The landside probe's assessment, when a probe was named. */
  landside: (SafetyAssessment & { probe: LandsideProbe }) | null;

  /**
   * The session's answer WITH NO JOURNEY IN IT — "given my window, can I go out
   * at all?" — rated against the same certified deadline as everything above.
   *
   * It exists because `GET /:id/safety` must publish an overall rating and used
   * to get one by inventing a candidate (census L293c). Computed here rather
   * than in the route so it cannot be derived twice, at two instants, from two
   * deadlines: that is the duplicate-buffer defect `9c26efba` closed, and a
   * second derivation in a handler is exactly how it came back last time.
   */
  windowOnly: SafetyAssessment;
}

/**
 * The probe's one-way landside leg as an estimate.
 *
 * Provenance decides the class, and it fails closed through the engine's
 * `travelTimeSourceFor` (an absent or unrecognised source resolves to the
 * least-trusted kind that applies). Whether a source is a real route is asked
 * of `TRAVEL_TIME_SOURCE_IS_ROUTED` rather than by comparing the string — see
 * that table for why. Today nothing on this tree is routed, so this is always
 * STATIC_DEFAULT / LOW / fallback 3.
 */
function outboundTravelEstimate(probe: LandsideProbe): Estimate | null {
  // NOTHING MEASURED, NOTHING ESTIMATED. A probe whose leg is unstated has no
  // outbound travel estimate — not a zero-minute one, and not a LOW-confidence
  // placeholder either. `estimates.outboundTravel` is already `Estimate | null`,
  // and `worstConfidence` folds in only the estimates that exist, so an absence
  // stays an absence all the way into the record's confidence.
  const stated = statedTravelMin({ travelMin: probe.travelTimeMin, insideAirport: false });
  if (stated === null) return null;
  const source = travelTimeSourceFor({
    insideAirport: false,
    travelTimeSource: probe.travelTimeSource,
  });
  const routed = TRAVEL_TIME_SOURCE_IS_ROUTED[source];
  return pointEstimate(
    stated,
    routed ? "LIVE" : "STATIC_DEFAULT",
    routed ? "MEDIUM" : "LOW",
    routed ? 0 : 3,
    [`travelTimeSource:${source}`],
  );
}

function bufferEstimates(inputs: FeasibilityInputs, breakdown: SafetyAssessment["breakdown"]): BufferEstimates {
  const a = inputs.airport;
  // A profile row is addressable per airport; a fallback profile (id === null)
  // is a code constant wearing an airport's name. Confidence follows the
  // airport maturity flag the spec §22 already defines — and measured
  // 2026-09-07, production has 0 verified airports, so this is LOW everywhere.
  const rowClass: EstimateSourceClass = a.id === null ? "STATIC_DEFAULT" : "AIRPORT_PROFILE";
  const rowLevel: EstimateFallbackLevel = a.id === null ? 3 : 2;
  const rowConf: EstimateConfidence = a.verified ? "MEDIUM" : "LOW";
  const col = (name: string) => (a.id === null
    ? [`StaticAirportData:${a.iataCode}`]
    : [`airport_profiles.${name}`]);

  return {
    baseBuffer: pointEstimate(
      breakdown.baseBuffer, rowClass, rowConf, rowLevel,
      col(inputs.session.flightType === "international" ? "international_buffer_min" : "domestic_buffer_min"),
    ),
    immigrationExtra: pointEstimate(breakdown.immigrationExtra, rowClass, rowConf, rowLevel, col("immigration_extra_min")),
    bagsExtra: pointEstimate(breakdown.bagsExtra, rowClass, rowConf, rowLevel, col("checked_bags_extra_min")),
    trafficExtra: pointEstimate(breakdown.trafficExtra, rowClass, rowConf, rowLevel, col("traffic_extra_min")),
    // The time-of-day ramp is a source constant, not an airport fact, whatever
    // the airport row says. It never claims better than STATIC_DEFAULT.
    timeOfDayExtra: pointEstimate(
      breakdown.timeOfDayExtra, "STATIC_DEFAULT", "LOW", 3,
      ["LayoverSafetyEngine.timeOfDayBand"],
    ),
    // §8.1 L72. The band table is a source constant like the ramp above it, so
    // it never inherits the airport row's class even though the MINUTES it
    // multiplies come from `traffic_extra_min` — that term is published as its
    // own estimate directly above, with the row's provenance, and claiming the
    // row's provenance twice would launder an assumption into an airport fact.
    returnTransport: pointEstimate(
      breakdown.returnTransportExtra, "STATIC_DEFAULT", "LOW", 3,
      // NAMES ITS PRODUCER, and it used to name a function no production path
      // calls. `layoverRouting.returnTransportForecast` is referenced nowhere
      // outside the tests; this value comes from LayoverSafetyEngine's own
      // `returnTransportExtra`, which ramps the time-of-day and return terms
      // JOINTLY and then subtracts timeOfDayExtra. The two agree wherever
      // timeOfDayExtra is 0 — which is why the wrong label survived — and
      // disagree at 15:00Z on a 475-minute layover, where this records 7 and
      // the helper returns 6. Pinned by layoverReturnConditions.test.ts §6.2.
      ["LayoverSafetyEngine.returnTransportExtra", "TripDepartureAssumptions.DEPARTURE_FACTORS"],
    ),
    liveExtra: liveExtraEstimate(inputs.liveConditions, breakdown.liveExtra),
  };
}

/**
 * The §10 live term as a §6.2 estimate.
 *
 * Two cases, and the difference between them is the whole point of §2.1's
 * "never fabricate freshness": with conditions supplied the term is LIVE at
 * fallback level 0 and carries the observation's own `observedAt`/`expiresAt`;
 * with none it is a ZERO-minute STATIC_DEFAULT at level 3 with a source ref
 * that says so in words. It never claims to be a live reading of "no queue".
 */
function liveExtraEstimate(live: LiveConditions | null, minutes: number): Estimate {
  if (!live) {
    return pointEstimate(0, "STATIC_DEFAULT", "LOW", 3, ["no live conditions supplied"]);
  }
  return {
    ...pointEstimate(minutes, "LIVE", "MEDIUM", 0, [
      `LayoverAirportTruth.liveConditionsFrom(${live.reasonCodes.join(",") || "no codes"})`,
    ]),
    observedAt: live.observedAt,
    expiresAt: live.expiresAt,
  };
}

/**
 * Certify feasibility for one session at one instant.
 *
 * Deterministic and side-effect free: no clock, no I/O, no randomness. The
 * same `inputs` always produce the same record, which is what makes
 * `inputHash` an identity rather than a decoration.
 */
export function certifyFeasibility(inputs: FeasibilityInputs): LayoverFeasibilityRecord {
  const { airport, session, nowMs } = inputs;

  const live = inputs.liveConditions;

  // ONE deadline computation. Everything below reads it; nothing recomputes it.
  const deadline = computeReturnDeadline(airport, session, live);
  const envelope = computeWindow(airport, session, nowMs, live);

  const probe = inputs.landsideProbe;
  const candidate: ActivityCandidate | null = probe
    ? {
        title: probe.title,
        travelTimeMin: probe.travelTimeMin,
        activityTimeMin: probe.activityTimeMin,
        travelTimeSource: probe.travelTimeSource,
        insideAirport: false,
      }
    : null;
  const landside = candidate
    ? { ...assess(airport, session, candidate, nowMs, deadline), probe: probe! }
    : null;
  // Same deadline object, not a second derivation. See `windowOnly`.
  const windowOnlyByClock = assessWindowOnly(airport, session, envelope, nowMs, deadline);

  const advice = adviseLeaving(airport, session, envelope, {
    travelTimeSource: probe?.travelTimeSource,
    liveConditions: live,
    entry: inputs.entry,
  });

  // ── ONE RESPONSE CANNOT SAY TWO THINGS ──────────────────────────────────
  //
  // `assessWindowOnly` rates the WINDOW and is right to: it reads a clock and
  // nothing else, and its name says so. Before the entry gate that was enough,
  // because the rating and the verdict were two readings of the SAME two
  // inputs — `usableMinutes` and `wantsToLeave` — and could not disagree;
  // `src/test/layoverUnmeasuredJourney.test.ts` pins that pairing.
  //
  // The gate breaks the coincidence. A traveller with ten spare hours and an
  // unconfirmed border gets `verdict: "entry_unverified"`, and `GET
  // /:id/safety` would serve `overallRating: "safe"` beside it — an
  // affirmative and a disclaimer about the same act, which is the L48 finding
  // put back one level down.
  //
  // So the published rating is CAPPED by the verdict here, at the one place
  // that holds both, rather than by teaching the clock about borders. It is a
  // minimum over the two, never a maximum: the cap can only take an
  // affirmation away. For every verdict that existed before the gate the cap
  // is the rating the clock already produced, so this is a no-op on them —
  // which is why the pairing test above still reads the raw engine.
  const VERDICT_CEILING: Record<LeaveAdvice["verdict"], SafetyRating> = {
    yes: "safe",
    tight: "possible_but_risky",
    // The clock said there is time and the border could not be checked. The
    // same band `LayoverCompassService.riskBand` gives it, so the two surfaces
    // agree by construction rather than by coincidence.
    entry_unverified: "possible_but_risky",
    no: "not_recommended",
    stay_airside: "airport_only",
  };
  // Worst-first, so `indexOf` is a severity rank. `airport_only` is not on the
  // scale: it is not a judgement about whether leaving is safe, it is the
  // traveller having said they are not leaving, and it is preserved whole.
  const RATING_RANK: SafetyRating[] = ["not_recommended", "possible_but_risky", "safe"];
  const ceiling = VERDICT_CEILING[advice.verdict];
  const capped =
    RATING_RANK.indexOf(ceiling) >= 0 &&
    RATING_RANK.indexOf(windowOnlyByClock.rating) > RATING_RANK.indexOf(ceiling);
  const windowOnly: SafetyAssessment = capped
    ? {
        ...windowOnlyByClock,
        rating: ceiling,
        // A demoted rating with no reason is a refusal nobody can explain
        // (App C2). The advice's last reason is the sentence that explains the
        // verdict doing the capping.
        warningReason: advice.reasons[advice.reasons.length - 1] ?? windowOnlyByClock.warningReason,
      }
    : windowOnlyByClock;

  const buffers = bufferEstimates(inputs, deadline.breakdown);
  const estimates: FeasibilityEstimates = {
    ...buffers,
    exitDelay: pointEstimate(
      envelope.exitDelayMin, "STATIC_DEFAULT", "LOW", 3,
      ["LayoverSafetyEngine.estimateExitDelay"],
    ),
    outboundTravel: probe ? outboundTravelEstimate(probe) : null,
  };

  const confidenceOver = [
    buffers.baseBuffer, buffers.immigrationExtra, buffers.bagsExtra,
    buffers.trafficExtra, buffers.timeOfDayExtra, estimates.exitDelay,
    ...(estimates.outboundTravel ? [estimates.outboundTravel] : []),
    // The live term folds in ONLY when it is a live term. A "no conditions
    // supplied" zero is a placeholder, and folding its LOW confidence in would
    // report the ABSENCE of live intelligence as evidence about the buffer.
    ...(live ? [buffers.liveExtra] : []),
  ];

  return {
    feasibilityVersion: LAYOVER_FEASIBILITY_VERSION,
    engineVersion: LAYOVER_ENGINE_VERSION,
    inputHash: feasibilityInputHash(inputs),
    computedAt: new Date(nowMs).toISOString(),
    inputs,
    verdict: advice.verdict,
    confidence: worstConfidence(confidenceOver),
    envelope,
    deadline,
    estimates,
    bufferMinutesAtPercentile: conservativeBufferMinutes(buffers, inputs.bufferPercentile),
    reasons: advice.reasons,
    unknowns: advice.unknowns,
    reasonCodes: advice.reasonCodes,
    disclaimer: advice.disclaimer,
    landside,
    windowOnly,
  };
}

/**
 * Spec §2.1 "replayable" / §18 `replay(sessionId, engineVersion)`.
 *
 * Feed a stored `record.inputs` back and get the identical record. This is a
 * separate name rather than a comment because "replay" is the operation the
 * spec asks for and a caller should be able to find it; it is deliberately the
 * same code path, because a replay that ran different code would prove nothing.
 */
export const replayFeasibility = certifyFeasibility;

/** Certify from the domain objects. The wrapper every route uses. */
export function certifySessionFeasibility(
  airport: FeasibilityAirport,
  session: FeasibilitySession,
  opts: {
    nowMs: number;
    landsideProbe?: LandsideProbe | null;
    bufferPercentile?: EstimatePercentile;
    liveConditions?: LiveConditions | null;
    /** Omitted = unresolved. Resolve it with `resolveLayoverEntry` and pass it. */
    entry?: EntryEligibility | null;
  },
): LayoverFeasibilityRecord {
  return certifyFeasibility(feasibilityInputs(airport, session, opts));
}

/**
 * The certification fields a consumer stores or logs beside a decision — the
 * §20 DecisionRecord header, without the record's bulk.
 */
export function certificationHeader(r: LayoverFeasibilityRecord) {
  return {
    engineVersion: r.engineVersion,
    feasibilityVersion: r.feasibilityVersion,
    inputHash: r.inputHash,
    computedAt: r.computedAt,
    verdict: r.verdict,
    confidence: r.confidence,
    bufferPercentile: r.inputs.bufferPercentile,
  };
}

// ── §2.1 "degrades VISIBLY" · §22 airport maturity ───────────────────────────

/**
 * How much of THIS airport's own intelligence the numbers rest on, weakest
 * first.
 *
 *   GENERIC          no `airport_profiles` row supplied any buffer term. The
 *                    minutes are this repository's constants; NOTHING about the
 *                    specific airport went into them.
 *   AIRPORT_RECORD   a row addressed to THIS airport supplied them, and nobody
 *                    has verified that row. Addressable is not curated: those
 *                    columns are `NOT NULL DEFAULT 60/90/120/180/30/15/20`
 *                    (`src/migrations/0127_layover_system.sql:28#domestic_buffer_min`),
 *                    so an uncurated row holds exactly the generic numbers.
 *                    What this rung claims is that the value CAN be curated per
 *                    airport, not that it has been.
 *   VERIFIED_RECORD  that row carries `verified = TRUE`. Measured 2026-09-07:
 *                    0 of 3,206 production rows do, so this rung is reachable
 *                    and currently empty in production.
 *   LIVE             a live observation folded into the buffer. Nothing on this
 *                    tree supplies `liveConditions` outside tests, so this rung
 *                    is DECLARED AND UNREACHED — it is here so a future producer
 *                    cannot invent a spelling, and the positive control in
 *                    `src/test/layoverAirportIntelligence.test.ts` is what stops
 *                    `liveObserved` from being a literal `false`.
 */
export const AIRPORT_INTELLIGENCE_TIERS = [
  "GENERIC",
  "AIRPORT_RECORD",
  "VERIFIED_RECORD",
  "LIVE",
] as const;
export type AirportIntelligenceTier = (typeof AIRPORT_INTELLIGENCE_TIERS)[number];

/**
 * What a surface must be able to say, in the traveller's own interest, about
 * where the minutes it is showing them came from.
 *
 * Census L9 (§2.1) — *"missing live intelligence degrades VISIBLY to
 * historical/conservative fallback"* — and L250 (§22) — *"do not imply
 * equivalent intelligence globally"* — are one gap stated twice: the fallback
 * ladder has always been real and it has never been visible. A traveller at an
 * airport nobody has curated read the same numbers, with the same presentation
 * and the same confidence, as one at an airport an admin had configured by
 * hand.
 *
 * EVERY FIELD IS READ OFF THE RECORD, NOT RECOMPUTED. The provenance comes from
 * `record.estimates` — the very objects `bufferEstimates` built the arithmetic
 * out of — and `airportVerified` from `record.inputs.airport`, the named input
 * set that is inside `inputHash`. A disclosure derived from a second read of
 * the profile could disagree with the numbers it describes, which is the
 * duplicate-derivation defect this module exists to prevent.
 *
 * IT DECIDES NOTHING. Like `confidence` above, this is reported and not acted
 * on. Withholding landside recommendations at the GENERIC rung is spec §22's
 * "airport-side guidance only by default" (census L243) — a product decision
 * with a cost, because in production EVERY airport is at GENERIC or
 * AIRPORT_RECORD — and it is not taken here.
 */
export interface AirportIntelligenceDisclosure {
  tier: AirportIntelligenceTier;
  /** True when an `airport_profiles` row for THIS airport supplied every buffer term. */
  airportAddressable: boolean;
  /** That row's own curation flag. False when there is no row. */
  airportVerified: boolean;
  /** True when a live observation folded into the buffer. */
  liveObserved: boolean;
  /** Weakest source class among the terms the AIRPORT supplies. */
  bufferSourceClass: EstimateSourceClass;
  /** Worst (highest) fallback level among those same terms. 2 = a row, 3 = a constant. */
  bufferFallbackLevel: EstimateFallbackLevel;
  /** The record's own confidence — the weakest estimate behind the verdict. */
  confidence: EstimateConfidence;
  /** What to look at to see where the numbers came from. Deduplicated, sorted. */
  sourceRefs: string[];
}

/**
 * The four terms the AIRPORT contributes, and deliberately only those.
 *
 * `timeOfDayExtra` and `exitDelay` are source constants whatever the airport
 * row says — `bufferEstimates` marks them STATIC_DEFAULT explicitly — so
 * folding them in would collapse every airport to GENERIC and destroy the
 * distinction this disclosure exists to draw.
 */
function airportSuppliedTerms(e: FeasibilityEstimates): Estimate[] {
  return [e.baseBuffer, e.immigrationExtra, e.bagsExtra, e.trafficExtra];
}

export function airportIntelligence(r: LayoverFeasibilityRecord): AirportIntelligenceDisclosure {
  const terms = airportSuppliedTerms(r.estimates);
  const airportAddressable = terms.every((t) => t.sourceClass === "AIRPORT_PROFILE");
  const airportVerified = r.inputs.airport.verified;
  const liveObserved = r.estimates.liveExtra.sourceClass === "LIVE";

  // Weakest class wins: ESTIMATE_SOURCE_CLASSES is ordered weakest-first, so a
  // single constant among four columns must not present as a curated airport.
  let weakest = ESTIMATE_SOURCE_CLASSES.length - 1;
  for (const t of terms) {
    const i = ESTIMATE_SOURCE_CLASSES.indexOf(t.sourceClass);
    if (i >= 0 && i < weakest) weakest = i;
  }

  const tier: AirportIntelligenceTier = liveObserved
    ? "LIVE"
    : airportAddressable && airportVerified
      ? "VERIFIED_RECORD"
      : airportAddressable
        ? "AIRPORT_RECORD"
        : "GENERIC";

  return {
    tier,
    airportAddressable,
    airportVerified,
    liveObserved,
    bufferSourceClass: ESTIMATE_SOURCE_CLASSES[weakest]!,
    bufferFallbackLevel: terms.reduce<EstimateFallbackLevel>(
      (worst, t) => (t.fallbackLevel > worst ? t.fallbackLevel : worst),
      0,
    ),
    confidence: r.confidence,
    sourceRefs: [...new Set(terms.flatMap((t) => t.sourceRefs))].sort(),
  };
}
