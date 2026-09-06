/**
 * TrustAdminService
 *
 * Admin-only mutations on the trust engine.
 * Every write creates a row in trust_admin_actions for full audit trail.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "TrustAdminService" });
import { recalculateTrustScore } from "./TrustScoreService.js";
import { createCap, liftCap } from "./TrustCapService.js";
import { applyRestriction, liftRestriction, type RestrictionType } from "./TrustRestrictionService.js";
import { setProbation } from "./TrustRecoveryService.js";
import type { TrustCategory } from "./TrustEventService.js";

type AdminActionType =
  | "confirm_event" | "dismiss_event"
  | "apply_restriction" | "lift_restriction"
  | "apply_cap" | "lift_cap"
  | "score_override" | "resolve_review" | "flag_gaming";

async function logAdminAction(
  db: SupabaseClient,
  adminId: string,
  targetUser: string,
  actionType: AdminActionType,
  reason: string,
  metadata: Record<string, unknown> = {},
  sourceId?: string,
): Promise<void> {
  // Non-fatal — audit log failure should not block the action
  const { error } = await db.from("trust_admin_actions").insert({
    admin_id:    adminId,
    target_user: targetUser,
    action_type: actionType,
    reason,
    source_id:   sourceId ?? null,
    metadata,
  });
  if (error) logger.warn({ err: error, adminId, actionType }, "audit log insert failed (non-fatal)");
}

/** Confirm a pending_review event → 'confirmed', trigger caps + recalc */
export async function confirmEvent(
  db: SupabaseClient,
  adminId: string,
  eventId: string,
  reason: string,
): Promise<{ ok: boolean }> {
  // Fetch event
  const { data: evt, error } = await db
    .from("trust_events")
    .select("id, user_id, event_type, severity, status")
    .eq("id", eventId)
    .maybeSingle();

  if (error || !evt) throw new Error("Event not found");
  const e = evt as any;
  if (e.status !== "pending_review") throw new Error("Event is not pending review");

  const nowMs = Date.now();
  // Mark confirmed
  await db.from("trust_events")
    .update({ status: "confirmed", reviewed_by: adminId, reviewed_at: new Date(nowMs).toISOString() })
    .eq("id", eventId);

  // Apply standard caps for this event type
  const { applyEventCaps } = await import("./TrustCapService.js");
  await applyEventCaps(db, e.user_id, e.event_type, e.severity, eventId).catch(() => {});

  // For severe events, set probation
  if (e.severity === "severe") {
    const probationEnd = new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString();
    await setProbation(db, e.user_id, true, probationEnd).catch(() => {});
  }

  // Recalculate score
  await recalculateTrustScore(db, e.user_id).catch(() => {});

  // Close any review for this event
  await db.from("trust_reviews")
    .update({ status: "resolved", resolved_by: adminId, resolved_at: new Date(nowMs).toISOString() })
    .eq("source_event_id", eventId)
    .eq("status", "open");

  await logAdminAction(db, adminId, e.user_id, "confirm_event", reason, { eventType: e.event_type }, eventId);
  return { ok: true };
}

/**
 * Reverse the trust consequences of moderation actions against a user.
 *
 * Called when a sanction is itself reversed — an account restored, an appeal
 * upheld. Dismisses the moderation-sourced trust events, lifts the caps those
 * events created, clears probation, and recalculates.
 *
 * WHY THIS HAD TO EXIST BEFORE THE EMITTERS. Confirming an event applies a cap,
 * and `behavior_report_confirmed` writes a respect_safety ceiling of 40 with no
 * expiry. Nothing lifted a cap by source event, so a reversed ban left that
 * ceiling standing forever: the ban was undoable and its trust penalty was not.
 * Wiring moderation to trust makes caps routine, which turns that gap from
 * theoretical into load-bearing. So the reversal path ships first.
 *
 * Scoped to source_type='moderation' so it reverses only what a moderation
 * action charged — a GPS finding or a gaming flag against the same user stands
 * on its own evidence and is untouched.
 *
 * Never throws: an admin restoring an account must not be blocked by trust
 * bookkeeping. Returns what it did so the caller can log it.
 *
 * ── `incomplete`: THE COUNTS ALONE USED TO LIE ──────────────────────────────
 * Every failure inside this function produced `{ eventsDismissed: 0, capsLifted: 0 }`
 * — the identical value returned when the user simply had no moderation
 * consequences to reverse. Worse, the dismissal UPDATE dropped its `error`
 * entirely and the function then reported `eventsDismissed: ids.length`: the
 * count of rows it INTENDED to dismiss, returned unconditionally, whether or not
 * a single row changed. So a wholly failed reversal reported full success.
 *
 * That matters more here than almost anywhere else in the engine, because the
 * consequence being reversed is PERMANENT if the reversal does not land: a
 * `behavior_confirmed` respect_safety ceiling has no `expires_at` and no other
 * code path lifts it. `incomplete: true` is the signal that the sanction was
 * lifted but its trust consequence may still be standing, and needs a human.
 */
