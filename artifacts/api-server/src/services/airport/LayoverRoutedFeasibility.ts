/**
 * LayoverRoutedFeasibility — §8 with ROUTED terms (LAYOVER 165, lane B1-R1).
 *
 * Owner decision 2026-10-18: Google Routes is approved for Layover. This module
 * is where the routed answer becomes the §8 answer:
 *
 *   §8  "Compute bidirectional reachability: airport → candidate and candidate
 *        → airport under future return-time conditions."              (L60)
 *   §8  "candidate_feasible iff outbound_arrival + minimum_experience_duration
 *        + conservative_return_duration <= hard_return_by"            (L65)
 *   §8  "SafeEnvelope = union(points satisfying feasibility constraint)" (L66)
 *   §8  "Use time-based isochrone/envelope geometry, not a fixed radius." (L61)
 *   §8  "Envelope edges must contract as confidence drops or return risk
 *        rises."                                                       (L63)
 *   §8.1 multiple independent return routes → robustness / preference  (L68)
 *        single fragile corridor → risk penalty                        (L69)
 *        non-interruptible transport → risk penalty                    (L70)
 *        transfer count → plan complexity / uncertainty                (L71)
 *   App A RETURN_ROUTE_UNRELIABLE                                       (L282)
 *   §24 "Candidate explosion — pre-filter by envelope/time/category before
 *        expensive ranking"                                            (L260)
 *
 * ── THE FORMULA, TERM BY TERM ────────────────────────────────────────────────
 *   outbound_arrival           windowStart + the routed airport → candidate leg,
 *                              asked FOR windowStart (the later of now and the
 *                              earliest realistic landside exit — the certified
 *                              record's own `earliestOutTime`), traffic-aware.
 *   minimum_experience_duration  STATED, never invented: a curated dwell
 *                              (`layover_place_dwell`, 3466) or the caller's own
 *                              figure. Nobody stated one → the candidate cannot be
 *                              certified (UNMEASURED), though it can still be
 *                              REFUSED when even the journey alone overflows.
 *   conservative_return_duration  the routed candidate → airport leg asked FOR
 *                              the instant the traveller would set off back
 *                              (outbound arrival + that experience), then made
 *                              conservative in two named, monotone steps:
 *                                × (1 + ENVELOPE_UNCERTAINTY_BUDGET[confidence])
 *                                  — the SAME table that holds back the window
 *                                  at each §6.2 confidence band, applied to the
 *                                  weakest of the record's and the route's own
 *                                  confidence (so the edge contracts as
 *                                  confidence drops, L63);
 *                                + the §8.1 robustness margins (L69, L70, L71).
 *   hard_return_by             `record.deadline.hardReturnTime` — the one
 *                              deadline every surface shows.
 *
 * ── MONOTONE, AND ONLY EVER TOWARDS CAUTION ──────────────────────────────────
 * Every §8.1 signal enters as minutes ADDED to the conservative return or as a
 * band step DOWN (SAFE → TIGHT → BLOCKED). Nothing here can widen what the
 * window allows: fewer independent routes, a non-interruptible leg, another
 * transfer, a lower confidence, a slower forecast — each can only keep a
 * candidate where it is or move it out (swept in layoverRoutedFeasibility.test.ts).
 *
 * ── A NAMED ABSENCE, NEVER A STAND-IN ────────────────────────────────────────
 * When the provider is unavailable, unconfigured, over budget, slow, or answers
 * something unreadable, the candidate is UNMEASURED and carries the refusal's
 * reason token. The straight-line bound is NEVER presented as a route: it is
 * used only to PROVE a candidate unreachable (the pre-filter), which is the one
 * thing a lower bound may do. A DRIVE return that Google answered from its
 * traffic-unaware fallback is not a forecast for the return instant; it may
 * refuse a candidate (even free-flowing traffic overflows the window) and never
 * certifies one.
 *
 * ── WHAT IT COSTS ────────────────────────────────────────────────────────────
 * Two billed calls per routed candidate (layoverRoutesSpendGate.ts has the
 * arithmetic). The pre-filter runs first and spends nothing: an airside card, a
 * place with no coordinate, one the straight-line envelope PROVES unreachable,
 * one whose stated experience cannot fit the window at any speed, one the
 * caller's category / time-of-day rule drops — none of them is routed. Of what
 * remains, at most `LAYOVER_ROUTES_CAPS.candidatesPerRead` are routed, in the
 * caller's order; the rest are named `candidate_cap`.
 */
import {
  haversineMeters,
  straightLineTravelTimeProvider,
  type GeoPoint,
  type TravelMode,
} from "../../domain/trips/contracts/TravelTimeProvider.js";
import { TRAVEL_CONFIDENCES, worstTravelConfidence, type TravelConfidence } from "../../lib/travelEstimate.js";
import type { RouteCorridorProvider } from "../../lib/providers/routeCorridorProvider.js";
import { LAYOVER_RETURN_CORRIDOR_PROVIDER, layoverReturnRisk, routedLegOf, type RoutedLegs } from "./LayoverReturnCorridor.js";
import { describeCorridorRefusal } from "../../lib/providers/corridorTravelTimeAdapter.js";
import { layoverRoutesGuardedCorridor } from "./LayoverTravelTime.js";
import {
  ENVELOPE_UNCERTAINTY_BUDGET,
  bandCandidate,
  routedSafeEnvelope,
  type EnvelopeBand,
  type EnvelopeVerdict,
  type RoutedSafeEnvelope,
  type SafeEnvelope,
} from "./LayoverEnvelope.js";
import type { LayoverFeasibilityRecord } from "./LayoverFeasibility.js";
import type { LayoverReasonCode, ReturnCorridorRisk } from "./LayoverSafetyEngine.js";
import { LAYOVER_ROUTES_CAPS } from "./layoverRoutesSpendGate.js";

/**
 * The policy, in ONE table. Each figure is a POLICY CHOICE written down as one,
 * not a measurement; none should ever read as one.
 */
