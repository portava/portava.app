/**
 * LayoverSafetyEngine
 *
 * Core calculation service. Computes required return buffer, available time,
 * and safety rating for candidate activities during a layover.
 */
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";

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
 * Time-of-day adjustment: night layovers (22:00–06:00 local) or early morning
 * add extra buffer due to reduced transport and higher caution.
 */
function timeOfDayExtra(departureTime: Date): number {
  const hour = departureTime.getUTCHours(); // use UTC as proxy; real apps would use TZ
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
): SafetyAssessment["breakdown"] {
  const baseBuffer       = session.flightType === "international"
    ? airport.internationalBufferMin
    : airport.domesticBufferMin;
  const immigrationExtra = session.immigrationRequired ? airport.immigrationExtraMin : 0;
  const bagsExtra        = session.checkedBags         ? airport.checkedBagsExtraMin  : 0;
  const trafficExtra     = airport.trafficExtraMin;
  const timeOfDayExtraMin = timeOfDayExtra(departureTime);
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

  const breakdown      = computeBuffer(airport, session, new Date(session.departureTime));
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
