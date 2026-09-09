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
import { affectedRows } from "../../lib/affectedRows";

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

// ── Result shapes ─────────────────────────────────────────────────────────────

/**
 * A read that can fail.
 *
 * ── WHY EVERY READ IN THIS FILE RETURNS ONE ─────────────────────────────────
 * supabase-js RESOLVES on a database error. Every function below used to
 * collapse that into the same value it uses for "nothing there": `null` for a
 * session, `[]` for contacts and history. On this surface those empties are
 * load-bearing CLAIMS —
 *
 *   getActiveSession    → null  → "you have no Safe Return running"
 *   listContacts        → []    → "nobody is on your trusted circle"
 *   findExpiredActive…  → []    → "no check-in has been missed"
 *
 * — and each is reassuring, each was produced by a query that did not answer,
 * and the last one silently switches OFF the escalation job for as long as the
 * read keeps failing. `ok: false` is the third state those claims need.
 */
export type SafeReturnRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * A state transition that can fail, applied to a row that may not match.
 *
 * `no_match` and `unavailable` are deliberately separate. `.single()` answers
 * a zero-row UPDATE with PostgREST's PGRST116, and folding that into the same
 * `null` a connection failure produces is what let "Session not found or
 * already closed" be shown for a session that is alive and still counting down
 * toward alerting this person's contacts.
 */
export type SafeReturnMutation =
  | { outcome: "ok"; session: SafeReturnSession }
  /** The filter matched no row: wrong id, wrong owner, or wrong status. */
  | { outcome: "no_match" }
  /** The statement did not complete. The row's state is UNKNOWN. */
  | { outcome: "unavailable"; reason: string };

function describeError(error: unknown): string {
  return String((error as any)?.message ?? (error as any)?.code ?? "db_error");
}

/** PostgREST's "no (or multiple) rows returned" — a matched-nothing UPDATE. */
function isNoRowsError(error: unknown): boolean {
  return (error as any)?.code === "PGRST116";
}

/**
 * Classify the `{ data, error }` of a `…update(…).select("*").single()`.
 * One place, so no call site has to remember that PGRST116 is not an outage.
 */
function settleMutation(data: unknown, error: unknown, op: string): SafeReturnMutation {
  if (error) {
    if (isNoRowsError(error)) return { outcome: "no_match" };
    logger.error({ err: error, op }, `SafeReturnService: ${op} failed — session state UNKNOWN`);
    return { outcome: "unavailable", reason: describeError(error) };
  }
  if (!data) return { outcome: "no_match" };
  return { outcome: "ok", session: mapSession(data) };
}

// ── Event writer ──────────────────────────────────────────────────────────────

/**
 * Append to `safe_return_events`, the audit trail for a session.
 *
 * Non-fatal by contract — an audit write must not be able to fail a check-in or
 * a cancellation — but the result is RETURNED rather than swallowed, because
 * "the alert was sent" and "we have a record that the alert was sent" are
 * different facts and the caller is the only one that can say which one it is
 * reporting.
 */