export const LAYOVER_ROUTED_POLICY = Object.freeze({
  /** L260 — routed per read, after the pre-filter. Two billed calls each. */
  candidatesPerRead: LAYOVER_ROUTES_CAPS.candidatesPerRead,
  /** At or under this straight-line distance the candidate is asked as a WALK (both ways); beyond it, a DRIVE. */
  walkMaxMetres: 1_200,
  /** L69 — one way back (or ways that share a failure point): share of the return held back, at least the minimum. */
  fragileShare: 0.25,
  fragileMinMinutes: 10,
  /** L70 — the fastest way back cannot be left part-way (or nobody can say it can). */
  committedShare: 0.15,
  committedMinMinutes: 5,
  /** L71 — per change of conveyance on the way back. */
  perTransferMinutes: 5,
  /** L71 — this many changes or more also lowers the candidate's confidence to LOW (plan complexity → uncertainty). */
  complexTransferCount: 2,
  /** SAFE needs at least this much slack against the hard return. The same 20 `assess` calls "tight". */
  tightSlackMinutes: 20,
  /** The dwell a POINT of the envelope is measured with when the place states none. Not a candidate's dwell. */
  envelopeDwellFloorMinutes: 30,
  /** Candidates routed at once. Bounded so one page load is not a burst. */
  concurrency: 3,
});

/** Why a candidate was NOT routed. The pre-filter spends nothing. */
export type RoutedPrefilter =
  | "airside"
  | "landside_closed"
  | "no_position"
  | "outside_envelope"
  | "experience_exceeds_window"
  | "category"
  | "candidate_cap";

export type RoutedCandidateState = "FEASIBLE" | "INFEASIBLE" | "UNMEASURED" | "NOT_ROUTED";

export interface RoutedCandidateInput {
  key: string;
  point: GeoPoint | null;
  insideAirport?: boolean;
  /** Minimum experience duration as STATED (curated dwell, plan stop). `null` = nobody stated one. */
  minExperienceMin: number | null;
  /** The caller's category / time-of-day rule. `false` = the caller drops it; it is not routed. */
  categoryAllowed?: boolean;
}

export interface RoutedRobustness {
  /** L68 — ways back that fail independently. */
  independentReturnRoutes: number;
  offeredReturnRoutes: number;
  /** L69 — one way back (or all through one shared point). */
  fragileCorridor: boolean;
  /** L70 — the fastest way back cannot be left part-way. `unknown` is treated as committed for the penalty. */
  returnInterruptibility: string;
  nonInterruptible: boolean;
  /** L71 — changes of conveyance on the fastest way back. */
  transferCount: number;
  fragileMinutes: number;
  nonInterruptibleMinutes: number;
  transferMinutes: number;
  totalMarginMinutes: number;
}

export interface RoutedFeasibilityTerms {
  mode: TravelMode;
  windowStartsAt: string;
  outboundDepartAt: string;
  outboundMinutes: number;
  outboundArrivalAt: string;
  /** The dwell the formula used, and where it came from. */
  minExperienceMin: number | null;
  experienceBasis: "stated" | "unstated";
  returnDepartAt: string;
  /** The routed way back, at `returnDepartAt`, before anything conservative is added. */
  returnMinutes: number;
  returnForecast: boolean;
  /** The weakest of the record's and the two legs' confidence (and LOW at ≥ 2 transfers). */
  confidence: TravelConfidence;
  inflationShare: number;
  inflationMinutes: number;
  robustness: RoutedRobustness;
  /** §8's conservative_return_duration. */
  conservativeReturnMinutes: number;
  hardReturnBy: string;
  /** The latest the traveller may leave the place: hard_return_by − conservative_return_duration. */
  leaveBy: string;
  /** Back at the airport under the conservative return, leaving after the minimum experience. Null with no stated dwell. */
  expectedAirportReturnAt: string | null;
  /** hard_return_by − expected return, in whole minutes (floored). Null with no stated dwell. */
  slackMinutes: number | null;
}

export interface RoutedCandidate {
  key: string;
  state: RoutedCandidateState;
  /** SAFE / TIGHT when FEASIBLE, BLOCKED when INFEASIBLE or proved unreachable, UNCERTIFIED otherwise. */
  band: EnvelopeBand;
  prefilter: RoutedPrefilter | null;
  /** Routing was wanted and there is no answer to certify on: the refusal's own reason token, and a line for an operator. */
  absence: { reason: string; detail: string | null } | null;
  legs: RoutedLegs | null;
  terms: RoutedFeasibilityTerms | null;
  risk: ReturnCorridorRisk | null;
  reasonCodes: LayoverReasonCode[];
  /** L68 — candidate preference from the way back alone. Higher is preferred. Never above an unsafe band. */
  preference: number;
  /** Why this state, in words a surface may show. Null when SAFE. */
  reason: string | null;
  /** Envelope membership with the floor dwell (a POINT of the §8 union), or null when it could not be judged. */
  inEnvelope: boolean | null;
  /** The straight-line verdict the pre-filter read (outer bound). */
  straightLine: EnvelopeVerdict | null;
}

export interface RouteLayoverCandidatesInput {
  record: LayoverFeasibilityRecord;
  /** The airport's coordinate; null = nothing can be routed (`no_position`). */
  airport: GeoPoint | null;
  candidates: ReadonlyArray<RoutedCandidateInput>;
  /** FALSE when the certified landside gate is closed: nothing landside is routed (and nothing is spent). */
  landsideAllowed: boolean;
  /** The certified outer bound (the straight-line disc) — the envelope pre-filter. */
  outerBound: SafeEnvelope | null;
  /** The route-shape port. Default: the layover surface's own (Google Routes, behind its gates). */
  corridorProvider?: RouteCorridorProvider;
}

