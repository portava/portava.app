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
 */
export const LAYOVER_ENGINE_VERSION = "2026.09.07-1";

/**
 * Spec Appendix A reason codes — the whole vocabulary, declared once so it can
 * be counted, tested and diffed. Only the codes whose triggering FACT exists in
 * this tree are ever emitted (see `adviseLeaving`); the rest are declared here
 * so a future emitter cannot invent a spelling. Emitters today:
 *   ENTRY_NOT_CONFIRMED         always — nothing on main confirms entry (§6.1)
 *   INSUFFICIENT_USABLE_TIME    verdict "no"
 *   RETURN_THRESHOLD_REACHED    returnState RETURN_NOW / CONNECTION_AT_RISK
 *   AIRPORT_MATURITY_LIMITED    airport.verified === false (spec §22 L0)
 * Declared, never emitted (no input exists): BAGGAGE_STATUS_CRITICAL_UNKNOWN
 * (checked_bags is a boolean, unknown is unrepresentable), SECURITY_WAIT_HIGH,
 * RETURN_ROUTE_UNRELIABLE, AIRPORT_CHANGE_REQUIRED, SELF_TRANSFER_FRICTION,
 * DATA_STALE, SOURCE_CONFLICT, TRAFFIC_DEGRADED, FLIGHT_MOVED_EARLIER,
 * FLIGHT_DELAY_CREATED_OPPORTUNITY, RECOMMENDATION_EXPIRED.
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
 *   category_default  a per-category constant chosen without reading a
 *                     coordinate (LayoverRecommendationService.estimateTravelTime
 *                     — 15 or 25 min; the city-escape card's 30; the safety
 *                     route's 20). This is every landside number on this tree.
 *   measured          derived from a real route/distance for THIS place from
 *                     THIS airport. Declared so a client can distinguish it;
 *                     NO PRODUCER EXISTS on this tree (pinned by
 *                     src/test/layoverTravelTimeProvenance.test.ts). When one is
 *                     built, persist the source on the row — see
 *                     `travelTimeSourceFor` for why the read path cannot infer it.
 */
export const TRAVEL_TIME_SOURCES = ["inside_airport", "category_default", "measured"] as const;
export type TravelTimeSource = (typeof TRAVEL_TIME_SOURCES)[number];

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

export interface ActivityCandidate {
  title: string;
  travelTimeMin: number;       // one-way travel time in minutes
  activityTimeMin: number;     // time needed at the destination
  insideAirport: boolean;
  verified?: boolean;
  /** Provenance of `travelTimeMin`. Absent = not measured (see travelTimeSourceFor). */
  travelTimeSource?: TravelTimeSource;
}

