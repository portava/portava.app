/**
 * LayoverSafetyEngine
 *
 * Core calculation service. Computes required return buffer, available time,
 * and safety rating for candidate activities during a layover.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt —
 * §6.1 hard invariants (deadline monotonicity), §15 escalation ladder
 * (`computeReturnState`), §20 engineVersion, Appendix A reason codes.
 */
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import { localHour, localDayString } from "./AirportTime.js";
// census L293 is L47's defect on the other surface, so it is closed with L47's
// module rather than a second copy of its rule. `statedTravelMin` is where
// "airside 0 is a FACT, landside 0 is an ABSENCE" is decided, once, for both
// `layover_plan_stops.travel_min` and `layover_recommendations.travel_time_min`
// — two INTEGER NOT NULL DEFAULT 0 columns that cannot say "nobody measured".
// Aliased on import because this module publishes fields of the same names.
import {
  statedTravelMin as statedLegMin,
  statedDurationMin as statedDwellMin,
} from "./LayoverPlanFit.js";
// Spec §7. The usable window is no longer derived here by hand: it is the
// generalised Temporal Freedom Engine's answer, asked through the layover
// ADAPTER. See LayoverTemporalFreedom's header for why the adapter takes plain
// numbers — that is what keeps this dependency one-directional.
import {
  buildFreedomWindow as buildLayoverFreedomWindow,
  earliestLandsideMs,
  type LayoverFreedomContext,
} from "./LayoverTemporalFreedom.js";
import type {
  FreedomWindow,
  TemporalConflict,
} from "../../domain/trips/invariants/TripFreedomEngine.js";

export type SafetyRating =
  | "safe"
  | "possible_but_risky"
  | "not_recommended"
  | "airport_only";

/**
 * Version stamp for every certified output of this module. Bump when the
 * arithmetic changes (a buffer term, a threshold, a band) so a stored
 * `hardReturnTime` / `returnState` can be traced to the rules that produced
 * it (spec §20 DecisionRecord.engineVersion, §18 replay(sessionId, engineVersion)).
 *
 * History:
 *   2026.09.07-1  ramped time-of-day buffer (1-Lipschitz), single deadline
 *                 anchor (9c26efba); returnState ladder + reason codes added.
 *   2026.09.13-1  §10 live conditions become a SIXTH buffer term (`liveExtra`).
 *                 The term is 0 for every caller that supplies none, which is
 *                 every caller on this tree outside tests, so no number a
 *                 traveller sees moves — but the ARITHMETIC gained a term and
 *                 the rule for this constant is that a new term bumps it, not
 *                 that a new term which happens to be zero does not.
 */
export const LAYOVER_ENGINE_VERSION = "2026.09.13-1";

/**
 * Spec Appendix A reason codes — the whole vocabulary, declared once so it can
 * be counted, tested and diffed. Only the codes whose triggering FACT exists in
 * this tree are ever emitted (see `adviseLeaving`); the rest are declared here
 * so a future emitter cannot invent a spelling. Emitters today:
 *   ENTRY_NOT_CONFIRMED         always — nothing on main confirms entry (§6.1)
 *   INSUFFICIENT_USABLE_TIME    verdict "no"
 *   RETURN_THRESHOLD_REACHED    returnState RETURN_NOW / CONNECTION_AT_RISK
 *   AIRPORT_MATURITY_LIMITED    airport.verified === false (spec §22 L0)
 * Emitted only when a caller supplies the fact, and NO PRODUCER OF THAT FACT
 * EXISTS ON THIS TREE outside tests — so in production these are still never
 * emitted, and saying otherwise would be the fabricated-freshness §2.1 forbids:
 *   SECURITY_WAIT_HIGH   `LiveConditions.reasonCodes` from LayoverAirportTruth
 *   TRAFFIC_DEGRADED     "
 *   DATA_STALE           "  (every credible observation past its expiry)
 *   SOURCE_CONFLICT      "  (§10.1 contradiction, never silently merged)
 *   FLIGHT_MOVED_EARLIER          LayoverEventReplanner, on a cutoff that moved
 *   FLIGHT_DELAY_CREATED_OPPORTUNITY  "  , on a delay that widened the window
 * Declared, never emitted anywhere (no input exists in any shape):
 * BAGGAGE_STATUS_CRITICAL_UNKNOWN (checked_bags is a boolean, unknown is
 * unrepresentable), RETURN_ROUTE_UNRELIABLE, AIRPORT_CHANGE_REQUIRED,
 * SELF_TRANSFER_FRICTION, RECOMMENDATION_EXPIRED.
 */
export const LAYOVER_REASON_CODES = [
  "ENTRY_NOT_CONFIRMED",
  "BAGGAGE_STATUS_CRITICAL_UNKNOWN",
  "INSUFFICIENT_USABLE_TIME",
  "SECURITY_WAIT_HIGH",
  "RETURN_ROUTE_UNRELIABLE",
  "AIRPORT_CHANGE_REQUIRED",
  "SELF_TRANSFER_FRICTION",
  "DATA_STALE",
  "SOURCE_CONFLICT",
  "TRAFFIC_DEGRADED",
  "FLIGHT_MOVED_EARLIER",
  "FLIGHT_DELAY_CREATED_OPPORTUNITY",
  "RETURN_THRESHOLD_REACHED",
  "RECOMMENDATION_EXPIRED",
  "AIRPORT_MATURITY_LIMITED",
] as const;
export type LayoverReasonCode = (typeof LAYOVER_REASON_CODES)[number];

/**
 * Spec §15 escalation ladder, derived deterministically from the clock and the
 * certified deadline. No side effect fires from it here (no notification, no
 * CTA switch — those are client/Safe Return concerns the spec assigns to other
 * surfaces); it is the STATE those surfaces are meant to consume.
 */
export type LayoverReturnState =
  | "NORMAL"
  | "RETURN_SOON"
  | "RETURN_NOW"
  | "CONNECTION_AT_RISK";

/**
 * Minutes before the hard return deadline at which RETURN_SOON begins. Equal to
 * the client's default "Remind me" lead (returnDeadlineSchema minutesBefore
 * default 30) so the server state and the local reminder agree.
 */
export const RETURN_SOON_LEAD_MIN = 30;

