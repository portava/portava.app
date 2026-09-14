/**
 * TrustAdminService
 *
 * Admin-only mutations on the trust engine.
 * Every write creates a row in trust_admin_actions for full audit trail.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { affectedRows } from "../../lib/affectedRows.js";

const logger = rootLogger.child({ service: "TrustAdminService" });
import { recalculateTrustScore, getTrustProfileResult } from "./TrustScoreService.js";
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
  // Mark confirmed — and make sure it happened. supabase-js resolves on a
  // database error; unread, a failed update left the event pending_review while
  // the code below still applied the cap, set probation, and logged the admin
  // action. The next confirm of the same (still pending) event would then apply
  // the cap AGAIN. The status transition is the idempotency guard for
  // everything that follows, so a failure here stops here.
  //
  // Reading `error` alone was not enough to make that guarantee. The statement
  // carries `.eq("status","pending_review")` — a compare-and-swap — and losing
  // that CAS is NOT an error: PostgREST answers a zero-row UPDATE with 204 and
  // supabase-js resolves `{ data: null, error: null }`, exactly as it does for
  // the winning caller. Two admins adjudicating the same queue item (or one
  // double-clicked request) therefore both ran the cap application, the
  // probation set and the audit write, which is the double-charge the comment
  // above says the transition prevents. `.select()` makes the update RETURNING
  // so the transition can be OBSERVED, and zero rows raises the same
  // "not pending review" the pre-check raises — the route already maps it.
  const { data: confirmed, error: confirmErr } = await db.from("trust_events")
    .update({ status: "confirmed", reviewed_by: adminId, reviewed_at: new Date(nowMs).toISOString() })
    .eq("id", eventId)
    .eq("status", "pending_review")
    .select("id");
  if (confirmErr) throw new Error(`confirmEvent: status update failed — ${confirmErr.message ?? confirmErr.code ?? "db_error"}`);
  if (affectedRows(confirmed) === 0) {
    logger.warn({ eventId, adminId }, "confirmEvent: pending_review→confirmed matched no row — already adjudicated; no cap, probation or audit applied");
    throw new Error("Event is not pending review");
  }

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

  // Close any review for this event (non-fatal: the event is confirmed and
  // scored; an open review row left behind is visible in the queue, not lost).
  {
    const { error: reviewErr } = await db.from("trust_reviews")
      .update({ status: "resolved", resolved_by: adminId, resolved_at: new Date(nowMs).toISOString() })
      .eq("source_event_id", eventId)
      .eq("status", "open");
    if (reviewErr) logger.warn({ err: reviewErr, eventId }, "confirmEvent: trust_reviews close failed (non-fatal)");
  }

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
 */
