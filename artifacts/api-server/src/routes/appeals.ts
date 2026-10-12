/**
 * Appeals router — moderation appeal queue
 *
 * POST   /api/appeals              — user submits an appeal
 * GET    /api/appeals/me           — user's own appeal history (paginated)
 * GET    /api/appeals              — admin: full queue with state filter
 * PATCH  /api/appeals/:id          — admin: update state (approved/denied) + resolution_note
 *
 * On PATCH approved: calls resolveAppeal() to run the reversal action and sends
 * a notification to the appellant.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isUuid } from "../lib/followDecisions.js";
import { resolveAppeal, isDeferred } from "../services/appeals/resolveAppeal.js";
import { listPendingRestorations } from "../services/appeals/pendingRestorations.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

/**
 * What the appellant is told when the appeal is upheld but the restoration did
 * not happen. It must never be omitted from a deferred approval — "your appeal
 * was approved" alone reads as "you have your trip back".
 */
const RESTORATION_PENDING_SENTENCE =
  "A moderator still needs to restore this by hand.";

/** Where an admin can see every restoration an approved appeal still owes. */
const RESTORATION_QUEUE_PATH = "/api/appeals/restorations/pending";

// ── POST /api/appeals ─────────────────────────────────────────────────────────

const CreateAppealSchema = z.object({
  targetType:  z.enum([
    "post",
    "memory",
    "highlight",
    "account_warning",
    "trust_score_event",
    "no_show",
    "event",
    "event_membership",
    "trip",
    "trip_membership",
    "review", "trust_restriction", // 3933 (lane B wave 3): the person's own ACTIVE Trust restriction; checked below
  ]),
  targetId:    z.string().uuid(),
  reason:      z.string().min(10).max(3000),
  evidenceUrl: z.string().url().optional(),
});

router.post("/appeals", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const parsed = CreateAppealSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  const { targetType, targetId, reason, evidenceUrl } = parsed.data;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; } if (targetType === "trust_restriction" && !await requireOwnActiveRestriction(sc, auth.user.id, targetId, req, res)) return; // foot of file

  const { data: appeal, error } = await sc
    .from("appeals")
    .insert({
      appellant_id:  auth.user.id,
      target_type:   targetType,
      target_id:     targetId,
      reason,
      evidence_url:  evidenceUrl ?? null,
      state:         "submitted",
      updated_at:    new Date().toISOString(),
    })
    .select("id, target_type, target_id, state, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      sendError(res, "appeal_already_active", "An active appeal already exists for this target");
    } else if (error.code === "22P02" && targetType === "trust_restriction") { res.status(503).json({ error: "appeal_target_unavailable", message: "Appealing a restriction isn't available yet. Please try again later." }); /* 3933 not applied: never db_error, never filed as another target */ } else {
      req.log.error({ err: error }, "create appeal");
      sendError(res, "db_error", error.message);
    }
    return;
  }

  res.status(201).json({
    id:         (appeal as any).id,
    targetType: (appeal as any).target_type,
    targetId:   (appeal as any).target_id,
    state:      (appeal as any).state,
    createdAt:  (appeal as any).created_at,
  });
}));

// ── GET /api/appeals/me ───────────────────────────────────────────────────────

router.get("/appeals/me", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page  = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data, error } = await sc
    .from("appeals")
    .select("id, target_type, target_id, reason, evidence_url, state, resolution_note, created_at, updated_at")
    .eq("appellant_id", auth.user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "get my appeals"); sendError(res, "db_error", error.message); return; }

  res.json({
    appeals: ((data as any[]) ?? []).map((a: any) => ({
      id:             a.id,
      targetType:     a.target_type,
      targetId:       a.target_id,
      reason:         a.reason,
      evidenceUrl:    a.evidence_url ?? null,
      state:          a.state,
      resolutionNote: a.resolution_note ?? null,
      createdAt:      a.created_at,
      updatedAt:      a.updated_at,
    })),
    page,
    limit,
  });
}));

