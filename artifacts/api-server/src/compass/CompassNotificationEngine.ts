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
 *   - Sensing §15 (`:176`): a WORLD CHANGE — a Compass recommendation or a
 *     discovery, levels 8–9 — that survives every filter above is NOT thereby
 *     sent. It routes through lib/attentionEngine (relevance, novelty, urgency,
 *     half-life, availability, interruption cost, attention budget) and only a
 *     NOTIFY route becomes a push. WALL keeps it on the durable in-app surface
 *     without interrupting; SILENT records it; IGNORE drops it for this
 *     viewer. Person-to-person and operational classes (messages, bookings,
 *     trip-critical, social) are not world changes and keep their send path.
 *
 * All decisions are logged to compass_notification_decisions (fire-and-forget).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile } from "./types.js";
import { runSafetyFilter } from "./CompassSafetyFilter.js";
import { localMinutesOfDay } from "../services/notifications/NotificationPreferenceService.js";
import {
  ATTENTION_BUDGET_PER_WINDOW,
  ATTENTION_RELEVANCE,
  routeAttentionSubject,
  type AttentionDecision,
  type AttentionRelevance,
  type AttentionRoute,
} from "../lib/attentionEngine.js";
import { readDeliveredInWindow } from "../lib/contextKernelRead.js";

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
  | "suppressed_ignored_category"
  /** Attention Engine routes for a world change that passed every filter (Sensing §15). */
  | "wall"
  | "silent"
  | "ignore";

export interface NotificationDecision {
  outcome:           NotificationOutcome;
  suppressionReason: string | null;
  priorityLevel:     number;
  strippedPayload:   NotificationPayload;
  /** The Attention Engine's decision, for a world change; null for every other class. */
  attention:         AttentionDecision | null;
}

// ── Attention Engine adapter (Sensing §15) ────────────────────────────────────

/**
 * The classes that are WORLD CHANGES in the spec's sense: something happened
 * in the world that Compass or Discovery thinks this person should know.
 * Messages, bookings, trip-critical and social activity are people acting, not
 * the world changing, and the spec's sentence does not cover them.
 */
export const WORLD_CHANGE_TYPES = ["recommendation", "discovery"] as const satisfies readonly NotificationType[];

export function isWorldChangeType(type: NotificationType): boolean {
  return (WORLD_CHANGE_TYPES as readonly string[]).includes(type);
}

/**
 * What a producer may DECLARE about a world change, under `data.attention`.
 * Relevance is the viewer's relation to the subject "declared by the caller
 * from what it knows" (lib/attentionEngine); a producer that knows the change
 * is about a saved place or a trip stop says so. Everything is optional and
 * everything is validated: an unknown relevance word is not a relevance.
 */
export interface AttentionDeclaration {
  relevance?: AttentionRelevance;
  /** 0..1 */
  urgency?: number;
  /** Identity for novelty; defaults to the notification id, then the type. */
  subjectId?: string;
  relevanceWindow?: { from: string; until: string };
  /** The producer knows the viewer has already seen this change. */
  alreadySeen?: boolean;
}

/**
 * Urgency from the notification row's priority, when the producer declared
 * no urgency of its own. `urgent` and `high` reach the NOTIFY floor (0.7 in
 * lib/attentionEngine); `normal` and `low` do not, and go to the WALL unless
 * a producer says otherwise.
 */
export const WORLD_CHANGE_URGENCY_BY_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  urgent: 1.0,
  high: 0.8,
  normal: 0.5,
  low: 0.3,
});
export const DEFAULT_WORLD_CHANGE_URGENCY = 0.5;

/**
 * An undeclared relation: the producer addressed this person, so the change
 * is not "none" — but nobody said it is a saved place or a trip stop, so it
 * may not interrupt. `followed` (0.6) reaches the WALL and stops there.
 */
export const DEFAULT_WORLD_CHANGE_RELEVANCE: AttentionRelevance = "followed";

/**
 * Per-event defaults for the Compass producers whose relation to the viewer
 * is known from the event itself (a Sense nudge about YOUR saved event is
 * about a saved place; "leave earlier" is about YOUR next trip stop). A
 * producer's own `data.attention` declaration wins over this table; the table
 * wins over the generic default. Digests never interrupt.
 */