/**
 * Where a candidate's `travelTimeMin` came from. Spec §2.1: "missing live
 * intelligence degrades VISIBLY; never fabricate freshness." A travel time is
 * an input to a "safe" rating a traveller may act on by leaving the airport,
 * so its nature travels with the recommendation to the client
 * (SafeRecommendation.travelTimeSource) and into `adviseLeaving`'s `unknowns`.
 *
 *   inside_airport    no landside travel — the candidate is airside, 0 minutes
 *                     by construction, not by estimate.
 *   unmeasured        THERE IS NO FIGURE. Nobody has measured this leg and no
 *                     routed provider answered for it, so the candidate's
 *                     `travelTimeMin` is `null`. This is what every landside
 *                     card on this tree now carries (census L293): the three
 *                     category constants that used to stand here — 15/25 from
 *                     `estimateTravelTime`, the city-escape card's 30 and the
 *                     safety route's 20 — are deleted, not relabelled. A
 *                     traveller is told the journey is unknown rather than told
 *                     a number that was chosen without a coordinate.
 *   category_default  a per-category constant chosen without reading a
 *                     coordinate. NOTHING PRODUCES ONE any more; the value
 *                     survives because rows written before L293 was closed
 *                     still hold such a number, and reporting those as
 *                     `unmeasured` would be a second fabrication in the other
 *                     direction. See `persistedTravelTimeSource`.
 *   measured          derived from a real route/distance for THIS place from
 *                     THIS airport — i.e. from a `TravelTimeProvider` whose
 *                     `routed` flag is true. Declared so a client can
 *                     distinguish it; the only configured provider on this tree
 *                     is `noRoutedProvider`, so nothing produces it (pinned by
 *                     src/test/layoverTravelTimeProvenance.test.ts). When one is
 *                     built, persist the source on the row — see
 *                     `travelTimeSourceFor` for why the read path cannot infer it.
 */
export const TRAVEL_TIME_SOURCES = ["inside_airport", "category_default", "measured", "unmeasured"] as const;
export type TravelTimeSource = (typeof TRAVEL_TIME_SOURCES)[number];

/**
 * Is a source a real route for THIS place from THIS airport, or a stand-in?
 *
 * Declared once, here, beside `TRAVEL_TIME_SOURCES`, for one reason: nothing
 * outside this file may write or compare the "measured" string — that is the
 * tripwire `src/test/layoverTravelTimeProvenance.test.ts` holds, because the
 * persisted read path infers provenance and the inference is exact only while
 * no producer exists. A consumer that needs to know whether a figure is routed
 * asks this table instead of re-spelling the value. This is a CLASSIFICATION
 * of the three declared sources, not a producer of any of them: adding a
 * routed producer still means adding a column, updating getRecommendations and
 * changing that test's expectation.
 */
export const TRAVEL_TIME_SOURCE_IS_ROUTED: Record<TravelTimeSource, boolean> = {
  inside_airport:   false,
  category_default: false,
  measured:         true,
  // Not routed, and not a figure at all. Kept in the table rather than special-
  // cased at the call sites, so "is this a route?" is still one question with
  // one answer for every member of the vocabulary.
  unmeasured:       false,
};

/**
 * Resolve the provenance of a travel-time figure, failing CLOSED: an absent
 * source is treated as the least-trusted kind that applies, never as measured.
 *
 * Today this is also how the persisted read path (`getRecommendations`)
 * recovers provenance, because `layover_recommendations` has no column for it
 * and adding one unconditionally would break the write on any database that
 * has not run the migration (the same hazard 2410 gates behind a flag). That
 * inference is honest ONLY while nothing produces "measured" — which the
 * provenance test pins. The day a measured producer lands, the row must carry
 * the source and this fallback must stop being used for persisted rows.
 */
export function travelTimeSourceFor(c: {
  insideAirport: boolean;
  travelTimeSource?: TravelTimeSource | null;
}): TravelTimeSource {
  if (c.travelTimeSource && (TRAVEL_TIME_SOURCES as readonly string[]).includes(c.travelTimeSource)) {
    return c.travelTimeSource;
  }
  return c.insideAirport ? "inside_airport" : "category_default";
}

/**
 * Provenance of a PERSISTED row's travel figure, resolved from the row itself.
 *
 * `layover_recommendations.travel_time_min` is `INTEGER NOT NULL DEFAULT 0`
 * (migration 0127), so — exactly like `layover_plan_stops.travel_min` in L47 —
 * the column cannot hold "nobody measured this". The row's own
 * `inside_airport` is what tells the two apart, and `statedTravelMin` is where
 * that rule lives:
 *
 *   inside_airport, 0   0 minutes of landside travel, BY CONSTRUCTION. A fact.
 *   landside, 0         nobody stated a journey. An ABSENCE -> "unmeasured".
 *   landside, > 0       a number is stored. Nothing produces one any more, so
 *                       it was written before L293 was closed -> the honest
 *                       label for it is still "category_default". Calling it
 *                       "unmeasured" would deny a figure the row visibly holds;
 *                       calling it "measured" would be the original defect.
 *
 * This remains exact only while nothing produces "measured" — see
 * `travelTimeSourceFor` for why, and `layoverTravelTimeProvenance.test.ts` for
 * the tripwire that holds it.
 */
export function persistedTravelTimeSource(row: {
  insideAirport: boolean;
  travelTimeMin: number | null | undefined;
}): TravelTimeSource {
  if (row.insideAirport) return "inside_airport";
  const stated = statedLegMin({ travelMin: row.travelTimeMin, insideAirport: false });
  return stated === null ? "unmeasured" : "category_default";
}

/**
 * Spec §10 "Fast live" conditions, as the ONE shape the buffer arithmetic will
 * accept them in.
 *
 * WHAT THIS IS. Three additive minute figures and the reason codes that
 * explain them, produced by `LayoverAirportTruth.liveConditionsFrom()` out of
 * reconciled observations and by nothing else. The engine deliberately does
 * NOT take raw observations: reconciliation, conflict handling, decay and the
 * conservative-source rule are §10.1 policy and belong one layer up, so what
 * reaches the arithmetic is already a decided number with a stated reason.
 *
 * WHAT IT IS NOT. It is not a producer. NOTHING ON THIS TREE BUILDS ONE
 * OUTSIDE TESTS: there is no observation table applied, no ingest route and no
 * external feed, so every production call passes `undefined` and every number
 * below is 0. That absence is the point of the default — `NO_LIVE_CONDITIONS`
 * reproduces today's arithmetic term for term, and
 * `src/test/layoverLiveConditions.test.ts` pins that equality so the seam
 * cannot start moving numbers by accident.
 *
 * WHY ADDITIVE-ONLY, AND NEVER SUBTRACTIVE. §10.1: "For safety calculations,
 * prefer conservative values when credible sources disagree." A live signal may
 * only ever make the buffer LARGER. An observed queue SHORTER than the baseline
 * the static buffer already assumes contributes 0, not a discount: shrinking a
 * safety buffer on a single crowd-sourced reading is the failure mode the
 * conservative rule exists to forbid, and it is also what keeps
 * `usableMinutes` monotonically non-increasing in every live wait (spec §6.1
 * L51, swept in `layoverLiveConditions.test.ts`).
 */