// ── GET /api/appeals/restorations/pending ─────────────────────────────────────
// Admin-only — the restorations an APPROVED appeal owes and the database does
// not show.
//
// This is the operator surface for `restore_requires_policy`. Before it, a
// deferred restoration existed only as a `req.log.error` line at the moment the
// appeal was approved: nobody could ask "what are we still holding?" and get an
// answer, so the debt was real, unbounded and invisible. Being unable to
// perform the restoration is a decision; being unable to SEE the ones we owe is
// just a missing endpoint.
//
// Declared before GET /api/appeals so no future `/appeals/:something` route can
// swallow it.
router.get("/appeals/restorations/pending", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(200, Math.max(1, parseInt((req.query.limit as string) ?? "50")));
  const offset = (page - 1) * limit;

  const result = await listPendingRestorations(sc, { limit, offset });

  // A failed read is NOT an empty queue. Returning `pending: []` here would tell
  // an operator that nothing is owed, which is the same lie one layer up as the
  // appeal that reported a restoration it never performed.
  if (!result.ok) {
    req.log.error({ reason: result.reason }, "pending restoration queue read failed");
    sendError(res, "db_error", result.reason);
    return;
  }

  res.json({
    pending: result.pending,
    page,
    limit,
    // `scanned` larger than `pending.length` is the honest statement that the
    // rest of the page was checked and found already restored.
    scanned: result.scanned,
  });
}));

// ── GET /api/appeals ──────────────────────────────────────────────────────────
// Admin-only — full queue with optional state filter

router.get("/appeals", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page  = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "50")));
  const offset = (page - 1) * limit;
  const stateFilter = req.query.state as string | undefined;

  const VALID_STATES = ["submitted", "under_review", "approved", "denied"];

  let q = sc
    .from("appeals")
    .select("id, appellant_id, target_type, target_id, reason, evidence_url, state, moderator_id, resolution_note, created_at, updated_at, profiles!appellant_id(handle, display_name, avatar_url)")
    .order("created_at", { ascending: true });

  if (stateFilter && VALID_STATES.includes(stateFilter)) {
    q = q.eq("state", stateFilter);
  }

  q = q.range(offset, offset + limit - 1);

  const { data, error } = await q;
  if (error) { req.log.error({ err: error }, "admin get appeals"); sendError(res, "db_error", error.message); return; }

  res.json({
    appeals: ((data as any[]) ?? []).map((a: any) => ({
      id:             a.id,
      appellantId:    a.appellant_id,
      appellant: {
        handle:      a.profiles?.handle ?? null,
        displayName: a.profiles?.display_name ?? null,
        avatarUrl:   a.profiles?.avatar_url ?? null,
      },
      targetType:     a.target_type,
      targetId:       a.target_id,
      reason:         a.reason,
      evidenceUrl:    a.evidence_url ?? null,
      state:          a.state,
      moderatorId:    a.moderator_id ?? null,
      resolutionNote: a.resolution_note ?? null,
      createdAt:      a.created_at,
      updatedAt:      a.updated_at,
    })),
    page,
    limit,
  });
}));

// ── PATCH /api/appeals/:id ────────────────────────────────────────────────────
// Admin-only — transition state + add resolution note

const UpdateAppealSchema = z.object({
  state:          z.enum(["under_review", "approved", "denied"]),
  resolutionNote: z.string().max(2000).optional(),
});