export interface RoutedLayoverEvaluation {
  candidates: RoutedCandidate[];
  byKey: Map<string, RoutedCandidate>;
  /** §8's union, from the candidates that were routed. Null with no airport coordinate. */
  envelope: RoutedSafeEnvelope | null;
  /** How many were routed, and why the rest were not — the L260 audit line. */
  summary: { routed: number; prefiltered: Partial<Record<RoutedPrefilter, number>>; absences: Partial<Record<string, number>> };
}

function confidenceOf(c: string): TravelConfidence {
  return (TRAVEL_CONFIDENCES as readonly string[]).includes(c) ? (c as TravelConfidence) : "INSUFFICIENT";
}

/** L69/L70/L71 — the robustness margins, read off the measured way back. Monotone in every signal. */
export function robustnessOf(legs: RoutedLegs, policy = LAYOVER_ROUTED_POLICY): RoutedRobustness {
  const back = legs.returnLeg;
  const fragileCorridor = back.independentRoutes <= 1;
  // `unknown` is folded towards the penalty, as returnRouteRisk's policy folds it for the warning:
  // resolving it away would withhold the penalty on exactly the legs nobody could check.
  const nonInterruptible = back.interruptibility !== "interruptible";
  const fragileMinutes = fragileCorridor ? Math.max(policy.fragileMinMinutes, Math.ceil(back.minutes * policy.fragileShare)) : 0;
  const nonInterruptibleMinutes = nonInterruptible ? Math.max(policy.committedMinMinutes, Math.ceil(back.minutes * policy.committedShare)) : 0;
  const transferMinutes = Math.max(0, back.transferCount) * policy.perTransferMinutes;
  return {
    independentReturnRoutes: back.independentRoutes,
    offeredReturnRoutes: back.offeredRoutes,
    fragileCorridor,
    returnInterruptibility: back.interruptibility,
    nonInterruptible,
    transferCount: back.transferCount,
    fragileMinutes,
    nonInterruptibleMinutes,
    transferMinutes,
    totalMarginMinutes: fragileMinutes + nonInterruptibleMinutes + transferMinutes,
  };
}

/** The weakest of the record's confidence, both legs' and — at ≥ 2 transfers — LOW (L71: complexity is uncertainty). */
export function routedConfidence(record: Pick<LayoverFeasibilityRecord, "confidence">, legs: RoutedLegs, policy = LAYOVER_ROUTED_POLICY): TravelConfidence {
  let c = worstTravelConfidence(confidenceOf(record.confidence), legs.outbound.confidence);
  c = worstTravelConfidence(c, legs.returnLeg.confidence);
  if (legs.returnLeg.transferCount >= policy.complexTransferCount) c = worstTravelConfidence(c, "LOW");
  return c;
}

/**
 * §8's conservative_return_duration: the routed way back, inflated by the
 * confidence band's share and then by the robustness margins. Null at
 * INSUFFICIENT confidence — a return nobody can size is not made conservative,
 * it is refused certification.
 */
export function conservativeReturnMinutes(
  returnMinutes: number,
  confidence: TravelConfidence,
  robustness: Pick<RoutedRobustness, "totalMarginMinutes">,
): { minutes: number; inflationShare: number; inflationMinutes: number } | null {
  if (confidence === "INSUFFICIENT") return null;
  const share = ENVELOPE_UNCERTAINTY_BUDGET[confidence];
  const inflated = Math.ceil(returnMinutes * (1 + share));
  return { minutes: inflated + robustness.totalMarginMinutes, inflationShare: share, inflationMinutes: inflated - returnMinutes };
}

/** L68 — preference from the way back: more independent routes up (to 3), every penalty down. */
export function routedPreference(r: RoutedRobustness): number {
  return Math.min(3, r.independentReturnRoutes) - (r.fragileCorridor ? 1 : 0) - (r.nonInterruptible ? 1 : 0) - r.transferCount;
}

function modeFor(airport: GeoPoint, point: GeoPoint, policy = LAYOVER_ROUTED_POLICY): TravelMode {
  return haversineMeters(airport, point) <= policy.walkMaxMetres ? "walk" : "drive";
}

function notRouted(
  key: string,
  prefilter: RoutedPrefilter,
  band: EnvelopeBand,
  reason: string | null,
  straightLine: EnvelopeVerdict | null,
  absence: RoutedCandidate["absence"] = null,
): RoutedCandidate {
  return {
    key, state: "NOT_ROUTED", band, prefilter, absence, legs: null, terms: null, risk: null,
    reasonCodes: [], preference: 0, reason, inEnvelope: band === "BLOCKED" ? false : null, straightLine,
  };
}

/** Run `fn` over `items` with at most `n` in flight, keeping input order in the output. */
async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/**
 * Judge ONE routed candidate from its two measured legs. Pure: no clock, no
 * I/O — the legs and the record carry every instant it needs.
 */