export interface LiveConditions {
  /** Extra minutes over the baseline the static buffer already covers. >= 0. */
  securityWaitExtraMin: number;
  /** Extra immigration-hall minutes over the airport's own immigration term. >= 0. */
  immigrationWaitExtraMin: number;
  /** Extra ground-transport minutes over the airport's traffic term. >= 0. */
  groundTransportExtraMin: number;
  /** Appendix A codes the truth layer decided apply. Merged into the advice. */
  reasonCodes: LayoverReasonCode[];
  /**
   * Oldest observation these minutes rest on, ISO, and the instant they stop
   * being usable. Carried rather than computed here so the §6.2 estimate built
   * from them can state a real `observedAt`/`expiresAt` instead of `null` —
   * the arithmetic ignores both. `null` when there is no observation.
   */
  observedAt: string | null;
  expiresAt: string | null;
}

/** The absence of live intelligence, spelled out. Adds 0 to every term. */
export const NO_LIVE_CONDITIONS: LiveConditions = {
  securityWaitExtraMin: 0,
  immigrationWaitExtraMin: 0,
  groundTransportExtraMin: 0,
  reasonCodes: [],
  observedAt: null,
  expiresAt: null,
};

/**
 * The single scalar the buffer adds for live conditions.
 *
 * Fails closed in both directions a caller can get wrong: an absent
 * `LiveConditions` is 0, and a negative or non-finite term is clamped to 0
 * rather than trusted — a producer that computed −20 must not be able to hand
 * a traveller twenty extra minutes in the city.
 */
export function liveExtraMinutes(live?: LiveConditions | null): number {
  if (!live) return 0;
  const term = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return (
    term(live.securityWaitExtraMin) +
    term(live.immigrationWaitExtraMin) +
    term(live.groundTransportExtraMin)
  );
}

export interface ActivityCandidate {
  title: string;
  /**
   * One-way travel time in minutes, or `null` when NOBODY HAS MEASURED IT
   * (census L293). `null` is not a zero and is not a default: it is the value
   * every landside candidate on this tree carries, because the only configured
   * `TravelTimeProvider` is `noRoutedProvider` and it answers
   * `NO_ROUTED_PROVIDER` for every pair of points.
   *
   * A landside 0 is read the same way — see `statedTravelMin` — so a caller
   * cannot slip an absence past this type by spelling it `0`. Airside 0 stays
   * a fact.
   */
  travelTimeMin: number | null;
  /** Time needed at the destination, or `null` when nobody has stated one. */
  activityTimeMin: number | null;
  insideAirport: boolean;
  verified?: boolean;
  /** Provenance of `travelTimeMin`. Absent = not measured (see travelTimeSourceFor). */
  travelTimeSource?: TravelTimeSource;
}

export interface SafetyAssessment {
  rating: SafetyRating;
  availableMinutes: number;
  /**
   * Total time needed: travel×2 + activity + buffer.
   *
   * A LOWER BOUND whenever `requiredMinutesIsLowerBound` is true — the terms
   * nobody stated are omitted rather than guessed, exactly as `planFitTotals`
   * omits an unstated leg. A lower bound can REFUSE ("even this overflows") and
   * can never CERTIFY.
   */
  requiredMinutes: number;
  returnBufferMin: number;     // computed buffer
  hardReturnTime: Date;        // absolute time user must leave by
  usableMinutes: number;       // availableMinutes - returnBufferMin
  /**
   * The one-way landside leg AS A STATED FIGURE: 0 for an airside candidate (a
   * fact), a positive number when one was stated, `null` when nobody measured
   * it. This is the value the arithmetic above actually used, published so a
   * caller never has to re-derive it from the candidate.
   */
  statedTravelMin: number | null;
  /** The dwell as a stated figure, or `null` when nobody stated one. */
  statedActivityMin: number | null;
  /** TRUE when `requiredMinutes` omits a term, so the real total is larger. */
  requiredMinutesIsLowerBound: boolean;
  warningReason: string | null;
  breakdown: {
    baseBuffer:       number;
    immigrationExtra: number;
    bagsExtra:        number;
    trafficExtra:     number;
    timeOfDayExtra:   number;
    /**
     * §10 live conditions, as one additive term. 0 whenever no live intelligence
     * was supplied — which is every production request today. It is a SEPARATE
     * term and never folded into `trafficExtra` on purpose: a traveller asking
     * "why is my deadline earlier than yesterday" must be able to see that the
     * answer is an observed queue and not the airport's static traffic figure.
     */
    liveExtra:        number;
    totalBuffer:      number;
  };
}

/**
 * Raw time-of-day band: night layovers (22:00–06:00 airport-local) or early
 * morning add extra buffer due to reduced transport and higher caution.
 * This is a STEP function of the local hour — do not call it directly when the
 * result feeds a deadline; use `timeOfDayExtra`, which ramps it. See below.
 */
function timeOfDayBand(hour: number): number {
  if (hour >= 22 || hour < 6) return 20;
  if (hour >= 20 || hour < 8) return 10;
  return 0;
}

/**
 * The largest value `timeOfDayBand` can return, and therefore the look-ahead
 * window (in minutes) the ramp below needs in order to be 1-Lipschitz. Keeping
 * these equal is what makes the monotonicity proof independent of how the
 * bands themselves are drawn: over any window of `RAMP + 1` minutes the band
 * can rise by at most `RAMP`, which is <= `RAMP + 1`.
 */
const TOD_RAMP_MIN = 20;

/**
 * Time-of-day buffer adjustment, ramped so it can never rise faster than one
 * minute per minute of clock time.
 *
 * WHY THIS IS NOT THE RAW STEP FUNCTION. The hard return deadline is
 * `cutoff − buffer(cutoff)`. With a raw step, a cutoff of 20:00 airport-local
 * carried a 10-minute-larger buffer than a cutoff of 19:59, so moving a flight
 * one minute LATER moved the traveller's "you must head back now" deadline
 * NINE MINUTES EARLIER — equivalently, a departure one minute EARLIER bought
 * nine extra minutes in the city. That is a safety defect: the deadline must be
 * monotonically non-decreasing in the flight cutoff.
 *
 * The fix takes the running maximum of `band(t + d) − d` over a look-ahead
 * window. Where the band is about to step up, the extra is phased in one minute
 * at a time beforehand, so `cutoff − buffer(cutoff)` is flat across the
 * transition instead of jumping backwards. Because the `d = 0` term is always
 * included, the ramped value is never BELOW the raw band — the correction only
 * ever moves the deadline earlier (more conservative), never later.
 *
 * Sampling real instants rather than clock arithmetic keeps this correct across
 * DST transitions, where local minutes-of-day do not advance uniformly.
 */