export async function revokeModerationTrustConsequences(
  db: SupabaseClient,
  adminId: string,
  userId: string,
  reason: string,
): Promise<{ eventsDismissed: number; capsLifted: number }> {
  try {
    const { data: events, error } = await db
      .from("trust_events")
      .select("id")
      .eq("user_id", userId)
      .eq("source_type", "moderation")
      .in("status", ["applied", "confirmed", "pending_review"]);
    if (error) return { eventsDismissed: 0, capsLifted: 0 };

    const ids = ((events as any[]) ?? []).map((e) => e.id).filter(Boolean);
    if (ids.length === 0) return { eventsDismissed: 0, capsLifted: 0 };

    const { liftCapsBySourceEvents } = await import("./TrustCapService.js");
    const capsLifted = await liftCapsBySourceEvents(db, ids, adminId);

    // The count this function RETURNS is what routes/admin.ts's restore path
    // reports as "the sanction's trust consequences were reversed". It used to
    // be `ids.length` — the size of the READ set — while the write's outcome
    // was discarded entirely: neither its error nor its affected-row count was
    // read, so a dismissal that moved nothing still answered "N events
    // dismissed" and the user kept the trust penalty for a lifted ban.
    const { data: dismissedEvents, error: dismissErr } = await db
      .from("trust_events")
      .update({ status: "dismissed", reviewed_by: adminId, reviewed_at: new Date().toISOString() })
      .in("id", ids)
      .in("status", ["applied", "confirmed", "pending_review"])
      .select("id");
    // Never throws, and the two user-favourable steps below (clearing probation
    // and recalculating) still run on a failed dismissal — they are independent
    // of it and the sanction really was lifted. What must NOT survive is the
    // CLAIM: a dismissal that errored or matched nothing reports 0.
    if (dismissErr) {
      logger.error({ err: dismissErr, userId, adminId }, "revokeModerationTrustConsequences: event dismissal failed — trust penalty NOT reversed");
    }
    const eventsDismissed = dismissErr ? 0 : affectedRows(dismissedEvents);
    if (eventsDismissed < ids.length) {
      logger.warn({ userId, selected: ids.length, dismissed: eventsDismissed }, "revokeModerationTrustConsequences: fewer events dismissed than selected");
    }

    // A reversed finding must not leave the user on probation for it.
    await setProbation(db, userId, false, null).catch(() => {});
    await recalculateTrustScore(db, userId).catch(() => {});

    // Logged as "lift_cap" rather than a more precise label because
    // trust_admin_actions.action_type carries a CHECK constraint limited to nine
    // values, and adding one would need a migration for an audit string. The
    // metadata carries what actually happened.
    await logAdminAction(
      db, adminId, userId, "lift_cap", reason,
      { op: "revoke_moderation_trust", eventsDismissed, capsLifted },
    ).catch(() => {});

    return { eventsDismissed, capsLifted };
  } catch {
    return { eventsDismissed: 0, capsLifted: 0 };
  }
}

