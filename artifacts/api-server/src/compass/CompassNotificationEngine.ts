/**
 * CompassNotificationEngine — Phase 5 notification priority & filtering.
 *
 * 10-level priority stack (1 = highest, 10 = lowest):
 *   1  emergency_safety      — SOS, safe-return triggers, danger-zone alerts
 *   2  safety_alert          — account moderation, harassment, suspension
 *   3  trip_critical         — flight change, trip cancellation, boarding alert
 *   4  booking_update        — booking confirmed / cancelled / status change
 *   5  message_urgent        — safety-related direct message
 *   6  message_normal        — regular chat message
 *   7  activity_social       — follow, like, meetup RSVP, circle invite
 *   8  recommendation        — Compass pick, AI suggestion, buddy match
 *   9  discovery             — new event / place in your area
 *  10  general               — tips, marketing, digest
 *
 * Rules:
 *   - Levels 1–2 always pass through (safety is non-negotiable).
 *   - Levels 3–10 are blocked during the user's configured quiet hours.
 *   - Levels 8–10 are suppressed if the category is muted by the user.
 *   - Any level is suppressed if the content fails the Safety Filter category
 *     check (nightlife to no-nightlife users, etc.).
 *   - Private location data (lat/lng, exact address) is stripped from all
 *     notification bodies before send.
 *
 * All decisions are logged to compass_notification_decisions (fire-and-forget).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotificationType =
  | "emergency_safety"
  | "safety_alert"
  | "trip_critical"
  | "booking_update"
  | "message_urgent"
  | "message_normal"
  | "activity_social"
  | "recommendation"
  | "discovery"
  | "general";

/** Map of notification type → priority level (1 = highest). */
export const PRIORITY_LEVELS: Record<NotificationType, number> = {
  emergency_safety: 1,
  safety_alert:     2,
  trip_critical:    3,
  booking_update:   4,
  message_urgent:   5,
  message_normal:   6,
  activity_social:  7,
  recommendation:   8,
  discovery:        9,
  general:          10,
};

/** Levels ≤ this threshold are never suppressed (safety override). */
const SAFETY_OVERRIDE_THRESHOLD = 2;

/** Levels ≥ this are subject to category-mute suppression. */
const CATEGORY_MUTE_THRESHOLD = 8;

export interface NotificationPayload {
  type:      NotificationType;
  title:     string;
  body:      string;
  /** Category tag (e.g. "nightlife", "buddy") — used for mute checks. */
  category?: string;
  /** Any extra data to send with the push. Private location keys will be stripped. */
  data?:     Record<string, unknown>;
}

export type NotificationOutcome =
  | "sent"
  | "suppressed_quiet_hours"
  | "suppressed_category_muted"
  | "suppressed_safety_filter"
  | "suppressed_private_location"
  | "suppressed_ignored_category";

export interface NotificationDecision {
  outcome:           NotificationOutcome;
  suppressionReason: string | null;
  priorityLevel:     number;
  strippedPayload:   NotificationPayload;
}

// ── Private-location strip ────────────────────────────────────────────────────

const PRIVATE_LOCATION_KEYS = [
  "lat", "lng", "latitude", "longitude",
  "exact_lat", "exact_lng", "location_lat", "location_lng",
  "exact_address", "home_address", "private_address",
  "gps_lat", "gps_lng", "user_lat", "user_lng",
];

/**
 * Remove any private location fields from the notification payload.
 * Returns a new payload — never mutates the input.
 */
export function stripPrivateLocation(payload: NotificationPayload): NotificationPayload {
  const strippedData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload.data ?? {})) {
    if (!PRIVATE_LOCATION_KEYS.includes(key.toLowerCase())) {
      strippedData[key] = value;
    }
  }
  return { ...payload, data: strippedData };
}

// ── Quiet hours helpers ───────────────────────────────────────────────────────

/**
 * Parse HH:MM string into minutes since midnight.  Returns null on invalid input.
 */
function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Returns true if the current UTC time falls within quiet hours.
 *
 * @param quietStart  "HH:MM" — quiet period start (e.g. "22:00")
 * @param quietEnd    "HH:MM" — quiet period end   (e.g. "07:00")
 * @param nowMinutes  Current time in minutes since midnight (UTC). Injected for testing.
 */
export function isQuietHours(
  quietStart:  string,
  quietEnd:    string,
  nowMinutes?: number,
): boolean {
  const start = parseHHMM(quietStart);
  const end   = parseHHMM(quietEnd);
  if (start === null || end === null) return false;

  const now =
    nowMinutes !== undefined
      ? nowMinutes
      : new Date().getUTCHours() * 60 + new Date().getUTCMinutes();

  if (start <= end) {
    // Same-day window (e.g. 08:00–20:00)
    return now >= start && now < end;
  } else {
    // Overnight window (e.g. 22:00–07:00)
    return now >= start || now < end;
  }
}

