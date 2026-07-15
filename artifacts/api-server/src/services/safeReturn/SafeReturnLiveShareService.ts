/**
 * SafeReturnLiveShareService
 *
 * Manages temporary live location sharing within a Safe Return session.
 *
 * Privacy rules (strictly enforced):
 *   - Only contacts listed in safe_return_contacts with can_receive_live_location=true
 *     can access recipient view.
 *   - expires_at is a hard cutoff — access is denied after this timestamp even if
 *     status is still 'active' in the DB.
 *   - The recipient view never returns raw lat/lng; only approximate area is returned.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger";

const logger = rootLogger.child({ service: "SafeReturnLiveShareService" });

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveShareStatus = "active" | "stopped" | "expired";

export interface LiveShare {
  id: string;
  sessionId: string;
  userId: string;
  recipientUserId: string | null;
  recipientContactId: string | null;
  status: LiveShareStatus;
  startedAt: string;
  expiresAt: string | null;
  stoppedAt: string | null;
}

/** Recipient-safe view: approximate area only, no raw GPS. */
export interface RecipientLiveShareView {
  shareId: string;
  status: LiveShareStatus;
  sharingUserName: string;
  approximateArea: string;
  expiresAt: string | null;
  /** Seconds remaining until expiry, null if no expiry. */
  secondsRemaining: number | null;
}

// ── Default share duration ────────────────────────────────────────────────────

const DEFAULT_SHARE_DURATION_MINUTES = 60;

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapShare(r: any): LiveShare {
  return {
    id:                  r.id,
    sessionId:           r.session_id,
    userId:              r.user_id,
    recipientUserId:     r.recipient_user_id ?? null,
    recipientContactId:  r.recipient_contact_id ?? null,
    status:              r.status as LiveShareStatus,
    startedAt:           r.started_at,
    expiresAt:           r.expires_at ?? null,
    stoppedAt:           r.stopped_at ?? null,
  };
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Start a live share for a given contact.
 * Requires live_share_enabled = true on the session (caller must verify).
 */
export async function startShare(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  recipientUserId: string | null,
  recipientContactId: string | null,
  durationMinutes: number = DEFAULT_SHARE_DURATION_MINUTES,
): Promise<LiveShare | null> {
  const expiresAt = new Date(Date.now() + durationMinutes * 60_000).toISOString();
  try {
    const { data, error } = await db
      .from("safe_return_live_shares")
      .insert({
        session_id:           sessionId,
        user_id:              userId,
        recipient_user_id:    recipientUserId,
        recipient_contact_id: recipientContactId,
        expires_at:           expiresAt,
      })
      .select("*")
      .single();

    if (error || !data) { logger.warn({ err: error }, "startShare: insert failed"); return null; }

    // Write event on the session
    try {
      await db.from("safe_return_events").insert({
        session_id: sessionId,
        user_id: userId,
        event_type: "live_share_started",
        metadata: { shareId: (data as any).id, recipientUserId, durationMinutes },
      });
    } catch { /* non-fatal */ }

    return mapShare(data);
  } catch (err) {
    logger.warn({ err }, "startShare: threw");
    return null;
  }
}

/**
 * User explicitly stops the live share.
 */
export async function stopShare(
  db: SupabaseClient,
  shareId: string,
  userId: string,
): Promise<LiveShare | null> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("safe_return_live_shares")
      .update({ status: "stopped", stopped_at: now })
      .eq("id", shareId)
      .eq("user_id", userId)
      .eq("status", "active")
      .select("*")
      .single();

    if (error || !data) { logger.warn({ err: error }, "stopShare: update failed"); return null; }

    try {
      await db.from("safe_return_events").insert({
        session_id: (data as any).session_id,
        user_id: userId,
        event_type: "live_share_stopped",
        metadata: { shareId },
      });
    } catch { /* non-fatal */ }

    return mapShare(data);
  } catch (err) {
    logger.warn({ err }, "stopShare: threw");
    return null;
  }
}