router.patch("/appeals/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid appeal id"); return; }

  const parsed = UpdateAppealSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  const { state, resolutionNote } = parsed.data;

  // Fetch current appeal
  const { data: appeal, error: fetchErr } = await sc
    .from("appeals")
    .select("id, appellant_id, target_type, target_id, state, resolution_note")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr || !appeal) { sendError(res, "not_found", "Appeal not found"); return; }

  const current = (appeal as any).state as string;

  // Enforce strict state machine: submitted → under_review → approved | denied
  // Terminal states (approved, denied) cannot be reopened or re-resolved.
  const ALLOWED: Record<string, string[]> = {
    submitted:    ["under_review"],
    under_review: ["approved", "denied"],
    approved:     [],
    denied:       [],
  };
  const allowed = ALLOWED[current] ?? [];
  if (!allowed.includes(state)) {
    const hint = allowed.length > 0 ? `Allowed next states: ${allowed.join(", ")}` : "This appeal is in a terminal state";
    sendError(res, "invalid_state_transition", `Cannot transition from '${current}' to '${state}'. ${hint}`);
    return;
  }

  const now = new Date().toISOString();

  // ── Reversal on approval — run BEFORE committing the state ────────────────
  // resolveAppeal returns { ok:false, action:'noop', reason } when the reversal
  // cannot be applied (wrong owner scope, DB error, or unknown target_type).
  // 'approved' is a terminal state that the state machine can never re-drive,
  // so committing it first and only then discovering the reversal failed would
  // leave the content moderated while the appellant is told it was restored.
  // Gate the state write on a successful reversal: if it fails, hold the appeal
  // in its current state and surface an error instead.
  let reversal: Awaited<ReturnType<typeof resolveAppeal>> | null = null;
  let restorationDeferred = false;
  if (state === "approved") {
    reversal = await resolveAppeal(sc, {
      id:              (appeal as any).id,
      appellant_id:    (appeal as any).appellant_id,
      target_type:     (appeal as any).target_type,
      target_id:       (appeal as any).target_id,
      resolution_note: resolutionNote ?? null, moderator_id: adminId,
    });

    req.log.info({ appealId: id, reversal }, "appeal reversal");

    // ── Restoration owed, appeal still resolves ───────────────────────────
    // A DEFERRED reversal is not a failure of the appeal: the appeal is upheld
    // and must be allowed to reach its terminal state (holding it under_review
    // forever is not "truthful", it is a queue that can never be closed). What
    // failed is the RESTORATION, and that must not be dressed up as a success:
    // the action recorded is `restore_requires_policy`, the appellant is NOT
    // told the action was reversed, and an operator gets the ids they need to
    // do it by hand.
    if (isDeferred(reversal)) {
      req.log.error(
        {
          appealId:    id,
          action:      reversal.action,
          reason:      reversal.reason,
          targetType:  (appeal as any).target_type,
          targetId:    (appeal as any).target_id,
          appellantId: (appeal as any).appellant_id,
          evidence:    reversal.evidence,
        },
        "appeal approved but the restoration did NOT happen — manual restoration required",
      );
      restorationDeferred = true;
    } else if (!reversal.ok) {
      // Do NOT commit 'approved' and do NOT notify the appellant that the
      // action was reversed. Leave the appeal in under_review so a moderator
      // can retry once the underlying cause is fixed.
      req.log.error(
        { appealId: id, reason: reversal.reason, targetType: (appeal as any).target_type },
        "appeal reversal failed — holding under_review, not approving",
      );
      sendError(
        res,
        "reversal_failed",
        `The moderated action could not be reversed (${reversal.reason}). The appeal remains under review.`,
      );
      return;
    }
  }

  const { data: updated, error: updateErr } = await sc
    .from("appeals")
    .update({
      state,
      moderator_id:    adminId,
      resolution_note: resolutionNote ?? (appeal as any).resolution_note ?? null,
      updated_at:      now,
    })
    .eq("id", id)
    .select("id, state, resolution_note, updated_at")
    .single();

  if (updateErr) { req.log.error({ err: updateErr }, "patch appeal"); sendError(res, "db_error", updateErr.message); return; }

  // ── Notify on approval (reversal already succeeded above) ─────────────────

  // ── THE APPELLANT'S ONLY NOTICE, WRITTEN INTO A VOID ──────────────────────
  // Both notification inserts below were `.then(() => {}).catch(() => {})`.
  // supabase-js RESOLVES on a database error, so the `.catch` was dead code for
  // the failure that actually happens, and the `.then(() => {})` threw away the
  // `{ error }` that WAS delivered. The result: the one message telling a person
  // their appeal was approved (and, when restoration is deferred, that their
  // content still has to be restored by hand) or denied could fail to write with
  // no log line, no response field, and no exception -- while the moderator's
  // response said the appeal was resolved.
  //
  // Direction unchanged and deliberately so: the appeal state transition is
  // already committed above and a notification failure must not undo or block
  // it. NOTHING here touches what "approved" does or what gets restored -- that
  // is a separate, open decision (APPEAL_RESTORE_SEMANTICS) and this change does
  // not enter it. The only thing that changes is that a failure to notify is now
  // observed, logged at ERROR, and reported to the moderator in `notified`, so
  // "the appellant was told" stops being an assumption.
  let notified: boolean | undefined = undefined;

  if (state === "approved") {
    // Notify appellant
    const { error: notifyErr } = await sc.from("notifications").insert({
      user_id:           (appeal as any).appellant_id,
      actor_id:          adminId,
      event_type:        "appeal.approved",
      category:          "admin",
      title:             "Appeal approved",
      // A deferred restoration ALWAYS says so, note or no note. The previous
      // wording dropped the "still needs to be restored" sentence the moment a
      // moderator supplied a resolution note — so the appellant most likely to
      // be reassured by a personal note was the one who never learned the
      // removal had not actually been undone.
      body:              restorationDeferred
        ? `Your appeal was approved.${resolutionNote ? ` ${resolutionNote}` : ""} ${pendingOf(reversal)?.appellantMessage ?? RESTORATION_PENDING_SENTENCE}`
        : (resolutionNote
            ? `Your appeal was approved. ${resolutionNote}`
            : "Your appeal was approved and the action has been reversed."),
      action_url:        "/appeals",
      metadata: {
        appealId:       id,
        targetType:     (appeal as any).target_type,
        resolutionNote: resolutionNote ?? null,
        reversalAction: reversal!.action,
        // Explicit, so an audit reader never has to infer restoration from the
        // appeal reaching 'approved'.
        restored:       !restorationDeferred,
        ...(restorationDeferred ? { restorationPending: (reversal as any).reason, restorationPendingCode: pendingOf(reversal)?.code ?? null } : {}),
      },
    });
    notified = !notifyErr;
    if (notifyErr) {
      req.log?.error?.(
        { err: notifyErr, appealId: id, appellantId: (appeal as any).appellant_id, restorationDeferred },
        "appeal APPROVED but the appellant was NOT notified — " +
          (restorationDeferred
            ? "they have not been told the restoration is still outstanding"
            : "they have not been told the action was reversed"),
      );
    }
  }

  if (state === "denied") {
    // Notify appellant of denial
    const { error: notifyErr } = await sc.from("notifications").insert({
      user_id:           (appeal as any).appellant_id,
      actor_id:          adminId,
      event_type:        "appeal.denied",
      category:          "admin",
      title:             "Appeal denied",
      body:              resolutionNote
        ? `Your appeal was denied. ${resolutionNote}`
        : "Your appeal was reviewed and denied.",
      action_url:        "/appeals",
      metadata: {
        appealId:       id,
        targetType:     (appeal as any).target_type,
        resolutionNote: resolutionNote ?? null,
      },
    });
    notified = !notifyErr;
    if (notifyErr) {
      req.log?.error?.(
        { err: notifyErr, appealId: id, appellantId: (appeal as any).appellant_id },
        "appeal DENIED but the appellant was NOT notified — they do not know the outcome",
      );
    }
  }

  res.json({
    id:             (updated as any).id,
    state:          (updated as any).state,
    resolutionNote: (updated as any).resolution_note ?? null,
    updatedAt:      (updated as any).updated_at,
    ...(notified === undefined ? {} : { notified }),
    ...(reversal
      ? {
          reversalAction: reversal.action,
          // The admin who approved must see, in the response to their own
          // request, that the restoration is still owed.
          restored:       !restorationDeferred,
          ...(restorationDeferred
            ? {
                restorationRequired: (reversal as any).reason,
                // Point the admin who just approved it at the queue, so the
                // owed restoration is something they can go and look at rather
                // than a sentence that scrolls past once.
                restorationQueue:    RESTORATION_QUEUE_PATH, ...(pendingOf(reversal) ? { restorationPending: pendingOf(reversal) } : {}), // crew full: code, message, retry path
              }
            : {}),
        }
      : {}),
  });
}));

