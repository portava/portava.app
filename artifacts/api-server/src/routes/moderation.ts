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
});

// ── Helper: resolve subject_user_id from the relevant table ───────────────────

async function resolveSubjectUserId(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  subjectType: (typeof SUBJECT_TYPES)[number],
  subjectId: string,
): Promise<string | null> {
  try {
    switch (subjectType) {
      case "user":
        return subjectId;

      case "post": {
        const { data } = await sc
          .from("posts")
          .select("author_id")
          .eq("id", subjectId)
          .maybeSingle();
        return (data as any)?.author_id ?? null;
      }

      case "comment": {
        // posts_comments.user_id is the comment author
        const { data } = await sc
          .from("posts_comments")
          .select("user_id")
          .eq("id", subjectId)
          .maybeSingle();
        return (data as any)?.user_id ?? null;
      }

      case "message": {
        const { data } = await sc
          .from("messages")
          .select("sender_id")
          .eq("id", subjectId)
          .maybeSingle();
        return (data as any)?.sender_id ?? null;
      }

      case "event": {
        const { data } = await sc
          .from("events")
          .select("host_id")
          .eq("id", subjectId)
          .maybeSingle();
        return (data as any)?.host_id ?? null;
      }

      case "review": {
        const { data } = await sc
          .from("reviews")
          .select("reviewer_id")
          .eq("id", subjectId)
          .maybeSingle();
        return (data as any)?.reviewer_id ?? null;
      }

      case "media": {
        // Canonical media asset (migration 0189) — owner is the accountable user.
        const { data } = await sc
          .from("media_assets")
          .select("owner_user_id")
          .eq("id", subjectId)
          .maybeSingle();
        return (data as any)?.owner_user_id ?? null;
      }

      case "buddy_listing": {
        // rent_buddy_profiles keyed by user_id
        const { data } = await sc
          .from("rent_buddy_profiles")
          .select("user_id")
          .eq("id", subjectId)
          .maybeSingle();
        if ((data as any)?.user_id) return (data as any).user_id;
        // fallback: subjectId might be a userId directly
        const { data: byUser } = await sc
          .from("rent_buddy_profiles")
          .select("user_id")
          .eq("user_id", subjectId)
          .maybeSingle();
        return (byUser as any)?.user_id ?? null;
      }

      case "place":
        // Canonical places are not owned by a single user — no subject_user_id.
        return null;

      default:
        return null;
    }
  } catch {
    return null;
  }
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

  const { subjectType, subjectId, category, details, threadId } = parsed.data;

  // Self-report guard
  if (subjectType === "user" && subjectId === user.id) {
    sendError(res, "invalid_payload", "Cannot report yourself");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Duplicate open-report collapse
  const { data: existing } = await sc
    .from("moderation_reports")
    .select("id")
    .eq("reporter_id", user.id)
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .eq("status", "open")
    .maybeSingle();

  if (existing) {
    res.status(200).json({
      reportId: (existing as any).id,
      message:  "Thanks — our team will review this.",
    });
    return;
  }

  // Derive subject_user_id server-side
  const subjectUserId = await resolveSubjectUserId(sc, subjectType, subjectId);

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
