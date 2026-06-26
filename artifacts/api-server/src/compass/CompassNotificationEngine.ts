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
 *   - Category is checked against COMPASS_<CATEGORY>_SAFETY_BLOCK feature flags.
 *   - Any level is suppressed for nightlife content if user has nightlife muted.
 *   - Private location data (lat/lng, exact address) is stripped from all
 *     notification data fields AND redacted from body text (coordinate patterns).
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

/**
 * Levels ≥ this are subject to category-mute suppression.
 * Value 3 means: levels 3–10 are suppressed when the notification's category
 * is muted by the user. Levels 1–2 (safety) always bypass suppression.
 * This aligns with the requirement that ignored categories should not be pushed
 * regardless of priority level, except for safety-override notifications.
 */
const CATEGORY_MUTE_THRESHOLD = 3;

export interface NotificationPayload {
  type:      NotificationType;
  title:     string;
  body:      string;
  /** Category tag (e.g. "nightlife", "buddy") — used for mute/safety checks. */
  category?: string;
  /** Extra data to send with the push. Private location keys will be stripped. */
  data?:     Record<string, unknown>;
}

export type NotificationOutcome =
  | "sent"
  | "suppressed_quiet_hours"
  | "suppressed_category_muted"
  | "suppressed_safety_filter"
  | "suppressed_blocked_sender"
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
 * Regex patterns for location data that should be redacted from body text.
 * - Decimal coordinates: e.g. 13.7563 or -100.5018
 * - Street addresses: e.g. "123 Main Street"
 */
const COORDINATE_REGEX  = /\b-?\d{1,3}\.\d{4,}\b/g;
const ADDRESS_REGEX     =
  /\b\d+\s+[\w\s]{2,30}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Place|Pl|Court|Ct)\b/gi;

/**
 * Redact GPS coordinates and street addresses from a text string.
 */
export function redactLocationText(text: string): string {
  return text
    .replace(COORDINATE_REGEX, "[location removed]")
    .replace(ADDRESS_REGEX,    "[address removed]");
}

/**
 * Remove any private location fields from the notification payload data
 * AND redact coordinate/address patterns from the body text.
 * Returns a new payload — never mutates the input.
 */
export function stripPrivateLocation(payload: NotificationPayload): NotificationPayload {
  // Strip private keys from data
  const strippedData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload.data ?? {})) {
    if (!PRIVATE_LOCATION_KEYS.includes(key.toLowerCase())) {
      strippedData[key] = value;
    }
  }

  // Redact location patterns from body text
  const strippedBody = redactLocationText(payload.body);

  return { ...payload, body: strippedBody, data: strippedData };
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

    const row = (data as any) ?? {};
    const topics: string[] = (row.muted_topics as string[]) ?? [];

    // Quiet hours are stored as special muted_topics entries:
    //   "quiet_start:HH:MM" and "quiet_end:HH:MM"
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

// ── Safety filter — category-level feature flag check ────────────────────────

/**
 * Check whether the notification category is blocked by a feature flag
 * (e.g. COMPASS_BUDDY_SAFETY_BLOCK or COMPASS_NIGHTLIFE_SAFETY_BLOCK).
 * This mirrors the CompassSafetyFilter type-level block check.
 * Never throws.
 */
async function isCategoryBlocked(
  db:       SupabaseClient | null,
  category: string,
): Promise<boolean> {
  if (!db || !category) return false;
  try {
    const flagKey = `COMPASS_${category.toUpperCase().replace(/[\s-]/g, "_")}_SAFETY_BLOCK`;
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flagKey)
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
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
  db.from("compass_notification_decisions")
    .insert({
      user_id:            userId,
      notification_type:  payload.type,
      priority_level:     decision.priorityLevel,
      outcome:            decision.outcome,
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
 * @param opts     Optional overrides (nowMinutes for quiet-hours tests).
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

  // ── Levels 1–2: always send (safety override) ────────────────────────────────
  if (level <= SAFETY_OVERRIDE_THRESHOLD) {
    return decide("sent");
  }

  // ── Safety filter step 1: sender–recipient block relationship ─────────────────
  // Mirror CompassSafetyFilter's "author_blocked_by_viewer" and
  // "viewer_blocked_by_author" hard-block checks. A blocked sender must never
  // reach the recipient via push — regardless of level, quiet hours, or category.
  const senderId =
    payload.data?.senderId != null ? String(payload.data.senderId) : null;

  if (db && senderId) {
    try {
      // Two separate queries so eq()-only fake DB in tests can exercise both paths.
      const [{ data: senderBlockedRecipient }, { data: recipientBlockedSender }] =
        await Promise.all([
          db
            .from("blocks")
            .select("id")
            .eq("blocker_id", senderId)
            .eq("blocked_id", userId)
            .maybeSingle(),
          db
            .from("blocks")
            .select("id")
            .eq("blocker_id", userId)
            .eq("blocked_id", senderId)
            .maybeSingle(),
        ]);
      if (senderBlockedRecipient || recipientBlockedSender) {
        return decide("suppressed_blocked_sender", `blocked:${senderId}`);
      }
    } catch { /* fail-open: a DB error should not block safety checking elsewhere */ }
  }

  // ── Safety filter step 2: category-level feature flag check ──────────────────
  if (payload.category) {
    const blocked = await isCategoryBlocked(db, payload.category);
    if (blocked) {
      return decide(
        "suppressed_safety_filter",
        `safety_block:${payload.category}`,
      );
    }
  }

  // ── User preferences (best-effort; fail-open for higher-priority levels) ─────
  const prefs = db
    ? await loadUserNotifPrefs(db, userId)
    : { quietStart: null, quietEnd: null, mutedCategories: [], compassEnabled: true };

  // ── Quiet hours check (levels 3–10) ──────────────────────────────────────────
  if (prefs.quietStart && prefs.quietEnd) {
    if (isQuietHours(prefs.quietStart, prefs.quietEnd, opts.nowMinutes)) {
      return decide("suppressed_quiet_hours", "quiet_hours_active");
    }
  }

  // ── Category mute check (levels 8–10) ────────────────────────────────────────
  if (level >= CATEGORY_MUTE_THRESHOLD && payload.category) {
    const catLower = payload.category.toLowerCase();
    const muted = prefs.mutedCategories.some(
      (m) => m.toLowerCase() === catLower,
    );
    if (muted) {
      return decide("suppressed_category_muted", `category_muted:${payload.category}`);
    }
  }

  // ── Nightlife suppression for users with no_clubs / no_alcohol preference ────
  if (
    payload.category &&
    ["nightlife", "clubs", "alcohol"].includes(payload.category.toLowerCase()) &&
    prefs.mutedCategories.some((m) =>
      ["clubs", "no_clubs", "alcohol", "no_alcohol"].includes(m.toLowerCase()),
    )
  ) {
    return decide("suppressed_ignored_category", "nightlife_preference");
  }

  return decide("sent");
}
