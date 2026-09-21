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

/**
 * Whether `approximateArea` is a fact or a placeholder.
 *
 * ── WHY THE STRING WAS NOT ENOUGH ───────────────────────────────────────────
 * `approximateArea` fell back to the literal "location unknown" for BOTH "this
 * person has no stored location state" and "user_location_state could not be
 * read". A contact watching a live share because someone did not come home
 * reads "location unknown" as a fact about the person. It was, half the time, a
 * fact about the database — and the same screen would have shown a real area
 * one retry later. The string stays (a recipient must still see something
 * honest); this field says which of the two it is, so the client can offer a
 * retry instead of presenting an outage as a person who cannot be located.
 */
export type AreaStatus = "known" | "none_recorded" | "unavailable";

/** Recipient-safe view: approximate area only, no raw GPS. */
export interface RecipientLiveShareView {
  shareId: string;
  status: LiveShareStatus;
  sharingUserName: string;
  approximateArea: string;
  areaStatus: AreaStatus;
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

    // Write event on the session (non-fatal)
    {
      const { error: evtError } = await db.from("safe_return_events").insert({
        session_id: sessionId,
        user_id: userId,
        event_type: "live_share_started",
        metadata: { shareId: (data as any).id, recipientUserId, durationMinutes },
      });
      if (evtError) logger.warn({ err: evtError, sessionId }, "live_share_started event write failed (non-fatal)");
    }

    return mapShare(data);
  } catch (err) {
    logger.warn({ err }, "startShare: threw");
    return null;
  }
}

/**
 * ── census L294/C2 — WHY THESE TWO MUTATIONS ANSWER AN OUTCOME ──────────────
 *
 * Both `stopShare` and `expireShare` answered `LiveShare | null`, computed as
 * `if (error || !data) return null` — the identical shape §19.2 removed from
 * every writer in `LayoverSessionService`, surviving one directory over because
 * nobody had swept for the SHAPE rather than for the `catch` keyword. The §20
 * sweep found it.
 *
 * The three cases that `null` collapsed are not interchangeable:
 *
 *   no_match     PostgREST answers a zero-row `.single()` UPDATE with
 *                `PGRST116`, which arrives as an `error`. For `expireShare`
 *                this is the overwhelmingly common case — the scheduler calls
 *                it for rows that are usually already closed — so treating it
 *                as a fault would bury the one that is not.
 *   unavailable  THE STATEMENT DID NOT COMPLETE. For `expireShare` that is a
 *                person's LOCATION STILL BEING SHARED past the moment they
 *                agreed to; for `stopShare` it is a person told their sharing
 *                is off when the write that would have stopped it failed. Both
 *                fail OPEN, which is the one direction a privacy window may
 *                never fail silently.
 *   ok           the row moved.
 *
 * `SafeReturnService.settleMutation` already draws exactly this distinction, in
 * the same product, for the same PostgREST behaviour; these two predate it.
 *
 * The `stopShare` / `expireShare` names keep their old `LiveShare | null`
 * signatures because `lib/safeReturnScheduler.ts` and the Safe Return routes
 * bind them and are not this lane's files. They are one-line projections of the
 * settled forms, and the projection is LOSSY ON PURPOSE — see the cross-lane
 * note in census-layover §20.
 */
export type LiveShareMutation =
  | { outcome: "ok"; share: LiveShare }
  /** The filter matched no row: wrong id, wrong owner, or already closed. */
  | { outcome: "no_match" }
  /** The statement did not complete. The share's state is UNKNOWN. */
  | { outcome: "unavailable"; reason: string };

/** PostgREST's "no (or multiple) rows returned" — a matched-nothing UPDATE. */
function isNoRowsError(error: unknown): boolean {
  return (error as any)?.code === "PGRST116";
}

function describeShareError(error: unknown): string {
  return String((error as any)?.message ?? (error as any)?.code ?? "db_error");
}

/**
 * User explicitly stops the live share.
 */
export async function stopShareSettled(
  db: SupabaseClient,
  shareId: string,
  userId: string,
): Promise<LiveShareMutation> {
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

    if (error && !isNoRowsError(error)) {
      logger.error(
        { err: error, shareId, userId },
        "stopShare: the update did not complete — this person's location may still be shared",
      );
      return { outcome: "unavailable", reason: describeShareError(error) };
    }
    if (error || !data) return { outcome: "no_match" };

    {
      const { error: evtError } = await db.from("safe_return_events").insert({
        session_id: (data as any).session_id,
        user_id: userId,
        event_type: "live_share_stopped",
        metadata: { shareId },
      });
      if (evtError) logger.warn({ err: evtError, shareId }, "live_share_stopped event write failed (non-fatal)");
    }

    return { outcome: "ok", share: mapShare(data) };
  } catch (err) {
    logger.error({ err, shareId }, "stopShare: threw — this person's location may still be shared");
    return { outcome: "unavailable", reason: describeShareError(err) };
  }
}

/**
 * Mark a share as expired (called by cron/background job).
 * Service-role only (no userId ownership check).
 */
