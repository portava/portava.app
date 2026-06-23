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

export async function endSession(db: SupabaseClient, sessionId: string, userId: string): Promise<boolean> {
  try {
    const { error } = await db
      .from("location_sessions")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .is("ended_at", null);

    if (error) { logger.warn({ err: error }, "endSession failed"); return false; }
    return true;
  } catch {
    return false;
  }
}

export async function getActiveSessions(
  db: SupabaseClient,
  userId: string,
  sessionType?: SessionType,
): Promise<LocationSessionRecord[]> {
  try {
    let q = db
      .from("location_sessions")
      .select("id, user_id, session_type, started_at, expires_at, ended_at, city, district, country")
      .eq("user_id", userId)
      .is("ended_at", null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

    if (sessionType) q = (q as any).eq("session_type", sessionType);

    const { data, error } = await q;
    if (error || !data) return [];
    return (data as any[]).map(mapSession);
  } catch {
    return [];
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