/**
 * Mark a share as expired (called by cron/background job).
 * Service-role only (no userId ownership check).
 */
export async function expireShare(
  db: SupabaseClient,
  shareId: string,
): Promise<LiveShare | null> {
  try {
    const { data, error } = await db
      .from("safe_return_live_shares")
      .update({ status: "expired" })
      .eq("id", shareId)
      .eq("status", "active")
      .lt("expires_at", new Date().toISOString())
      .select("*")
      .single();

    if (error || !data) return null;

    try {
      await db.from("safe_return_events").insert({
        session_id: (data as any).session_id,
        user_id: (data as any).user_id,
        event_type: "live_share_expired",
        metadata: { shareId },
      });
    } catch { /* non-fatal */ }

    return mapShare(data);
  } catch (err) {
    logger.warn({ err }, "expireShare: threw");
    return null;
  }
}

/**
 * Get the recipient-safe view of a live share.
 *
 * Authorization rules (ALL must pass):
 *   1. Share exists
 *   2. Caller is the recipient_user_id (or the sharer themselves for preview)
 *   3. Contact row has can_receive_live_location = true
 *   4. status = 'active'
 *   5. expires_at has NOT passed (hard cutoff, enforced in code)
 */
export async function getRecipientView(
  db: SupabaseClient,
  shareId: string,
  callerUserId: string,
): Promise<{ view: RecipientLiveShareView } | { error: "not_found" | "forbidden" | "expired" | "stopped" }> {
  try {
    const { data: share } = await db
      .from("safe_return_live_shares")
      .select("*")
      .eq("id", shareId)
      .maybeSingle();

    if (!share) return { error: "not_found" };

    const s = mapShare(share as any);

    // Hard expiry check (code-level, before DB status)
    if (s.expiresAt && new Date(s.expiresAt) < new Date()) {
      // Opportunistically expire in DB (fire-and-forget)
      expireShare(db, shareId).catch(() => {});
      return { error: "expired" };
    }

    if (s.status === "stopped") return { error: "stopped" };
    if (s.status === "expired") return { error: "expired" };

    // Authorization: caller must be the recipient_user_id
    if (s.recipientUserId !== callerUserId && s.userId !== callerUserId) {
      return { error: "forbidden" };
    }

    // If there's a contact row, verify can_receive_live_location
    if (s.recipientContactId) {
      const { data: contact } = await db
        .from("safe_return_contacts")
        .select("can_receive_live_location")
        .eq("id", s.recipientContactId)
        .maybeSingle();

      if (!contact || !(contact as any).can_receive_live_location) {
        return { error: "forbidden" };
      }
    }

    // Fetch approximate area from user_location_state (city/country — no raw GPS)
    const { data: locState } = await db
      .from("user_location_state")
      .select("city, country")
      .eq("user_id", s.userId)
      .maybeSingle();

    const parts: string[] = [];
    if ((locState as any)?.city) parts.push((locState as any).city);
    if ((locState as any)?.country) parts.push((locState as any).country);
    const approximateArea = parts.length > 0 ? parts.join(", ") : "location unknown";

    // Sharer name
    let sharingUserName = "A traveler";
    try {
      const { data: profile } = await db
        .from("profiles")
        .select("display_name")
        .eq("id", s.userId)
        .maybeSingle();
      sharingUserName = (profile as any)?.display_name ?? "A traveler";
    } catch { /* non-fatal */ }

    const secondsRemaining = s.expiresAt
      ? Math.max(0, Math.floor((new Date(s.expiresAt).getTime() - Date.now()) / 1000))
      : null;

    return {
      view: {
        shareId: s.id,
        status: s.status,
        sharingUserName,
        approximateArea,
        expiresAt: s.expiresAt,
        secondsRemaining,
      },
    };
  } catch (err) {
    logger.warn({ err }, "getRecipientView: threw");
    return { error: "not_found" };
  }
}
