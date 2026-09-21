/**
 * LocationSessionService
 *
 * Start, end, and expire location-share sessions.
 * Used by Safe Return and trusted-circle live share (Phase 4 seam).
 *
 * PRIVACY: exact coords are written to location_sessions (server-side only)
 * and are NEVER returned in any public API response.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger";
import { affectedRows } from "../../lib/affectedRows";

const logger = rootLogger.child({ service: "LocationSessionService" });

export type SessionType = "private_stay" | "safe_return" | "trusted_circle" | "plan_checkin";

export type SessionTimer = "15min" | "30min" | "1hr" | "until_plan_ends" | "manual";

export interface StartSessionInput {
  userId: string;
  sessionType: SessionType;
  timer: SessionTimer;
  city?: string | null;
  district?: string | null;
  country?: string | null;
  countryCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  relatedTripId?: string | null;
  relatedPlanId?: string | null;
}

export interface LocationSessionRecord {
  id: string;
  userId: string;
  sessionType: SessionType;
  startedAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  city: string | null;
  district: string | null;
  country: string | null;
  // coords intentionally omitted from public shape
}

const TIMER_DURATIONS: Record<SessionTimer, number | null> = {
  "15min":           15 * 60 * 1000,
  "30min":           30 * 60 * 1000,
  "1hr":             60 * 60 * 1000,
  "until_plan_ends": null,  // set by caller via relatedPlanId
  "manual":          null,  // no auto-expiry
};

export async function startSession(
  db: SupabaseClient,
  input: StartSessionInput,
): Promise<LocationSessionRecord | null> {
  const durationMs = TIMER_DURATIONS[input.timer];
  const expiresAt = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;

  try {
    const { data, error } = await db
      .from("location_sessions")
      .insert({
        user_id:        input.userId,
        session_type:   input.sessionType,
        expires_at:     expiresAt,
        city:           input.city ?? null,
        district:       input.district ?? null,
        country:        input.country ?? null,
        country_code:   input.countryCode ?? null,
        lat:            input.lat ?? null,
        lng:            input.lng ?? null,
        related_trip_id:input.relatedTripId ?? null,
        related_plan_id:input.relatedPlanId ?? null,
      })
      .select("id, user_id, session_type, started_at, expires_at, ended_at, city, district, country")
      .single();

    if (error) { logger.warn({ err: error }, "startSession failed"); return null; }
    return mapSession(data);
  } catch (err) {
    logger.warn({ err }, "startSession threw");
    return null;
  }
}

/**
 * The outcome of trying to end a location share.
 *
 * ── WHY THIS IS NOT A BOOLEAN ───────────────────────────────────────────────
 * This is a REVOCATION: `ended_at` is what stops `getActiveSessions` — and
 * GeoZoneService's private-stay lookup — from treating the row as live. The old
 * body returned `true` whenever `error` was null, and an UPDATE without
 * `.select()` resolves `{ data: null, error: null }` whether it matched one row
 * or none. So "your location sharing has been turned off" was reported for an
 * update that changed nothing, and the session kept serving. A revocation that
 * failed must never display as revoked.
 *
 * Zero rows here is genuinely AMBIGUOUS, because the filter carries
 * `.is("ended_at", null)`: it means either "already ended" (idempotent, and the
 * user's intent is satisfied — the share is off) or "no such session for this
 * user" (the revocation did NOT happen to anything). Those need different
 * answers, so a zero-row update is followed by one narrow read that decides
 * which — and if THAT read fails, the outcome is `unavailable`, never `ended`.
 */
export type EndSessionOutcome =
  | { outcome: "ended"; endedAt: string }
  /** The row was already closed. The share is off; nothing needed doing. */
  | { outcome: "already_ended" }
  /** No session with this id belongs to this user. Nothing was revoked. */
  | { outcome: "not_found" }
  /** The write or the disambiguating read failed. State is UNKNOWN — not off. */
  | { outcome: "unavailable"; reason: string };

export async function endSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<EndSessionOutcome> {
  const endedAt = new Date().toISOString();
  try {
    // `.select("id")` is load-bearing: without a RETURNING clause PostgREST
    // answers a zero-row UPDATE with 204, exactly as it answers a successful
    // one, and this function cannot tell them apart.
    const { data, error } = await db
      .from("location_sessions")
      .update({ ended_at: endedAt })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .is("ended_at", null)
      .select("id");

    if (error) {
      const reason = String((error as any)?.message ?? (error as any)?.code ?? "db_error");
      logger.error({ err: error, sessionId, userId }, "endSession: update failed — session NOT ended");
      return { outcome: "unavailable", reason };
    }

    if (affectedRows(data) > 0) return { outcome: "ended", endedAt };

    // Zero rows. Decide WHICH zero this is rather than assuming the kind one.
    const { data: existing, error: readErr } = await db
      .from("location_sessions")
      .select("id, ended_at")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();

    if (readErr) {
      const reason = String((readErr as any)?.message ?? (readErr as any)?.code ?? "db_error");
      logger.error(
        { err: readErr, sessionId, userId },
        "endSession: update matched no rows and the disambiguating read failed — session state UNKNOWN",
      );
      return { outcome: "unavailable", reason };
    }

    if (!existing) {
      logger.warn({ sessionId, userId }, "endSession: no such session for this user — nothing revoked");
      return { outcome: "not_found" };
    }
    return { outcome: "already_ended" };
  } catch (err) {
    const reason = String((err as any)?.message ?? err);
    logger.error({ err, sessionId, userId }, "endSession threw — session NOT known to be ended");
    return { outcome: "unavailable", reason };
  }
}

/**
 * The live shares a user currently has open.
 *
 * ── EMPTY IS AN ANSWER; UNREADABLE IS NOT ───────────────────────────────────
 * "You are not sharing your location with anyone" is a reassuring statement,
 * and the old body produced it from a failed read: supabase-js RESOLVES on a
 * database error, so `if (error || !data) return []` handed back the same empty
 * array for "no live sessions" and for "location_sessions could not be read".
 * A person checking whether they are still broadcasting would have been told
 * no, while the rows — and the sharing — were still there.
 */
export type ActiveSessionsResult =
  | { ok: true; sessions: LocationSessionRecord[] }
  | { ok: false; reason: string };

export async function getActiveSessions(
  db: SupabaseClient,
  userId: string,
  sessionType?: SessionType,
): Promise<ActiveSessionsResult> {
  try {
    let q = db
      .from("location_sessions")
      .select("id, user_id, session_type, started_at, expires_at, ended_at, city, district, country")
      .eq("user_id", userId)
      .is("ended_at", null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

    if (sessionType) q = (q as any).eq("session_type", sessionType);

    const { data, error } = await q;
    if (error) {
      const reason = String((error as any)?.message ?? (error as any)?.code ?? "db_error");
      logger.error({ err: error, userId }, "getActiveSessions: read failed — cannot say whether sharing is active");
      return { ok: false, reason };
    }
    if (!Array.isArray(data)) {
      return { ok: false, reason: "location_sessions read returned no rows array" };
    }
    return { ok: true, sessions: (data as any[]).map(mapSession) };
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message ?? err) };
  }
}

function mapSession(r: any): LocationSessionRecord {
  return {
    id:          r.id,
    userId:      r.user_id,
    sessionType: r.session_type as SessionType,
    startedAt:   r.started_at,
    expiresAt:   r.expires_at ?? null,
    endedAt:     r.ended_at ?? null,
    city:        r.city ?? null,
    district:    r.district ?? null,
    country:     r.country ?? null,
  };
}
