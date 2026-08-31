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
import type { CompassItem, CompassProfile } from "./types.js";
import { runSafetyFilter } from "./CompassSafetyFilter.js";
import { localMinutesOfDay } from "../services/notifications/NotificationPreferenceService.js";

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
 * Returns true if the current time falls within quiet hours.
 *
 * The current time is evaluated in the user's own IANA timezone when one is
 * provided; otherwise it falls back to server-local time (same fallback as
 * NotificationPreferenceService.isQuietHour).
 *
 * @param quietStart  "HH:MM" — quiet period start (e.g. "22:00")
 * @param quietEnd    "HH:MM" — quiet period end   (e.g. "07:00")
 * @param nowMinutes  Current time in minutes since midnight. Injected for testing.
 * @param timezone    IANA timezone (e.g. "Asia/Bangkok") used when nowMinutes is not injected.
 */
export function isQuietHours(
  quietStart:  string,
  quietEnd:    string,
  nowMinutes?: number,
  timezone?:   string | null,
): boolean {
  const start = parseHHMM(quietStart);
  const end   = parseHHMM(quietEnd);
  if (start === null || end === null) return false;

  const now =
    nowMinutes !== undefined
      ? nowMinutes
      : localMinutesOfDay(new Date(), timezone ?? null);

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
  /** IANA timezone quiet hours are evaluated in; null → server time. */
  timezone:        string | null;
  mutedCategories: string[];
  compassEnabled:  boolean;
}

