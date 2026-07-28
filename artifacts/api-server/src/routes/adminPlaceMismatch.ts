/**
 * Admin place-mismatch report routes.
 *
 *   GET  /admin/place-mismatch-reports?status=pending&limit=50&before=<id>
 *        — paginated list of reports (default status=pending)
 *
 *   POST /admin/place-mismatch-reports/:id/resolve
 *        body: { action: 'accept' | 'reject' }
 *        accept → nulls posts.canonical_place_id so the post re-resolves later
 *        reject → marks report resolved without changing the post
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { asyncHandler } from "../lib/asyncHandler.js";
import { runBackfillTick } from "../lib/places/postPlaceBackfillWorker.js";

const router = Router();

// ── Admin guard ───────────────────────────────────────────────────────────────

async function requireAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

// ── GET /admin/place-mismatch-reports ─────────────────────────────────────────

const listQuerySchema = z.object({
  status: z.enum(["pending", "resolved"]).default("pending"),
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().uuid().optional(),
});

router.get("/admin/place-mismatch-reports", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query params");
    return;
  }
  const { status, limit, before } = parsed.data;

  let q = sc
    .from("place_mismatch_reports")
    .select(
      "id, post_id, reporter_id, reported_place_id, reason, status, resolved_action, resolved_at, created_at",
      { count: "exact" },
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) {
    // Cursor-based pagination: created_at of the row with id=before
    const { data: pivot } = await sc
      .from("place_mismatch_reports")
      .select("created_at")
      .eq("id", before)
      .maybeSingle();
    if ((pivot as any)?.created_at) {
      q = q.lt("created_at", (pivot as any).created_at);
    }
  }

  const { data, error, count } = await q;
  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({
    reports: data ?? [],
    total: count ?? 0,
    status,
  });
}));

// ── POST /admin/place-mismatch-reports/:id/resolve ────────────────────────────

const resolveSchema = z.object({
  action: z.enum(["accept", "reject"]),
});

router.post("/admin/place-mismatch-reports/:id/resolve", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const reportId = req.params["id"];
  if (!reportId) {
    sendError(res, "invalid_payload", "Report ID is required");
    return;
  }

  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { action } = parsed.data;

  // Fetch the report
  const { data: report, error: fetchErr } = await sc
    .from("place_mismatch_reports")
    .select("id, post_id, status, reported_place_id")
    .eq("id", reportId)
    .maybeSingle();

  if (fetchErr || !report) {
    sendError(res, "not_found", "Report not found");
    return;
  }
  if ((report as any).status === "resolved") {
    res.status(409).json({ error: "already_resolved", message: "This report is already resolved" });
    return;
  }

  const now = new Date().toISOString();

  // accept: null the canonical_place_id so the post gets re-queued for resolution,
  // then immediately kick a backfill tick so it is re-resolved without waiting for
  // the next scheduled interval (the worker might have idled since the backlog was 0).
  if (action === "accept") {
    const { error: postErr } = await sc
      .from("posts")
      .update({ canonical_place_id: null })
      .eq("id", (report as any).post_id);

    if (postErr) {
      sendError(res, "db_error", `Failed to clear canonical place: ${postErr.message}`);
      return;
    }

    // Fire-and-forget: kick the backfill so the re-queued post is resolved promptly.
    void runBackfillTick().catch(() => {});
  }

  // Mark the report resolved in both cases
  const { error: resolveErr } = await sc
    .from("place_mismatch_reports")
    .update({
      status:          "resolved",
      resolved_by:     userId,
      resolved_action: action,
      resolved_at:     now,
    })
    .eq("id", reportId);

  if (resolveErr) {
    sendError(res, "db_error", `Failed to resolve report: ${resolveErr.message}`);
    return;
  }

  res.json({ ok: true, action, reportId });
}));

export default router;
