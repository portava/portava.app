/**
 * TripCrewLiveShareService
 *
 * Manages timed live-share sessions within a trip crew.
 * Visibility levels are capped at "nearby" — exact coordinates are never shared.
 * Writes audit events to trip_crew_location_events for every state transition.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "TripCrewLiveShareService" });

// ── Duration helpers ──────────────────────────────────────────────────────────

export type ShareDuration = "15m" | "30m" | "1h" | "plan_end";

function expiresAtFromDuration(
  duration: ShareDuration,
  planEndAt?: string | null,
): string {
  const now = Date.now();
  if (duration === "15m") return new Date(now + 15 * 60_000).toISOString();
  if (duration === "30m") return new Date(now + 30 * 60_000).toISOString();
  if (duration === "1h")  return new Date(now + 60 * 60_000).toISOString();
  // plan_end: use plan item end time, or fall back to 1 hour
  if (duration === "plan_end" && planEndAt) {
    const end = new Date(planEndAt).getTime();
    if (end > now) return new Date(end).toISOString();
  }
  return new Date(now + 60 * 60_000).toISOString();
}

// ── Audit helper ──────────────────────────────────────────────────────────────

async function logEvent(
  db: SupabaseClient,
  tripId: string,
  userId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // best-effort
  const { error } = await db.from("trip_crew_location_events").insert({
    trip_id: tripId,
    user_id: userId,
    event_type: eventType,
    metadata,
  });
  if (error) logger.warn({ err: error, tripId, eventType }, "trip crew event write failed (non-fatal)");
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface StartShareInput {
  tripId: string;
  userId: string;
  duration: ShareDuration;
  visibilityLevel?: "city_only" | "neighborhood" | "nearby";
  allowedMemberIds: string[];
  planEndAt?: string | null;
}

export interface StartShareResult {
  ok: boolean;
  sessionId?: string;
  expiresAt?: string;
  error?: string;
}

/**
 * Start a timed live share session. Any existing active session for this
 * user+trip is stopped first (only one active session per user per trip).
 */