export interface SafetyAssessment {
  rating: SafetyRating;
  availableMinutes: number;
  requiredMinutes: number;     // total time needed (travel×2 + activity + buffer)
  returnBufferMin: number;     // computed buffer
  hardReturnTime: Date;        // absolute time user must leave by
  usableMinutes: number;       // availableMinutes - returnBufferMin
  warningReason: string | null;
  breakdown: {
    baseBuffer:       number;
    immigrationExtra: number;
    bagsExtra:        number;
    trafficExtra:     number;
    timeOfDayExtra:   number;
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

export function computeBuffer(
  airport: Pick<AirportProfile,
    "domesticBufferMin" | "internationalBufferMin" |
    "immigrationExtraMin" | "checkedBagsExtraMin" | "trafficExtraMin"
  >,
  session: Pick<LayoverSession, "flightType" | "immigrationRequired" | "checkedBags">,
  /** Instant the buffer is required to be complete by — the flight cutoff. */
  at: Date,
  timezone?: string,
): SafetyAssessment["breakdown"] {
  const baseBuffer       = session.flightType === "international"
    ? airport.internationalBufferMin
    : airport.domesticBufferMin;
  const immigrationExtra = session.immigrationRequired ? airport.immigrationExtraMin : 0;
  const bagsExtra        = session.checkedBags         ? airport.checkedBagsExtraMin  : 0;
  const trafficExtra     = airport.trafficExtraMin;
  const timeOfDayExtraMin = timeOfDayExtra(at, timezone);
  const totalBuffer       = baseBuffer + immigrationExtra + bagsExtra + trafficExtra + timeOfDayExtraMin;
  return { baseBuffer, immigrationExtra, bagsExtra, trafficExtra, timeOfDayExtra: timeOfDayExtraMin, totalBuffer };
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
  airport: Pick<AirportProfile,
    "domesticBufferMin" | "internationalBufferMin" |
    "immigrationExtraMin" | "checkedBagsExtraMin" | "trafficExtraMin" | "timezone"
  >,
  session: Pick<LayoverSession,
    "flightType" | "immigrationRequired" | "checkedBags" | "departureTime" | "boardingTime"
  >,
): { cutoffMs: number; breakdown: SafetyAssessment["breakdown"]; hardReturnTime: Date } {
  const cutoffMs  = layoverCutoffMs(session);
  const breakdown = computeBuffer(airport, session, new Date(cutoffMs), airport.timezone);
  return {
    cutoffMs,
    breakdown,
    hardReturnTime: new Date(cutoffMs - breakdown.totalBuffer * 60_000),
  };
}

/**
 * Assess a single activity against the current session state.
 */
export function assess(
  airport: AirportProfile,
  session: LayoverSession,
  candidate: ActivityCandidate,
  nowMs = Date.now(),
): SafetyAssessment {
  const { cutoffMs, breakdown, hardReturnTime } = computeReturnDeadline(airport, session);
  const availableMin   = Math.max(0, Math.round((cutoffMs - nowMs) / 60000));

  const bufferMin      = breakdown.totalBuffer;
  const usableMin      = Math.max(0, availableMin - bufferMin);

  // Inside airport: no travel time, always include buffer
  const tripTimeMin    = candidate.insideAirport
    ? 0
    : candidate.travelTimeMin * 2; // round trip

  const requiredMin    = tripTimeMin + candidate.activityTimeMin + bufferMin;

  let rating: SafetyRating;
  let warningReason: string | null = null;

  if (candidate.insideAirport) {
    // Inside airport is always safe unless the layover itself is too short
    if (availableMin < candidate.activityTimeMin + 15) {
      rating = "possible_but_risky";
      warningReason = "Your layover is very short — plan for a quick visit.";
    } else {
      rating = "safe";
    }
  } else if (!session.wantsToLeave) {
    rating = "airport_only";
    warningReason = "You indicated you'd prefer to stay at the airport.";
  } else if (usableMin <= 0) {
    rating = "not_recommended";
    warningReason = "Not enough time after your required return buffer.";
  } else if (usableMin < tripTimeMin + candidate.activityTimeMin) {
    rating = "not_recommended";
    warningReason = `You'd need ${tripTimeMin + candidate.activityTimeMin} min but only have ${usableMin} min usable.`;
  } else if (usableMin - tripTimeMin - candidate.activityTimeMin < 20) {
    rating = "possible_but_risky";
    warningReason = "Your return buffer is tight — any delay could cause you to miss your flight.";
  } else if (!candidate.verified && candidate.travelTimeMin > 30) {
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
    warningReason,
    breakdown,
  };
}

/**
 * Sort a list of activities by safety + vibe fit.
 * Safe activities come first; within same rating, shorter travel time wins.
 */
export function rankActivities(
  airport: AirportProfile,
  session: LayoverSession,
  candidates: ActivityCandidate[],
  nowMs = Date.now(),
): Array<ActivityCandidate & { assessment: SafetyAssessment }> {
  const RATING_ORDER: Record<SafetyRating, number> = {
    safe:               0,
    possible_but_risky: 1,
    not_recommended:    2,
    airport_only:       3,
  };

  return candidates
    .map((c) => ({ ...c, assessment: assess(airport, session, c, nowMs) }))
    .sort((a, b) => {
      const rDiff = RATING_ORDER[a.assessment.rating] - RATING_ORDER[b.assessment.rating];
      if (rDiff !== 0) return rDiff;
      return a.travelTimeMin - b.travelTimeMin;
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
  airport: AirportProfile,
  session: LayoverSession,
  nowMs = Date.now(),
): LayoverWindow {
  const arrivalMs = new Date(session.arrivalTime).getTime();
  const tz        = airport.timezone;

  const { cutoffMs, breakdown: breakdownBase, hardReturnTime } = computeReturnDeadline(airport, session);

  const totalMinutes  = Math.max(0, Math.round((cutoffMs - arrivalMs) / 60000));
  const exitDelayMin  = estimateExitDelay(session);

  const hardReturnMs   = hardReturnTime.getTime();
  const earliestOutMs  = arrivalMs + exitDelayMin * 60000;
  // Usable window from the later of "now" and "earliest landside".
  const windowStartMs  = Math.max(nowMs, earliestOutMs);
  const usableMinutes  = Math.max(0, Math.round((hardReturnMs - windowStartMs) / 60000));

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
}

/**
 * The `unknowns` line for a travel time that was not measured. Exported so the
 * test can assert on the exact sentence the traveller sees.
 */
export const TRAVEL_TIME_UNMEASURED_UNKNOWN =
  "Travel times to places outside the airport are category estimates, not measured routes from this airport";

/** "Can I Leave the Airport?" decision, phrased as guidance. */
export function adviseLeaving(
  airport: AirportProfile,
  session: LayoverSession,
  window: LayoverWindow,
  facts: LeaveAdviceFacts = {},
): LeaveAdvice {
  const reasons: string[] = [];
  const unknowns: string[] = [
    "Visa or transit-permit requirements for your nationality",
  ];
  // Landside travel times: on this tree every one is a category constant
  // (TravelTimeSource "category_default"). Say so wherever the traveller might
  // act on it — i.e. whenever they intend to leave — and stop saying so only
  // when the caller asserts the figures were measured. Absent facts fail closed.
  if (session.wantsToLeave && travelTimeSourceFor({ insideAirport: false, travelTimeSource: facts.travelTimeSource }) !== "measured") {
    unknowns.push(TRAVEL_TIME_UNMEASURED_UNKNOWN);
  }
  // Entry is never confirmed on this tree — the visa line above is a standing
  // unknown, and the code says so in a form a client or a metric can count.
  const reasonCodes: LayoverReasonCode[] = ["ENTRY_NOT_CONFIRMED"];
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