function timeOfDayExtra(at: Date, timezone?: string): number {
  const bandAt = (offsetMin: number): number => {
    const t = offsetMin === 0 ? at : new Date(at.getTime() + offsetMin * 60_000);
    return timeOfDayBand(timezone ? localHour(timezone, t) : t.getUTCHours());
  };
  let extra = bandAt(0);
  for (let d = 1; d <= TOD_RAMP_MIN; d++) {
    const ramped = bandAt(d) - d;
    if (ramped > extra) extra = ramped;
  }
  return extra;
}

/**
 * Exactly the airport fields this engine reads, and exactly the session fields
 * it reads. Declared as narrowings rather than the full domain types so that
 * the certified input set in LayoverFeasibility can be checked against them by
 * the compiler: if the arithmetic ever starts reading a field, it has to be
 * added here, which makes it visible in the record and in its input hash.
 * `AirportProfile` and `LayoverSession` satisfy these, so every existing
 * caller is unaffected.
 */
export type EngineAirport = Pick<AirportProfile,
  | "timezone" | "verified"
  | "domesticBufferMin" | "internationalBufferMin"
  | "immigrationExtraMin" | "checkedBagsExtraMin" | "trafficExtraMin"
> & {
  /**
   * OPTIONAL, and read by NO arithmetic in this file — which is why it is added
   * as an optional member rather than to the `Pick` above, where every entry is
   * a term in a buffer. It names the place the two §7 commitments sit at, so
   * the freedom window says WHICH airport it is about instead of `null`. A
   * caller that does not hold it (there is none today — both `AirportProfile`
   * and `FeasibilityAirport` carry it) loses the label and nothing else.
   */
  iataCode?: string;
};
export type EngineSession = Pick<LayoverSession,
  | "arrivalTime" | "departureTime" | "boardingTime"
  | "flightType" | "immigrationRequired" | "checkedBags" | "wantsToLeave"
>;

/** The certified deadline computation, as `computeReturnDeadline` returns it. */
export interface ReturnDeadline {
  cutoffMs: number;
  breakdown: SafetyAssessment["breakdown"];
  hardReturnTime: Date;
}

export function computeBuffer(
  airport: Pick<AirportProfile,
    "domesticBufferMin" | "internationalBufferMin" |
    "immigrationExtraMin" | "checkedBagsExtraMin" | "trafficExtraMin"
  >,
  session: Pick<LayoverSession, "flightType" | "immigrationRequired" | "checkedBags">,
  /** Instant the buffer is required to be complete by — the flight cutoff. */
  at: Date,
  timezone?: string,
  /**
   * §10 reconciled live conditions. Absent (the only case in production today)
   * adds 0 and leaves every other term untouched.
   */
  live?: LiveConditions | null,
): SafetyAssessment["breakdown"] {
  const baseBuffer       = session.flightType === "international"
    ? airport.internationalBufferMin
    : airport.domesticBufferMin;
  const immigrationExtra = session.immigrationRequired ? airport.immigrationExtraMin : 0;
  const bagsExtra        = session.checkedBags         ? airport.checkedBagsExtraMin  : 0;
  const trafficExtra     = airport.trafficExtraMin;
  const timeOfDayExtraMin = timeOfDayExtra(at, timezone);
  const liveExtra         = liveExtraMinutes(live);
  const totalBuffer       = baseBuffer + immigrationExtra + bagsExtra + trafficExtra + timeOfDayExtraMin + liveExtra;
  return { baseBuffer, immigrationExtra, bagsExtra, trafficExtra, timeOfDayExtra: timeOfDayExtraMin, liveExtra, totalBuffer };
}

/**
 * The instant the traveller's flight stops waiting for them: boarding time when
 * the session carries one, departure time otherwise. Every buffer and every
 * deadline in this module is anchored here — having some call sites anchor the
 * buffer to `departureTime` while anchoring the deadline to the cutoff is what
 * made `GET /sessions/:id/safety` publish a `returnBufferMin` that did not match
 * its own `hardReturnTime`.
 */
export function layoverCutoffMs(
  session: Pick<LayoverSession, "departureTime" | "boardingTime">,
): number {
  const boardingMs = session.boardingTime ? new Date(session.boardingTime).getTime() : null;
  return boardingMs ?? new Date(session.departureTime).getTime();
}

/**
 * The single source of truth for "when must the traveller start heading back".
 *
 * Guarantees, both covered by property tests in `src/test/layoverDeadlineMonotonicity.test.ts`:
 *  1. `hardReturnTime` is monotonically non-decreasing in the flight cutoff.
 *  2. `hardReturnTime === cutoff − breakdown.totalBuffer`, always — so a caller
 *     may publish the two together without them contradicting each other.
 */
export function computeReturnDeadline(
  airport: EngineAirport,
  session: Pick<LayoverSession,
    "flightType" | "immigrationRequired" | "checkedBags" | "departureTime" | "boardingTime"
  >,
  /**
   * §10 reconciled live conditions. `liveExtra` is a constant with respect to
   * the cutoff, so guarantee 1 above (monotone in the cutoff) is unaffected by
   * it — proved for non-zero live conditions in
   * `src/test/layoverLiveConditions.test.ts`, not merely argued here.
   */
  live?: LiveConditions | null,
): ReturnDeadline {
  const cutoffMs  = layoverCutoffMs(session);
  const breakdown = computeBuffer(airport, session, new Date(cutoffMs), airport.timezone, live);
  return {
    cutoffMs,
    breakdown,
    hardReturnTime: new Date(cutoffMs - breakdown.totalBuffer * 60_000),
  };
}

/**
 * The sentence a traveller is shown when the journey behind a card was never
 * measured. Exported so the test can assert on the exact words, and so no
 * caller re-spells it.
 *
 * It names the REAL cause. The refusal it accompanies is `not_recommended`,
 * whose stock label is "too little time to return safely" — an arithmetic claim
 * this engine has no right to make about a leg it never measured. The warning
 * is therefore the load-bearing half of the answer, not decoration.
 */
export const UNMEASURED_TRAVEL_WARNING =
  "We have not measured how long it takes to get there from this airport, so we cannot tell you it is safe to go.";

/** The same, for a card whose time-at-the-destination nobody stated. */
export const UNSTATED_ACTIVITY_WARNING =
  "Nobody has said how long this takes, so we cannot tell you it fits your layover.";