export const ATTENTION_BY_EVENT_TYPE: Readonly<Record<string, Readonly<{ relevance: AttentionRelevance; urgency: number }>>> =
  Object.freeze({
    "compass.warning":                    { relevance: "trip_stop", urgency: 0.9 },
    "compass.weather_alert":              { relevance: "trip_stop", urgency: 0.7 },
    "compass.itinerary_ready":            { relevance: "trip_stop", urgency: 0.7 },
    "compass.sense.leave_earlier":        { relevance: "trip_stop", urgency: 0.9 },
    "compass.sense.saved_event_starting": { relevance: "saved",     urgency: 0.8 },
    "compass.sense.circle_plan_change":   { relevance: "trip_stop", urgency: 0.7 },
    "compass.sense.weather_change":       { relevance: "trip_stop", urgency: 0.6 },
    "compass.sense.free_time_block":      { relevance: "trip_stop", urgency: 0.4 },
    "compass.live.live_next_up":          { relevance: "trip_stop", urgency: 0.8 },
    "compass.live.live_arriving_early":   { relevance: "trip_stop", urgency: 0.7 },
    "compass.live.live_ride_home":        { relevance: "trip_stop", urgency: 0.7 },
    "compass.recommendation":             { relevance: "followed",  urgency: 0.5 },
    "compass.daily_brief":                { relevance: "followed",  urgency: 0.3 },
    "digest.compass":                     { relevance: "followed",  urgency: 0.3 },
  });

function isRelevance(v: unknown): v is AttentionRelevance {
  return typeof v === "string" && (ATTENTION_RELEVANCE as readonly string[]).includes(v);
}

/** Read `data.attention`, keeping only what validates. Never throws. */
export function readAttentionDeclaration(data: Record<string, unknown> | undefined): AttentionDeclaration {
  const raw = data?.attention;
  if (!raw || typeof raw !== "object") return {};
  const a = raw as Record<string, unknown>;
  const out: AttentionDeclaration = {};
  if (isRelevance(a.relevance)) out.relevance = a.relevance;
  if (typeof a.urgency === "number" && Number.isFinite(a.urgency)) out.urgency = Math.min(1, Math.max(0, a.urgency));
  if (typeof a.subjectId === "string" && a.subjectId.length > 0) out.subjectId = a.subjectId;
  const w = a.relevanceWindow as Record<string, unknown> | undefined;
  if (w && typeof w === "object" && typeof w.from === "string" && typeof w.until === "string") {
    out.relevanceWindow = { from: w.from, until: w.until };
  }
  if (a.alreadySeen === true) out.alreadySeen = true;
  return out;
}

/** Relevance and urgency for a world change: declaration → event table → defaults. */
export function worldChangeFactors(payload: NotificationPayload): { relevance: AttentionRelevance; urgency: number } {
  const declared = readAttentionDeclaration(payload.data);
  const eventType = typeof payload.data?.eventType === "string" ? payload.data.eventType : null;
  const byEvent = eventType ? ATTENTION_BY_EVENT_TYPE[eventType] : undefined;
  const priority = typeof payload.data?.priority === "string" ? payload.data.priority : null;
  const relevance = declared.relevance ?? byEvent?.relevance ?? DEFAULT_WORLD_CHANGE_RELEVANCE;
  const urgency =
    declared.urgency ??
    byEvent?.urgency ??
    (priority !== null && priority in WORLD_CHANGE_URGENCY_BY_PRIORITY ? WORLD_CHANGE_URGENCY_BY_PRIORITY[priority]! : DEFAULT_WORLD_CHANGE_URGENCY);
  return { relevance, urgency };
}

const OUTCOME_OF_ROUTE: Readonly<Record<AttentionRoute, NotificationOutcome>> = Object.freeze({
  NOTIFY: "sent",
  WALL: "wall",
  SILENT: "silent",
  IGNORE: "ignore",
});

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
  /** True when a preferences read failed: availability is then UNKNOWN, never "available". */
  readFailed:      boolean;
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
    const [{ data, error: prefsErr }, { data: notifPrefsRow, error: notifErr }] = await Promise.all([
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
      readFailed:      Boolean(prefsErr) || Boolean(notifErr),
      quietStart,
      quietEnd,
      timezone:        ((notifPrefsRow as any)?.timezone as string | null) ?? null,
      mutedCategories: mutedCats,
      compassEnabled:  row.compass_enabled !== false,
    };
  } catch {
    return { readFailed: true, quietStart: null, quietEnd: null, timezone: null, mutedCategories: [], compassEnabled: true };
  }
}

// ── Safety filter — category-level feature flag check ────────────────────────

