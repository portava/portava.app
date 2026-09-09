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
  TRAVEL_TIME_SOURCE_IS_ROUTED,
  type ActivityCandidate,
  type LayoverReasonCode,
  type LayoverWindow,
  type LeaveAdvice,
  type SafetyAssessment,
  type TravelTimeSource,
} from "./LayoverSafetyEngine.js";

/**
 * Version of the RECORD SHAPE, separate from `LAYOVER_ENGINE_VERSION` (the
 * arithmetic). A consumer that stored a record needs to know both: the engine
 * version says which rules produced the numbers, this one says which fields
 * were present to read them out of.
 *
 * History:
 *   2026.09.08-1  first certified record: single derivation for the four route
 *                 call sites, inputHash, §6.2 estimate representation.
 */
export const LAYOVER_FEASIBILITY_VERSION = "2026.09.08-1";

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
    estimateMinutesAt(b.timeOfDayExtra, percentile)
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
 * The generic "can I go landside at all" probe. `GET /:id/safety` has always
 * asked this question with a 20-minute leg and a 30-minute activity that
 * describe no real place (census L293c); the numbers are unchanged, but they
 * are now a NAMED INPUT that lands in the record and in the hash, instead of a
 * literal buried in a route handler where nothing could see it.
 */
export interface LandsideProbe {
  title: string;
  travelTimeMin: number;
  activityTimeMin: number;
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
}

/** Project the domain objects onto the named input set. */
export function feasibilityInputs(
  airport: FeasibilityAirport,
  session: FeasibilitySession,
  opts: { nowMs: number; landsideProbe?: LandsideProbe | null; bufferPercentile?: EstimatePercentile },
): FeasibilityInputs {
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
   * because the forbid half turns on entry permission state (§6.1 L48) which
   * nothing on this tree reads, and inventing a prohibition from a confidence
   * we already know is LOW for every production session would block every
   * traveller on a fact we have not measured. Reported, not decided.
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
function outboundTravelEstimate(probe: LandsideProbe): Estimate {
  const source = travelTimeSourceFor({
    insideAirport: false,
    travelTimeSource: probe.travelTimeSource,
  });
  const routed = TRAVEL_TIME_SOURCE_IS_ROUTED[source];
  return pointEstimate(
    probe.travelTimeMin,
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

  // ONE deadline computation. Everything below reads it; nothing recomputes it.
  const deadline = computeReturnDeadline(airport, session);
  const envelope = computeWindow(airport, session, nowMs);

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

  const advice = adviseLeaving(airport, session, envelope, {
    travelTimeSource: probe?.travelTimeSource,
  });

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
  opts: { nowMs: number; landsideProbe?: LandsideProbe | null; bufferPercentile?: EstimatePercentile },
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