async function loadUserNotifPrefs(
  db:     SupabaseClient,
  userId: string,
): Promise<UserNotifPrefs> {
  try {
    const [{ data }, { data: notifPrefsRow }] = await Promise.all([
      db
        .from("compass_user_preferences")
        .select("compass_enabled, exclude_budget_styles, muted_topics, category_weights")
        .eq("user_id", userId)
        .maybeSingle(),
      db
        .from("notification_preferences")
        .select("timezone, quiet_hours_enabled, quiet_start, quiet_end")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);

    const row = (data as any) ?? {};
    const topics: string[] = (row.muted_topics as string[]) ?? [];
    const notifRow = (notifPrefsRow as any) ?? null;

    // Quiet hours source of truth is notification_preferences — the same window
    // users configure on the notification settings screen. Legacy muted_topics
    // entries ("quiet_start:HH:MM"/"quiet_end:HH:MM") remain as a fallback so
    // users who only ever set the Compass window don't regress.
    let quietStart: string | null = null;
    let quietEnd:   string | null = null;
    if (notifRow && notifRow.quiet_hours_enabled != null) {
      // Shared setting exists — it is authoritative in BOTH directions:
      // enabled=true uses its window; enabled=false means no quiet hours,
      // even if stale legacy muted_topics entries remain.
      if (
        notifRow.quiet_hours_enabled === true &&
        typeof notifRow.quiet_start === "string" &&
        typeof notifRow.quiet_end === "string"
      ) {
        quietStart = notifRow.quiet_start;
        quietEnd   = notifRow.quiet_end;
      }
    } else {
      // Legacy fallback: quiet hours stored as special muted_topics entries.
      const quietStartEntry = topics.find((t: string) => t.startsWith("quiet_start:"));
      const quietEndEntry   = topics.find((t: string) => t.startsWith("quiet_end:"));
      quietStart = quietStartEntry?.replace("quiet_start:", "") ?? null;
      quietEnd   = quietEndEntry?.replace("quiet_end:", "") ?? null;
    }

    // Build muted-category set from three sources:
    //   1. exclude_budget_styles — explicit lifestyle preferences (no_clubs, no_alcohol, …)
    //   2. category_weights with negative values — every category a user has hidden via
    //      hide_category / show_less feedback. Any weight < 0 means the user actively
    //      deprioritised that category, so we suppress push notifications for it too.
    const categoryWeights: Record<string, number> =
      (row.category_weights as Record<string, number>) ?? {};
    const weightMutedCats = Object.entries(categoryWeights)
      .filter(([, w]) => w < 0)
      .map(([cat]) => cat);

    const mutedCats: string[] = [
      ...((row.exclude_budget_styles as string[]) ?? []),
      ...weightMutedCats,
    ];

    return {
      quietStart,
      quietEnd,
      timezone:        ((notifPrefsRow as any)?.timezone as string | null) ?? null,
      mutedCategories: mutedCats,
      compassEnabled:  row.compass_enabled !== false,
    };
  } catch {
    return { quietStart: null, quietEnd: null, timezone: null, mutedCategories: [], compassEnabled: true };
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
      const [
        { data: senderBlockedRecipient, error: senderBlockErr },
        { data: recipientBlockedSender, error: recipientBlockErr },
      ] =
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
      // maybeSingle() returns `data: null` both when there is no block row and
      // when the query was rejected — and this gate's whole contract is that a
      // blocked sender "must never reach the recipient via push". PostgREST
      // reports rejections in `error` rather than throwing, so the catch below
      // never fires for them: without binding these, a schema/query error
      // delivers the push and leaves no trace that the check did not run.
      if (senderBlockErr || recipientBlockErr) {
        console.warn(
          "CompassNotificationEngine: blocked-sender check failed — push is being delivered WITHOUT block suppression",
          {
            userId,
            senderId,
            senderCode: (senderBlockErr as any)?.code,
            recipientCode: (recipientBlockErr as any)?.code,
            message:
              (senderBlockErr as any)?.message ?? (recipientBlockErr as any)?.message,
          },
        );
      }
      if (senderBlockedRecipient || recipientBlockedSender) {
        return decide("suppressed_blocked_sender", `blocked:${senderId}`);
      }
    } catch (err) {
      // fail-open: a DB error should not block safety checking elsewhere
      console.warn(
        "CompassNotificationEngine: blocked-sender check rejected — push is being delivered WITHOUT block suppression",
        { userId, senderId, err },
      );
    }
  }

  // ── Safety filter step 2: canonical CompassSafetyFilter on synthetic item ─────
  // Build a synthetic CompassItem from the notification payload's data fields and
  // run it through the SAME runSafetyFilter used by the feed pipeline. This gives
  // full parity with all 16 hard-block conditions (suspended, adult-service flag,
  // unsafe intent, hidden/expired/cancelled, age gate, delayed post, report count,
  // etc.) without maintaining a separate hand-rolled subset.
  //
  // Block-relationship checks (conditions 1–2) are intentionally omitted from the
  // minimal profile (empty block arrays) because they are already covered by the
  // dedicated step 1 above, which returns the notification-specific
  // "suppressed_blocked_sender" outcome.
  {
    // Resolve whether the sender is suspended via trust_profiles when the payload
    // doesn't already carry an explicit isSuspended flag.
    const dataFields = payload.data ?? {};
    let senderSuspended = dataFields["isSuspended"] === true;
    if (db && senderId && !senderSuspended) {
      try {
        const { data: senderTrust } = await db
          .from("trust_profiles")
          .select("public_level")
          .eq("user_id", senderId)
          .maybeSingle();
        if ((senderTrust as any)?.public_level === "suspended") senderSuspended = true;
      } catch { /* fail-open */ }
    }

    const VALID_ITEM_TYPES = new Set([
      "event", "post", "user", "buddy", "trip", "stamp", "notification", "suggestion",
    ]);
    const rawType   = String(dataFields["itemType"] ?? "");
    const itemType  = (VALID_ITEM_TYPES.has(rawType) ? rawType : "notification") as CompassItem["type"];

    const syntheticItem: CompassItem = {
      id:                     String(dataFields["itemId"] ?? `notif:${payload.type}`),
      type:                   itemType,
      authorId:               senderId ?? undefined,
      isSuspended:            senderSuspended,
      isReportedByViewer:     dataFields["isReportedByViewer"]   === true,
      reportCount:            typeof dataFields["reportCount"]   === "number" ? (dataFields["reportCount"] as number) : 0,
      hasAdultServiceFlag:    dataFields["hasAdultServiceFlag"]  === true,
      hasOffAppPaymentSignal: dataFields["hasOffAppPaymentSignal"] === true,
      hasUnsafeIntentSignal:  dataFields["hasUnsafeIntentSignal"] === true,
      isHidden:               dataFields["isHidden"]             === true,
      isExpired:              dataFields["isExpired"]            === true,
      isCancelled:            dataFields["isCancelled"]          === true,
      isDelayedPost:          dataFields["isDelayedPost"]        === true,
      publishEligibleAt:      dataFields["publishEligibleAt"]    != null ? String(dataFields["publishEligibleAt"]) : undefined,
      requiresVerification:   dataFields["requiresVerification"] === true,
      isVerified:             dataFields["isVerified"]           === true,
      minAgeRequired:         typeof dataFields["minAgeRequired"] === "number" ? (dataFields["minAgeRequired"] as number) : 0,
      country:                dataFields["country"]              != null ? String(dataFields["country"]) : undefined,
    };

    // Minimal profile — block arrays empty (handled by step 1); all other
    // fields are safe defaults that do not influence safety-filter outcomes.
    const minimalProfile: CompassProfile = {
      userId,
      preferredCities:        [],
      preferredLanguages:     [],
      budgetStyle:            null,
      travelStyles:           [],
      socialStyle:            null,
      safetyPreference:       "standard",
      visibilityPreference:   "semi_private",
      blockedUserIds:         [],
      blockerUserIds:         [],
      mutedUserIds:           [],
      blockCount:             0,
      blockerCount:           0,
      trustScore:             null,
      trustLevel:             null,
      activeUserScore:        null,
      hasActiveTrip:          false,
      hasActiveBooking:       false,
      upcomingTripWithin48h:  false,
      hasFutureTripScheduled: false,
      currentCity:            null,
      currentCountry:         null,
      safeReturnActive:       false,
      categoryWeights:        {},
      ignoredItemIds:         [],
      mutedHashtags:          [],
      computedAt:             new Date().toISOString(),
    };

    const filterResult = runSafetyFilter(syntheticItem, minimalProfile, null);
    if (!filterResult.allowed) {
      return decide("suppressed_safety_filter", filterResult.reason ?? "safety_filter_blocked");
    }
  }

  // ── Safety filter step 3: category-level feature flag check ──────────────────
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
    : { quietStart: null, quietEnd: null, timezone: null, mutedCategories: [], compassEnabled: true };

  // ── Quiet hours check (levels 3–10) ──────────────────────────────────────────
  if (prefs.quietStart && prefs.quietEnd) {
    if (isQuietHours(prefs.quietStart, prefs.quietEnd, opts.nowMinutes, prefs.timezone)) {
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
