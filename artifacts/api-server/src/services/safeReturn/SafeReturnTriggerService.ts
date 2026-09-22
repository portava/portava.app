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
  /**
   * Caution flag from geo_zones.
   *
   *   true      — a caution/avoid zone covers this location
   *   false     — the zone table was READ and covers nothing here
   *   null      — the read FAILED; whether this location is flagged is UNKNOWN
   *   undefined — no lookup was attempted (caller does not use this signal)
   *
   * `null` and `false` are deliberately distinct. supabase-js resolves
   * `{ data, error }` rather than throwing, so a failed geo_zones read used to
   * collapse into `data = undefined -> length 0 -> false` and a location rated
   * `avoid` was reported as carrying no caution. A safety verdict may not be
   * manufactured out of a failed read, so the unknown case has its own value.
   */
  hasLocationCautionFlag?: boolean | null;
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
  | "location_caution_unknown"
  | "new_city";

export interface SuggestionResult {
  shouldSuggest: boolean;
  reasons: SuggestionReason[];
  confidence: "low" | "medium" | "high";
  /**
   * True when at least one input to the verdict could not be read. The caller
   * must surface this rather than presenting the result as a measurement.
   */
  cautionUnknown: boolean;
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

  // 4. Location caution flag.
  //
  // Fail CLOSED. `null` means the geo_zones read failed, so this location may
  // well be rated caution/avoid — we simply do not know. Treating that as "no
  // caution" is the fabrication this branch exists to prevent, so an unknown
  // becomes its own reason and still raises the suggestion.
  if (planItem.hasLocationCautionFlag === true) {
    reasons.push("location_caution_flag");
  } else if (planItem.hasLocationCautionFlag === null) {
    reasons.push("location_caution_unknown");
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
  const cautionUnknown = planItem.hasLocationCautionFlag === null;

  // Confidence describes how much was MEASURED, so an unknown must not inflate
  // it — a single unread table would otherwise read as corroborating evidence.
  const measuredReasons = reasons.filter((r) => r !== "location_caution_unknown");
  let confidence: "low" | "medium" | "high" = "low";
  if (measuredReasons.length >= 3) confidence = "high";
  else if (measuredReasons.length >= 2) confidence = "medium";

  return { shouldSuggest, reasons, confidence, cautionUnknown };
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
    location_caution_unknown: "We couldn't check this area's travel advisories",
    new_city:               "You're exploring a new city",
  };

  if (reasons.length === 1) return labels[reasons[0]];

  const all = reasons.map((r) => labels[r]);
  const last = all.pop()!;
  return `${all.join(", ")} and ${last}`;
}