// ── Trust restrictions: what is restricted, for how long, and how to appeal (lane B wave 3, 3933) ──
// Appended at the foot so every cited line above keeps its number.
//
// OD-TRUST-4: "Show the user what is restricted, the reason at an appropriate
// level of detail, duration or review timing, and a clear appeal path."
// Lead ruling D-24: the sentence the person is shown names everything the
// restriction stops (services/trust/TrustPrivacyGuard.ts restrictionSentence).
// The moderator's free-text reason is NOT sent: it may name a reporter (the
// same rule TV-4b's 403 follows, `why: { shared: false }`).

const RESTRICTION_TYPES = new Set<string>(["hosting", "private_plan_access", "messaging", "location_plan_join"]);

/**
 * The caller's ACTIVE restrictions: not lifted, not expired. A failed read is `null`, never an empty list.
 * services/trust owns trust_restrictions (check:trust-table-ownership): its subject seam selects no `reason`.
 */
async function readOwnActiveRestrictions(sc: SupabaseClient, userId: string): Promise<OwnActiveRestrictionRow[] | null> {
  const read = await listOwnActiveRestrictions(sc, userId);
  return read.state === "ok" ? read.rows : null;
}

/**
 * POST /api/appeals with targetType `trust_restriction`: the target must be the
 * appellant's OWN restriction and still active. Writes the refusal and answers
 * false otherwise. An unreadable table is a 503, not a "not found".
 */
