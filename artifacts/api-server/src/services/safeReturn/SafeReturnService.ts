/**
 * SafeReturnService
 *
 * Core CRUD for Safe Return sessions.  All writes go through the service-role
 * client and append an entry to safe_return_events for every state transition.
 * Backward-compat: existing location_sessions rows for session_type='safe_return'
 * are untouched; new sessions write to safe_return_sessions only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger";
import { recordTrustEvent } from "../trust/TrustEventService.js";

const logger = rootLogger.child({ service: "SafeReturnService" });

// ── Types ─────────────────────────────────────────────────────────────────────

export type SafeReturnStatus = "pending" | "active" | "safe" | "missed" | "cancelled";

export interface SafeReturnContactInput {
  contactUserId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  contactMethod: "in_app" | "sms" | "email";
  canReceiveLiveLocation?: boolean;
}

export interface CreateSessionInput {
  userId: string;
  planItemId?: string | null;
  tripId?: string | null;
  triggerReason?: string | null;
  escalationLevel?: 0 | 1 | 2 | 3;
  timerMinutes?: number | null;
  trustedCircleEnabled?: boolean;
  liveShareEnabled?: boolean;
  notifyHostEnabled?: boolean;
  notifyTripCrewEnabled?: boolean;
  emergencyNote?: string | null;
  contacts?: SafeReturnContactInput[];
}

export interface SafeReturnSession {
  id: string;
  userId: string;
  planItemId: string | null;
  tripId: string | null;
  status: SafeReturnStatus;
  triggerReason: string | null;
  escalationLevel: number;
  timerStartAt: string | null;
  timerEndAt: string | null;
  lastPromptAt: string | null;
  lastSafeConfirmationAt: string | null;
  trustedCircleEnabled: boolean;
  liveShareEnabled: boolean;
  notifyHostEnabled: boolean;
  notifyTripCrewEnabled: boolean;
  emergencyNote: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SafeReturnContact {
  id: string;
  sessionId: string;
  contactUserId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactMethod: "in_app" | "sms" | "email";
  canReceiveLiveLocation: boolean;
  notifiedAt: string | null;
  acknowledgedAt: string | null;
}

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapSession(r: any): SafeReturnSession {
  return {
    id:                       r.id,
    userId:                   r.user_id,
    planItemId:               r.plan_item_id ?? null,
    tripId:                   r.trip_id ?? null,
    status:                   r.status as SafeReturnStatus,
    triggerReason:            r.trigger_reason ?? null,
    escalationLevel:          Number(r.escalation_level ?? 0),
    timerStartAt:             r.timer_start_at ?? null,
    timerEndAt:               r.timer_end_at ?? null,
    lastPromptAt:             r.last_prompt_at ?? null,
    lastSafeConfirmationAt:   r.last_safe_confirmation_at ?? null,
    trustedCircleEnabled:     Boolean(r.trusted_circle_enabled),
    liveShareEnabled:         Boolean(r.live_share_enabled),
    notifyHostEnabled:        Boolean(r.notify_host_enabled),
    notifyTripCrewEnabled:    Boolean(r.notify_trip_crew_enabled),
    emergencyNote:            r.emergency_note ?? null,
    closedAt:                 r.closed_at ?? null,
    createdAt:                r.created_at,
    updatedAt:                r.updated_at,
  };
}

function mapContact(r: any): SafeReturnContact {
  return {
    id:                     r.id,
    sessionId:              r.session_id,
    contactUserId:          r.contact_user_id ?? null,
    contactName:            r.contact_name ?? null,
    contactPhone:           r.contact_phone ?? null,
    contactEmail:           r.contact_email ?? null,
    contactMethod:          r.contact_method as "in_app" | "sms" | "email",
    canReceiveLiveLocation: Boolean(r.can_receive_live_location),
    notifiedAt:             r.notified_at ?? null,
    acknowledgedAt:         r.acknowledged_at ?? null,
  };
}

// ── Event writer ──────────────────────────────────────────────────────────────

async function writeEvent(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.from("safe_return_events").insert({ session_id: sessionId, user_id: userId, event_type: eventType, metadata });
  } catch (err) {
    logger.warn({ err, sessionId, eventType }, "SafeReturnService: event write failed (non-fatal)");
  }
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Create a new Safe Return session (status = pending).
 * Optionally inserts contacts.  Returns the new session.
 */
