/**
 * SafeReturnTriggerService
 *
 * Pure logic — determines whether to show a Safe Return suggestion for a
 * given plan item + user context.  No DB calls; all data is passed in.
 */

export type PlanCategory =
  | "accommodation"
  | "activity"
  | "dining"
  | "transport"
  | "free_time"
  | "meeting_point"
  | "nightlife"
  | "other";

export interface PlanItemContext {
  id: string;
  category: PlanCategory | string;
  startsAt: string | null;  // ISO timestamp or null
  dayDate: string | null;   // YYYY-MM-DD or null
  locationName: string | null;
  /** Caution flag from geo_zones (optional). */
  hasLocationCautionFlag?: boolean;
  /** Number of confirmed attendees (optional — 1 = solo). */
  attendeeCount?: number | null;
}

export interface UserContext {
  homeCity?: string | null;
  currentCity?: string | null;
}

export type SuggestionReason =
  | "nightlife_plan"
  | "late_night_activity"
  | "solo_activity"
  | "location_caution_flag"
  | "new_city";

export interface SuggestionResult {
  shouldSuggest: boolean;
  reasons: SuggestionReason[];
  confidence: "low" | "medium" | "high";
}

/** Hour (0–23) at which we consider a start "late night". */
const LATE_NIGHT_HOUR = 21;

/** Parse HH:MM or ISO timestamp into the hour (24-h). Returns null if unparseable. */
function extractHour(ts: string | null): number | null {
  if (!ts) return null;
  try {
    // ISO timestamp
    if (ts.includes("T") || ts.includes(" ")) {
      return new Date(ts).getHours();
    }
    // HH:MM format
    const parts = ts.split(":");
    if (parts.length >= 2) return parseInt(parts[0], 10);
  } catch {
    // ignore
  }
  return null;
}

/**
 * Determines whether a Safe Return suggestion is appropriate for this plan
 * item and user context.  Returns a result with detected reasons.
 *
 * Trigger conditions (OR-combined):
 *   1. category is 'nightlife'
 *   2. plan starts after 21:00
 *   3. solo attendee (attendeeCount === 1)
 *   4. location has a caution flag (geo_zone safety_rating = caution/avoid)
 *   5. user is in a different city than their home city
 */
export function shouldSuggest(
  planItem: PlanItemContext,
  _userId: string,
  userCtx: UserContext = {},
): SuggestionResult {
  const reasons: SuggestionReason[] = [];

  // 1. Nightlife category
  if (planItem.category === "nightlife") {
    reasons.push("nightlife_plan");
  }

  // 2. Late-night start
  const hour = extractHour(planItem.startsAt);
  if (hour !== null && hour >= LATE_NIGHT_HOUR) {
    reasons.push("late_night_activity");
  }

  // 3. Solo attendance
  if (planItem.attendeeCount != null && planItem.attendeeCount <= 1) {
    reasons.push("solo_activity");
  }

  // 4. Location caution flag
  if (planItem.hasLocationCautionFlag) {
    reasons.push("location_caution_flag");
  }

  // 5. New city (current city differs from home city)
  if (
    userCtx.homeCity &&
    userCtx.currentCity &&
    userCtx.homeCity.toLowerCase().trim() !== userCtx.currentCity.toLowerCase().trim()
  ) {
    reasons.push("new_city");
  }

  const shouldSuggest = reasons.length > 0;

  let confidence: "low" | "medium" | "high" = "low";
  if (reasons.length >= 3) confidence = "high";
  else if (reasons.length >= 2) confidence = "medium";

  return { shouldSuggest, reasons, confidence };
}

/**
 * Human-readable summary of why Safe Return was suggested.
 * Suitable for display in the suggestion callout.
 */
export function getSuggestionReason(reasons: SuggestionReason[]): string {
  if (reasons.length === 0) return "";

  const labels: Record<SuggestionReason, string> = {
    nightlife_plan:         "This is a nightlife plan",
    late_night_activity:    "This activity starts late at night",
    solo_activity:          "You're going solo",
    location_caution_flag:  "This area has a travel advisory",
    new_city:               "You're exploring a new city",
  };

  if (reasons.length === 1) return labels[reasons[0]];

  const all = reasons.map((r) => labels[r]);
  const last = all.pop()!;
  return `${all.join(", ")} and ${last}`;
}