/** Dismiss a pending_review event → 'dismissed', recalc (no caps) */
export async function dismissEvent(
  db: SupabaseClient,
  adminId: string,
  eventId: string,
  reason: string,
): Promise<{ ok: boolean }> {
  const { data: evt, error: fetchErr } = await db
    .from("trust_events")
    .select("id, user_id, status")
    .eq("id", eventId)
    .maybeSingle();

  if (fetchErr) throw new Error(`dismissEvent: event read failed — ${fetchErr.message ?? fetchErr.code ?? "db_error"}`);
  if (!evt) throw new Error("Event not found");
  const e = evt as any;
  if (e.status !== "pending_review") throw new Error("Event is not pending review");

  // Same rule as confirmEvent: the status transition must be known to have
  // happened before the dismissal is recalculated and audited as done.
  const { data: dismissed, error: dismissErr } = await db.from("trust_events")
    .update({ status: "dismissed", reviewed_by: adminId, reviewed_at: new Date().toISOString() })
    .eq("id", eventId)
    .eq("status", "pending_review")
    .select("id");
  if (dismissErr) throw new Error(`dismissEvent: status update failed — ${dismissErr.message ?? dismissErr.code ?? "db_error"}`);
  // Losing the compare-and-swap is not an error (see confirmEvent): zero rows
  // means someone else adjudicated this event first, and reviewed_by on the row
  // is theirs, not this admin's. Recalculating and writing a dismiss_event audit
  // row for an adjudication this call did not make is the false success.
  if (affectedRows(dismissed) === 0) {
    logger.warn({ eventId, adminId }, "dismissEvent: pending_review→dismissed matched no row — already adjudicated; no recalc or audit written");
    throw new Error("Event is not pending review");
  }

  {
    const { error: reviewErr } = await db.from("trust_reviews")
      .update({ status: "dismissed", resolved_by: adminId, resolved_at: new Date().toISOString() })
      .eq("source_event_id", eventId)
      .eq("status", "open");
    if (reviewErr) logger.warn({ err: reviewErr, eventId }, "dismissEvent: trust_reviews close failed (non-fatal)");
  }

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

/**
 * Direct score override for a specific category.
 *
 * ── THE OWNER'S RULING: CAP NOW, PIN LATER BEHIND A FLAG (census-trust §14.4) ──
 *
 * An admin override sets a CEILING. Events may move the category below it;
 * nothing lifts it above. An admin can WITHHOLD standing and cannot GRANT it.
 * `trust_caps` has only `ceiling_score` and `TrustScoreService.loadCaps` folds
 * caps with `Math.min`, so an override BELOW the natural score binds and an
 * override ABOVE it is inert — including against another cap: an admin cannot
 * grant relief from a `behavior_confirmed` ceiling today, and that is the
 * intended behaviour, not an accident. PIN semantics (a floor, an upward
 * override, a relief path), an expiry and a two-admin precedence rule are named
 * as LATER WORK in census-trust §14.4; none of them is built here.
 *
 * ── WHAT WAS WRONG, AND IT WAS NOT "the override does not land" ───────────────
 *
 * This function used to write the admin's raw number straight into
 * `trust_profiles` "for immediate effect" and then recalculate. Both halves of
 * that were defects, in opposite directions:
 *
 *   - On the SUCCESS path the raw write is dead. `recalculateTrustScore`
 *     recomputes from events, applies the cap, and overwrites it before this
 *     function returns. So the write bought nothing and made the reader believe
 *     the persist came from here rather than from the ceiling.
 *
 *   - On the FAILURE path it is worse than dead, and this is the defect that
 *     mattered. `recalculateTrustScore` is deliberately FAIL-CLOSED: an
 *     unreadable `trust_settings`, `trust_events` or `trust_caps` makes it THROW
 *     and write nothing. That throw was swallowed by `.catch(() => {})`. The raw
 *     write then STOOD — a category value that no `overall_score` or
 *     `public_level` on the same row corresponds to, and that no cap produced.
 *     An upward override of 90 against a moderation ceiling of 40 therefore
 *     granted exactly the relief the ruling says an admin does not have, wrote
 *     it permanently, reported `{ ok: true }`, and filed a `score_override`
 *     audit row saying the engine had applied it. Nothing retries: the score the
 *     product actually gates on — `trust_profiles.overall_score` — never
 *     received the ceiling at all.
 *
 * So the raw write is gone. The ceiling lives in `trust_caps`, which is durable,
 * and the ONLY writer of a scored column is `recalculateTrustScore`. If the
 * recalculation does not happen, this function says so instead of reporting a
 * success — the same rule `confirmEvent`, `dismissEvent` and `adminResolveReview`
 * already apply to their own transitions — and no audit row claims an override
 * that the engine never applied.
 *
 * The cap row survives such a throw on purpose: it is the ceiling, and the next
 * successful recalculation (a later admin action, the maintenance sweep) applies
 * it. A retry writes a second `admin_override` row with the same ceiling, which
 * folds to the same `Math.min` and is lifted by the same `adminRemoveOverride`.
 *
 * ── AND THE RESULT IS A MEASUREMENT, NOT A CLAIM ─────────────────────────────
 *
 * `persistedScore` is READ BACK from `trust_profiles` after the recalculation,
 * because `recalculateTrustScore` persists non-fatally: it logs and returns the
 * computed result even when its own upsert failed. Returning the computed number
 * would be this function asserting a persist it had not observed.
 *
 *   persistedScore  — the category value now on the row.
 *   ceilingBinding  — true only when the admin's number is what is holding the
 *                     score down. False when the natural score already sits
 *                     below it (nothing was withheld) and false when a LOWER
 *                     ceiling — a moderation cap, or another admin's override —
 *                     is the one binding. An upward override reads false, which
 *                     is CAP semantics reported rather than silently applied.
 *
 * Pinned by `src/test/trust-integration.test.ts` — "D-OVERRIDE: adminOverrideScore
 * caps, and a cap only binds downward" and "D-OVERRIDE: the ceiling the owner
 * ruled for must PERSIST". Changing the answer must change those assertions.
 */
export async function adminOverrideScore(
  db: SupabaseClient,
  adminId: string,
  targetUserId: string,
  category: TrustCategory,
  newScore: number,
  reason: string,
): Promise<{ ok: boolean; category: TrustCategory; persistedScore: number; ceilingBinding: boolean }> {
  if (newScore < 0 || newScore > 100) throw new Error("Score must be 0–100");

  const cap = await createCap(db, {
    userId: targetUserId,
    category,
    ceilingScore: newScore,
    reasonCode: "admin_override",
  });

  // Fail-closed, and NOT swallowed: an override whose recalculation did not run
  // has not been applied, and must not be reported or audited as if it had.
  const recalculated = await recalculateTrustScore(db, targetUserId);

  // Read back rather than trust the computed result — see the docblock.
  const read = await getTrustProfileResult(db, targetUserId);
  if (read.state !== "ok") {
    throw new Error(
      `adminOverrideScore: ceiling written to trust_caps but NOT confirmed on trust_profiles — read is '${read.state}'` +
      (read.state === "unavailable" ? ` (${read.reason})` : ""),
    );
  }
  const persistedScore = Number((read.profile.categories as Record<string, unknown>)[category]);
  // numeric(5,2) round-trips exactly at two decimals; the epsilon absorbs that,
  // not a disagreement. A persisted value ABOVE the ceiling means the ceiling is
  // not in force, which is the one thing this function exists to guarantee.
  if (!Number.isFinite(persistedScore) || persistedScore > newScore + 0.005) {
    throw new Error(
      `adminOverrideScore: ceiling ${newScore} did not take effect on ${category} — trust_profiles still reads ${String(persistedScore)}`,
    );
  }

  const ceilingBinding =
    recalculated.capsApplied.includes(category) && Math.abs(persistedScore - newScore) < 0.005;

  // The audit records what HAPPENED, not what was asked for: an override that
  // withheld nothing is a different fact from one that pulled a score down.
  await logAdminAction(db, adminId, targetUserId, "score_override", reason,
    { category, newScore, persistedScore, ceilingBinding }, cap.id);
  return { ok: true, category, persistedScore, ceilingBinding };
}

/**
 * Remove a previously applied score override for a category: lift the
 * `admin_override` cap(s), recompute, and confirm the score came back.
 *
 * ── THIS PATH HAD THE DEFECT THE APPLY PATH NO LONGER HAS ──────────────────
 * `adminOverrideScore` above was fixed: its recalculation is awaited and not
 * swallowed, the persisted value is READ BACK from `trust_profiles` rather than
 * computed, and no audit row is written unless the ceiling is observed in force.
 * The removal path was the mirror image of the old bug and nothing had noticed:
 *
 *   - `liftCap(...).catch(() => {})` — a lift that failed was discarded, and
 *     because `liftCap` also could not tell "lifted one" from "matched nothing",
 *     even a lift that SUCCEEDED proved nothing about the ceiling being gone.
 *   - `recalculateTrustScore(...).catch(() => {})` — and that function is
 *     deliberately fail-closed: an unreadable `trust_settings`, `trust_events`
 *     or `trust_caps` makes it THROW and write nothing. Swallowed, the ceiling
 *     stayed on `trust_profiles` with nothing scheduled to remove it.
 *   - the audit row and `{ ok: true }` were then written unconditionally.
 *
 * So an admin could be told an override was removed while the user's score was
 * still being held down by it, with a `score_override` audit row asserting a
 * removal that had not happened. Ceiling persistence was confirmed on apply and
 * unconfirmed on remove, which is half a guarantee.
 *
 * Every step is now awaited, nothing is swallowed, and the result is a
 * MEASUREMENT: the caps are re-read after the recalculation and the function
 * refuses to report success while an `admin_override` ceiling is still active.
 * Same rule `confirmEvent`, `dismissEvent` and `adminResolveReview` already
 * apply to their own transitions.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ─────────────────────────────────────────
 * The selection is still keyed on (user, category, reason_code): one admin's
 * removal clears every admin's override in that category, and it touches no
 * moderation cap. That is characterized behaviour and a pending owner question,
 * not a defect to fix here. Removing NOTHING now throws rather than reporting a
 * removal, which is the same fail-closed rule and not a change of that policy.
 */
export async function adminRemoveOverride(
  db: SupabaseClient,
  adminId: string,
  targetUserId: string,
  category: TrustCategory,
  reason: string,
  sourceCapId?: string,
): Promise<{ ok: boolean; liftedCapIds: string[]; persistedScore: number }> {
  // Find the active admin_override cap for this user+category. A failed read
  // must not be audited as "override removed" — nothing was lifted.
  const { data: caps, error: capsErr } = await db
    .from("trust_caps")
    .select("id")
    .eq("user_id", targetUserId)
    .eq("category", category)
    .eq("reason_code", "admin_override")
    .is("lifted_at", null);
  if (capsErr) throw new Error(`adminRemoveOverride: trust_caps read failed — ${capsErr.message ?? capsErr.code ?? "db_error"}`);

  const capIds = (Array.isArray(caps) ? caps : []).map((c) => String((c as any).id));
  if (capIds.length === 0) {
    throw new Error(
      `adminRemoveOverride: no active admin_override ceiling on ${category} for this user — nothing was removed`,
    );
  }

  // Sequential, not Promise.all: each lift is a separate confirmation and a
  // partial failure must name which cap is still standing.
  const liftedCapIds: string[] = [];
  for (const capId of capIds) {
    if (await liftCap(db, { capId, userId: targetUserId, liftedBy: adminId })) liftedCapIds.push(capId);
  }
  if (liftedCapIds.length !== capIds.length) {
    const missed = capIds.filter((id) => !liftedCapIds.includes(id));
    throw new Error(
      `adminRemoveOverride: ${missed.length} of ${capIds.length} admin_override cap(s) were not lifted (${missed.join(", ")}) — the ceiling may still be in force`,
    );
  }

  // Recompute from raw events — no override cap ceiling any more. Fail-closed
  // and NOT swallowed: a removal whose recalculation did not run has not taken
  // effect, and must not be reported or audited as if it had.
  await recalculateTrustScore(db, targetUserId);

  const persistedScore = await confirmOverrideRemoved(db, targetUserId, category);

  await logAdminAction(db, adminId, targetUserId, "score_override", reason,
    { action: "remove_override", category, liftedCapIds, persistedScore }, sourceCapId);
  return { ok: true, liftedCapIds, persistedScore };
}

/**
 * Read back the state a removal claims to have produced, and return the
 * category value now on the row.
 *
 * Two reads, because "the cap row is lifted" and "the score the product gates on
 * no longer carries the ceiling" are different facts and the old code asserted
 * neither. `recalculateTrustScore` persists NON-fatally — it logs and returns
 * the computed result even when its own upsert failed — so the computed number
 * is not evidence that anything reached `trust_profiles`.
 */
async function confirmOverrideRemoved(
  db: SupabaseClient,
  targetUserId: string,
  category: TrustCategory,
): Promise<number> {
  const { data: stillActive, error: recheckErr } = await db
    .from("trust_caps")
    .select("id")
    .eq("user_id", targetUserId)
    .eq("category", category)
    .eq("reason_code", "admin_override")
    .is("lifted_at", null);
  if (recheckErr) {
    throw new Error(
      `adminRemoveOverride: caps lifted but NOT confirmed — trust_caps re-read failed (${recheckErr.message ?? recheckErr.code ?? "db_error"})`,
    );
  }
  if (Array.isArray(stillActive) && stillActive.length > 0) {
    throw new Error(
      `adminRemoveOverride: ${stillActive.length} admin_override ceiling(s) on ${category} are still active after the lift`,
    );
  }

  const read = await getTrustProfileResult(db, targetUserId);
  if (read.state !== "ok") {
    throw new Error(
      `adminRemoveOverride: ceiling lifted but the score was NOT confirmed on trust_profiles — read is '${read.state}'` +
      (read.state === "unavailable" ? ` (${read.reason})` : ""),
    );
  }
  const persistedScore = Number((read.profile.categories as Record<string, unknown>)[category]);
  if (!Number.isFinite(persistedScore)) {
    throw new Error(
      `adminRemoveOverride: trust_profiles.${category} reads ${String(persistedScore)} after the removal`,
    );
  }
  return persistedScore;
}

/** Resolve a trust_review item */
export async function adminResolveReview(
  db: SupabaseClient,
  adminId: string,
  reviewId: string,
  resolution: "resolved" | "dismissed",
  notes?: string,
): Promise<{ ok: boolean }> {
  // supabase-js RESOLVES on a database error, so an unbound `error` here made an
  // unreadable `trust_reviews` indistinguishable from a review that does not
  // exist — the admin was told "Review not found" about a row that is right
  // there. The two sibling adjudication paths (confirmEvent, dismissEvent)
  // already separate them; this one did not.
  const { data: review, error: fetchErr } = await db
    .from("trust_reviews")
    .select("id, user_id")
    .eq("id", reviewId)
    .maybeSingle();

  if (fetchErr) throw new Error(`adminResolveReview: review read failed — ${fetchErr.message ?? fetchErr.code ?? "db_error"}`);
  if (!review) throw new Error("Review not found");
  const r = review as any;

  // The resolution must be KNOWN to have happened before it is reported as
  // done and written into the admin audit log. This update carried no
  // `.select()` and no `.error` check at all: its result was discarded
  // entirely, so a failed write returned `{ ok: true }` to the admin, left the
  // review sitting in the queue, and recorded a `resolve_review` audit row for
  // an action that never took place — a false entry in the one log whose whole
  // purpose is to be trustworthy. Same rule confirmEvent and dismissEvent
  // already apply to their status transitions.
  const { data: resolved, error: updateErr } = await db.from("trust_reviews").update({
    status:      resolution,
    resolved_by: adminId,
    resolved_at: new Date().toISOString(),
    notes:       notes ?? null,
  }).eq("id", reviewId).select("id");
  if (updateErr) throw new Error(`adminResolveReview: status update failed — ${updateErr.message ?? updateErr.code ?? "db_error"}`);
  // A bodyless UPDATE cannot report affected rows (PostgREST answers 204 with
  // no content-range), so `.select()` is what makes the transition observable
  // at all. Zero rows means the review vanished between the read and the write;
  // auditing a resolution of a row that is not there is the false success.
  if (affectedRows(resolved) === 0) {
    logger.warn({ reviewId, adminId, resolution }, "adminResolveReview: update matched no row — no audit written");
    throw new Error("Review not found");
  }

  await logAdminAction(db, adminId, r.user_id, "resolve_review",
    notes ?? resolution, { resolution }, reviewId);
  return { ok: true };
}

/**
 * Get pending events queue for admin.
 *
 * THROWS on a read failure. These two queue reads used to swallow both the
 * resolved `error` and any throw and return `[]` — so an unreachable ledger
 * rendered as an EMPTY queue, "nothing to review", to the one person whose job
 * is to notice. An empty queue and a broken queue are different answers; the
 * route turns the throw into a db_error.
 */
export async function getPendingEvents(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  const { data, error } = await db
    .from("trust_events")
    .select("id, user_id, event_type, category, delta, severity, source_type, metadata, created_at")
    .eq("status", "pending_review")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`getPendingEvents: trust_events read failed — ${error.message ?? error.code ?? "db_error"}`);
  return (data as any[]) ?? [];
}

/** Get open reviews queue. Throws on a read failure — see getPendingEvents. */
export async function getOpenReviews(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  const { data, error } = await db
    .from("trust_reviews")
    .select("id, user_id, review_type, source_event_id, metadata, created_at")
    .in("status", ["open", "in_progress"])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`getOpenReviews: trust_reviews read failed — ${error.message ?? error.code ?? "db_error"}`);
  return (data as any[]) ?? [];
}