/**
 * Assess a single activity against the current session state.
 *
 * ── IT FAILS CLOSED ON A TERM NOBODY STATED (census L293) ───────────────────
 * `travelTimeMin: null` — or a landside `0`, which is the same absence wearing
 * the only value an `INTEGER NOT NULL` column can hold — means nobody measured
 * the journey. The old code multiplied a fabricated 15, 25, 20 or 30 by two and
 * returned `"safe"`; a traveller read that and left an airport.
 *
 * The rule now has L47's shape. `requiredMinutes` counts only the terms that
 * were stated, which makes it a LOWER BOUND, and a lower bound is allowed to do
 * exactly one thing: refuse. So:
 *
 *   - if even the lower bound overflows the usable window, the refusal is
 *     CERTAIN and keeps its arithmetic reason;
 *   - otherwise, with any term unstated, the answer is still a refusal
 *     (`not_recommended`) but the reason is the missing measurement. Never
 *     "safe", never "possible_but_risky" — those are certifications, and
 *     nothing here has been measured well enough to certify.
 *
 * Airside is untouched: its 0 is a fact, not an estimate.
 */
export function assess(
  airport: EngineAirport,
  session: EngineSession,
  candidate: ActivityCandidate,
  nowMs = Date.now(),
  /**
   * The already-certified deadline for this session, when the caller holds
   * one. Passing it is how "one computation per request" is made literally
   * true: without it every candidate in a list re-derives the same deadline.
   * It is the SAME function's output either way — `computeReturnDeadline` is
   * pure and depends on nothing but these two arguments — so this is a reuse,
   * not a second path, and `layoverFeasibilityRecord.test.ts` pins that
   * passing it and omitting it give identical assessments.
   */
  certified?: ReturnDeadline,
  /**
   * §10 live conditions, used ONLY when no certified deadline was handed in.
   * A caller that passes both is telling the engine two things at once, so the
   * certified deadline wins — it is the one already published elsewhere in the
   * same response, and a candidate rated against a different buffer than the
   * one on screen is precisely headline defect 2.
   */
  live?: LiveConditions | null,
): SafetyAssessment {
  const { cutoffMs, breakdown, hardReturnTime } = certified ?? computeReturnDeadline(airport, session, live);
  const availableMin   = Math.max(0, Math.round((cutoffMs - nowMs) / 60000));

  const bufferMin      = breakdown.totalBuffer;
  const usableMin      = Math.max(0, availableMin - bufferMin);

  // The two terms, as FACTS or as absences. `statedLegMin` is L47's own rule:
  // airside 0 is a fact, landside 0 is the absence of a journey.
  const statedTravel   = statedLegMin({ travelMin: candidate.travelTimeMin, insideAirport: candidate.insideAirport });
  const statedActivity = statedDwellMin({ durationMin: candidate.activityTimeMin });
  const lowerBound     = statedTravel === null || statedActivity === null;

  // Round trip. Airside is 0 by construction; landside is twice the OUTBOUND
  // leg, and only when that leg was stated.
  const tripTimeMin    = candidate.insideAirport ? 0 : (statedTravel ?? 0) * 2;

  // Only the stated terms are counted, so this is a lower bound whenever
  // `lowerBound` is true. Nothing is substituted for what is missing.
  const requiredMin    = tripTimeMin + (statedActivity ?? 0) + bufferMin;
  const outAndBackMin  = tripTimeMin + (statedActivity ?? 0);

  let rating: SafetyRating;
  let warningReason: string | null = null;

  if (candidate.insideAirport) {
    if (statedActivity === null) {
      // An airside card whose dwell nobody stated. Its 0 travel is still a
      // fact, but "safe" would be a claim about a length no one gave.
      rating = "not_recommended";
      warningReason = UNSTATED_ACTIVITY_WARNING;
    } else if (availableMin < statedActivity + 15) {
      // Inside airport is always safe unless the layover itself is too short
      rating = "possible_but_risky";
      warningReason = "Your layover is very short — plan for a quick visit.";
    } else {
      rating = "safe";
    }
  } else if (!session.wantsToLeave) {
    // Not a time claim, so an unstated leg does not change it: the traveller
    // said they are staying airside, and that answer is theirs.
    rating = "airport_only";
    warningReason = "You indicated you'd prefer to stay at the airport.";
  } else if (usableMin <= 0) {
    rating = "not_recommended";
    warningReason = "Not enough time after your required return buffer.";
  } else if (usableMin < outAndBackMin) {
    // CERTAIN refusal: even the lower bound overflows, so no measurement of the
    // missing terms could rescue it. The arithmetic reason is the true one.
    rating = "not_recommended";
    warningReason = `You'd need ${outAndBackMin} min but only have ${usableMin} min usable.`;
  } else if (lowerBound) {
    // It MIGHT fit. Nobody has measured it, and "possible but risky" would be a
    // certification of a risk this engine cannot size. Refuse, and say why.
    rating = "not_recommended";
    warningReason = statedTravel === null ? UNMEASURED_TRAVEL_WARNING : UNSTATED_ACTIVITY_WARNING;
  } else if (usableMin - outAndBackMin < 20) {
    rating = "possible_but_risky";
    warningReason = "Your return buffer is tight — any delay could cause you to miss your flight.";
  } else if (!candidate.verified && (statedTravel ?? 0) > 30) {
    rating = "possible_but_risky";
    warningReason = "Unverified place far from airport — allow extra time.";
  } else {
    rating = "safe";
  }

  return {
    rating,
    availableMinutes: availableMin,
    requiredMinutes: requiredMin,
    returnBufferMin: bufferMin,
    hardReturnTime,
    usableMinutes: usableMin,
    statedTravelMin: statedTravel,
    statedActivityMin: statedActivity,
    requiredMinutesIsLowerBound: lowerBound,
    warningReason,
    breakdown,
  };
}

/**
 * The session's own answer, WITH NO JOURNEY IN IT (census L293c).
 *
 * `GET /:id/safety` used to invent a candidate — `travelTimeMin: 20,
 * activityTimeMin: 30`, the same two numbers for every session at every airport
 * — purely so `assess` had something to score, and published that score as the
 * session's overall safety. There is no place and no journey behind that
 * question: what the traveller is asking is "given my window, can I go out at
 * all?", and the window alone answers it.
 *
 * So this rates the WINDOW. `requiredMinutes` is the buffer and nothing else,
 * `statedTravelMin` / `statedActivityMin` are null because no leg was named,
 * and `requiredMinutesIsLowerBound` is true because any real outing costs more
 * than the buffer.
 *
 * THE BANDS ARE `adviseLeaving`'S, NOT NEW ONES, AND SO IS THE NUMBER THEY READ.
 * 90 / 45 are the same thresholds that produce `yes` / `tight` / `no`, and they
 * are applied to `window.usableMinutes` — the ENVELOPE's figure, which starts
 * the clock at the later of `now` and the earliest realistic landside exit.
 * `assess`'s own `availableMinutes − buffer` is a different and more optimistic
 * number (it charges nothing for immigration and bags), and rating against it
 * while the same response published the envelope's is how `overallRating` and
 * `advice.verdict` came to disagree — caught by this pass's own regression
 * test, with `verdict: "no"` sitting next to `possible_but_risky` at 20 usable
 * minutes. The window is therefore a REQUIRED argument: there is no default
 * that could be right, and computing a second one here would put the two back.
 */