/**
 * Check whether the notification category is blocked by a feature flag
 * (e.g. COMPASS_BUDDY_SAFETY_BLOCK or COMPASS_NIGHTLIFE_SAFETY_BLOCK).
 * This mirrors the CompassSafetyFilter type-level block check.
 * Never throws.
 *
 * ── POLARITY ────────────────────────────────────────────────────────────────
 * `*_SAFETY_BLOCK` is a KILL SWITCH: the row existing with `enabled = true` is
 * how an operator says "stop sending this category, right now, for everyone".
 * That inverts the usual `*_enabled` polarity, and it inverts what an
 * unreadable flag means. supabase-js RESOLVES on a DB error, so
 * `Boolean((data as any)?.enabled)` answered `false` — NOT BLOCKED — for both
 * "no such flag row" (correct: nothing is blocked by default) and "feature_flags
 * could not be read" (the switch's position is unknown). A kill switch whose
 * position cannot be read must be treated as THROWN; the alternative is that a
 * blocked safety category resumes firing during exactly the incident the
 * operator threw it for.
 *
 * The absent-row case keeps its meaning: `data === null` with no error is still
 * "not blocked", so no category needs a flag row to work.
 */
async function isCategoryBlocked(
  db:       SupabaseClient | null,
  category: string,
): Promise<boolean> {
  if (!db || !category) return false;
  try {
    const flagKey = `COMPASS_${category.toUpperCase().replace(/[\s-]/g, "_")}_SAFETY_BLOCK`;
    const { data, error } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flagKey)
      .maybeSingle();
    if (error) return true; // kill switch in an unknown position — treat as thrown
    return Boolean((data as any)?.enabled);
  } catch {
    return true;
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
  // ONE clock read for the whole evaluation. src/test/splitClockGuard.test.ts
  // forbids a function taking two independent reads (Date.now() plus a no-arg
  // new Date()), because two instants can straddle a boundary and make one
  // decision internally inconsistent — here, a suspension that expires between
  // the account-state comparison below and the profile's computedAt stamp.
  // Derive every date from this value (the pushRetryQueue.ts pattern).
  const nowMs = Date.now();
  const level = PRIORITY_LEVELS[payload.type];

  // Strip private location from body/data regardless of outcome
  const stripped = stripPrivateLocation(payload);

  const decide = (
    outcome: NotificationOutcome,
    reason:  string | null = null,
    attention: AttentionDecision | null = null,
  ): NotificationDecision => {
    const d: NotificationDecision = {
      outcome,
      suppressionReason: reason,
      priorityLevel:     level,
      strippedPayload:   stripped,
      attention,
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
          "CompassNotificationEngine: blocked-sender check failed — push SUPPRESSED (cannot establish the block relationship)",
          {
            userId,
            senderId,
            senderCode: (senderBlockErr as any)?.code,
            recipientCode: (recipientBlockErr as any)?.code,
            message:
              (senderBlockErr as any)?.message ?? (recipientBlockErr as any)?.message,
          },
        );
        // A LOG LINE IS NOT A GUARD. This branch used to name the exact outcome
        // it was about to produce — that the push was going out with no block
        // suppression applied — and then produce it. (The old wording is NOT
        // quoted here: `silentSchemaErrorCatches.test.ts` pins these messages by
        // substring, and a comment repeating a retired marker satisfies that
        // guard with a quotation instead of a diagnostic. It did, until this was
        // caught.) `blocks` is an EXCLUSION table: a row means DENY, so an
        // empty read means ALLOW and an UNREADABLE one means nothing at all. This
        // gate's stated contract, eighteen lines above, is that "a blocked sender
        // must never reach the recipient via push", and a delivered push is
        // unrecallable — so the only answer consistent with that sentence is to
        // withhold this one notification.
        //
        // The reason is DISTINCT from a real block on purpose: `logDecision`
        // writes it to the ledger, and "we could not check" must not be readable
        // later as "this person is blocked".
        return decide("suppressed_blocked_sender", `block_state_unknown:${senderId}`);
      }
      if (senderBlockedRecipient || recipientBlockedSender) {
        return decide("suppressed_blocked_sender", `blocked:${senderId}`);
      }
    } catch (err) {
      // SAME UNKNOWN, SAME ANSWER. This arm used to read "fail-open: a DB error
      // should not block safety checking elsewhere". That reasoning is about not
      // ABORTING the pipeline, and it does not follow that the push should go: a
      // throw leaves the block relationship exactly as unknown as a rejected
      // read does, and suppressing this notification blocks no other check.
      // Leaving the two paths to disagree would have meant the gate held or not
      // depending on whether PostgREST reported the failure or threw it.
      console.warn(
        "CompassNotificationEngine: blocked-sender check rejected — push SUPPRESSED (cannot establish the block relationship)",
        { userId, senderId, err },
      );
      return decide("suppressed_blocked_sender", `block_state_unknown:${senderId}`);
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
    // Resolve whether the sender is suspended when the payload doesn't already
    // carry an explicit isSuspended flag.
    //
    // This used to read `trust_profiles.public_level === "suspended"`. That
    // value cannot exist: the live CHECK on trust_profiles.public_level admits
    // only new_traveler / building_trust / reliable_traveler / trusted_traveler
    // / highly_trusted / city_trusted (verified against production
    // 2026-09-07), so the check was dead and a suspended sender's push was
    // never suppressed by it. Suspension lives in `user_account_states`
    // (state banned/suspended, optionally time-bounded by expires_at) — the
    // same table lib/circleAccessGuard, lib/http and lib/profileVisibility
    // read for the same question. A read error is bound and logged rather
    // than discarded (supabase-js resolves on a DB error); the posture stays
    // deliver-with-warning, matching the blocked-sender step above.
    const dataFields = payload.data ?? {};
    let senderSuspended = dataFields["isSuspended"] === true;
    if (db && senderId && !senderSuspended) {
      try {
        const { data: acctRows, error: acctErr } = await db
          .from("user_account_states")
          .select("state, expires_at")
          .eq("user_id", senderId)
          .in("state", ["banned", "suspended"]);
        if (acctErr) {
          // SAME SHAPE AS THE BLOCK READ ABOVE, one step further along. This
          // branch used to log and fall through, leaving `senderSuspended` at
          // its initial false — so the synthetic item handed to runSafetyFilter
          // asserted, as a fact, that the sender is in good standing. An
          // unreadable state table is not a clean record.
          //
          // census-compass §6 F2 recorded this site as closed with the evidence
          // "`error` bound and logged". Binding and logging is how this defect
          // is FOUND; it is not how it is fixed.
          console.warn(
            "CompassNotificationEngine: sender account-state check failed — push SUPPRESSED (cannot establish suspension)",
            { userId, senderId, code: (acctErr as any)?.code, message: (acctErr as any)?.message },
          );
          return decide("suppressed_safety_filter", `account_state_unknown:${senderId}`);
        } else {
          senderSuspended = ((acctRows ?? []) as Array<{ state: string; expires_at: string | null }>)
            .some((r) => r.expires_at == null || Date.parse(r.expires_at) > nowMs);
        }
      } catch (err) {
        // Same unknown, same answer — see the block read above for why the
        // thrown and the rejected path must not disagree.
        console.warn(
          "CompassNotificationEngine: sender account-state check rejected — push SUPPRESSED (cannot establish suspension)",
          { userId, senderId, err },
        );
        return decide("suppressed_safety_filter", `account_state_unknown:${senderId}`);
      }
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
      computedAt:             new Date(nowMs).toISOString(),
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
  const prefs: UserNotifPrefs = db
    ? await loadUserNotifPrefs(db, userId)
    : { readFailed: false, quietStart: null, quietEnd: null, timezone: null, mutedCategories: [], compassEnabled: true };

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

  // ── Attention Engine (Sensing §15 `:176`) — MANDATORY for a world change ─────
  // Everything above is a hard filter: blocked, unsafe, muted, asleep. A world
  // change that passed them all has not yet earned an interruption. It is
  // routed on the seven factors the spec names, and only NOTIFY is a push.
  if (isWorldChangeType(payload.type)) {
    const declared = readAttentionDeclaration(payload.data);
    const { relevance, urgency } = worldChangeFactors(payload);
    const subjectId =
      declared.subjectId ??
      (typeof payload.data?.notificationId === "string" ? payload.data.notificationId : payload.type);
    // Interruption cost: pushes already delivered this window. An UNREADABLE
    // count is the budget spent — the same rule routes/wallMoments.ts applies —
    // because "we could not tell how often we have interrupted you" is not a
    // licence to interrupt again.
    const delivered = db ? await readDeliveredInWindow(db, userId, new Date(nowMs)) : 0;
    const attention = routeAttentionSubject(
      { id: subjectId, urgency, safety: false, relevanceWindow: declared.relevanceWindow ?? null },
      {
        relevance,
        seenMomentIds: declared.alreadySeen ? new Set([subjectId]) : new Set(),
        // Quiet hours and push-off were answered above; what is left is whether
        // the preferences could be READ. Unreadable consent is never consent.
        available: prefs.readFailed ? null : true,
        notifiesInWindow: delivered ?? ATTENTION_BUDGET_PER_WINDOW,
      },
      nowMs,
    );
    const outcome = OUTCOME_OF_ROUTE[attention.route];
    return decide(outcome, outcome === "sent" ? null : `attention:${attention.route.toLowerCase()}:${attention.reasons.join(",")}`, attention);
  }

  return decide("sent");
}
