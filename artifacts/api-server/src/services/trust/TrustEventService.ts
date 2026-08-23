/**
 * TrustEventService
 *
 * Records trust signals into trust_events with:
 * - Source deduplication (same user+type+source within window)
 * - Daily/weekly earning caps per event type (from trust_settings)
 * - Severity classification (minor / moderate / serious / severe)
 * - Automatic pending_review status for serious/severe events
 * - Feature-flag gating (trust_engine_enabled)
 *
 * Never auto-bans. Serious/severe events are queued for admin review.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type TrustCategory =
  | "plan_attendance"
  | "host_quality"
  | "communication"
  | "respect_safety"
  | "location_honesty"
  | "content_quality"
  | "community_value"
  | "guide_accuracy"
  | "passport_authenticity";

export type TrustSeverity = "minor" | "moderate" | "serious" | "severe";
export type TrustEventStatus = "applied" | "pending_review" | "confirmed" | "dismissed";

export interface TrustEventInput {
  userId: string;
  eventType: string;
  category: TrustCategory;
  delta: number;
  severity: TrustSeverity;
  sourceType?: string;
  sourceId?: string;
  /** Dedup window in hours — default 24 */
  dedupWindowHours?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordEventResult {
  ok: boolean;
  eventId?: string;
  skipped?: boolean;
  skipReason?: "dedup" | "daily_cap" | "flag_off";
  pendingReview?: boolean;
}

/**
 * Check if trust engine is enabled.
 *
 * Exported so the maintenance scheduler uses this exact gate rather than its own
 * copy: events and scoring must never disagree about whether the engine is on,
 * and a second direct feature_flags read would need its own DIRECT_READS entry
 * recording a separately-verified failure direction. One read, one judgement.
 */
export async function isTrustEnabled(db: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "trust_engine_enabled")
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
  }
}

/** Count events for a user/type within a time window */
async function countInWindow(
  db: SupabaseClient,
  userId: string,
  eventType: string,
  windowMs: number,
): Promise<number> {
  try {
    const since = new Date(Date.now() - windowMs).toISOString();
    const { data } = await db
      .from("trust_events")
      .select("id")
      .eq("user_id", userId)
      .eq("event_type", eventType)
      .gt("created_at", since);
    return (data as any[])?.length ?? 0;
  } catch {
    return 0;
  }
}

interface EarningCaps { daily: number; weekly: number }

/**
 * Canonical event-type → cap bucket map.
 * Keys are lower-cased for case-insensitive matching.
 * "plan_attend" | "guide_verify" | "gem_save" — unlimited otherwise.
 */
const EVENT_TYPE_CAP_BUCKET: Record<string, "plan_attend" | "guide_verify" | "gem_save"> = {
  // Plan attendance
  plan_attended:           "plan_attend",
  plan_attend_positive:    "plan_attend",
  plan_attend_weekly:      "plan_attend",
  // Guide verification
  guide_verify_positive:   "guide_verify",
  gem_verified_by_guide:   "guide_verify",
  guide_verification:      "guide_verify",
  // Gem save
  gem_save_positive:       "gem_save",
  gem_saved:               "gem_save",
  checkin_verified:        "gem_save",
};

/**
 * Earning cap for positive event types with no explicit bucket.
 *
 * This used to be 999/999 — i.e. no cap at all. Only 9 literal event-type
 * strings are bucketed, but far more positive types are actually emitted
 * (event_attended, event_hosted, review_submitted, pulse_post_created,
 * passport_stamp_earned, rent_buddy_completed, telegraph_connection_accepted,
 * identity_verified, appeal_approved …), so in practice the main earning
 * surfaces were entirely uncapped.
 *
 * Chosen to sit at the most permissive existing bucket (gem_save, 10/40) so it
 * cannot bind ordinary heavy use — nobody legitimately completes more than ten
 * trust-earning actions of one type in a day — while still removing the
 * unbounded-accrual path. Naturally one-shot types (identity_verified,
 * first_event_joined) are unaffected: they fire once and never approach it.
 *
 * These are counts of EVENTS ACCEPTED, not score. The confidence ramp in
 * TrustScoreService is what actually governs how fast a score can rise; this
 * cap bounds ledger volume and the load a farming loop can generate.
 */
const DEFAULT_EARNING_CAP: EarningCaps = { daily: 10, weekly: 40 };