// ── User prefs loader ─────────────────────────────────────────────────────────

interface UserNotifPrefs {
  quietStart:      string | null;
  quietEnd:        string | null;
  mutedCategories: string[];
  compassEnabled:  boolean;
}

async function loadUserNotifPrefs(
  db:     SupabaseClient,
  userId: string,
): Promise<UserNotifPrefs> {
  try {
    const { data } = await db
      .from("compass_user_preferences")
      .select("compass_enabled, exclude_budget_styles, muted_topics")
      .eq("user_id", userId)
      .maybeSingle();

    // Quiet hours stored as muted_topics entries with "quiet_start:HH:MM" /
    // "quiet_end:HH:MM" convention, or a dedicated column if available.
    const row = (data as any) ?? {};
    const topics: string[] = (row.muted_topics as string[]) ?? [];
    const quietStartEntry = topics.find((t: string) => t.startsWith("quiet_start:"));
    const quietEndEntry   = topics.find((t: string) => t.startsWith("quiet_end:"));
    const quietStart = quietStartEntry?.replace("quiet_start:", "") ?? null;
    const quietEnd   = quietEndEntry?.replace("quiet_end:", "") ?? null;

    const mutedCats: string[] = [
      ...((row.exclude_budget_styles as string[]) ?? []),
    ];

    return {
      quietStart,
      quietEnd,
      mutedCategories: mutedCats,
      compassEnabled:  row.compass_enabled !== false,
    };
  } catch {
    return { quietStart: null, quietEnd: null, mutedCategories: [], compassEnabled: true };
  }
}

// ── Audit logger ──────────────────────────────────────────────────────────────

function logDecision(
  db:       SupabaseClient | null,
  userId:   string,
  payload:  NotificationPayload,
  decision: NotificationDecision,
): void {
  if (!db) return;
  const level = PRIORITY_LEVELS[payload.type];
  db.from("compass_notification_decisions")
    .insert({
      user_id:           userId,
      notification_type: payload.type,
      priority_level:    level,
      outcome:           decision.outcome,
      suppression_reason: decision.suppressionReason,
    })
    .then(() => {}, () => {});
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Evaluate whether a notification should be sent to a user.
 *
 * Returns a NotificationDecision with the outcome and the stripped payload.
 * The caller is responsible for actually sending the push via Expo.
 *
 * @param db       Supabase service-role client (null in tests).
 * @param userId   The recipient's user ID.
 * @param payload  The notification to evaluate.
 * @param opts     Optional test overrides (e.g. inject now-minutes for quiet-hours tests).
 */
export async function evaluateNotification(
  db:      SupabaseClient | null,
  userId:  string,
  payload: NotificationPayload,
  opts:    { nowMinutes?: number } = {},
): Promise<NotificationDecision> {
  const level = PRIORITY_LEVELS[payload.type];

  // Strip private location from body/data regardless of outcome
  const stripped = stripPrivateLocation(payload);

  const decide = (
    outcome: NotificationOutcome,
    reason:  string | null = null,
  ): NotificationDecision => {
    const d: NotificationDecision = {
      outcome,
      suppressionReason: reason,
      priorityLevel:     level,
      strippedPayload:   stripped,
    };
    logDecision(db, userId, payload, d);
    return d;
  };

  // Levels 1–2: always send (safety override)
  if (level <= SAFETY_OVERRIDE_THRESHOLD) {
    return decide("sent");
  }

  // Load user preferences (best-effort; if unavailable, fail-open for levels 3–6)
  const prefs = db
    ? await loadUserNotifPrefs(db, userId)
    : { quietStart: null, quietEnd: null, mutedCategories: [], compassEnabled: true };

  // Quiet hours check (levels 3–10)
  if (prefs.quietStart && prefs.quietEnd) {
    if (isQuietHours(prefs.quietStart, prefs.quietEnd, opts.nowMinutes)) {
      return decide("suppressed_quiet_hours", "quiet_hours_active");
    }
  }

  // Category mute check (levels 8–10)
  if (level >= CATEGORY_MUTE_THRESHOLD && payload.category) {
    const catLower = payload.category.toLowerCase();
    const muted = prefs.mutedCategories.some(
      (m) => m.toLowerCase() === catLower,
    );
    if (muted) {
      return decide("suppressed_category_muted", `category_muted:${payload.category}`);
    }
  }

  // Nightlife suppression for users with "no_clubs" / "no_alcohol" preference
  if (
    payload.category &&
    ["nightlife", "clubs", "alcohol"].includes(payload.category.toLowerCase()) &&
    prefs.mutedCategories.some((m) =>
      ["clubs", "no_clubs", "alcohol", "no_alcohol"].includes(m.toLowerCase()),
    )
  ) {
    return decide("suppressed_ignored_category", `nightlife_preference`);
  }

  return decide("sent");
}