export interface RevokeModerationTrustResult {
  /** Events this call actually moved to 'dismissed' (not the count attempted). */
  eventsDismissed: number;
  /** Caps this call actually lifted. */
  capsLifted: number;
  /**
   * True when any step could not be completed. NOT the same as "there was
   * nothing to reverse", which is `incomplete: false` with both counts 0.
   */
  incomplete: boolean;
}

export async function revokeModerationTrustConsequences(
  db: SupabaseClient,
  adminId: string,
  userId: string,
  reason: string,
): Promise<RevokeModerationTrustResult> {
  try {
    const { data: events, error } = await db
      .from("trust_events")
      .select("id")
      .eq("user_id", userId)
      .eq("source_type", "moderation")
      .in("status", ["applied", "confirmed", "pending_review"]);
    if (error) {
      logger.warn({ err: error, userId }, "revokeModerationTrustConsequences: event read failed — consequences may still stand");
      return { eventsDismissed: 0, capsLifted: 0, incomplete: true };
    }

    const ids = ((events as any[]) ?? []).map((e) => e.id).filter(Boolean);
    // Genuinely nothing to reverse. The only path that returns zeroes WITHOUT
    // incomplete, and the one every failure above used to be confused with.
    if (ids.length === 0) return { eventsDismissed: 0, capsLifted: 0, incomplete: false };

    const { liftCapsBySourceEvents } = await import("./TrustCapService.js");
    const lift = await liftCapsBySourceEvents(db, ids, adminId);
    let incomplete = lift.failed;

    // Count what actually changed, and read the error. `.select("id")` turns the
    // blind write into an observation.
    const { data: dismissed, error: dismissError } = await db
      .from("trust_events")
      .update({ status: "dismissed", reviewed_by: adminId, reviewed_at: new Date().toISOString() })
      .in("id", ids)
      .select("id");
    if (dismissError) {
      logger.warn({ err: dismissError, userId, attempted: ids.length }, "revokeModerationTrustConsequences: dismissal failed — findings still charged");
      incomplete = true;
    }
    const eventsDismissed = dismissError ? 0 : ((dismissed as any[]) ?? []).length;
    // A write that reported success but moved fewer rows than it targeted is
    // still a partial reversal, and must not read as a whole one.
    if (!dismissError && eventsDismissed < ids.length) incomplete = true;

    // A reversed finding must not leave the user on probation for it.
    await setProbation(db, userId, false, null).catch(() => {});
    await recalculateTrustScore(db, userId).catch(() => {});

    // Logged as "lift_cap" rather than a more precise label because
    // trust_admin_actions.action_type carries a CHECK constraint limited to nine
    // values, and adding one would need a migration for an audit string. The
    // metadata carries what actually happened.
    await logAdminAction(
      db, adminId, userId, "lift_cap", reason,
      {
        op: "revoke_moderation_trust",
        eventsTargeted: ids.length,
        eventsDismissed,
        capsLifted: lift.lifted,
        incomplete,
      },
    ).catch(() => {});

    if (incomplete) {
      logger.error(
        { userId, adminId, eventsTargeted: ids.length, eventsDismissed, capsLifted: lift.lifted },
        "moderation trust reversal INCOMPLETE — a permanent ceiling or a charged finding may still stand",
      );
    }

    return { eventsDismissed, capsLifted: lift.lifted, incomplete };
  } catch (err) {
    logger.warn({ err, userId }, "revokeModerationTrustConsequences threw — consequences may still stand");
    return { eventsDismissed: 0, capsLifted: 0, incomplete: true };
  }
}

/** Dismiss a pending_review event → 'dismissed', recalc (no caps) */
export async function dismissEvent(
  db: SupabaseClient,
  adminId: string,
  eventId: string,
  reason: string,
): Promise<{ ok: boolean }> {
  const { data: evt } = await db
    .from("trust_events")
    .select("id, user_id, status")
    .eq("id", eventId)
    .maybeSingle();

  if (!evt) throw new Error("Event not found");
  const e = evt as any;
  if (e.status !== "pending_review") throw new Error("Event is not pending review");

  await db.from("trust_events")
    .update({ status: "dismissed", reviewed_by: adminId, reviewed_at: new Date().toISOString() })
    .eq("id", eventId);

  await db.from("trust_reviews")
    .update({ status: "dismissed", resolved_by: adminId, resolved_at: new Date().toISOString() })
    .eq("source_event_id", eventId)
    .eq("status", "open");

  await recalculateTrustScore(db, e.user_id).catch(() => {});
  await logAdminAction(db, adminId, e.user_id, "dismiss_event", reason, {}, eventId);
  return { ok: true };
}