export function judgeRoutedCandidate(args: {
  key: string;
  record: LayoverFeasibilityRecord;
  legs: RoutedLegs;
  risk: ReturnCorridorRisk | null;
  minExperienceMin: number | null;
  straightLine: EnvelopeVerdict | null;
  policy?: typeof LAYOVER_ROUTED_POLICY;
}): RoutedCandidate {
  const policy = args.policy ?? LAYOVER_ROUTED_POLICY;
  const { key, record, legs, risk, straightLine } = args;
  const nowMs = record.inputs.nowMs;
  const hardReturnMs = record.deadline.hardReturnTime.getTime();
  const windowStartMs = Math.max(nowMs, record.envelope.earliestOutTime.getTime());
  const out = legs.outbound;
  const back = legs.returnLeg;
  const robustness = robustnessOf(legs, policy);
  const confidence = routedConfidence(record, legs, policy);
  const conservative = conservativeReturnMinutes(back.minutes, confidence, robustness);
  const stated = typeof args.minExperienceMin === "number" && Number.isFinite(args.minExperienceMin) && args.minExperienceMin > 0
    ? args.minExperienceMin : null;
  const reasonCodes: LayoverReasonCode[] = risk?.returnRouteUnreliable === true ? ["RETURN_ROUTE_UNRELIABLE"] : [];
  const arrivalMs = windowStartMs + out.minutes * 60_000;
  const windowMin = (hardReturnMs - windowStartMs) / 60_000;
  const base = { key, prefilter: null, legs, risk, reasonCodes, straightLine } as const;

  // ── a way back that is not a forecast for its instant, or a stale one ─────
  const stale = Date.parse(legs.expiresAt) <= nowMs || risk?.facts.stale === true;
  if (!out.forecast || !back.forecast || stale || conservative === null) {
    // It may still REFUSE: free-flow is the most optimistic reading of a drive,
    // so if even that overflows the window with no time at the place, nothing
    // measured later could rescue the candidate.
    const freeFlowBack = back.freeFlowMinutes ?? back.minutes;
    const freeFlowOut = out.freeFlowMinutes ?? out.minutes;
    const absence = stale
      ? { reason: "route_stale", detail: `the routed legs expired at ${legs.expiresAt}` }
      : conservative === null
        ? { reason: "confidence_insufficient", detail: "a way back nobody can size is not certified" }
        : { reason: "return_forecast_unavailable", detail: legs.sourceRefs.find((r) => r.includes(":fallback:")) ?? "the way back was not answered for its own instant" };
    if (freeFlowOut + freeFlowBack + (stated ?? 0) > windowMin) {
      return {
        ...base, state: "INFEASIBLE", band: "BLOCKED", absence, terms: null, preference: 0, inEnvelope: false,
        reason: `even without traffic it is ${freeFlowOut + freeFlowBack} min there and back${stated ? ` plus ${stated} min there` : ""}, against ${Math.floor(windowMin)} usable min`,
      };
    }
    return {
      ...base, state: "UNMEASURED", band: "UNCERTIFIED", absence, terms: null, preference: 0, inEnvelope: null,
      reason: "the way back could not be forecast for the time you would set off, so this cannot be certified against your deadline",
    };
  }

  const returnDepartMs = Date.parse(back.departAt);
  const leaveByMs = hardReturnMs - conservative.minutes * 60_000;
  const expectedReturnMs = stated === null ? null : arrivalMs + stated * 60_000 + conservative.minutes * 60_000;
  const slack = expectedReturnMs === null ? null : Math.floor((hardReturnMs - expectedReturnMs) / 60_000);
  const terms: RoutedFeasibilityTerms = {
    mode: legs.mode === "unspecified" ? "drive" : legs.mode,
    windowStartsAt: new Date(windowStartMs).toISOString(),
    outboundDepartAt: out.departAt,
    outboundMinutes: out.minutes,
    outboundArrivalAt: new Date(arrivalMs).toISOString(),
    minExperienceMin: stated,
    experienceBasis: stated === null ? "unstated" : "stated",
    returnDepartAt: new Date(returnDepartMs).toISOString(),
    returnMinutes: back.minutes,
    returnForecast: back.forecast,
    confidence,
    inflationShare: conservative.inflationShare,
    inflationMinutes: conservative.inflationMinutes,
    robustness,
    conservativeReturnMinutes: conservative.minutes,
    hardReturnBy: record.deadline.hardReturnTime.toISOString(),
    leaveBy: new Date(leaveByMs).toISOString(),
    expectedAirportReturnAt: expectedReturnMs === null ? null : new Date(expectedReturnMs).toISOString(),
    slackMinutes: slack,
  };
  const preference = routedPreference(robustness);
  // A POINT of the envelope: feasible with the place's own dwell, or the floor when it states none.
  const pointDwell = stated ?? policy.envelopeDwellFloorMinutes;
  const inEnvelope = arrivalMs + pointDwell * 60_000 + conservative.minutes * 60_000 <= hardReturnMs;

  // ── L65 — the formula, with routed terms ───────────────────────────────────
  if (arrivalMs + (stated ?? 0) * 60_000 + conservative.minutes * 60_000 > hardReturnMs) {
    return {
      ...base, state: "INFEASIBLE", band: "BLOCKED", absence: null, terms, preference, inEnvelope: false,
      reason: `${out.minutes} min there, ${stated !== null ? `${stated} min there, ` : ""}and ${conservative.minutes} min to allow for the way back — past your ${terms.hardReturnBy} return`,
    };
  }
  if (stated === null) {
    return {
      ...base, state: "UNMEASURED", band: "UNCERTIFIED", absence: { reason: "experience_unstated", detail: null }, terms, preference, inEnvelope,
      reason: "nobody has said how long this takes, so it cannot be certified against your window",
    };
  }
  const safe = slack !== null && slack >= policy.tightSlackMinutes
    && !robustness.fragileCorridor && !robustness.nonInterruptible
    && risk?.returnRouteUnreliable !== true;
  const why: string[] = [];
  if (slack !== null && slack < policy.tightSlackMinutes) why.push(`only ${slack} min to spare`);
  if (robustness.fragileCorridor) why.push("one way back");
  if (robustness.nonInterruptible) why.push("the way back cannot be left part-way");
  if (risk?.returnRouteUnreliable === true) why.push("the way back is not dependable");
  return {
    ...base, state: "FEASIBLE", band: safe ? "SAFE" : "TIGHT", absence: null, terms, preference, inEnvelope,
    reason: safe ? null : `fits, but ${why.join("; ")}`,
  };
}

/**
 * Pre-filter, route and judge a candidate list (the L260 order: cheap first,
 * expensive last). Never throws on a provider failure: every refusal is a
 * named absence on the candidate it concerns.
 */
