/**
 * LayoverSafetyEngine
 *
 * Core calculation service. Computes required return buffer, available time,
 * and safety rating for candidate activities during a layover.
 */
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import { localHour, localDayString } from "./AirportTime.js";
import {
  entryEligibilityMessage,
  type EntryEligibility,
} from "../../lib/layoverEntryEligibility.js";
import { DISCLAIMER as ENTRY_DISCLAIMER } from "../../lib/entryRequirements.js";

export type SafetyRating =
  | "safe"
  | "possible_but_risky"
  | "not_recommended"
  | "airport_only";

export interface ActivityCandidate {
  title: string;
  /**
   * One-way travel time in minutes, or NULL when it is not known.
   *
   * `null` is not a missing value to be defaulted — it is the honest answer.
   * This repo has no routing provider: MAPBOX_TOKEN and GOOGLE_MAPS_API_KEY are
   * both used for geocoding only, and no Directions, Distance Matrix or
   * Isochrone client exists anywhere. Until one does, the only candidates with a
   * real travel time are the ones where the answer is structurally zero, i.e.
   * inside the terminal.
   *
   * What used to sit here was `estimateTravelTime(placeType)` returning 15 for a
   * cafe and 25 for anything else — a number that never consulted a coordinate,
   * so a place across the road and a place across the city scored identically
   * and both came back "safe". That constant is deleted, not relocated.
   */
  travelTimeMin: number | null;
  activityTimeMin: number;     // time needed at the destination
  insideAirport: boolean;
  verified?: boolean;
}

export interface SafetyAssessment {
  rating: SafetyRating;
  availableMinutes: number;
  /**
   * Total time needed (travel×2 + activity + buffer), or NULL when travel time
   * is unknown and the total therefore cannot be computed. A number here is a
   * claim; `null` is the absence of one.
   */
  requiredMinutes: number | null;
  /** True when this verdict rests on an unknown travel time. */
  travelTimeUnknown: boolean;
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

  // Inside the terminal there is no journey to measure, so 0 is a fact rather
  // than an estimate. Outside it, an unknown travel time stays unknown.
  const travelKnown    = candidate.insideAirport || typeof candidate.travelTimeMin === "number";
  const tripTimeMin    = candidate.insideAirport
    ? 0
    : (candidate.travelTimeMin as number) * 2; // round trip

  const requiredMin    = travelKnown ? tripTimeMin + candidate.activityTimeMin + bufferMin : null;
  const hardReturnTime = new Date(cutoffMs - bufferMin * 60000);

  let rating: SafetyRating;
  let warningReason: string | null = null;

  if (!travelKnown) {
    // FAIL CLOSED. Every branch below decides between "safe", "risky" and "not
    // recommended" by comparing the round trip against the usable window — and
    // with no travel time there is no round trip to compare. Guessing one is how
    // this surface came to tell a traveller in Bangkok that an hour across the
    // city was "safe". A verdict we cannot compute is withheld, and the reason
    // says so rather than blaming the clock.
    rating = "not_recommended";
    warningReason =
      "We can't work out how long it takes to get here and back, so we can't tell you it's safe.";
  } else if (candidate.insideAirport) {
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
  } else if (!candidate.verified && tripTimeMin / 2 > 30) {
    rating = "possible_but_risky";
    warningReason = "Unverified place far from airport — allow extra time.";
  } else {
    rating = "safe";
  }

