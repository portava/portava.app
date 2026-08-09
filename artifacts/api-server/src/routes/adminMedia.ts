/**
 * Admin Media Review routes
 *
 * Mounted at /api (full paths: /api/admin/media/...)
 * All routes require profiles.role = 'admin'.
 *
 * GET  /api/admin/media/processing-failures  — items stuck in non-ready states
 * GET  /api/admin/media/reported             — items with unreviewed reports
 * GET  /api/admin/media/wrong-place          — wrong-place reports for Gems
 * GET  /api/admin/media/gems-pending         — Gems submissions awaiting review
 * GET  /api/admin/media/ai-provenance        — items labelled illustrative/AI-generated
 * POST /api/admin/media/:id/moderate         — approve | reject | flag with action + reason
 *
 * Schema notes (live DB):
 *   reports: target_type, target_id, reason_code, reason_detail, moderation_notes,
 *            reviewed_by, reviewed_at — status: open|reviewed|resolved|dismissed
 *   hidden_gems: status enum = pending|active|hidden|merged
 *                (no reviewed_by/reviewed_at/review_notes columns)
 *   posts: post_status column (not moderation_status); pending_safety_review for flagging
 *   post_media: processing_status, moderation_status (on post_media, not posts)
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

// ── Pagination helper ─────────────────────────────────────────────────────────

function parsePagination(query: any): { page: number; limit: number; offset: number } {
  const page  = Math.max(1, Number(query.page  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
  return { page, limit, offset: (page - 1) * limit };
}

// ── GET /admin/media/processing-failures ─────────────────────────────────────

router.get("/admin/media/processing-failures", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);

  // Find post_media rows that are not in a terminal-success state.
  // Select list deliberately static so the column checker can resolve it.
  const { data, error, count } = await sc
    .from("post_media")
    .select(
      "id, post_id, media_type, processing_status, moderation_status, public_url, thumbnail_url, storage_path, storage_bucket, created_at, updated_at",
      { count: "exact" },
    )
    .in("processing_status", ["failed", "error", "processing", "pending", "queued"])
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { sendError(res, "db_error", error.message); return; }

  const rows: any[] = data ?? [];
  const postIds = [...new Set(rows.map((r) => r.post_id).filter(Boolean))];

  let postMap: Record<string, { author_id: string; has_video: boolean; visibility: string }> = {};
  if (postIds.length > 0) {
    const { data: posts } = await sc
      .from("posts")
      .select("id, author_id, has_video, visibility")
      .in("id", postIds);
    for (const p of posts ?? []) postMap[p.id] = p;
  }

  res.json({
    items: rows.map((r) => ({ ...r, post: postMap[r.post_id] ?? null })),
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── GET /admin/media/reported ─────────────────────────────────────────────────
// Uses the unified reports table: target_type = 'post', status = 'open'

router.get("/admin/media/reported", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);
  const status = (req.query.status as string) ?? "open";

  let query = sc
    .from("reports")
    .select("id, reporter_id, target_type, target_id, reason_code, reason_detail, moderation_notes, severity, status, reviewed_by, reviewed_at, created_at, updated_at", { count: "exact" })
    .eq("target_type", "post");

  if (status !== "all") query = query.eq("status", status);

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  const rows: any[] = data ?? [];

  // Enrich with primary media thumbnail
  const postIds = [...new Set(rows.map((r) => r.target_id).filter(Boolean))];
  let mediaMap: Record<string, { media_type: string; public_url: string | null; thumbnail_url: string | null }> = {};
  if (postIds.length > 0) {
    const { data: media } = await sc
      .from("post_media")
      .select("post_id, media_type, public_url, thumbnail_url")
      .in("post_id", postIds)
      .eq("sort_order", 0);
    for (const m of media ?? []) {
      if (!mediaMap[m.post_id]) mediaMap[m.post_id] = m;
    }
  }

  res.json({
    items: rows.map((r) => ({ ...r, primaryMedia: mediaMap[r.target_id] ?? null })),
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── GET /admin/media/wrong-place ──────────────────────────────────────────────
// Wrong-place reports: reports against hidden_gem entities

router.get("/admin/media/wrong-place", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);
  const status = (req.query.status as string) ?? "open";

  let query = sc
    .from("reports")
    .select("id, reporter_id, target_type, target_id, reason_code, reason_detail, moderation_notes, severity, status, reviewed_by, reviewed_at, created_at, updated_at", { count: "exact" })
    .eq("target_type", "hidden_gem");

  if (status !== "all") query = query.eq("status", status);

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({
    items: (data as any[]) ?? [],
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── GET /admin/media/gems-pending ─────────────────────────────────────────────
// Hidden gems with status = 'pending' (submitted, not yet approved/rejected)

router.get("/admin/media/gems-pending", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);

  // hidden_gems columns: id, name, category, city, description, vibe_tags,
  // submitted_by, status, image_url, created_at, updated_at.
  // There is no place_id column — the gem itself carries name/category/city.
  const { data, error, count } = await sc
    .from("hidden_gems")
    .select("id, name, category, city, submitted_by, status, description, vibe_tags, image_url, created_at, updated_at", { count: "exact" })
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({
    items: (data as any[]) ?? [],
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── GET /admin/media/ai-provenance ────────────────────────────────────────────
// Media items sourced from AI generation (generated_visuals, non-place entities)

router.get("/admin/media/ai-provenance", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);

  // Scope to entity_type='post' so every item is backed by a real post row and
  // the moderate action (updating posts.post_status) is guaranteed to match.
  const { data, error, count } = await sc
    .from("generated_visuals")
    .select("id, entity_type, entity_id, image_source_type, accuracy_status, source_url, generated_with_ai, disclaimer_required, created_at", { count: "exact" })
    .eq("generated_with_ai", true)
    .eq("entity_type", "post")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({
    items: (data as any[]) ?? [],
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── POST /admin/media/:id/moderate ────────────────────────────────────────────

const moderateSchema = z.object({
  action: z.enum(["approve", "reject", "flag"]),
  target: z.enum(["post", "post_media", "hidden_gem", "report"]).optional().default("post"),
  reason: z.string().min(1).max(500).optional(),
});

router.post("/admin/media/:id/moderate", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const { id } = req.params;
  if (!id) { sendError(res, "invalid_payload", "id is required"); return; }

  const parsed = moderateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.errors[0]?.message ?? "Invalid body");
    return;
  }
  const { action, target, reason } = parsed.data;
  const now = new Date().toISOString();

  // Each branch selects the updated row (count) to detect zero-match (false positive).
  if (target === "post") {
    const newStatus =
      action === "approve" ? "published" :
      action === "reject"  ? "removed" :
      "pending_safety_review";

    const { data: updated, error } = await sc
      .from("posts")
      .update({ post_status: newStatus })
      .eq("id", id)
      .select("id");

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!updated || (updated as any[]).length === 0) {
      res.status(404).json({ error: "not_found", message: "Post not found" });
      return;
    }

  } else if (target === "post_media") {
    const newStatus =
      action === "approve" ? "approved" :
      action === "reject"  ? "rejected" :
      "flagged";

    const { data: updated, error } = await sc
      .from("post_media")
      .update({ moderation_status: newStatus })
      .eq("id", id)
      .select("id");

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!updated || (updated as any[]).length === 0) {
      res.status(404).json({ error: "not_found", message: "Media item not found" });
      return;
    }

  } else if (target === "hidden_gem") {
    // hidden_gems status enum: pending | active | hidden | merged
    const newStatus =
      action === "approve" ? "active" :
      "hidden";

    const { data: updated, error } = await sc
      .from("hidden_gems")
      .update({ status: newStatus })
      .eq("id", id)
      .select("id");

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!updated || (updated as any[]).length === 0) {
      res.status(404).json({ error: "not_found", message: "Hidden gem not found" });
      return;
    }

  } else if (target === "report") {
    // reports status: open | reviewed | resolved | dismissed
    const newStatus =
      action === "approve" ? "resolved" :
      action === "reject"  ? "dismissed" :
      "reviewed";

    const { data: updated, error } = await sc
      .from("reports")
      .update({
        status:           newStatus,
        reviewed_by:      userId,
        reviewed_at:      now,
        moderation_notes: reason ?? null,
      })
      .eq("id", id)
      .select("id");

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!updated || (updated as any[]).length === 0) {
      res.status(404).json({ error: "not_found", message: "Report not found" });
      return;
    }
  }

  res.json({ ok: true, id, action, target });
}));

export default router;
