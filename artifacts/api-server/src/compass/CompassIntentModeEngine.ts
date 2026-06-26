/**
 * CompassIntentModeEngine
 *
 * Maps a CompassContext to one of 9 intent modes (primary + secondary ranked list).
 *
 * Primary mapping (contextState → primary intent mode):
 *   safety_mode        → safety_mode
 *   active_booking_mode → social_mode   (meeting the buddy)
 *   arrival_mode       → arrival_mode
 *   active_trip_mode   → explore_now
 *   night_mode         → night_mode
 *   private_mode       → private_mode
 *   creator_mode       → creator_mode
 *   budget_mode        → budget_mode
 *   planning_ahead     → plan_ahead
 *   exploring_now      → explore_now
 *   normal             → explore_now   (default)
 *
 * Secondary modes — additional active modes that may influence ranking:
 *   Always consider: night_mode if hour ∈ NIGHT_HOURS (and not primary)
 *   Always consider: safety_mode if safeReturnActive (and not primary)
 *   active_trip_mode → also add plan_ahead as secondary
 */
import type {
  CompassContext,
  CompassIntentMode,
  CompassIntentModeName,
} from "./types.js";

const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4]);

const PRIMARY_MAP: Record<string, CompassIntentModeName> = {
  safety_mode:         "safety_mode",
  active_booking_mode: "social_mode",
  arrival_mode:        "arrival_mode",
  active_trip_mode:    "explore_now",
  night_mode:          "night_mode",
  private_mode:        "private_mode",
  creator_mode:        "creator_mode",
  budget_mode:         "budget_mode",
  planning_ahead:      "plan_ahead",
  exploring_now:       "explore_now",
  normal:              "explore_now",
};

/**
 * Derive the CompassIntentMode from the resolved context.
 */
export function deriveIntentMode(context: CompassContext): CompassIntentMode {
  const primary: CompassIntentModeName =
    PRIMARY_MAP[context.contextState] ?? "explore_now";

  const secondary: CompassIntentModeName[] = [];

  const { hourUtc, safeReturnActive } = context.signals;

  // Always surface safety_mode as secondary if safe-return is active but isn't primary
  if (safeReturnActive && primary !== "safety_mode") {
    secondary.push("safety_mode");
  }

  // Always surface night_mode as secondary if it's night-time but isn't primary
  if (NIGHT_HOURS.has(hourUtc) && primary !== "night_mode") {
    secondary.push("night_mode");
  }

  // Active trip → plan_ahead is a natural co-mode
  if (context.contextState === "active_trip_mode" && !secondary.includes("plan_ahead")) {
    secondary.push("plan_ahead");
  }

  // Creator mode → explore_now is a relevant secondary (creating needs context)
  if (context.contextState === "creator_mode" && !secondary.includes("explore_now")) {
    secondary.push("explore_now");
  }

  return { primary, secondary };
}