/** Returns daily and weekly caps for an event type from trust_settings */
async function getEarningCaps(
  db: SupabaseClient,
  eventType: string,
): Promise<EarningCaps> {
  try {
    const bucket = EVENT_TYPE_CAP_BUCKET[eventType.toLowerCase()];
    if (!bucket) return DEFAULT_EARNING_CAP;
    const { data } = await db.from("trust_settings").select(
      "daily_cap_plan_attend,daily_cap_guide_verify,daily_cap_gem_save," +
      "weekly_cap_plan_attend,weekly_cap_guide_verify,weekly_cap_gem_save",
    ).eq("id", 1).maybeSingle();
    if (!data) {
      const defaults = { plan_attend: { daily: 3, weekly: 10 }, guide_verify: { daily: 5, weekly: 20 }, gem_save: { daily: 10, weekly: 40 } };
      return defaults[bucket];
    }
    const s = data as any;
    if (bucket === "plan_attend")  return { daily: s.daily_cap_plan_attend  ?? 3,  weekly: s.weekly_cap_plan_attend  ?? 10 };
    if (bucket === "guide_verify") return { daily: s.daily_cap_guide_verify ?? 5,  weekly: s.weekly_cap_guide_verify ?? 20 };
    /* gem_save */                 return { daily: s.daily_cap_gem_save     ?? 10, weekly: s.weekly_cap_gem_save     ?? 40 };
  } catch {
    // Restrict rather than open on error. This path only ever delays ACCRUAL —
    // it can never reduce an existing score — so failing closed costs a user at
    // most a postponed positive event, whereas failing open (the previous
    // 999/999) turned any transient trust_settings read failure into an
    // uncapped earning window.
    return DEFAULT_EARNING_CAP;
  }
}

/** Check deduplication window */
async function isDuplicate(
  db: SupabaseClient,
  userId: string,
  eventType: string,
  sourceType: string,
  sourceId: string | undefined,
  windowHours: number,
): Promise<boolean> {
  if (!sourceId) return false;
  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const { data } = await db
      .from("trust_events")
      .select("id")
      .eq("user_id", userId)
      .eq("event_type", eventType)
      .eq("source_type", sourceType)
      .eq("source_id", sourceId)
      .gt("created_at", since)
      .maybeSingle();
    return Boolean(data);
  } catch {
    return false;
  }
}

/** Record a trust event with dedup, cap, and severity checks */
export async function recordTrustEvent(
  db: SupabaseClient,
  input: TrustEventInput,
): Promise<RecordEventResult> {
  if (!await isTrustEnabled(db)) {
    return { ok: false, skipped: true, skipReason: "flag_off" };
  }

  const {
    userId, category, delta, severity,
    sourceType = "system", sourceId, dedupWindowHours = 24,
    metadata = {},
  } = input;
  // Normalize to lowercase so "PLAN_ATTENDED" and "plan_attended" are the same bucket
  const eventType = input.eventType.toLowerCase();

  // Deduplication check
  const dup = await isDuplicate(db, userId, eventType, sourceType, sourceId, dedupWindowHours);
  if (dup) return { ok: false, skipped: true, skipReason: "dedup" };

  // Daily and weekly cap checks (only for positive events)
  if (delta > 0) {
    const caps = await getEarningCaps(db, eventType);
    const [dayCount, weekCount] = await Promise.all([
      countInWindow(db, userId, eventType, 24 * 60 * 60 * 1000),
      countInWindow(db, userId, eventType, 7 * 24 * 60 * 60 * 1000),
    ]);
    if (dayCount >= caps.daily || weekCount >= caps.weekly) {
      return { ok: false, skipped: true, skipReason: "daily_cap" };
    }
  }

  // Serious/severe → pending_review; others → applied
  const status: TrustEventStatus =
    (severity === "serious" || severity === "severe") ? "pending_review" : "applied";

  const { data, error } = await db
    .from("trust_events")
    .insert({
      user_id:     userId,
      event_type:  eventType,
      category,
      delta,
      severity,
      source_type: sourceType,
      source_id:   sourceId ?? null,
      status,
      metadata,
    })
    .select("id")
    .single();

  if (error) throw new Error(`recordTrustEvent DB error: ${error.message}`);

  return {
    ok: true,
    eventId: (data as any).id,
    pendingReview: status === "pending_review",
  };
}

/** Batch record multiple events (ignores individual failures) */
export async function recordTrustEvents(
  db: SupabaseClient,
  inputs: TrustEventInput[],
): Promise<RecordEventResult[]> {
  return Promise.all(inputs.map((i) => recordTrustEvent(db, i).catch(() => ({ ok: false }))));
}

/**
 * Wire location trust events into the engine.
 * Called from LocationSafetyService after suspicious GPS detected.
 */
export async function recordLocationTrustEvent(
  db: SupabaseClient,
  userId: string,
  suspicionReason: string,
  confidence: "low" | "medium" | "high",
): Promise<void> {
  const severity: TrustSeverity =
    confidence === "high" ? "serious" : confidence === "medium" ? "moderate" : "minor";
  const delta = confidence === "high" ? -8 : confidence === "medium" ? -4 : -1;

  await recordTrustEvent(db, {
    userId,
    eventType: `gps_${suspicionReason}`,
    category: "location_honesty",
    delta,
    severity,
    sourceType: "gps",
    sourceId: `${userId}:${suspicionReason}:${Math.floor(Date.now() / 86400000)}`, // daily dedup
    dedupWindowHours: 24,
    metadata: { suspicionReason, confidence },
  }).catch(() => {/* non-fatal */});
}