export async function routeLayoverCandidates(input: RouteLayoverCandidatesInput): Promise<RoutedLayoverEvaluation> {
  const policy = LAYOVER_ROUTED_POLICY;
  const { record, airport } = input;
  const nowMs = record.inputs.nowMs;
  const windowStartMs = Math.max(nowMs, record.envelope.earliestOutTime.getTime());
  const usable = record.envelope.usableMinutes;
  const provider = layoverRoutesGuardedCorridor(input.corridorProvider ?? LAYOVER_RETURN_CORRIDOR_PROVIDER);
  const prefiltered: Partial<Record<RoutedPrefilter, number>> = {};
  const absences: Partial<Record<string, number>> = {};
  const results = new Map<string, RoutedCandidate>();
  const queue: Array<{ c: RoutedCandidateInput; point: GeoPoint; sl: EnvelopeVerdict | null }> = [];
  const count = (p: RoutedPrefilter) => { prefiltered[p] = (prefiltered[p] ?? 0) + 1; };

  for (const c of input.candidates) {
    if (c.insideAirport === true) { count("airside"); results.set(c.key, notRouted(c.key, "airside", "UNCERTIFIED", null, null)); continue; }
    if (!input.landsideAllowed) { count("landside_closed"); results.set(c.key, notRouted(c.key, "landside_closed", "UNCERTIFIED", "this layover may not go landside", null)); continue; }
    if (!airport || !c.point) { count("no_position"); results.set(c.key, notRouted(c.key, "no_position", "UNCERTIFIED", "we do not have a location to route from or to", null)); continue; }
    // ENVELOPE: the straight-line bound PROVES a round trip cannot fit at any speed. Pure, free.
    const sl = input.outerBound ? await bandCandidate(input.outerBound, c.point, new Date(windowStartMs), straightLineTravelTimeProvider) : null;
    if (sl?.band === "BLOCKED") { count("outside_envelope"); results.set(c.key, notRouted(c.key, "outside_envelope", "BLOCKED", sl.reason, sl)); continue; }
    // TIME: a stated experience that cannot fit beside even the straight-line round trip.
    const minExp = typeof c.minExperienceMin === "number" && c.minExperienceMin > 0 ? c.minExperienceMin : null;
    if (minExp !== null && minExp + (sl?.roundTripLowerBoundMin ?? 0) > usable) {
      count("experience_exceeds_window");
      results.set(c.key, notRouted(c.key, "experience_exceeds_window", "BLOCKED", `takes ${minExp} min there, more than your ${usable} usable min allow`, sl));
      continue;
    }
    // CATEGORY / TIME OF DAY: the caller's own rule.
    if (c.categoryAllowed === false) { count("category"); results.set(c.key, notRouted(c.key, "category", "UNCERTIFIED", null, sl)); continue; }
    queue.push({ c, point: c.point, sl });
  }

  const routedNow = queue.slice(0, policy.candidatesPerRead);
  for (const q of queue.slice(policy.candidatesPerRead)) {
    count("candidate_cap");
    results.set(q.c.key, notRouted(q.c.key, "candidate_cap", "UNCERTIFIED", "not measured this time — only the nearest candidates are routed per look", q.sl, { reason: "candidate_cap", detail: null }));
  }

  await pool(routedNow, policy.concurrency, async ({ c, point, sl }) => {
    const mode = modeFor(airport!, point, policy);
    const minExp = typeof c.minExperienceMin === "number" && c.minExperienceMin > 0 ? c.minExperienceMin : null;
    // L60: the way out FIRST, asked for the moment they can leave the airport. Its measured arrival fixes
    // the instant the way back is asked FOR — arrival + the dwell (the place's own, or the envelope floor) —
    // so the return is priced at its own future instant, never at the outbound's and never doubled.
    const outboundDepartAt = new Date(windowStartMs);
    const first = await provider.corridor({ from: airport!, to: point, departAt: outboundDepartAt, mode, wantAlternatives: true });
    if (!first.ok) {
      absences[first.reason] = (absences[first.reason] ?? 0) + 1;
      results.set(c.key, {
        key: c.key, state: "UNMEASURED", band: "UNCERTIFIED", prefilter: null,
        absence: { reason: first.reason, detail: describeCorridorRefusal(first) }, legs: null, terms: null, risk: null,
        reasonCodes: [], preference: 0, inEnvelope: null, straightLine: sl,
        reason: "the route to and from here could not be measured right now",
      });
      return;
    }
    const measuredOut = first.value.routes.length > 0 ? routedLegOf(first.value, mode).minutes : 0;
    const returnDepartAt = new Date(windowStartMs + (measuredOut + (minExp ?? policy.envelopeDwellFloorMinutes)) * 60_000);
    // Both directions through the one door that judges the way back (L68–L71, L282). The outbound is the
    // SAME question as above and is answered from the provider's memo — it is not billed twice.
    const outcome = await layoverReturnRisk({ airport: airport!, candidate: point, outboundDepartAt, returnDepartAt, mode }, nowMs, provider);
    if (!outcome.legs) {
      const reason = String(outcome.reason ?? "no_answer");
      absences[reason] = (absences[reason] ?? 0) + 1;
      results.set(c.key, {
        key: c.key, state: "UNMEASURED", band: "UNCERTIFIED", prefilter: null,
        absence: { reason, detail: outcome.detail }, legs: null, terms: null, risk: outcome.risk,
        reasonCodes: [], preference: 0, inEnvelope: null, straightLine: sl,
        reason: "the route to and from here could not be measured right now",
      });
      return;
    }
    results.set(c.key, judgeRoutedCandidate({ key: c.key, record, legs: outcome.legs, risk: outcome.risk, minExperienceMin: minExp, straightLine: sl, policy }));
  });

  const candidates = input.candidates.map((c) => results.get(c.key)!);
  const byKey = new Map(candidates.map((c) => [c.key, c] as const));
  const envelope = airport
    ? routedSafeEnvelope({
        centre: airport,
        record,
        outerBound: input.outerBound,
        dwellFloorMinutes: policy.envelopeDwellFloorMinutes,
        points: input.candidates.flatMap((c) => {
          const r = byKey.get(c.key);
          if (!r || !c.point || r.prefilter === "airside") return [];
          return [{
            key: c.key,
            point: c.point,
            member: r.inEnvelope === true,
            band: r.band,
            slackMinutes: r.terms?.slackMinutes ?? null,
            mode: r.terms?.mode ?? null,
            outboundMinutes: r.terms?.outboundMinutes ?? null,
            conservativeReturnMinutes: r.terms?.conservativeReturnMinutes ?? null,
            reason: r.reason,
            expiresAt: r.legs?.expiresAt ?? null,
          }];
        }),
      })
    : null;
  return { candidates, byKey, envelope, summary: { routed: routedNow.length, prefiltered, absences } };
}