export async function createSession(
  db: SupabaseClient,
  input: CreateSessionInput,
): Promise<SafeReturnSession | null> {
  const timerEndAt = input.timerMinutes
    ? new Date(Date.now() + input.timerMinutes * 60_000).toISOString()
    : null;

  try {
    const { data, error } = await db
      .from("safe_return_sessions")
      .insert({
        user_id:                 input.userId,
        plan_item_id:            input.planItemId ?? null,
        trip_id:                 input.tripId ?? null,
        trigger_reason:          input.triggerReason ?? null,
        escalation_level:        input.escalationLevel ?? 0,
        timer_end_at:            timerEndAt,
        trusted_circle_enabled:  input.trustedCircleEnabled ?? false,
        live_share_enabled:      input.liveShareEnabled ?? false,
        notify_host_enabled:     input.notifyHostEnabled ?? false,
        notify_trip_crew_enabled:input.notifyTripCrewEnabled ?? false,
        emergency_note:          input.emergencyNote ?? null,
      })
      .select("*")
      .single();

    if (error || !data) { logger.warn({ err: error }, "createSession: insert failed"); return null; }

    const session = mapSession(data);

    // Insert contacts if provided
    if (input.contacts && input.contacts.length > 0) {
      const contactRows = input.contacts.map((c) => ({
        session_id:               session.id,
        contact_user_id:          c.contactUserId ?? null,
        contact_name:             c.contactName ?? null,
        contact_phone:            c.contactPhone ?? null,
        contact_email:            c.contactEmail ?? null,
        contact_method:           c.contactMethod,
        can_receive_live_location:c.canReceiveLiveLocation ?? false,
      }));
      const { error: cErr } = await db.from("safe_return_contacts").insert(contactRows);
      if (cErr) logger.warn({ err: cErr }, "createSession: contact insert failed (non-fatal)");
    }

    await writeEvent(db, session.id, input.userId, "session_created", {
      escalationLevel: session.escalationLevel,
      timerMinutes: input.timerMinutes ?? null,
    });

    return session;
  } catch (err) {
    logger.warn({ err }, "createSession: threw");
    return null;
  }
}

/** Start the timer (status pending → active, sets timer_start_at). */
export async function startSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnSession | null> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("safe_return_sessions")
      .update({ status: "active", timer_start_at: now, updated_at: now })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .eq("status", "pending")
      .select("*")
      .single();

    if (error || !data) { logger.warn({ err: error }, "startSession: update failed"); return null; }
    await writeEvent(db, sessionId, userId, "session_started");
    return mapSession(data);
  } catch (err) {
    logger.warn({ err }, "startSession: threw");
    return null;
  }
}

/** Extend timer_end_at by `minutes`. */
export async function extendTimer(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  minutes: number,
): Promise<SafeReturnSession | null> {
  try {
    // Fetch current timer_end_at first
    const { data: cur } = await db
      .from("safe_return_sessions")
      .select("timer_end_at, status")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!cur) return null;
    if (cur.status !== "active" && cur.status !== "missed") return null;

    const base = cur.timer_end_at ? new Date(cur.timer_end_at) : new Date();
    const newEnd = new Date(Math.max(base.getTime(), Date.now()) + minutes * 60_000).toISOString();
    const now = new Date().toISOString();

    const { data, error } = await db
      .from("safe_return_sessions")
      .update({ timer_end_at: newEnd, status: "active", updated_at: now })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .select("*")
      .single();

    if (error || !data) { logger.warn({ err: error }, "extendTimer: update failed"); return null; }
    await writeEvent(db, sessionId, userId, "timer_extended", { minutes, newEnd });
    return mapSession(data);
  } catch (err) {
    logger.warn({ err }, "extendTimer: threw");
    return null;
  }
}

/** User confirms they are safe (status → safe). */
export async function confirmSafe(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnSession | null> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("safe_return_sessions")
      .update({
        status: "safe",
        last_safe_confirmation_at: now,
        closed_at: now,
        updated_at: now,
      })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .in("status", ["active", "missed", "pending"])
      .select("*")
      .single();

    if (error || !data) { logger.warn({ err: error }, "confirmSafe: update failed"); return null; }
    await writeEvent(db, sessionId, userId, "safe_confirmed");
    // Feed into Trust Engine (fire-and-forget; flag-gated internally)
    void recordTrustEvent(db, {
      userId,
      eventType: "safe_return_completed",
      category: "respect_safety",
      delta: 3,
      severity: "minor",
      sourceType: "safe_return",
      sourceId: sessionId,
      dedupWindowHours: 12,
    });
    return mapSession(data);
  } catch (err) {
    logger.warn({ err }, "confirmSafe: threw");
    return null;
  }
}