async function requireOwnActiveRestriction(sc: SupabaseClient, userId: string, restrictionId: string, req: Request, res: Response): Promise<boolean> {
  const rows = await readOwnActiveRestrictions(sc, userId);
  if (rows === null) {
    req.log.error({ userId }, "appeal: trust_restrictions unreadable");
    sendError(res, "degraded_unavailable", "We couldn't check that restriction right now. Please try again shortly.");
    return false;
  }
  if (!rows.some((r) => r.id === restrictionId)) {
    sendError(res, "not_found", "There is no active restriction on your account with that id.");
    return false;
  }
  return true;
}

/**
 * GET /api/appeals/me/restrictions — the caller's active Trust restrictions,
 * each with the sentence that names what it stops, when it ends, and the appeal
 * path. An unreadable table answers 503: "no restrictions" is a claim this
 * route may only make from a successful read.
 */
router.get("/appeals/me/restrictions", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const rows = await readOwnActiveRestrictions(sc, auth.user.id);
  if (rows === null) {
    req.log.error({ userId: auth.user.id }, "GET /appeals/me/restrictions: trust_restrictions unreadable");
    sendError(res, "degraded_unavailable", "We couldn't load your restrictions right now. Please try again shortly.");
    return;
  }
  res.json({
    restrictions: rows
      .filter((r) => RESTRICTION_TYPES.has(r.restriction_type))
      .map((r) => ({
        id:      r.id,
        type:    r.restriction_type,
        summary: restrictionSentence(r.restriction_type as RestrictionType),
        since:   r.created_at,
        until:   r.expires_at, // null: until it is reviewed or lifted
        why:     { shared: false },
        appeal:  { method: "POST", path: "/api/appeals", targetType: "trust_restriction", targetId: r.id },
      })),
  });
}));