/**
 * The routed verdict in the envelope's own vocabulary, so a map pin and the
 * existing `candidateFeasibilityFrom` read it without a second shape. Keeps the
 * straight-line bound's numbers (they are still the outer bound) and replaces
 * the band and its reason with the routed ones.
 */
export function routedEnvelopeVerdict(r: RoutedCandidate): EnvelopeVerdict | undefined {
  if (!r.straightLine) return undefined;
  // Nothing was measured (not routed, or the router did not answer): the pin keeps EXACTLY the straight-line
  // verdict it had — the absence is said on the card's `routing` contract, not by rewriting a bound.
  // The one exception is a stated activity that cannot fit beside even the bound: that IS a proof.
  if (!r.legs) return r.prefilter === "experience_exceeds_window" ? { ...r.straightLine, band: "BLOCKED", reason: r.reason } : r.straightLine;
  return {
    ...r.straightLine,
    band: r.band,
    reason: r.reason,
    returnForecastLowerBoundMin: r.terms ? r.terms.returnMinutes : r.straightLine.returnForecastLowerBoundMin,
    returnDepartsAt: r.terms ? r.terms.returnDepartAt : r.straightLine.returnDepartsAt,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// The certified action universe's routing plan (LayoverSnapshot.certifiedActionUniverse)
// ─────────────────────────────────────────────────────────────────────────────
//
// The universe already asked the return corridor per candidate (census §39:
// `LayoverSnapshot.ts:613`), every candidate, at ONE instant (the end of the
// window), and used only the risk. The plan below is what that loop now reads:
//
//   L260   which candidates are routed at all — not the ones the straight-line
//          envelope PROVED unreachable, not one whose stated activity cannot fit
//          beside even that bound, and at most `candidatesPerRead` of the rest,
//          in the caller's order;
//   L60    the mode (walk or drive) and the two instants: out at the window's
//          start, back at that candidate's own arrival + dwell — the caller's
//          own measured outbound when it has one, the straight-line bound
//          otherwise (the corridor records the instant actually asked for);
//   L65    once the corridor answers, the routed terms: the outbound becomes
//          the candidate's travel term when the caller stated none, and the
//          CONSERVATIVE return becomes its return term — `candidateFits` then
//          evaluates §8's formula with them;
//   L66    the routed union, for the universe to publish.

export interface UniverseRoutable {
  id: string;
  travelTimeMin?: number | null;
  activityTimeMin?: number | null;
}

export interface UniverseRoutingPlan<T extends UniverseRoutable> {
  /** The window's start: the later of now and the earliest realistic landside exit. */
  outboundDepartAt: Date;
  /** The candidates the loop asks the router for (pre-filtered, capped, in the caller's order). */
  toRoute: T[];
  modeOf(c: T): TravelMode;
  /** The instant the way back is asked FOR: the window's start + the outbound + the dwell. `fallback` only with neither figure. */
  returnInstantFor(c: T, fallback: Date): Date;
  /** Judge one answered candidate (the loop's corridor outcome). */
  record(c: T, outcome: { risk: ReturnCorridorRisk | null; reason: string | null; detail: string | null; legs?: RoutedLegs | null }): void;
  /** The routed terms for one candidate, when its legs were forecasts. */
  termsOf(c: T): RoutedFeasibilityTerms | null;
  /** The bands with each routed verdict in place of the straight-line one. */
  routedBands(preBands: Map<string, EnvelopeVerdict>): Map<string, EnvelopeVerdict>;
  /** Every routed or pre-filtered landside candidate's routed verdict. */
  results(): RoutedCandidate[];
  /** §8's union over what was routed; null with no centre. */
  envelope(): RoutedSafeEnvelope | null;
}

export function universeRoutingPlan<T extends UniverseRoutable>(args: {
  record: LayoverFeasibilityRecord;
  centre: GeoPoint | null;
  outerBound: SafeEnvelope | null;
  landside: readonly T[];
  pointOf: (c: T) => GeoPoint | null;
  preBands: Map<string, EnvelopeVerdict>;
}): UniverseRoutingPlan<T> {
  const policy = LAYOVER_ROUTED_POLICY;
  const { record, centre } = args;
  const windowStartMs = Math.max(record.inputs.nowMs, record.envelope.earliestOutTime.getTime());
  const usable = record.envelope.usableMinutes;
  const results = new Map<string, RoutedCandidate>();
  const terms = new WeakMap<T, RoutedFeasibilityTerms>();
  const stated = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const survivors: T[] = [];
  for (const c of args.landside) {
    const point = args.pointOf(c);
    const sl = args.preBands.get(c.id) ?? null;
    if (!centre || !point) { results.set(c.id, notRouted(c.id, "no_position", "UNCERTIFIED", null, sl)); continue; }
    if (sl?.band === "BLOCKED") { results.set(c.id, notRouted(c.id, "outside_envelope", "BLOCKED", sl.reason, sl)); continue; }
    const dwell = stated(c.activityTimeMin);
    if (dwell !== null && dwell + (sl?.roundTripLowerBoundMin ?? 0) > usable) {
      results.set(c.id, notRouted(c.id, "experience_exceeds_window", "BLOCKED", `takes ${dwell} min there, more than your ${usable} usable min allow`, sl));
      continue;
    }
    survivors.push(c);
  }
  const toRoute = survivors.slice(0, policy.candidatesPerRead);
  for (const c of survivors.slice(policy.candidatesPerRead)) {
    results.set(c.id, notRouted(c.id, "candidate_cap", "UNCERTIFIED", null, args.preBands.get(c.id) ?? null, { reason: "candidate_cap", detail: null }));
  }
  return {
    outboundDepartAt: new Date(windowStartMs),
    toRoute,
    modeOf: (c) => (centre && args.pointOf(c) ? modeFor(centre, args.pointOf(c)!, policy) : "drive"),
    returnInstantFor(c, fallback) {
      const out = stated(c.travelTimeMin) ?? args.preBands.get(c.id)?.outboundLowerBoundMin ?? null;
      if (out === null) return fallback;
      return new Date(windowStartMs + (out + (stated(c.activityTimeMin) ?? policy.envelopeDwellFloorMinutes)) * 60_000);
    },
    record(c, outcome) {
      const sl = args.preBands.get(c.id) ?? null;
      if (!outcome.legs) {
        results.set(c.id, {
          key: c.id, state: "UNMEASURED", band: "UNCERTIFIED", prefilter: null,
          absence: { reason: String(outcome.reason ?? "no_answer"), detail: outcome.detail }, legs: null, terms: null,
          risk: outcome.risk, reasonCodes: [], preference: 0, inEnvelope: null, straightLine: sl,
          reason: "the route to and from here could not be measured right now",
        });
        return;
      }
      const judged = judgeRoutedCandidate({ key: c.id, record, legs: outcome.legs, risk: outcome.risk, minExperienceMin: stated(c.activityTimeMin), straightLine: sl, policy });
      results.set(c.id, judged);
      if (judged.terms) terms.set(c, judged.terms);
    },
    termsOf: (c) => terms.get(c) ?? null,
    routedBands(preBands) {
      const out = new Map(preBands);
      for (const [key, r] of results) {
        const v = routedEnvelopeVerdict(r);
        if (v) out.set(key, v);
      }
      return out;
    },
    results: () => [...results.values()],
    envelope() {
      if (!centre) return null;
      return routedSafeEnvelope({
        centre,
        record,
        outerBound: args.outerBound,
        dwellFloorMinutes: policy.envelopeDwellFloorMinutes,
        points: args.landside.flatMap((c) => {
          const r = results.get(c.id);
          const point = args.pointOf(c);
          if (!r || !point) return [];
          return [{
            key: c.id, point, member: r.inEnvelope === true, band: r.band,
            slackMinutes: r.terms?.slackMinutes ?? null, mode: r.terms?.mode ?? null,
            outboundMinutes: r.terms?.outboundMinutes ?? null, conservativeReturnMinutes: r.terms?.conservativeReturnMinutes ?? null,
            reason: r.reason, expiresAt: r.legs?.expiresAt ?? null,
          }];
        }),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The recommendation path (GET /airport/sessions/:id/recommendations)
// ─────────────────────────────────────────────────────────────────────────────
//
// The path a traveller in production reaches. `generateRecommendations` reads
// its places WITHOUT routing them (LayoverTravelTime.LAYOVER_DEFERRED_LEG_PROVIDER),
// runs its own cheap filters (the time-of-day / category rule, the straight-line
// envelope's proof), and then hands the survivors here. This pass:
//
//   1. reads the curated minimum dwell for each place (`layover_place_dwell`
//      behind `layover_place_dwell_enabled`; `off` reads nothing) — the
//      candidate's own stated figure wins;
//   2. routes them inside the layover session's Routes budget (R5);
//   3. writes the routed terms ONTO the candidate — `travelTimeMin` (the
//      outbound), `travelTimeSource: "measured"`, `returnTravelTimeMin` (§8's
//      conservative return) and, from a curated dwell, `activityTimeMin` — so
//      `assess` rates the card with the routed formula and the row persists a
//      measured leg with its provenance;
//   4. puts the routed band in place of the straight-line one in `bands`, so
//      the card's pin (`candidateFeasibilityFrom`) carries SAFE / TIGHT /
//      BLOCKED with the routed reason;
//   5. returns the routed union (L66) and each candidate's routed verdict for
//      the card's `routing` contract.
//
// A candidate the router did not answer for is left EXACTLY as it was read:
// no term is written, so `assess` keeps refusing it for the unmeasured leg.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readCuratedDwell } from "./LayoverPlaceDwell.js";
import { withLayoverRoutesBudget, type LayoverRoutesSession } from "./LayoverTravelTime.js";
import type { TravelTimeSource } from "./LayoverSafetyEngine.js";
import { logger as rootLogger } from "../../lib/logger.js";

/** What a recommendation candidate carries into the pass. Mutated in place with the routed terms. */
export interface RoutableRecommendation {
  insideAirport: boolean;
  point: GeoPoint | null;
  placeId?: string | null;
  travelTimeMin: number | null;
  travelTimeSource?: TravelTimeSource;
  activityTimeMin: number | null;
  returnTravelTimeMin?: number | null;
}

/** The card's routing contract — what a client renders. No operator detail, no coordinate. */
export interface RoutedCardContract {
  state: RoutedCandidateState;
  band: EnvelopeBand;
  reason: string | null;
  reasonCodes: LayoverReasonCode[];
  /** L68 — higher is preferred. */
  preference: number;
  /** The absence's reason token when there is no routed answer to certify on, else null. */
  absence: string | null;
  prefilter: RoutedPrefilter | null;
  mode: TravelMode | null;
  outboundMinutes: number | null;
  returnMinutes: number | null;
  conservativeReturnMinutes: number | null;
  minExperienceMin: number | null;
  hardReturnBy: string | null;
  leaveBy: string | null;
  expectedAirportReturnAt: string | null;
  slackMinutes: number | null;
  confidence: TravelConfidence | null;
  signals: {
    independentReturnRoutes: number;
    offeredReturnRoutes: number;
    fragileCorridor: boolean;
    nonInterruptible: boolean;
    returnInterruptibility: string;
    transferCount: number;
    returnRouteUnreliable: boolean | null;
    contributingFactors: string[];
  } | null;
  /** L221 — the certified return contract WITH the route back: when to leave, and how. */
  returnContract: {
    hardReturnBy: string;
    leaveBy: string;
    route: {
      mode: TravelMode;
      departAt: string;
      minutes: number;
      conservativeMinutes: number;
      forecast: boolean;
      independentRoutes: number;
      offeredRoutes: number;
      transferCount: number;
      interruptibility: string;
      conveyances: Array<{ mode: TravelMode; minutes: number; interruptibility: string; endsAt: string | null }>;
    };
  } | null;
  expiresAt: string | null;
}

export function routedCardContract(r: RoutedCandidate | undefined): RoutedCardContract | null {
  if (!r) return null;
  const t = r.terms;
  const back = r.legs?.returnLeg ?? null;
  return {
    state: r.state,
    band: r.band,
    reason: r.reason,
    reasonCodes: [...r.reasonCodes],
    preference: r.preference,
    absence: r.absence?.reason ?? null,
    prefilter: r.prefilter,
    mode: t?.mode ?? null,
    outboundMinutes: t?.outboundMinutes ?? null,
    returnMinutes: t?.returnMinutes ?? null,
    conservativeReturnMinutes: t?.conservativeReturnMinutes ?? null,
    minExperienceMin: t?.minExperienceMin ?? null,
    hardReturnBy: t?.hardReturnBy ?? null,
    leaveBy: t?.leaveBy ?? null,
    expectedAirportReturnAt: t?.expectedAirportReturnAt ?? null,
    slackMinutes: t?.slackMinutes ?? null,
    confidence: t?.confidence ?? null,
    signals: t ? {
      independentReturnRoutes: t.robustness.independentReturnRoutes,
      offeredReturnRoutes: t.robustness.offeredReturnRoutes,
      fragileCorridor: t.robustness.fragileCorridor,
      nonInterruptible: t.robustness.nonInterruptible,
      returnInterruptibility: t.robustness.returnInterruptibility,
      transferCount: t.robustness.transferCount,
      returnRouteUnreliable: r.risk?.returnRouteUnreliable ?? null,
      contributingFactors: [...(r.risk?.contributingFactors ?? [])],
    } : null,
    returnContract: t && back ? {
      hardReturnBy: t.hardReturnBy,
      leaveBy: t.leaveBy,
      route: {
        mode: t.mode,
        departAt: t.returnDepartAt,
        minutes: t.returnMinutes,
        conservativeMinutes: t.conservativeReturnMinutes,
        forecast: t.returnForecast,
        independentRoutes: back.independentRoutes,
        offeredRoutes: back.offeredRoutes,
        transferCount: back.transferCount,
        interruptibility: back.interruptibility,
        conveyances: back.conveyances.map((c) => ({ ...c })),
      },
    } : null,
    expiresAt: r.legs?.expiresAt ?? null,
  };
}

export interface RoutedRecommendationPass {
  envelope: RoutedSafeEnvelope | null;
  byKey: Map<string, RoutedCandidate>;
  summary: RoutedLayoverEvaluation["summary"];
}

export async function applyRoutedRecommendationPass<C extends RoutableRecommendation>(args: {
  db: SupabaseClient;
  session: LayoverRoutesSession;
  record: LayoverFeasibilityRecord;
  airport: GeoPoint | null;
  outerBound: SafeEnvelope | null;
  bands: Map<string, EnvelopeVerdict>;
  candidates: C[];
  keyOf: (c: C) => string;
  /** FALSE when the certified landside gate is closed. */
  landsideAllowed: boolean;
  corridorProvider?: RouteCorridorProvider;
}): Promise<RoutedRecommendationPass> {
  const landside = args.candidates.filter((c) => !c.insideAirport);
  // Nothing landside to evaluate (an airport-only window, a closed gate, no places): no geometry, no budget, no read.
  if (landside.length === 0) return { envelope: null, byKey: new Map(), summary: { routed: 0, prefiltered: {}, absences: {} } };
  const dwell = await readCuratedDwell(args.db, landside.map((c) => c.placeId ?? null));
  const curated = (c: C): number | null => (dwell.state === "read" && c.placeId ? dwell.byPlace.get(c.placeId)?.activityMin ?? null : null);
  const stated = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const evaluation = await withLayoverRoutesBudget(args.session, () => routeLayoverCandidates({
    record: args.record,
    airport: args.airport,
    landsideAllowed: args.landsideAllowed,
    outerBound: args.outerBound,
    corridorProvider: args.corridorProvider,
    candidates: landside.map((c) => ({
      key: args.keyOf(c),
      point: c.point,
      insideAirport: false,
      minExperienceMin: stated(c.activityTimeMin) ?? curated(c),
    })),
  }));
  for (const c of landside) {
    const key = args.keyOf(c);
    const r = evaluation.byKey.get(key);
    if (!r) continue;
    const v = routedEnvelopeVerdict(r);
    if (v) args.bands.set(key, v);
    if (!r.terms) continue;
    c.travelTimeMin = r.terms.outboundMinutes;
    c.travelTimeSource = "measured";
    c.returnTravelTimeMin = r.terms.conservativeReturnMinutes;
    if (stated(c.activityTimeMin) === null && curated(c) !== null) c.activityTimeMin = curated(c);
  }
  // The operator's half of every named absence: the reason token reaches the card, the refusal's own words (which gate,
  // which variable NAME — never a value) reach the log. Counts and tokens only; no place, no person, no coordinate.
  if (Object.keys(evaluation.summary.absences).length > 0 || evaluation.summary.routed > 0) {
    const firstDetail: Record<string, string> = {};
    for (const r of evaluation.candidates) if (r.absence?.detail && !(r.absence.reason in firstDetail)) firstDetail[r.absence.reason] = r.absence.detail;
    routedLogger.info({ sessionId: args.session.id ?? null, ...evaluation.summary, firstDetail }, "layover routed pass");
  }
  return { envelope: evaluation.envelope, byKey: evaluation.byKey, summary: evaluation.summary };
}

const routedLogger = rootLogger.child({ service: "LayoverRoutedFeasibility" });