export function assessWindowOnly(
  airport: EngineAirport,
  session: EngineSession,
  /** The certified envelope this answer is about. `computeWindow`'s output. */
  window: LayoverWindow,
  nowMs = Date.now(),
  certified?: ReturnDeadline,
  live?: LiveConditions | null,
): SafetyAssessment {
  const { cutoffMs, breakdown, hardReturnTime } = certified ?? computeReturnDeadline(airport, session, live);
  const availableMin = Math.max(0, Math.round((cutoffMs - nowMs) / 60000));
  const bufferMin    = breakdown.totalBuffer;
  const usableMin    = window.usableMinutes;

  let rating: SafetyRating;
  let warningReason: string | null = null;
  if (!session.wantsToLeave) {
    rating = "airport_only";
    warningReason = "You indicated you'd prefer to stay at the airport.";
  } else if (usableMin >= 90) {
    rating = "safe";
  } else if (usableMin >= 45) {
    rating = "possible_but_risky";
    warningReason = `Only ~${usableMin} min usable — a very short trip right by the airport at most.`;
  } else {
    rating = "not_recommended";
    warningReason = `After the required buffers you'd have ~${usableMin} min — not enough to leave and return safely.`;
  }

  return {
    rating,
    availableMinutes: availableMin,
    requiredMinutes: bufferMin,
    returnBufferMin: bufferMin,
    hardReturnTime,
    usableMinutes: usableMin,
    statedTravelMin: null,
    statedActivityMin: null,
    requiredMinutesIsLowerBound: true,
    warningReason,
    breakdown,
  };
}

/**
 * Sort a list of activities by safety + vibe fit.
 * Safe activities come first; within same rating, shorter travel time wins.
 *
 * §9.1's "HARD GATE … before any optimisation", as an ordering: the certified
 * rating is the primary key and every preference the caller has already encoded
 * is demoted beneath it. `Array.prototype.sort` is stable, so candidates that
 * tie on (rating, travelTimeMin) keep the order they arrived in — which is how
 * the recommendation service's verified/time-of-day/live ordering survives
 * underneath this one instead of being discarded by it.
 *
 * THE `certified` PARAMETER IS NOT AN OPTIMISATION. Until 2026-09-13 this
 * function had no caller outside its test, and giving it one without this
 * parameter would have silently reintroduced the defect `9c26efba` closed: a
 * SECOND `computeReturnDeadline` derivation inside one request, at a different
 * `nowMs` and — worse — without the `LiveConditions` the caller certified with,
 * so a live queue reading would have moved the deadline the cards were rated
 * against and not the one ranking them. Callers that hold a certified deadline
 * pass it; the fallback below is the same pure function and is what the unit
 * test still exercises.
 */
export function rankActivities<T extends ActivityCandidate>(
  airport: EngineAirport,
  session: EngineSession,
  /**
   * Generic in the candidate rather than widened to `ActivityCandidate`: the
   * recommendation service's candidates carry `recType`, `placeId`, `city` and
   * the rest, the spread below preserves them at runtime, and a non-generic
   * signature threw them away at the type level — which is how a caller ends up
   * re-deriving what it already had.
   */
  candidates: T[],
  nowMs = Date.now(),
  /** The deadline this request already certified. See the note above. */
  certifiedDeadline?: ReturnDeadline,
): Array<T & { assessment: SafetyAssessment }> {
  const RATING_ORDER: Record<SafetyRating, number> = {
    safe:               0,
    possible_but_risky: 1,
    not_recommended:    2,
    airport_only:       3,
  };

  // One deadline for the whole list, not one per candidate.
  const certified = certifiedDeadline ?? computeReturnDeadline(airport, session);
  return candidates
    .map((c) => ({ ...c, assessment: assess(airport, session, c, nowMs, certified) }))
    .sort((a, b) => {
      const rDiff = RATING_ORDER[a.assessment.rating] - RATING_ORDER[b.assessment.rating];
      if (rDiff !== 0) return rDiff;
      // "within a rating, shorter travel time wins" — but a leg nobody measured
      // is not a short one. `a.travelTimeMin - b.travelTimeMin` was NaN for a
      // null, and a NaN comparator silently leaves the array in whatever order
      // the engine's sort happened to produce. Unstated legs sort last, which
      // is the same direction every other decision here fails.
      const at = a.assessment.statedTravelMin ?? Number.POSITIVE_INFINITY;
      const bt = b.assessment.statedTravelMin ?? Number.POSITIVE_INFINITY;
      if (at === bt) return 0;
      return at < bt ? -1 : 1;
    });
}

/** Safety wording for the UI ("Safe with your current time window.", etc.) */
export function safetyLabel(rating: SafetyRating): string {
  switch (rating) {
    case "safe":               return "Safe with your current time window.";
    case "possible_but_risky": return "Possible, but your return buffer is tight.";
    case "not_recommended":    return "Not recommended — too little time to return safely.";
    case "airport_only":       return "Airport-only option for your preference.";
  }
}

// ── Usable window, status tier & leave advice ─────────────────────────────────

export type LayoverTier =
  | "too_short"
  | "airport_only"
  | "quick_city"
  | "half_day"
  | "overnight";

export interface LayoverWindow {
  /** Full arrival→cutoff span in minutes (boarding time wins over departure). */
  totalMinutes: number;
  /** Estimated arrival→landside exit process (immigration, bags) in minutes. */
  exitDelayMin: number;
  /** Required landside→gate return buffer (security, transfer, contingency). */
  returnBufferMin: number;
  /** Free out-of-airport minutes between exit and hard return, from `now`. */
  usableMinutes: number;
  /** Instant the user must start heading back to the airport. */
  hardReturnTime: Date;
  /** Earliest instant the user can realistically be landside. */
  earliestOutTime: Date;
  breakdown: SafetyAssessment["breakdown"] & { exitDelay: number };
  tier: LayoverTier;
  tierLabel: string;
  tierBlurb: string;
  overnight: boolean;
  /** §15 escalation state at `nowMs`. See `computeReturnState`. */
  returnState: LayoverReturnState;
  /** Rules version that produced every number above. */
  engineVersion: string;
  /**
   * Spec §7 `FreedomWindow`, as the GENERALISED Temporal Freedom Engine
   * computed it for this layover's two commitments — the artifact every number
   * above is the layover-shaped projection of.
   *
   * `null` when there is no window, which is the case `temporalConflict`
   * explains. It is not a second computation: `freedomWindow.endsAt` is
   * `hardReturnTime` to the millisecond and `usableMinutes` is that window
   * clipped to `nowMs`, both swept in the adapter's test.
   */
  freedomWindow: FreedomWindow | null;
  /**
   * §7.2 — "a conflict is not silently rendered as a normal itinerary". Present
   * exactly when `freedomWindow` is null: the buffer (and, for a layover with
   * no gap at all, the cutoff itself) leaves no window, and this says by how
   * many minutes. Before this the traveller got `usableMinutes: 0` and the
   * shortfall existed nowhere.
   */
  temporalConflict: TemporalConflict | null;
  /**
   * The conflict's `shortfallMinutes`, lifted out so a client can read one
   * number without knowing the engine's conflict vocabulary. `null` whenever
   * there IS a window — an existing window is never short.
   */
  shortfallMinutes: number | null;
}