export async function startLiveShare(
  db: SupabaseClient,
  input: StartShareInput,
): Promise<StartShareResult> {
  const { tripId, userId, duration, allowedMemberIds, planEndAt } = input;
  const visibilityLevel = input.visibilityLevel ?? "neighborhood";
  const expiresAt = expiresAtFromDuration(duration, planEndAt);

  // Stop any existing active session
  await db
    .from("trip_crew_location_sessions")
    .update({ status: "stopped", stopped_at: new Date().toISOString() })
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .eq("status", "active");

  const { data, error } = await db
    .from("trip_crew_location_sessions")
    .insert({
      trip_id: tripId,
      user_id: userId,
      visibility_level: visibilityLevel,
      status: "active",
      allowed_member_ids: allowedMemberIds,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error) {
    logger.error({ err: error, tripId, userId }, "startLiveShare: insert failed");
    return { ok: false, error: error.message };
  }

  const sessionId = (data as any)?.id as string;
  await logEvent(db, tripId, userId, "live_share_started", {
    sessionId,
    duration,
    visibilityLevel,
    allowedCount: allowedMemberIds.length,
  });

  return { ok: true, sessionId, expiresAt };
}

/**
 * Stop the caller's active live share session for a trip.
 */
export async function stopLiveShare(
  db: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db
    .from("trip_crew_location_sessions")
    .update({ status: "stopped", stopped_at: new Date().toISOString() })
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .eq("status", "active");

  if (error) {
    logger.error({ err: error, tripId, userId }, "stopLiveShare: update failed");
    return { ok: false, error: error.message };
  }

  await logEvent(db, tripId, userId, "live_share_stopped");
  return { ok: true };
}

/**
 * Get active live shares visible to the viewer in a trip.
 * Only returns sessions where viewerId is in allowed_member_ids.
 */
export async function getActiveLiveShares(
  db: SupabaseClient,
  tripId: string,
  viewerId: string,
): Promise<Array<{
  sessionId: string;
  userId: string;
  visibilityLevel: string;
  expiresAt: string;
  startedAt: string;
}>> {
  const now = new Date().toISOString();
  const { data } = await db
    .from("trip_crew_location_sessions")
    .select("id, user_id, visibility_level, expires_at, started_at, allowed_member_ids")
    .eq("trip_id", tripId)
    .eq("status", "active")
    .gt("expires_at", now);

  return ((data as any[]) ?? [])
    .filter((row) => (row.allowed_member_ids ?? []).includes(viewerId))
    .map((row) => ({
      sessionId: row.id,
      userId: row.user_id,
      visibilityLevel: row.visibility_level,
      expiresAt: row.expires_at,
      startedAt: row.started_at,
    }));
}

/**
 * Revoke access for a specific member from all active live shares in a trip.
 * Called when a member is removed from the trip.
 */
export async function revokeAccessForMember(
  db: SupabaseClient,
  tripId: string,
  removedUserId: string,
): Promise<void> {
  // Fetch active sessions for the trip.
  //
  // This read's error was unchecked, and it is the defect: supabase-js RESOLVES
  // on a database error rather than throwing, so `data` is null both when the
  // trip has no active live shares and when the table could not be read. The
  // loop below then iterates nothing, the function falls through to logging
  // "access_revoked", and the removed member KEEPS LIVE LOCATION ACCESS with an
  // audit trail asserting it was taken away. Of the fail-open reads in this
  // service that is the one with a physical consequence.
  const { data, error: readError } = await db
    .from("trip_crew_location_sessions")
    .select("id, allowed_member_ids")
    .eq("trip_id", tripId)
    .eq("status", "active");

  if (readError) {
    // The audit trail must record the ATTEMPT and its failure. Staying silent
    // here is what made the original defect invisible: the member is already
    // gone from trip_members, so without this row nothing anywhere says their
    // live-share access may still stand.
    await logEvent(db, tripId, removedUserId, "access_revoke_failed", {
      reason: "member_removed",
      stage: "read_sessions",
      detail: readError.message,
    });
    logger.error({ err: readError, tripId, removedUserId }, "revokeAccessForMember: could not read active sessions; access may still stand");
    throw new Error(
      `revokeAccessForMember: could not read active live-share sessions for trip ${tripId}: ${readError.message}`,
    );
  }

  const failedSessionIds: string[] = [];
  for (const row of (data as any[]) ?? []) {
    const current: string[] = row.allowed_member_ids ?? [];
    if (current.includes(removedUserId)) {
      const updated = current.filter((id: string) => id !== removedUserId);
      // Same reasoning on the write: an unchecked error here is a revocation
      // that silently did not happen.
      const { error: updateError } = await db
        .from("trip_crew_location_sessions")
        .update({ allowed_member_ids: updated })
        .eq("id", row.id);
      if (updateError) {
        failedSessionIds.push(row.id as string);
        logger.error({ err: updateError, tripId, removedUserId, sessionId: row.id }, "revokeAccessForMember: session update failed");
      }
    }
  }

  if (failedSessionIds.length > 0) {
    await logEvent(db, tripId, removedUserId, "access_revoke_failed", {
      reason: "member_removed",
      stage: "update_sessions",
      failedSessionIds,
    });
    throw new Error(
      `revokeAccessForMember: ${failedSessionIds.length} live-share session(s) still grant access to ${removedUserId} on trip ${tripId}`,
    );
  }

  // Only now, and only because every session that named them was actually
  // rewritten. "access_revoked" is an assertion about the world, not a note
  // that the function ran.
  await logEvent(db, tripId, removedUserId, "access_revoked", { reason: "member_removed" });
}

// ── Background expiry sweep ───────────────────────────────────────────────────

/**
 * Mark all expired active sessions as 'expired' and write audit events.
 * Called by the background cleanup job every 5 minutes.
 */
export async function sweepExpiredLiveShares(db: SupabaseClient): Promise<number> {
  const now = new Date().toISOString();

  const { data, error } = await db
    .from("trip_crew_location_sessions")
    .update({ status: "expired", stopped_at: now })
    .eq("status", "active")
    .lt("expires_at", now)
    .select("id, trip_id, user_id");

  if (error) {
    logger.error({ err: error }, "sweepExpiredLiveShares: update failed");
    return 0;
  }

  const expired = (data as any[]) ?? [];
  for (const row of expired) {
    await logEvent(db, row.trip_id, row.user_id, "live_share_expired", { sessionId: row.id });
  }

  return expired.length;
}
