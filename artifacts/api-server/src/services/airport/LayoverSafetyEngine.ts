/**
 * LayoverSafetyEngine
 *
 * Core calculation service. Computes required return buffer, available time,
 * and safety rating for candidate activities during a layover.
 */
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import { localHour, localDayString } from "./AirportTime.js";

export type SafetyRating =
  | "safe"
  | "possible_but_risky"
  | "not_recommended"
  | "airport_only";

export interface ActivityCandidate {
  title: string;
  travelTimeMin: number;       // one-way travel time in minutes
  activityTimeMin: number;     // time needed at the destination
  insideAirport: boolean;
  verified?: boolean;
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
  };
}

export interface LeaveAdvice {
  verdict: "yes" | "tight" | "no" | "stay_airside";
  reasons: string[];
  /** Facts we cannot know from the data we hold — shown explicitly to the user. */
  unknowns: string[];
  disclaimer: string;
}

const LEAVE_DISCLAIMER =
  "This is guidance based on your timings, not a guarantee. Verify visa rules, " +
  "airline re-check-in policy and local conditions before leaving the airport.";

/** "Can I Leave the Airport?" decision, phrased as guidance. */
export function adviseLeaving(
  airport: AirportProfile,
  session: LayoverSession,
  window: LayoverWindow,
): LeaveAdvice {
  const reasons: string[] = [];
  const unknowns: string[] = [
    "Visa or transit-permit requirements for your nationality",
  ];
  if (session.flightType === "international") {
    unknowns.push("Security and immigration queue times vary by hour");
  }
  if (!session.checkedBags) {
    // nothing extra
  } else {
    reasons.push("Checked bags: confirm they're tagged through to your next flight.");
  }

  if (!session.wantsToLeave) {
    return {
      verdict: "stay_airside",
      reasons: ["You chose to stay at the airport for this layover."],
      unknowns,
      disclaimer: LEAVE_DISCLAIMER,
    };
  }

  if (window.usableMinutes >= 90) {
    reasons.unshift(
      `About ${Math.floor(window.usableMinutes / 60)}h ${window.usableMinutes % 60}m of usable time after exit and return buffers.`,
    );
    return { verdict: "yes", reasons, unknowns, disclaimer: LEAVE_DISCLAIMER };
  }
  if (window.usableMinutes >= 45) {
    reasons.unshift(
      `Only ~${window.usableMinutes} min usable — a very short trip right by the airport at most.`,
    );
    return { verdict: "tight", reasons, unknowns, disclaimer: LEAVE_DISCLAIMER };
  }
  reasons.unshift(
    `After the required buffers you'd have ~${window.usableMinutes} min — not enough to leave and return safely.`,
  );
  return { verdict: "no", reasons, unknowns, disclaimer: LEAVE_DISCLAIMER };
}