/**
 * Derive the §15 escalation state from the clock.
 *
 *   NORMAL              now <  hardReturn − RETURN_SOON_LEAD_MIN
 *   RETURN_SOON         now >= hardReturn − RETURN_SOON_LEAD_MIN
 *   RETURN_NOW          now >= hardReturn
 *   CONNECTION_AT_RISK  now >= hardReturn + contingency, where contingency is
 *                       the cushion half of the buffer (traffic + time-of-day);
 *                       past it, only the process terms (security, immigration,
 *                       bags) remain and any further delay is a missed flight.
 *
 * Two properties, both swept in src/test/layoverReturnState.test.ts:
 *   1. monotone in time — as `nowMs` advances the state never steps back;
 *   2. monotone in the cutoff — a flight that stops waiting EARLIER never yields
 *      a calmer state at the same instant (hardReturn is non-decreasing in the
 *      cutoff, proved in layoverDeadlineMonotonicity.test.ts, and
 *      hardReturn + contingency = cutoff − (base + immigration + bags) is
 *      non-decreasing by construction).
 */
export function computeReturnState(
  hardReturnMs: number,
  breakdown: Pick<SafetyAssessment["breakdown"], "trafficExtra" | "timeOfDayExtra">,
  nowMs: number,
): LayoverReturnState {
  const contingencyMs = (breakdown.trafficExtra + breakdown.timeOfDayExtra) * 60_000;
  if (nowMs >= hardReturnMs + contingencyMs) return "CONNECTION_AT_RISK";
  if (nowMs >= hardReturnMs) return "RETURN_NOW";
  if (nowMs >= hardReturnMs - RETURN_SOON_LEAD_MIN * 60_000) return "RETURN_SOON";
  return "NORMAL";
}

/** Estimated minutes from wheels-down to standing landside. */
export function estimateExitDelay(
  session: Pick<LayoverSession, "flightType" | "immigrationRequired" | "checkedBags">,
): number {
  let mins = session.flightType === "international"
    ? (session.immigrationRequired ? 45 : 25)
    : 15;
  if (session.checkedBags) mins += 20;
  return mins;
}

const TIER_META: Record<LayoverTier, { label: string; blurb: string }> = {
  too_short:    { label: "Too Short",    blurb: "Stay near your gate — there isn't enough time to do more safely." },
  airport_only: { label: "Airport Only", blurb: "Enough time to enjoy the terminal, not enough to leave safely." },
  quick_city:   { label: "Quick City",   blurb: "You can make one focused trip out — pick something close." },
  half_day:     { label: "Half-Day",     blurb: "A real chunk of the city is within reach. Plan it well." },
  overnight:    { label: "Overnight",    blurb: "An overnight layover — consider a transit hotel or a proper outing." },
};

/**
 * Compute the usable time window and status tier for a session.
 * All hour-of-day logic runs in the airport's timezone.
 */
export function computeWindow(
  airport: EngineAirport,
  session: EngineSession,
  nowMs = Date.now(),
  /** §10 reconciled live conditions; absent adds 0 to the buffer. */
  live?: LiveConditions | null,
): LayoverWindow {
  const arrivalMs = new Date(session.arrivalTime).getTime();
  const tz        = airport.timezone;

  const { cutoffMs, breakdown: breakdownBase, hardReturnTime } = computeReturnDeadline(airport, session, live);

  const totalMinutes  = Math.max(0, Math.round((cutoffMs - arrivalMs) / 60000));
  const exitDelayMin  = estimateExitDelay(session);

  const hardReturnMs   = hardReturnTime.getTime();

  // ── §7: THE WINDOW IS THE GENERALISED ENGINE'S, NOT A THIRD COPY ──────────
  //
  // `arrival + exitDelay` and `hardReturn − windowStart` were spelled out here
  // by hand. They are the two ends of a FreedomWindow between two commitments,
  // which is exactly what `domain/trips/invariants/TripFreedomEngine.ts`
  // computes and what spec §7 says this surface should be the first ADAPTER of.
  // The adapter translates; nothing airport-shaped crosses into the engine.
  //
  // `confidence` mirrors `bufferEstimates`'s own `rowConf` (a verified airport
  // is MEDIUM, every other is LOW) rather than inventing a second rule. It can
  // never be HIGH here, which is why `freedomWindow.certified` is always false.
  const freedomCtx: LayoverFreedomContext = {
    arrivalMs,
    departureMs: new Date(session.departureTime).getTime(),
    cutoffMs,
    exitDelayMin,
    returnBufferMin: breakdownBase.totalBuffer,
    // The two commitments are the SAME place, so the hop between them is 0 by
    // identity and no coordinate is needed to know that. `computeWindow` reads
    // no coordinate at all, and saying `point: null` is what makes the engine
    // report that honestly (a `NO_ORIGIN` constraint) instead of this file
    // asserting a location the arithmetic never opened.
    airportPoint: null,
    airportPlaceId: airport.iataCode ?? null,
    confidence: airport.verified ? "MEDIUM" : "LOW",
  };
  const freedom = buildLayoverFreedomWindow(freedomCtx);
  const earliestOutMs = earliestLandsideMs(freedomCtx);
  // Usable window from the later of "now" and "earliest landside". When the
  // engine returns no window there is none to clip, and the answer is 0 — which
  // is precisely what `Math.max(0, …)` produced before, so no number moves.
  const windowEndMs    = freedom.window ? Date.parse(freedom.window.endsAt) : hardReturnMs;
  const windowStartMs  = Math.max(nowMs, earliestOutMs);
  const usableMinutes  = freedom.window
    ? Math.max(0, Math.round((windowEndMs - windowStartMs) / 60000))
    : 0;

  // Overnight: window crosses into a different airport-local calendar day and
  // is long enough that sleep is part of the plan.
  const overnight =
    localDayString(tz, new Date(arrivalMs)) !== localDayString(tz, new Date(cutoffMs)) &&
    totalMinutes >= 420;

  let tier: LayoverTier;
  if (overnight)                    tier = "overnight";
  else if (usableMinutes < 45)      tier = "too_short";
  else if (usableMinutes < 90 || !session.wantsToLeave) tier = "airport_only";
  else if (usableMinutes < 240)     tier = "quick_city";
  else                              tier = "half_day";

  return {
    totalMinutes,
    exitDelayMin,
    returnBufferMin: breakdownBase.totalBuffer,
    usableMinutes,
    hardReturnTime,
    earliestOutTime: new Date(earliestOutMs),
    breakdown: { ...breakdownBase, exitDelay: exitDelayMin },
    tier,
    tierLabel: TIER_META[tier].label,
    tierBlurb: tier === "airport_only" && !session.wantsToLeave
      ? "You chose to stay at the airport — here's how to make the most of it."
      : TIER_META[tier].blurb,
    overnight,
    returnState: computeReturnState(hardReturnMs, breakdownBase, nowMs),
    engineVersion: LAYOVER_ENGINE_VERSION,
    freedomWindow: freedom.window,
    temporalConflict: freedom.conflict,
    shortfallMinutes: freedom.window ? null : (freedom.conflict?.shortfallMinutes ?? null),
  };
}