async function writeEvent(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<{ ok: boolean; reason?: string }> {
  const { error } = await db.from("safe_return_events").insert({ session_id: sessionId, user_id: userId, event_type: eventType, metadata });
  if (error) {
    logger.error({ err: error, sessionId, eventType }, "SafeReturnService: event write failed — audit trail is incomplete");
    return { ok: false, reason: describeError(error) };
  }
  return { ok: true };
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * What a create actually achieved.
 *
 * ── WHY THE CONTACT COUNT IS PART OF THE RESULT ─────────────────────────────
 * The contacts ARE the safety mechanism. A session with a timer and no stored
 * contacts alerts nobody when the timer runs out; it only nags the person who
 * is already in trouble. The contact insert used to be `if (cErr) logger.warn(…
 * "non-fatal")` and the function returned the session regardless, so a user who
 * listed three people and got a 201 back had been told, in the only language
 * the API speaks, that those three would be alerted. Nothing anywhere would
 * have said otherwise until the night it mattered.
 *
 * So the numbers travel with the session and the route reports them. Creation
 * is NOT refused when contacts fail: the timer and the missed-check-in alert to
 * the user themselves are real and worth having, and deleting the session to
 * "clean up" risks leaving an un-startable orphan behind if that delete fails
 * too. What is refused is the SILENCE.
 */
export interface CreateSessionResult {
  session: SafeReturnSession;
  /** How many contacts the caller asked to store. */
  contactsRequested: number;
  /** How many are actually in `safe_return_contacts`. */
  contactsSaved: number;
  /** Set when the contact insert failed; the reason, for operator logs. */
  contactsError?: string;
  /** Set when the `session_created` audit row could not be written. */
  auditError?: string;
}

/**
 * Create a new Safe Return session (status = pending).
 * Optionally inserts contacts.  Returns the new session.
 */
export async function createSession(
  db: SupabaseClient,
  input: CreateSessionInput,
): Promise<CreateSessionResult | null> {
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
    const contactsRequested = input.contacts?.length ?? 0;
    let contactsSaved = 0;
    let contactsError: string | undefined;
    if (input.contacts && contactsRequested > 0) {
      const contactRows = input.contacts.map((c) => ({
        session_id:               session.id,
        contact_user_id:          c.contactUserId ?? null,
        contact_name:             c.contactName ?? null,
        contact_phone:            c.contactPhone ?? null,
        contact_email:            c.contactEmail ?? null,
        contact_method:           c.contactMethod,
        can_receive_live_location:c.canReceiveLiveLocation ?? false,
      }));
      // `.select("id")` so the count is the rows the database actually holds,
      // not the length of the array we hoped to write.
      const { data: cData, error: cErr } = await db
        .from("safe_return_contacts")
        .insert(contactRows)
        .select("id");
      if (cErr) {
        contactsError = describeError(cErr);
        logger.error(
          { err: cErr, sessionId: session.id, contactsRequested },
          "createSession: trusted contacts NOT stored — this session will alert nobody if the timer expires",
        );
      } else {
        contactsSaved = affectedRows(cData);
        if (contactsSaved < contactsRequested) {
          contactsError = `only ${contactsSaved} of ${contactsRequested} contacts were stored`;
          logger.error(
            { sessionId: session.id, contactsRequested, contactsSaved },
            "createSession: fewer trusted contacts stored than requested",
          );
        }
      }

      // The audit trail records what HAPPENED, not what was asked for.
      if (contactsError) {
        await writeEvent(db, session.id, input.userId, "contacts_not_stored", {
          contactsRequested,
          contactsSaved,
          reason: contactsError,
        });
      }
    }

    const audit = await writeEvent(db, session.id, input.userId, "session_created", {
      escalationLevel: session.escalationLevel,
      timerMinutes: input.timerMinutes ?? null,
      contactsRequested,
      contactsSaved,
    });

    return {
      session,
      contactsRequested,
      contactsSaved,
      ...(contactsError ? { contactsError } : {}),
      ...(audit.ok ? {} : { auditError: audit.reason }),
    };
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
): Promise<SafeReturnMutation> {
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

    const result = settleMutation(data, error, "startSession");
    if (result.outcome === "ok") await writeEvent(db, sessionId, userId, "session_started");
    return result;
  } catch (err) {
    logger.error({ err, sessionId }, "startSession: threw — session state UNKNOWN");
    return { outcome: "unavailable", reason: describeError(err) };
  }
}

/** Extend timer_end_at by `minutes`. */
export async function extendTimer(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  minutes: number,
): Promise<SafeReturnMutation> {
  try {
    // Fetch current timer_end_at first.
    //
    // `error` is bound and checked: an unreadable row used to arrive here as
    // `cur === null` and be reported to the user as "session not found or
    // cannot be extended". Someone standing outside at the end of their timer,
    // trying to buy another twenty minutes before their contacts are alerted,
    // must not be told their session does not exist when the truth is that the
    // database blinked and RETRYING WOULD HAVE WORKED.
    const { data: cur, error: curErr } = await db
      .from("safe_return_sessions")
      .select("timer_end_at, status")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();

    if (curErr) {
      logger.error({ err: curErr, sessionId }, "extendTimer: current-timer read failed");
      return { outcome: "unavailable", reason: describeError(curErr) };
    }
    if (!cur) return { outcome: "no_match" };
    if (cur.status !== "active" && cur.status !== "missed") return { outcome: "no_match" };

    const nowMs = Date.now();
    const base = cur.timer_end_at ? new Date(cur.timer_end_at) : new Date(nowMs);
    const newEnd = new Date(Math.max(base.getTime(), nowMs) + minutes * 60_000).toISOString();
    const now = new Date(nowMs).toISOString();

    const { data, error } = await db
      .from("safe_return_sessions")
      .update({ timer_end_at: newEnd, status: "active", updated_at: now })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .select("*")
      .single();

    const result = settleMutation(data, error, "extendTimer");
    if (result.outcome === "ok") await writeEvent(db, sessionId, userId, "timer_extended", { minutes, newEnd });
    return result;
  } catch (err) {
    logger.error({ err, sessionId }, "extendTimer: threw — timer NOT known to be extended");
    return { outcome: "unavailable", reason: describeError(err) };
  }
}

/** User confirms they are safe (status → safe). */
export async function confirmSafe(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnMutation> {
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

    const result = settleMutation(data, error, "confirmSafe");
    if (result.outcome !== "ok") return result;
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
    return result;
  } catch (err) {
    logger.error({ err, sessionId }, "confirmSafe: threw — session NOT known to be closed");
    return { outcome: "unavailable", reason: describeError(err) };
  }
}

/** User explicitly cancels before expiry (status → cancelled). */
export async function cancelSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnMutation> {
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

    const result = settleMutation(data, error, "cancelSession");
    if (result.outcome === "ok") await writeEvent(db, sessionId, userId, "session_cancelled");
    return result;
  } catch (err) {
    logger.error({ err, sessionId }, "cancelSession: threw — session may still be ACTIVE and counting down");
    return { outcome: "unavailable", reason: describeError(err) };
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
): Promise<SafeReturnMutation> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("safe_return_sessions")
      .update({ status: "missed", last_prompt_at: now, updated_at: now })
      .eq("id", sessionId)
      .eq("status", "active")
      .select("*")
      .single();

    const result = settleMutation(data, error, "markMissed");
    if (result.outcome === "ok") await writeEvent(db, sessionId, userId, "check_in_missed");
    return result;
  } catch (err) {
    logger.error({ err, sessionId }, "markMissed: threw — escalation NOT started");
    return { outcome: "unavailable", reason: describeError(err) };
  }
}