/** Apply a restriction and log it */
export async function adminApplyRestriction(
  db: SupabaseClient,
  adminId: string,
  targetUserId: string,
  restrictionType: RestrictionType,
  reason: string,
  expiresAt?: string | null,
): Promise<{ ok: boolean; restrictionId: string }> {
  const restriction = await applyRestriction(db, {
    userId: targetUserId, restrictionType, reason, expiresAt,
  });
  await logAdminAction(db, adminId, targetUserId, "apply_restriction", reason,
    { restrictionType, expiresAt }, restriction.id);
  return { ok: true, restrictionId: restriction.id };
}

/** Lift a restriction and log it */
export async function adminLiftRestriction(
  db: SupabaseClient,
  adminId: string,
  targetUserId: string,
  restrictionId: string,
  reason: string,
): Promise<{ ok: boolean }> {
  await liftRestriction(db, restrictionId, adminId);
  await logAdminAction(db, adminId, targetUserId, "lift_restriction", reason, {}, restrictionId);
  return { ok: true };
}

/** Direct score override for a specific category */
export async function adminOverrideScore(
  db: SupabaseClient,
  adminId: string,
  targetUserId: string,
  category: TrustCategory,
  newScore: number,
  reason: string,
): Promise<{ ok: boolean }> {
  if (newScore < 0 || newScore > 100) throw new Error("Score must be 0–100");

  // Set the cap at the override value to lock it in place
  const cap = await createCap(db, {
    userId: targetUserId,
    category,
    ceilingScore: newScore,
    reasonCode: "admin_override",
  });

  // Also upsert the trust_profiles row directly for immediate effect (non-fatal)
  {
    const { error } = await db.from("trust_profiles").upsert(
      { user_id: targetUserId, [category]: newScore, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) logger.warn({ err: error, targetUserId, category }, "score override upsert failed (non-fatal)");
  }

  await recalculateTrustScore(db, targetUserId).catch(() => {});
  await logAdminAction(db, adminId, targetUserId, "score_override", reason,
    { category, newScore }, cap.id);
  return { ok: true };
}

/**
 * Remove a previously applied score override for a category.
 * Lifts the admin_override cap, then triggers a full recalculation so the
 * score returns to its naturally-computed value.
 */
export async function adminRemoveOverride(
  db: SupabaseClient,
  adminId: string,
  targetUserId: string,
  category: TrustCategory,
  reason: string,
): Promise<{ ok: boolean }> {
  // Find the active admin_override cap for this user+category
  const { data: caps } = await db
    .from("trust_caps")
    .select("id")
    .eq("user_id", targetUserId)
    .eq("category", category)
    .eq("reason_code", "admin_override")
    .is("lifted_at", null);

  if (caps && Array.isArray(caps)) {
    await Promise.all((caps as any[]).map(cap =>
      liftCap(db, (cap as any).id, adminId).catch(() => {}),
    ));
  }

  // Recompute from raw events — no override cap ceiling any more
  await recalculateTrustScore(db, targetUserId).catch(() => {});

  await logAdminAction(db, adminId, targetUserId, "score_override", reason,
    { action: "remove_override", category });
  return { ok: true };
}

/** Resolve a trust_review item */
export async function adminResolveReview(
  db: SupabaseClient,
  adminId: string,
  reviewId: string,
  resolution: "resolved" | "dismissed",
  notes?: string,
): Promise<{ ok: boolean }> {
  const { data: review } = await db
    .from("trust_reviews")
    .select("id, user_id")
    .eq("id", reviewId)
    .maybeSingle();

  if (!review) throw new Error("Review not found");
  const r = review as any;

  await db.from("trust_reviews").update({
    status:      resolution,
    resolved_by: adminId,
    resolved_at: new Date().toISOString(),
    notes:       notes ?? null,
  }).eq("id", reviewId);

  await logAdminAction(db, adminId, r.user_id, "resolve_review",
    notes ?? resolution, { resolution }, reviewId);
  return { ok: true };
}

/** Get pending events queue for admin */
export async function getPendingEvents(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  try {
    const { data } = await db
      .from("trust_events")
      .select("id, user_id, event_type, category, delta, severity, source_type, metadata, created_at")
      .eq("status", "pending_review")
      .order("created_at", { ascending: true })
      .limit(limit);
    return (data as any[]) ?? [];
  } catch {
    return [];
  }
}

/** Get open reviews queue */
export async function getOpenReviews(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  try {
    const { data } = await db
      .from("trust_reviews")
      .select("id, user_id, review_type, source_event_id, metadata, created_at")
      .in("status", ["open", "in_progress"])
      .order("created_at", { ascending: true })
      .limit(limit);
    return (data as any[]) ?? [];
  } catch {
    return [];
  }
}