// ── POST /api/appeals/:id/restoration/retry ───────────────────────────────────
// Admin-only. The operator retry path the owner ruled on 2026-10-12 for PR #691:
// "An upheld appeal does not override the crew cap or displace another member.
//  Keep restoration pending with a clear explanation and an operator retry path."
//
// It re-attempts the restoration an UPHELD trip_membership appeal still owes
// (listed in GET /api/appeals/restorations/pending with this path). It does not
// re-decide the appeal and never writes trip_members itself: it re-runs
// resolveAppeal's whole trip_membership path with the retrying admin as the
// kernel actor — the admin check, the removal ledger, the plan, the
// trip_kernel_enabled flag, and ADMIN_RESTORE_PARTICIPANT under the same appeal
// key, which re-checks the cap and the ledger and, with 3979 absent, refuses
// before any write. Idempotent: a member row this appeal already restored is
// recognised before any command is sent, and the appellant is told once.
//   restored            200 restored:true (+ one notice to the appellant)
//   still pending       200 restored:false + restorationPending (crew still full)
//   cannot run now      422 reversal_failed (flag off, 3979 absent, ledger
//                       unreadable, …): nothing written, still pending
// An appeal still under_review is not upheld: approving it (PATCH) runs the restore.
router.post("/appeals/:id/restoration/retry", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid appeal id"); return; }

  const { data: appeal, error: fetchErr } = await sc
    .from("appeals")
    .select("id, appellant_id, target_type, target_id, state, resolution_note")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) { req.log.error({ err: fetchErr }, "restoration retry: appeal read"); sendError(res, "db_error", fetchErr.message); return; }
  if (!appeal) { sendError(res, "not_found", "Appeal not found"); return; }

  const a = appeal as { id: string; appellant_id: string; target_type: string; target_id: string; state: string; resolution_note: string | null };
  if (a.target_type !== "trip_membership") {
    sendError(res, "invalid_payload", "Only an upheld trip_membership appeal has a restoration this path can retry");
    return;
  }
  if (a.state !== "approved") {
    sendError(res, "invalid_state_transition",
      `This appeal is '${a.state}', not upheld. Approving it (PATCH /api/appeals/${id} with state 'approved') runs the restoration.`);
    return;
  }

  const reversal = await resolveAppeal(sc, {
    id: a.id, appellant_id: a.appellant_id, target_type: a.target_type, target_id: a.target_id,
    resolution_note: a.resolution_note ?? null, moderator_id: adminId,
  });
  req.log.info({ appealId: id, reversal }, "appeal restoration retry");

  if (!reversal.ok) {
    sendError(res, "reversal_failed",
      `The restoration was not performed (${reversal.reason}). The appeal stays upheld and the restoration stays pending; retry once the cause is fixed.`);
    return;
  }
  if (isDeferred(reversal)) {
    res.json({
      id, state: a.state, restored: false, reversalAction: reversal.action,
      restorationRequired: reversal.reason, restorationQueue: RESTORATION_QUEUE_PATH,
      ...(pendingOf(reversal) ? { restorationPending: pendingOf(reversal) } : {}),
    });
    return;
  }

  // Restored now (not a replay, not a member who was never gone): tell the
  // appellant once, the same way the approval notice was written.
  let notified: boolean | undefined = undefined;
  if (reversal.restored === true && reversal.replayed !== true) {
    const { error: notifyErr } = await sc.from("notifications").insert({
      user_id:    a.appellant_id,
      actor_id:   adminId,
      event_type: "appeal.approved",
      category:   "admin",
      title:      "Appeal restoration complete",
      body:       reversal.action === "trip_record_access_restored"
        ? "Your access to this trip's record has been restored."
        : "Your place on the trip has been restored. Location sharing stays off until you turn it on again.",
      action_url: "/appeals",
      metadata:   { appealId: id, targetType: a.target_type, reversalAction: reversal.action, restored: true, restorationRetry: true },
    });
    notified = !notifyErr;
    if (notifyErr) req.log?.error?.({ err: notifyErr, appealId: id }, "appeal restoration retried and DONE, but the appellant was NOT notified");
  }

  res.json({
    id, state: a.state, restored: true, reversalAction: reversal.action,
    ...(notified === undefined ? {} : { notified }),
  });
}));

/** The crew-full pending detail a deferred reversal carries, if any (owner ruling 2026-10-12). */
function pendingOf(r: unknown): RestorationPending | null {
  const p = (r as { pending?: RestorationPending } | null)?.pending;
  return p && typeof p === "object" ? p : null;
}

import type { RestorationPending } from "../services/appeals/resolveAppeal.js";
import { restrictionSentence } from "../services/trust/TrustPrivacyGuard.js";
import { listOwnActiveRestrictions, type OwnActiveRestrictionRow, type RestrictionType } from "../services/trust/TrustRestrictionService.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";

export default router;