export async function expireShareSettled(
  db: SupabaseClient,
  shareId: string,
): Promise<LiveShareMutation> {
  try {
    const { data, error } = await db
      .from("safe_return_live_shares")
      .update({ status: "expired" })
      .eq("id", shareId)
      .eq("status", "active")
      .lt("expires_at", new Date().toISOString())
      .select("*")
      .single();

    if (error && !isNoRowsError(error)) {
      logger.error(
        { err: error, shareId },
        "expireShare: the expiry update did not complete — a live share is past its cutoff and still active",
      );
      return { outcome: "unavailable", reason: describeShareError(error) };
    }
    if (error || !data) return { outcome: "no_match" };

    {
      const { error: evtError } = await db.from("safe_return_events").insert({
        session_id: (data as any).session_id,
        user_id: (data as any).user_id,
        event_type: "live_share_expired",
        metadata: { shareId },
      });
      if (evtError) logger.warn({ err: evtError, shareId }, "live_share_expired event write failed (non-fatal)");
    }

    return { outcome: "ok", share: mapShare(data) };
  } catch (err) {
    logger.error({ err, shareId }, "expireShare: threw — a live share may be past its cutoff and still active");
    return { outcome: "unavailable", reason: describeShareError(err) };
  }
}

/** COMPATIBILITY PROJECTION — `stopShareSettled` is the honest one. */
export async function stopShare(
  db: SupabaseClient,
  shareId: string,
  userId: string,
): Promise<LiveShare | null> {
  const r = await stopShareSettled(db, shareId, userId);
  return r.outcome === "ok" ? r.share : null;
}

/** COMPATIBILITY PROJECTION — `expireShareSettled` is the honest one. */
export async function expireShare(
  db: SupabaseClient,
  shareId: string,
): Promise<LiveShare | null> {
  const r = await expireShareSettled(db, shareId);
  return r.outcome === "ok" ? r.share : null;
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
): Promise<
  | { view: RecipientLiveShareView }
  | { error: "not_found" | "forbidden" | "expired" | "stopped" | "unavailable" }
> {
  try {
    const nowMs = Date.now();
    // `error` bound. `const { data: share } = …; if (!share) return not_found`
    // told a contact that a live share they were sent DOES NOT EXIST whenever
    // the table could not be read — the most reassuring possible reading of an
    // outage on the one screen someone opens when they are worried.
    const { data: share, error: shareErr } = await db
      .from("safe_return_live_shares")
      .select("*")
      .eq("id", shareId)
      .maybeSingle();

    if (shareErr) {
      logger.error({ err: shareErr, shareId }, "getRecipientView: share read failed");
      return { error: "unavailable" };
    }
    if (!share) return { error: "not_found" };

    const s = mapShare(share as any);

    // Hard expiry check (code-level, before DB status)
    if (s.expiresAt && new Date(s.expiresAt) < new Date(nowMs)) {
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
      const { data: contact, error: contactErr } = await db
        .from("safe_return_contacts")
        .select("can_receive_live_location")
        .eq("id", s.recipientContactId)
        .maybeSingle();

      // FAIL CLOSED either way — an unreadable consent row is never a grant.
      // But `unavailable` rather than `forbidden`: telling a legitimate
      // recipient they are not authorised is a false accusation that makes them
      // stop trying, where "temporarily unavailable" makes them retry. Neither
      // discloses anything.
      if (contactErr) {
        logger.error({ err: contactErr, shareId }, "getRecipientView: contact permission read failed — refusing");
        return { error: "unavailable" };
      }
      if (!contact || !(contact as any).can_receive_live_location) {
        return { error: "forbidden" };
      }
    }

    // Fetch approximate area from user_location_state (city/country — no raw GPS)
    const { data: locState, error: locErr } = await db
      .from("user_location_state")
      .select("city, country")
      .eq("user_id", s.userId)
      .maybeSingle();

    let approximateArea: string;
    let areaStatus: AreaStatus;
    if (locErr) {
      logger.error({ err: locErr, shareId, userId: s.userId }, "getRecipientView: location state unreadable");
      approximateArea = "location temporarily unavailable";
      areaStatus = "unavailable";
    } else {
      const parts: string[] = [];
      if ((locState as any)?.city) parts.push((locState as any).city);
      if ((locState as any)?.country) parts.push((locState as any).country);
      if (parts.length > 0) {
        approximateArea = parts.join(", ");
        areaStatus = "known";
      } else {
        approximateArea = "location unknown";
        areaStatus = "none_recorded";
      }
    }

    // Sharer name
    let sharingUserName = "A traveler";
    try {
      const { data: profile, error: profErr } = await db
        .from("profiles")
        .select("display_name")
        .eq("id", s.userId)
        .maybeSingle();
      if (profErr) logger.warn({ err: profErr, shareId }, "getRecipientView: sharer name read failed");
      sharingUserName = (profile as any)?.display_name ?? "A traveler";
    } catch { /* non-fatal */ }

    const secondsRemaining = s.expiresAt
      ? Math.max(0, Math.floor((new Date(s.expiresAt).getTime() - nowMs) / 1000))
      : null;

    return {
      view: {
        shareId: s.id,
        status: s.status,
        sharingUserName,
        approximateArea,
        areaStatus,
        expiresAt: s.expiresAt,
        secondsRemaining,
      },
    };
  } catch (err) {
    // Not `not_found`: a thrown transport error is not evidence the share does
    // not exist.
    logger.error({ err, shareId }, "getRecipientView: threw");
    return { error: "unavailable" };
  }
}