/** All event types by source system */
export const TRUST_EVENT_TYPES = {
  // Plans
  PLAN_ATTENDED:            { category: "plan_attendance" as TrustCategory, delta: 5,  severity: "minor" as TrustSeverity },
  PLAN_NO_SHOW:             { category: "plan_attendance" as TrustCategory, delta: -10, severity: "moderate" as TrustSeverity },
  PLAN_LATE_CANCEL:         { category: "plan_attendance" as TrustCategory, delta: -5,  severity: "minor" as TrustSeverity },
  HOST_POSITIVE_REVIEW:     { category: "host_quality" as TrustCategory,    delta: 6,  severity: "minor" as TrustSeverity },
  HOST_NEGATIVE_REVIEW:     { category: "host_quality" as TrustCategory,    delta: -8, severity: "moderate" as TrustSeverity },
  // Communication
  RESPONDED_PROMPTLY:       { category: "communication" as TrustCategory,   delta: 2,  severity: "minor" as TrustSeverity },
  MESSAGE_REPORT_CONFIRMED: { category: "communication" as TrustCategory,   delta: -15, severity: "serious" as TrustSeverity },
  // Respect & Safety
  SAFE_RETURN_COMPLETED:    { category: "respect_safety" as TrustCategory,  delta: 3,  severity: "minor" as TrustSeverity },
  BEHAVIOR_REPORT_CONFIRMED:{ category: "respect_safety" as TrustCategory,  delta: -20, severity: "severe" as TrustSeverity },
  // Location
  GPS_COORDINATE_JUMP:      { category: "location_honesty" as TrustCategory,delta: -4, severity: "moderate" as TrustSeverity },
  GPS_IMPOSSIBLE_SPEED:     { category: "location_honesty" as TrustCategory,delta: -8, severity: "serious" as TrustSeverity },
  CHECKIN_VERIFIED:         { category: "location_honesty" as TrustCategory,delta: 2,  severity: "minor" as TrustSeverity },
  FAKE_GPS_CONFIRMED:       { category: "location_honesty" as TrustCategory,delta: -20, severity: "severe" as TrustSeverity },
  // Content
  PULSE_POST_REPORTED:      { category: "content_quality" as TrustCategory, delta: -5, severity: "moderate" as TrustSeverity },
  CONTENT_REMOVED:          { category: "content_quality" as TrustCategory, delta: -10, severity: "serious" as TrustSeverity },
  // Community
  TRAVEL_CIRCLE_JOIN:       { category: "community_value" as TrustCategory, delta: 1,  severity: "minor" as TrustSeverity },
  MUTUAL_REPORT:            { category: "community_value" as TrustCategory, delta: -3, severity: "minor" as TrustSeverity },
  // Local Guide / Hidden Gems
  GEM_VERIFIED_BY_GUIDE:    { category: "guide_accuracy" as TrustCategory,  delta: 4,  severity: "minor" as TrustSeverity },

  /** Emitted when a user completes Portava Verified (id or id_selfie tier). */
  IDENTITY_VERIFIED:        { category: "respect_safety" as TrustCategory,  delta: 10, severity: "minor" as TrustSeverity },
  GEM_DISPUTED:             { category: "guide_accuracy" as TrustCategory,  delta: -5, severity: "moderate" as TrustSeverity },
  // Passport
  STAMP_VERIFIED:           { category: "passport_authenticity" as TrustCategory, delta: 3,  severity: "minor" as TrustSeverity },
  STAMP_DISPUTED:           { category: "passport_authenticity" as TrustCategory, delta: -6, severity: "moderate" as TrustSeverity },
  // Reviews & Appeals
  REVIEW_SUBMITTED:         { category: "community_value" as TrustCategory,  delta: 2,  severity: "minor" as TrustSeverity },
  APPEAL_APPROVED_REVERSAL: { category: "community_value" as TrustCategory,  delta: 2,  severity: "minor" as TrustSeverity },
  // Events
  EVENT_HOSTED:             { category: "host_quality" as TrustCategory,     delta: 5,  severity: "minor" as TrustSeverity },
  EVENT_ATTENDED:           { category: "plan_attendance" as TrustCategory,  delta: 5,  severity: "minor" as TrustSeverity },
  EVENT_HOST_CANCELLED:     { category: "host_quality" as TrustCategory,     delta: -8, severity: "moderate" as TrustSeverity },
  EVENT_HOST_NO_SHOW:       { category: "host_quality" as TrustCategory,     delta: -15, severity: "serious" as TrustSeverity },
  EVENT_ATTENDEE_NO_SHOW:   { category: "plan_attendance" as TrustCategory,  delta: -5, severity: "minor" as TrustSeverity },
  EVENT_POSITIVE_REVIEW:    { category: "host_quality" as TrustCategory,     delta: 3,  severity: "minor" as TrustSeverity },
  EVENT_NEGATIVE_REVIEW:    { category: "host_quality" as TrustCategory,     delta: -6, severity: "moderate" as TrustSeverity },
} as const;
