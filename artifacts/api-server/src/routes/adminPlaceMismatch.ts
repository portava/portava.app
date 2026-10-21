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
import { sendError } from "../lib/http";
import { asyncHandler } from "../lib/asyncHandler.js";
import { runBackfillTick } from "../lib/places/postPlaceBackfillWorker.js";
import { requireAdmin } from "../lib/requireAdmin.js"; import { exactListCount, listTotalRefusal } from "../lib/moderationCounts.js";

const router = Router();

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
      "id, post_id, reporter_id, reported_place_id, reason, status, resolved_action, resolved_at, created_at, posts!post_id(content), places!reported_place_id(name)",
      { count: "exact" },
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) {
    // Cursor-based pagination: created_at of the row with id=before
    const { data: pivot, error: pivotErr } = await sc
      .from("place_mismatch_reports")
      .select("created_at")
      .eq("id", before)
      .maybeSingle();
    if (pivotErr) { sendError(res, "db_error", `The page cursor could not be read: ${pivotErr.message}. Retry.`, { exposeDetail: true }); return; } // was ignored: a failed cursor read served page 1 again as if it were the next page
    if (!(pivot as any)?.created_at) { sendError(res, "invalid_payload", "`before` names no report (it may have been removed). Restart from the first page."); return; }
    q = q.lt("created_at", (pivot as any).created_at);
  }

  const { data, error, count } = await q;
  if (error) {
    sendError(res, "db_error", error.message);
    return;
  } const total = exactListCount(count, data); // never `count ?? 0` (wave 5): a count-less answer read as "no wrong-place reports"
  if (total === null) { sendError(res, "db_error", listTotalRefusal("place-mismatch report"), { exposeDetail: true }); return; }
  // Flatten the joined post content and place name into top-level fields
  const reports = (data as any[]).map((row: any) => {
    const { posts, places, ...rest } = row;
    return {
      ...rest,
      post_content: (posts as any)?.content ?? null,
      place_name:   (places as any)?.name   ?? null,
    };
  });

  res.json({
    reports,
    total,
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

  // Fetch the report — with the resolution fields, so a claim undone below restores exactly what was read
  const { data: report, error: fetchErr } = await sc
    .from("place_mismatch_reports")
    .select("id, post_id, status, reported_place_id, resolved_by, resolved_action, resolved_at")
    .eq("id", reportId)
    .maybeSingle();

  if (fetchErr) { sendError(res, "db_error", fetchErr.message); return; } if (!report) { // a failed read is not "no such report" (it answered 404)
    sendError(res, "not_found", "Report not found");
    return;
  }
  if ((report as any).status === "resolved") {
    res.status(409).json({ error: "already_resolved", message: "This report is already resolved" });
    return;
  }

  const now = new Date().toISOString();

  // CLAIM FIRST (wave 5), guarded on the status this request READ, as lib/legacyReportClose.ts claims a legacy
  // report. The update was unguarded and ran LAST, after accept had already cleared the post's place: two admins
  // resolving at once both "won", the second overwrote the first's resolved_by / resolved_action, and an accept
  // could clear a post the report then said was rejected. Now exactly one resolve moves the row; zero rows is a
  // 409 with NOTHING written (the post untouched), and a claim that answers no rows to count is not called success.
  const { data: claimed, error: claimErr } = await sc
    .from("place_mismatch_reports")
    .update({ status: "resolved", resolved_by: userId, resolved_action: action, resolved_at: now })
    .eq("id", reportId)
    .eq("status", (report as any).status)
    .select("id");
  if (claimErr) { sendError(res, "db_error", `Failed to resolve report: ${claimErr.message}. Nothing was changed.`, { exposeDetail: true }); return; }
  if (!Array.isArray(claimed)) { sendError(res, "db_error", "The resolve answered no rows to count; whether the report moved is unknown. Re-read it before retrying.", { exposeDetail: true }); return; }
  if (claimed.length === 0) { res.status(409).json({ error: "already_resolved", message: "This report was resolved by someone else while this request ran. Nothing was changed." }); return; }

  // accept: null the canonical_place_id so the post gets re-queued for resolution, then immediately kick a backfill
  // tick so it is re-resolved without waiting for the next scheduled interval (the worker might have idled since the
  // backlog was 0). If the post cannot be cleared, the claim above is UNDONE — back to what the report held when
  // read, guarded on this request's own resolved_at — so the report never reads "accepted" over a post left as it was.
  if (action === "accept") {
    const { error: postErr } = await sc
      .from("posts")
      .update({ canonical_place_id: null })
      .eq("id", (report as any).post_id);

    if (postErr) {
      const prior = { status: (report as any).status, resolved_by: (report as any).resolved_by ?? null, resolved_action: (report as any).resolved_action ?? null, resolved_at: (report as any).resolved_at ?? null };
      const { data: undone, error: undoErr } = await sc.from("place_mismatch_reports").update(prior).eq("id", reportId).eq("status", "resolved").eq("resolved_at", now).select("id");
      const restored = !undoErr && Array.isArray(undone) && undone.length === 1;
      sendError(res, "db_error", `Failed to clear canonical place: ${postErr.message}. ${restored ? `The report was restored to '${prior.status}'; nothing was changed.` : `The report could NOT be restored (${undoErr?.message ?? "no row matched"}): it reads resolved (accept) over a post whose place was not cleared. Fix by hand.`}`, { exposeDetail: true });
      return;
    }

    // Fire-and-forget: kick the backfill so the re-queued post is resolved promptly.
    void runBackfillTick().catch(() => {});
  }

  res.json({ ok: true, action, reportId });
}));

export default router;
