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
 * Time-of-day adjustment: night layovers (22:00–06:00 airport-local) or early
 * morning add extra buffer due to reduced transport and higher caution.
 * When a timezone is provided the hour is computed in the airport's timezone;
 * otherwise UTC is used as a fallback.
 */
function timeOfDayExtra(departureTime: Date, timezone?: string): number {
  const hour = timezone ? localHour(timezone, departureTime) : departureTime.getUTCHours();
  if (hour >= 22 || hour < 6) return 20;
  if (hour >= 20 || hour < 8) return 10;
  return 0;
}

export function computeBuffer(
  airport: Pick<AirportProfile,
    "domesticBufferMin" | "internationalBufferMin" |
    "immigrationExtraMin" | "checkedBagsExtraMin" | "trafficExtraMin"
  >,
  session: Pick<LayoverSession, "flightType" | "immigrationRequired" | "checkedBags">,
  departureTime: Date,
  timezone?: string,
): SafetyAssessment["breakdown"] {
  const baseBuffer       = session.flightType === "international"
    ? airport.internationalBufferMin
    : airport.domesticBufferMin;
  const immigrationExtra = session.immigrationRequired ? airport.immigrationExtraMin : 0;
  const bagsExtra        = session.checkedBags         ? airport.checkedBagsExtraMin  : 0;
  const trafficExtra     = airport.trafficExtraMin;
  const timeOfDayExtraMin = timeOfDayExtra(departureTime, timezone);
  const totalBuffer       = baseBuffer + immigrationExtra + bagsExtra + trafficExtra + timeOfDayExtraMin;
  return { baseBuffer, immigrationExtra, bagsExtra, trafficExtra, timeOfDayExtra: timeOfDayExtraMin, totalBuffer };
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
  const departureMs    = new Date(session.departureTime).getTime();
  const boardingMs     = session.boardingTime ? new Date(session.boardingTime).getTime() : null;
  const cutoffMs       = boardingMs ?? departureMs;
  const availableMin   = Math.max(0, Math.round((cutoffMs - nowMs) / 60000));

  const breakdown      = computeBuffer(airport, session, new Date(session.departureTime), airport.timezone);
  const bufferMin      = breakdown.totalBuffer;
  const usableMin      = Math.max(0, availableMin - bufferMin);

  // Inside airport: no travel time, always include buffer
  const tripTimeMin    = candidate.insideAirport
    ? 0
    : candidate.travelTimeMin * 2; // round trip

  const requiredMin    = tripTimeMin + candidate.activityTimeMin + bufferMin;
  const hardReturnTime = new Date(cutoffMs - bufferMin * 60000);

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
  const arrivalMs   = new Date(session.arrivalTime).getTime();
  const departureMs = new Date(session.departureTime).getTime();
  const boardingMs  = session.boardingTime ? new Date(session.boardingTime).getTime() : null;
  const cutoffMs    = boardingMs ?? departureMs;
  const tz          = airport.timezone;

  const totalMinutes  = Math.max(0, Math.round((cutoffMs - arrivalMs) / 60000));
  const breakdownBase = computeBuffer(airport, session, new Date(cutoffMs), tz);
  const exitDelayMin  = estimateExitDelay(session);

  const hardReturnMs   = cutoffMs - breakdownBase.totalBuffer * 60000;
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
    hardReturnTime: new Date(hardReturnMs),
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
