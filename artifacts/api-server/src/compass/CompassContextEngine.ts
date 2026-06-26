/**
 * CompassContextEngine
 *
 * Takes a CompassProfile + server-side signals and returns a typed CompassContext.
 *
 * contextState determination (priority order — first match wins):
 *   1. safety_mode        → safeReturnActive (signal or profile)
 *   2. active_booking_mode → activeBooking (signal or profile)
 *   3. arrival_mode       → upcomingTripWithin48h (signal or profile)
 *   4. active_trip_mode   → activeTripNow (signal or profile.hasActiveTrip)
 *   5. night_mode         → hourUtc in [22, 23, 0, 1, 2, 3, 4]
 *   6. private_mode       → visibilityPreference = 'private'
 *   7. creator_mode       → hasPendingDelayedPosts
 *   8. budget_mode        → budgetStyle = 'backpacker'
 *   9. planning_ahead     → hasFutureTripScheduled (trip beyond 48h window)
 *  10. exploring_now      → currentCity set, no active trip
 *  11. normal             → fallback
 */
import type { CompassProfile, CompassContext, CompassContextState, CompassSignals } from "./types.js";

const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4]);

function deriveState(profile: CompassProfile, signals: CompassSignals): CompassContextState {
  if (signals.safeReturnActive || profile.safeReturnActive) {
    return "safety_mode";
  }
  if (signals.activeBooking || profile.hasActiveBooking) {
    return "active_booking_mode";
  }
  if (signals.upcomingTripWithin48h || profile.upcomingTripWithin48h) {
    return "arrival_mode";
  }
  if (signals.activeTripNow || profile.hasActiveTrip) {
    return "active_trip_mode";
  }
  if (NIGHT_HOURS.has(signals.hourUtc)) {
    return "night_mode";
  }
  if (profile.visibilityPreference === "private") {
    return "private_mode";
  }
  if (signals.hasPendingDelayedPosts) {
    return "creator_mode";
  }
  if (profile.budgetStyle === "backpacker") {
    return "budget_mode";
  }
  // planning_ahead: user has a future trip scheduled (beyond 48h) but isn't on one yet
  if (signals.hasFutureTripScheduled || profile.hasFutureTripScheduled) {
    return "planning_ahead";
  }
  if (profile.currentCity) {
    return "exploring_now";
  }
  return "normal";
}

/**
 * Build a CompassContext from a profile and server-side signals.
 *
 * @param profile   CompassProfile built by CompassProfileService
 * @param signals   Live server-side signals (time, safe-return, bookings, etc.)
 * @returns         A typed CompassContext
 */
export function buildCompassContext(
  profile: CompassProfile,
  signals: CompassSignals,
): CompassContext {
  const contextState = deriveState(profile, signals);
  return {
    contextState,
    signals,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Build default signals from the current wall clock, with all boolean signals
 * driven from the CompassProfile.
 */
export function defaultSignals(profile: CompassProfile): CompassSignals {
  return {
    hourUtc:                 new Date().getUTCHours(),
    safeReturnActive:        profile.safeReturnActive,
    activeBooking:           profile.hasActiveBooking,
    upcomingTripWithin48h:   profile.upcomingTripWithin48h,
    activeTripNow:           profile.hasActiveTrip,
    hasPendingDelayedPosts:  false,
    hasFutureTripScheduled:  profile.hasFutureTripScheduled,
  };
}
