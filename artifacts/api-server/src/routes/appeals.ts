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
import { resolveAppeal } from "../services/appeals/resolveAppeal.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

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
    "review",
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
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

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
    } else {
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
  if (state === "approved") {
    reversal = await resolveAppeal(sc, {
      id:              (appeal as any).id,
      appellant_id:    (appeal as any).appellant_id,
      target_type:     (appeal as any).target_type,
      target_id:       (appeal as any).target_id,
      resolution_note: resolutionNote ?? null,
    });

    req.log.info({ appealId: id, reversal }, "appeal reversal");

    if (!reversal.ok) {
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

  if (state === "approved") {
    // Notify appellant
    await sc.from("notifications").insert({
      user_id:           (appeal as any).appellant_id,
      actor_id:          adminId,
      event_type:        "appeal.approved",
      category:          "admin",
      title:             "Appeal approved",
      body:              resolutionNote
        ? `Your appeal was approved. ${resolutionNote}`
        : "Your appeal was approved and the action has been reversed.",
      action_url:        "/appeals",
      metadata: {
        appealId:       id,
        targetType:     (appeal as any).target_type,
        resolutionNote: resolutionNote ?? null,
        reversalAction: reversal!.action,
      },
    }).then(() => {}).catch(() => {});
  }

  if (state === "denied") {
    // Notify appellant of denial
    await sc.from("notifications").insert({
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
    }).then(() => {}).catch(() => {});
  }

  res.json({
    id:             (updated as any).id,
    state:          (updated as any).state,
    resolutionNote: (updated as any).resolution_note ?? null,
    updatedAt:      (updated as any).updated_at,
  });
}));

export default router;