  return {
    rating,
    availableMinutes: availableMin,
    requiredMinutes: requiredMin,
    travelTimeUnknown: !travelKnown,
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
      // An unknown travel time sorts last rather than as zero — `null` coerced
      // through arithmetic would have ranked the least-known option first.
      const at = typeof a.travelTimeMin === "number" ? a.travelTimeMin : Number.POSITIVE_INFINITY;
      const bt = typeof b.travelTimeMin === "number" ? b.travelTimeMin : Number.POSITIVE_INFINITY;
      return at - bt;
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

/**
 * The session's overall safety picture, derived from the window ALONE.
 *
 * This replaces a fabricated probe. `/airport/sessions/:id/safety` used to build
 * a fake candidate — "Leaving airport", travelTimeMin 20, activityTimeMin 30 —
 * purely so that `assess()` would have something to score, and then presented
 * the result as the session's overall rating. Those two numbers were identical
 * for every session at every airport on earth, so the "overall safety" of a
 * 3-hour Singapore layover and a 3-hour Lagos layover differed only by their
 * buffers.
 *
 * Everything here comes from the session's own timings and the airport's own
 * profile. It makes no claim about any journey, because no journey has been
 * measured — which is why there is no travel time in it at all.
 */
export function assessWindowOnly(
  airport: AirportProfile,
  session: LayoverSession,
  window: LayoverWindow,
): SafetyAssessment {
  const departureMs = new Date(session.departureTime).getTime();
  const boardingMs  = session.boardingTime ? new Date(session.boardingTime).getTime() : null;
  const cutoffMs    = boardingMs ?? departureMs;
  const breakdown   = computeBuffer(airport, session, new Date(session.departureTime), airport.timezone);

  let rating: SafetyRating;
  let warningReason: string | null = null;
  if (!session.wantsToLeave) {
    rating = "airport_only";
    warningReason = "You indicated you'd prefer to stay at the airport.";
  } else if (window.tier === "airport_only") {
    rating = "airport_only";
    warningReason = window.tierBlurb;
  } else if (window.usableMinutes >= 90) {
    rating = "safe";
  } else if (window.usableMinutes >= 45) {
    rating = "possible_but_risky";
    warningReason = "Your usable window is short — any delay eats into your return buffer.";
  } else {
    rating = "not_recommended";
    warningReason = "Not enough time after your required return buffer.";
  }

  return {
    rating,
    availableMinutes: Math.max(0, Math.round((cutoffMs - Date.now()) / 60000)),
    // No journey was measured, so there is no total to state.
    requiredMinutes: null,
    travelTimeUnknown: true,
    returnBufferMin: breakdown.totalBuffer,
    hardReturnTime: window.hardReturnTime,
    usableMinutes: window.usableMinutes,
    warningReason,
    breakdown,
  };
}

export interface LeaveAdvice {
  /**
   * `entry_unverified` is the state this surface was missing. Previously the
   * only outcomes were time-shaped, so "we do not know whether you are allowed
   * into this country" had nowhere to go and came out as "yes" with a sentence
   * about visas in `unknowns`. A caveat attached to an affirmative answer is
   * still an affirmative answer.
   */
  verdict: "yes" | "tight" | "no" | "stay_airside" | "entry_unverified";
  reasons: string[];
  /** Facts we cannot know from the data we hold — shown explicitly to the user. */
  unknowns: string[];
  /** The resolved entry decision this verdict was gated on, for the UI to explain. */
  entry: EntryEligibility | null;
  disclaimer: string;
}

const LEAVE_DISCLAIMER =
  "This is guidance based on your timings, not a guarantee. Verify visa rules, " +
  "airline re-check-in policy and local conditions before leaving the airport.";

/**
 * "Can I Leave the Airport?" — now gated on TWO independent questions, both of
 * which must pass:
 *
 *   1. Is there time?          the window arithmetic, unchanged
 *   2. May you enter at all?   lib/layoverEntryEligibility, newly consulted
 *
 * THE ENTRY GATE CAN ONLY DOWNGRADE. It never turns a "no" into a "yes" and
 * never improves a tight window. That direction is the whole safety property:
 * whatever the entry data says, this function can only become more cautious
 * than the clock alone would have been.
 *
 * Passing `entry` as null is treated as UNRESOLVED, not as permission. A caller
 * that forgets to resolve entry gets the cautious answer, which is the correct
 * failure mode for a caller that forgot something.
 */
export function adviseLeaving(
  airport: AirportProfile,
  session: LayoverSession,
  window: LayoverWindow,
  entry: EntryEligibility | null,
): LeaveAdvice {
  const reasons: string[] = [];
  const unknowns: string[] = [];
  if (session.flightType === "international") {
    unknowns.push("Security and immigration queue times vary by hour");
  }
  if (session.checkedBags) {
    reasons.push("Checked bags: confirm they're tagged through to your next flight.");
  }

  const resolved: EntryEligibility =
    entry ?? {
      state: "unresolved",
      reason: "lookup_failed",
      passportCountry: null,
      destinationCountry: null,
      disclaimer: ENTRY_DISCLAIMER,
    };

  if (!session.wantsToLeave) {
    return {
      verdict: "stay_airside",
      reasons: ["You chose to stay at the airport for this layover."],
      unknowns,
      entry: resolved,
      disclaimer: LEAVE_DISCLAIMER,
    };
  }

  // ── The clock, on its own ──────────────────────────────────────────────────
  let verdict: LeaveAdvice["verdict"];
  if (window.usableMinutes >= 90) {
    verdict = "yes";
    reasons.unshift(
      `About ${Math.floor(window.usableMinutes / 60)}h ${window.usableMinutes % 60}m of usable time after exit and return buffers.`,
    );
  } else if (window.usableMinutes >= 45) {
    verdict = "tight";
    reasons.unshift(
      `Only ~${window.usableMinutes} min usable — a very short trip right by the airport at most.`,
    );
  } else {
    verdict = "no";
    reasons.unshift(
      `After the required buffers you'd have ~${window.usableMinutes} min — not enough to leave and return safely.`,
    );
  }

  // ── The border, which can only make the answer worse ──────────────────────
  if (resolved.state === "not_permitted") {
    // A definite refusal outranks any amount of spare time.
    verdict = "no";
    reasons.unshift(entryEligibilityMessage(resolved));
    if (resolved.officialSourceUrl) reasons.push(`Official source: ${resolved.officialSourceUrl}`);
  } else if (resolved.state === "unresolved") {
    // We cannot affirm what we have not established. "no" stays "no" — the
    // clock already refused, and softening that would be an upgrade.
    if (verdict === "yes" || verdict === "tight") verdict = "entry_unverified";
    reasons.unshift(entryEligibilityMessage(resolved));
    unknowns.unshift("Whether you may enter this country on the passport you're travelling on");
  } else if (resolved.condition) {
    // Permitted, but the border costs time inside the same window.
    reasons.push(resolved.condition);
  }

  return { verdict, reasons, unknowns, entry: resolved, disclaimer: LEAVE_DISCLAIMER };
}