export interface LeaveAdvice {
  verdict: "yes" | "tight" | "no" | "stay_airside";
  reasons: string[];
  /** Facts we cannot know from the data we hold — shown explicitly to the user. */
  unknowns: string[];
  disclaimer: string;
  /**
   * Machine-readable counterpart of `reasons` / `unknowns` (spec Appendix A).
   * Every code here corresponds to a fact the engine actually holds; see
   * LAYOVER_REASON_CODES for which codes can and cannot be emitted on this tree.
   */
  reasonCodes: LayoverReasonCode[];
  engineVersion: string;
}

const LEAVE_DISCLAIMER =
  "This is guidance based on your timings, not a guarantee. Verify visa rules, " +
  "airline re-check-in policy and local conditions before leaving the airport.";

/**
 * Facts about the inputs behind the advice that the engine cannot observe on
 * its own. Every field is optional and every absence is read the CONSERVATIVE
 * way — an unstated fact is an unknown, never an assumption in the traveller's
 * favour.
 */
export interface LeaveAdviceFacts {
  /**
   * Provenance of the travel-time figures the traveller's landside options rest
   * on. Anything other than "measured" (including absent) is disclosed in
   * `unknowns` so a category constant is never mistaken for a routed estimate.
   */
  travelTimeSource?: TravelTimeSource;
  /**
   * §10 reconciled live conditions behind this window's buffer. Its reason
   * codes are merged into the advice's codes; absent contributes none. The
   * MINUTES are not re-read here — they are already inside `window`, and
   * reading them twice is how two numbers in one response stop agreeing.
   */
  liveConditions?: LiveConditions | null;
}

/**
 * The `unknowns` line for a travel time that was not measured. Exported so the
 * test can assert on the exact sentence the traveller sees.
 *
 * REWORDED WITH L293. It used to say the times "are category estimates", which
 * was true while `estimateTravelTime` existed and is now false in the
 * traveller's favour: there are no estimates at all. The sentence has to cover
 * both what this tree produces today (nothing — `unmeasured`) and what rows
 * written before L293 still hold (`category_default`), and "has not been
 * measured" is the claim both share.
 */
export const TRAVEL_TIME_UNMEASURED_UNKNOWN =
  "How long it takes to reach places outside this airport has not been measured — no routed travel time exists for this airport";

/** "Can I Leave the Airport?" decision, phrased as guidance. */
export function adviseLeaving(
  airport: Pick<AirportProfile, "verified">,
  session: Pick<LayoverSession, "wantsToLeave" | "flightType" | "checkedBags">,
  window: LayoverWindow,
  facts: LeaveAdviceFacts = {},
): LeaveAdvice {
  const reasons: string[] = [];
  const unknowns: string[] = [
    "Visa or transit-permit requirements for your nationality",
  ];
  // Landside travel times: on this tree there are none (TravelTimeSource
  // "unmeasured"), and rows written before census L293 hold a category constant
  // ("category_default"). Say so wherever the traveller might act on it — i.e.
  // whenever they intend to leave — and stop saying so only when the caller
  // asserts the figures were measured. Absent facts fail closed.
  if (session.wantsToLeave && travelTimeSourceFor({ insideAirport: false, travelTimeSource: facts.travelTimeSource }) !== "measured") {
    unknowns.push(TRAVEL_TIME_UNMEASURED_UNKNOWN);
  }
  // Entry is never confirmed on this tree — the visa line above is a standing
  // unknown, and the code says so in a form a client or a metric can count.
  const reasonCodes: LayoverReasonCode[] = ["ENTRY_NOT_CONFIRMED"];
  // §10 live conditions carry their own Appendix A codes (SECURITY_WAIT_HIGH,
  // TRAFFIC_DEGRADED, DATA_STALE, SOURCE_CONFLICT). They are merged, never
  // re-derived here, and de-duplicated so a caller passing the same code twice
  // cannot inflate a count. Empty in production — nothing produces conditions.
  for (const code of facts.liveConditions?.reasonCodes ?? []) {
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
  }
  if (!airport.verified) reasonCodes.push("AIRPORT_MATURITY_LIMITED");
  if (window.returnState === "RETURN_NOW" || window.returnState === "CONNECTION_AT_RISK") {
    reasonCodes.push("RETURN_THRESHOLD_REACHED");
  }
  if (session.flightType === "international") {
    unknowns.push("Security and immigration queue times vary by hour");
  }
  if (!session.checkedBags) {
    // nothing extra
  } else {
    reasons.push("Checked bags: confirm they're tagged through to your next flight.");
  }
  const common = { unknowns, disclaimer: LEAVE_DISCLAIMER, engineVersion: LAYOVER_ENGINE_VERSION };

  if (!session.wantsToLeave) {
    return {
      verdict: "stay_airside",
      reasons: ["You chose to stay at the airport for this layover."],
      reasonCodes,
      ...common,
    };
  }

  if (window.usableMinutes >= 90) {
    reasons.unshift(
      `About ${Math.floor(window.usableMinutes / 60)}h ${window.usableMinutes % 60}m of usable time after exit and return buffers.`,
    );
    return { verdict: "yes", reasons, reasonCodes, ...common };
  }
  if (window.usableMinutes >= 45) {
    reasons.unshift(
      `Only ~${window.usableMinutes} min usable — a very short trip right by the airport at most.`,
    );
    return { verdict: "tight", reasons, reasonCodes, ...common };
  }
  reasons.unshift(
    `After the required buffers you'd have ~${window.usableMinutes} min — not enough to leave and return safely.`,
  );
  reasonCodes.push("INSUFFICIENT_USABLE_TIME");
  return { verdict: "no", reasons, reasonCodes, ...common };
}
