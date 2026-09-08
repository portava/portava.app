/**
 * Moderation routes — V-3
 *
 * POST /api/moderation/report       — file a moderation report
 * GET  /api/moderation/reports/mine — reporter reads own history
 *
 * Design guarantees:
 *   - subject_user_id is ALWAYS derived server-side (never client-supplied).
 *   - Self-reports are rejected 400.
 *   - Duplicate open reports for the same reporter+subject collapse to 200.
 *   - Rate limited: 10 reports per 24 h (per-user, in-process).
 *   - For E2EE message reports: subject_id=messageId, thread_id stored for
 *     future attachment flow.
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { moderationReportRateLimit } from "../lib/rateLimit.js";

import { resolveContentOwner } from "../lib/contentOwner.js";

const router = Router();

// ── Enum constants ─────────────────────────────────────────────────────────────

const SUBJECT_TYPES = [
  "user", "post", "comment", "message", "event", "review", "buddy_listing", "media", "place",
] as const;

const CATEGORIES = [
  "impersonation", "harassment", "scam_fraud", "inappropriate_content",
  "safety_concern", "underage", "spam", "other",
] as const;

/** Place-specific report categories — validated when subjectType === 'place'. */
const PLACE_CATEGORIES = [
  "wrong_place", "wrong_photo", "duplicate", "closed",
  "incorrect_address", "incorrect_category", "outdated_image",
] as const;

// ── Zod schema ────────────────────────────────────────────────────────────────

const ReportSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId:   z.string().uuid("subjectId must be a UUID"),
  category:    z.union([z.enum(CATEGORIES), z.enum(PLACE_CATEGORIES)]),
  details:     z.string().max(500).optional().nullable(),
  /** Only for message reports in E2EE threads */
  threadId:    z.string().uuid().optional().nullable(),
  /** Optional photo evidence URL for safety_concern reports. */
  imageUrl:    z.string().url().max(2048).optional().nullable(),
});

// ── Helper: resolve subject_user_id from the relevant table ───────────────────
//
// Delegates to the shared resolver so intake and the admin moderation paths
// agree on who owns a piece of content. This used to be a second, independent
// implementation; see lib/contentOwner.ts for why having several was a problem.

async function resolveSubjectUserId(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  subjectType: (typeof SUBJECT_TYPES)[number],
  subjectId: string,
): Promise<string | null> {
  return resolveContentOwner(sc, subjectType, subjectId);
}

/* ===========================================================================
 * POST /moderation/report
 * ===========================================================================
 */
router.post("/moderation/report", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  // Rate limit: 10 reports per 24 h
  const rl = moderationReportRateLimit(user.id);
  if (!rl.allowed) {
    const retryAfterSecs = Math.ceil(rl.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSecs));
    sendError(res, "rate_limited", "Too many reports. Please try again later.");
    return;
  }

  const parsed = ReportSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  const { subjectType, subjectId, category, details, threadId, imageUrl } = parsed.data;

  // Self-report guard
  if (subjectType === "user" && subjectId === user.id) {
    sendError(res, "invalid_payload", "Cannot report yourself");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Duplicate open-report collapse.
  //
  // Deliberately NOT fail-closed: this is the abuse-reporting path, and
  // refusing to record a safety report because the dedupe lookup was
  // unreadable would be a strictly worse failure than filing a second copy of
  // one the reporter already sent (the moderation queue collapses those; a
  // report never filed is gone). supabase-js RESOLVES on a DB error, though, so
  // without binding `error` the collapse silently stopped happening and looked
  // identical to a first-time report — hence the explicit log, so a run of
  // duplicate open reports has a visible cause.
  const { data: existing, error: existingErr } = await sc
    .from("moderation_reports")
    .select("id")
    .eq("reporter_id", user.id)
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .eq("status", "open")
    .maybeSingle();

  if (existingErr) {
    req.log.error(
      { err: existingErr, subjectType, subjectId },
      "moderation_reports duplicate-collapse read failed — filing the report anyway; it may duplicate an existing open one",
    );
  }

  if (existing) {
    res.status(200).json({
      reportId: (existing as any).id,
      message:  "Thanks — our team will review this.",
    });
    return;
  }

  // Derive subject_user_id server-side.
  //
  // ── WHY A NULL HERE IS LOGGED AND NOT REFUSED ─────────────────────────────
  // `resolveContentOwner` is documented as never throwing and returning null
  // both for "this content has no accountable user" and for "the owner lookup
  // failed" (lib/contentOwner.ts). For `place` the first is correct by design.
  // For every other subject type a null means the report lands with
  // `subject_user_id: null` and cannot be counted against the person who wrote
  // the thing being reported — the report exists, but the escalation it should
  // feed does not see it.
  //
  // This does NOT refuse: this is the abuse-reporting path, and the deliberate
  // fail-OPEN posture documented on the dedupe read above governs here too. A
  // report filed without attribution is recoverable by a moderator; a report
  // refused because an owner lookup blinked is gone. So the fix is the operator
  // signal that was missing, not a new way to lose a report.
  const subjectUserId = await resolveSubjectUserId(sc, subjectType, subjectId);
  if (!subjectUserId && subjectType !== "place") {
    req.log.error(
      { subjectType, subjectId, reporterId: user.id },
      "moderation report has no accountable subject user — the content row is missing or the owner lookup failed; this report will not be attributed to anyone",
    );
  }

  // Second self-report guard after resolution (for non-user subject types)
  if (subjectUserId && subjectUserId === user.id) {
    sendError(res, "invalid_payload", "Cannot report your own content");
    return;
  }

  const insertRow: Record<string, unknown> = {
    reporter_id:     user.id,
    subject_type:    subjectType,
    subject_id:      subjectId,
    subject_user_id: subjectUserId ?? null,
    category,
    details:         details?.trim() ?? null,
    status:          "open",
  };

  // For message reports: also persist thread_id
  if (subjectType === "message" && threadId) {
    insertRow.thread_id = threadId;
    // TODO(e2ee-report-attachment): recipient device can attach decrypted content here
  }

  // Optional photo evidence (safety_concern reports).
  if (imageUrl) {
    insertRow.image_url = imageUrl;
  }

  const { data: report, error } = await sc
    .from("moderation_reports")
    .insert(insertRow)
    .select("id")
    .single();

  if (error) {
    req.log.error({ err: error }, "moderation_reports insert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json({
    reportId: (report as any).id as string,
    message:  "Thanks — our team will review this.",
  });
}));

/* ===========================================================================
 * GET /moderation/reports/mine
 * ===========================================================================
 * Returns the caller's own report history (RLS permits this).
 */
router.get("/moderation/reports/mine", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit = Math.min(Number(req.query.limit ?? 50), 100);

  const { data, error } = await sc
    .from("moderation_reports")
    .select("id, subject_type, category, status, created_at")
    .eq("reporter_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log.error({ err: error }, "moderation_reports/mine fetch failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ reports: data ?? [] });
}));

export default router;