/** User explicitly cancels before expiry (status → cancelled). */
export async function cancelSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnSession | null> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("safe_return_sessions")
      .update({ status: "cancelled", closed_at: now, updated_at: now })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .in("status", ["pending", "active"])
      .select("*")
      .single();

    if (error || !data) { logger.warn({ err: error }, "cancelSession: update failed"); return null; }
    await writeEvent(db, sessionId, userId, "session_cancelled");
    return mapSession(data);
  } catch (err) {
    logger.warn({ err }, "cancelSession: threw");
    return null;
  }
}

/**
 * Mark session as missed (internal/cron — service-role only).
 * Called when timer_end_at has passed without safe confirmation.
 */
export async function markMissed(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnSession | null> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("safe_return_sessions")
      .update({ status: "missed", last_prompt_at: now, updated_at: now })
      .eq("id", sessionId)
      .eq("status", "active")
      .select("*")
      .single();

    if (error || !data) { logger.warn({ err: error }, "markMissed: update failed"); return null; }
    await writeEvent(db, sessionId, userId, "check_in_missed");
    return mapSession(data);
  } catch (err) {
    logger.warn({ err }, "markMissed: threw");
    return null;
  }
}

/** Get the most recent active/pending session for a user. */
export async function getActiveSession(
  db: SupabaseClient,
  userId: string,
): Promise<SafeReturnSession | null> {
  try {
    const { data, error } = await db
      .from("safe_return_sessions")
      .select("*")
      .eq("user_id", userId)
      .in("status", ["pending", "active", "missed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return mapSession(data);
  } catch {
    return null;
  }
}

/** Get a single session by ID, scoped to the user. */
export async function getSessionById(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnSession | null> {
  try {
    const { data, error } = await db
      .from("safe_return_sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error || !data) return null;
    return mapSession(data);
  } catch {
    return null;
  }
}

/** List past sessions for a user (history), ordered newest-first. */
export async function listHistory(
  db: SupabaseClient,
  userId: string,
  limit = 20,
): Promise<SafeReturnSession[]> {
  try {
    const { data, error } = await db
      .from("safe_return_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return (data as any[]).map(mapSession);
  } catch {
    return [];
  }
}

/** List contacts for a session (scoped to session owner). */
export async function listContacts(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnContact[]> {
  try {
    const session = await getSessionById(db, sessionId, userId);
    if (!session) return [];

    const { data, error } = await db
      .from("safe_return_contacts")
      .select("*")
      .eq("session_id", sessionId);

    if (error || !data) return [];
    return (data as any[]).map(mapContact);
  } catch {
    return [];
  }
}

/**
 * Find all active sessions whose timer has expired.
 * Intended for the background scheduler only (service-role client).
 */
export async function findExpiredActiveSessions(
  db: SupabaseClient,
): Promise<SafeReturnSession[]> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("safe_return_sessions")
      .select("*")
      .eq("status", "active")
      .not("timer_end_at", "is", null)
      .lt("timer_end_at", now);

    if (error || !data) return [];
    return (data as any[]).map(mapSession);
  } catch {
    return [];
  }
}

/**
 * Unified session closer — delegates to confirmSafe or cancelSession.
 * Prefer calling confirmSafe / cancelSession directly when the intent is
 * unambiguous; use closeSession when the call site receives mode from user
 * input or a shared utility.
 */
export async function closeSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  mode: "safe" | "cancel" = "safe",
): Promise<SafeReturnSession | null> {
  return mode === "cancel"
    ? cancelSession(db, sessionId, userId)
    : confirmSafe(db, sessionId, userId);
}

/** Mark a contact as notified. */
export async function markContactNotified(
  db: SupabaseClient,
  contactId: string,
): Promise<void> {
  try {
    await db
      .from("safe_return_contacts")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", contactId)
      .is("notified_at", null);
  } catch (err) {
    logger.warn({ err }, "markContactNotified: threw");
  }
}