/**
 * Get the most recent active/pending session for a user.
 *
 * `ok: true, value: null` means "checked, nothing running". `ok: false` means
 * the question was not answered — which the /sessions/active endpoint used to
 * render as `{ session: null }`, i.e. "no Safe Return is running", to a person
 * whose session might well have been counting down.
 */
export async function getActiveSession(
  db: SupabaseClient,
  userId: string,
): Promise<SafeReturnRead<SafeReturnSession | null>> {
  try {
    const { data, error } = await db
      .from("safe_return_sessions")
      .select("*")
      .eq("user_id", userId)
      .in("status", ["pending", "active", "missed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error({ err: error, userId }, "getActiveSession: read failed");
      return { ok: false, reason: describeError(error) };
    }
    return { ok: true, value: data ? mapSession(data) : null };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  }
}

/** Get a single session by ID, scoped to the user. */
export async function getSessionById(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnRead<SafeReturnSession | null>> {
  try {
    const { data, error } = await db
      .from("safe_return_sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      logger.error({ err: error, sessionId }, "getSessionById: read failed");
      return { ok: false, reason: describeError(error) };
    }
    return { ok: true, value: data ? mapSession(data) : null };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  }
}

/** List past sessions for a user (history), ordered newest-first. */
export async function listHistory(
  db: SupabaseClient,
  userId: string,
  limit = 20,
): Promise<SafeReturnRead<SafeReturnSession[]>> {
  try {
    const { data, error } = await db
      .from("safe_return_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      logger.error({ err: error, userId }, "listHistory: read failed");
      return { ok: false, reason: describeError(error) };
    }
    if (!Array.isArray(data)) return { ok: false, reason: "safe_return_sessions read returned no rows array" };
    return { ok: true, value: (data as any[]).map(mapSession) };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  }
}

/**
 * List contacts for a session (scoped to session owner).
 *
 * THIS IS THE ONE THAT DECIDES WHO GETS ALERTED. The escalation path calls it
 * and hands the result to `notifyTrustedCircle`. An empty array means "this
 * person nominated nobody" and the escalation correctly notifies no one; when
 * an unreadable table produced that same empty array, the escalation ALSO
 * notified no one, wrote a `trusted_circle_notified` audit row saying zero
 * contacts, and answered the request `{ ok: true }`. Nobody — not the user, not
 * an operator — would have learned that three people who should have been told
 * were not.
 */
export async function listContacts(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<SafeReturnRead<SafeReturnContact[]>> {
  try {
    const session = await getSessionById(db, sessionId, userId);
    if (!session.ok) return { ok: false, reason: session.reason };
    if (!session.value) return { ok: true, value: [] };

    const { data, error } = await db
      .from("safe_return_contacts")
      .select("*")
      .eq("session_id", sessionId);

    if (error) {
      logger.error({ err: error, sessionId }, "listContacts: read failed — cannot say who should be alerted");
      return { ok: false, reason: describeError(error) };
    }
    if (!Array.isArray(data)) return { ok: false, reason: "safe_return_contacts read returned no rows array" };
    return { ok: true, value: (data as any[]).map(mapContact) };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
  }
}

/**
 * Find all active sessions whose timer has expired.
 * Intended for the background scheduler only (service-role client).
 */
export async function findExpiredActiveSessions(
  db: SupabaseClient,
): Promise<SafeReturnRead<SafeReturnSession[]>> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("safe_return_sessions")
      .select("*")
      .eq("status", "active")
      .not("timer_end_at", "is", null)
      .lt("timer_end_at", now);

    if (error) {
      // The scheduler's `expired.length === 0 → return` was the entire
      // escalation system's off switch: while this read kept failing, every
      // missed check-in in the system was silently skipped and the job logged
      // nothing, because "no sessions have expired" is what a healthy minute
      // looks like too.
      logger.error({ err: error }, "findExpiredActiveSessions: read failed — missed check-ins are NOT being escalated");
      return { ok: false, reason: describeError(error) };
    }
    if (!Array.isArray(data)) return { ok: false, reason: "safe_return_sessions read returned no rows array" };
    return { ok: true, value: (data as any[]).map(mapSession) };
  } catch (err) {
    return { ok: false, reason: describeError(err) };
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
): Promise<SafeReturnMutation> {
  return mode === "cancel"
    ? cancelSession(db, sessionId, userId)
    : confirmSafe(db, sessionId, userId);
}

/**
 * Mark a contact as notified.
 *
 * ── ZERO ROWS IS FINE HERE; A SWALLOWED ERROR IS NOT ────────────────────────
 * The filter carries `.is("notified_at", null)`, so a zero-row update means the
 * stamp is already there — this is idempotent and re-running the escalation
 * must not clear or duplicate it. That is a legitimate zero.
 *
 * The defect was the other half: `await db.from(…).update(…)` bound NOTHING, so
 * the resolved `{ error }` was dropped on the floor and the `catch` could never
 * see it (supabase-js resolves rather than throws). `notified_at` is the column
 * an operator reads to answer "was this person's emergency contact actually
 * told?", so a failure to stamp it silently corrupts that answer in the
 * reassuring direction.
 */
export async function markContactNotified(
  db: SupabaseClient,
  contactId: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { error } = await db
      .from("safe_return_contacts")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", contactId)
      .is("notified_at", null);
    if (error) {
      logger.error({ err: error, contactId }, "markContactNotified: update failed — notified_at may misreport this contact");
      return { ok: false, reason: describeError(error) };
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err, contactId }, "markContactNotified: threw");
    return { ok: false, reason: describeError(err) };
  }
}
