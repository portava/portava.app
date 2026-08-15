/**
 * Admin Place Image Review & Moderation routes
 *
 * Mounted at /api (full paths: /api/admin/place-images/...)
 * All routes require admin role.
 *
 * GET  /admin/place-images/queue                        — paginated review queue
 * GET  /admin/place-images/reports                      — paginated reports queue
 * GET  /admin/place-images/:visualId                    — full provenance detail
 * POST /admin/place-images/:visualId/approve            — approve image
 * POST /admin/place-images/:visualId/reject             — reject image
 * POST /admin/place-images/:visualId/downgrade          — reference_grounded_ai → generic_ai_illustration
 * POST /admin/place-images/:visualId/replace            — replace primary image
 * POST /admin/place-images/reports/:reportId/resolve    — resolve a user report
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { invalidateDiscoveryCacheForEntity } from "../lib/discoveryPersistentCache.js";
import { evictCacheEntriesForEntity } from "./discovery.js";
import { evictStoredPlacePhoto } from "../lib/discoveryPlacePhotoStore.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

/** High-importance: reference_grounded_ai images that need admin sign-off */
function isHighImportance(row: any): boolean {
  return row.image_source_type === "reference_grounded_ai" &&
    row.accuracy_status !== "verified_real" &&
    row.accuracy_status !== "reference_grounded" &&
    row.accuracy_status !== "rejected";
}

// ── GET /admin/place-images/queue ─────────────────────────────────────────────

router.get("/admin/place-images/queue", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc } = admin;

  const page   = Math.max(1, Number(req.query.page  ?? 1));
  const limit  = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const offset = (page - 1) * limit;

  const accuracyStatus   = req.query.accuracy_status   as string | undefined;
  const imageSourceType  = req.query.image_source_type as string | undefined;
  const hasReportsFilter = req.query.has_reports === "true"  ? true
                         : req.query.has_reports === "false" ? false
                         : undefined;

  // Build base query: place visuals only (entity_type = 'place')
  let query = sc
    .from("generated_visuals")
    .select("*", { count: "exact" })
    .eq("entity_type", "place")
    .not("accuracy_status", "eq", "rejected");  // rejected items leave the queue

  if (accuracyStatus) {
    query = query.eq("accuracy_status", accuracyStatus);
  }
  if (imageSourceType) {
    query = query.eq("image_source_type", imageSourceType);
  }

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data: visuals, error: visErr, count } = await query;
  if (visErr) { sendError(res, "db_error", visErr.message); return; }

  const rows: any[] = visuals ?? [];

  // Fetch report counts scoped by (image_url, place_id) so counts from one
  // place never bleed into another even when the same CDN URL is reused.
  const sourceUrls = rows.map((v) => v.source_url).filter(Boolean);
  const reportCountMap = new Map<string, number>();
  if (sourceUrls.length > 0) {
    const { data: repRows } = await sc
      .from("place_image_reports")
      .select("image_url, place_id")
      .in("image_url", sourceUrls)
      .eq("status", "pending");
    for (const r of repRows ?? []) {
      const key = `${r.image_url}|||${r.place_id}`;
      reportCountMap.set(key, (reportCountMap.get(key) ?? 0) + 1);
    }
  }

  let items = rows.map((v) => {
    // entity_id is the canonical place identifier when entity_type = 'place'
    const placeKey = `${v.source_url}|||${v.entity_id}`;
    return {
      ...v,
      reportCount: reportCountMap.get(placeKey) ?? 0,
      needsReview: isHighImportance(v),
    };
  });

  // Apply has_reports filter post-join
  if (hasReportsFilter === true)  items = items.filter((v) => v.reportCount > 0);
  if (hasReportsFilter === false) items = items.filter((v) => v.reportCount === 0);

  res.json({
    items,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      hasMore: (count ?? 0) > offset + limit,
    },
  });
}));

// ── GET /admin/place-images/reports ──────────────────────────────────────────

router.get("/admin/place-images/reports", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc } = admin;

  const page   = Math.max(1, Number(req.query.page  ?? 1));
  const limit  = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const offset = (page - 1) * limit;
  const status = (req.query.status as string) ?? "pending";

  let query = sc
    .from("place_image_reports")
    .select("*, reporter:profiles!place_image_reports_reported_by_fkey(id, handle, username, display_name)", { count: "exact" });

  if (status !== "all") {
    query = query.eq("status", status);
  }

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data: reports, error: repErr, count } = await query;
  if (repErr) { sendError(res, "db_error", repErr.message); return; }

  // Fetch prior review actions scoped by (source_url, entity_id) so we never
  // show actions from a different place that happens to share the same CDN URL.
  const imageUrls = (reports ?? []).map((r: any) => r.image_url).filter(Boolean);
  const visualMap: Record<string, any> = {};
  if (imageUrls.length > 0) {
    const { data: vrows } = await sc
      .from("generated_visuals")
      .select("id, source_url, entity_id, accuracy_status, image_source_type, verified_by, verified_at, canonical_place_id")
      .in("source_url", imageUrls)
      .eq("entity_type", "place");
    for (const v of vrows ?? []) {
      if (v.source_url && v.entity_id) {
        // Keyed by (url, entity_id) so different places never collide
        const key = `${v.source_url}|||${v.entity_id}`;
        visualMap[key] = v;
      }
    }
  }

  const items = (reports ?? []).map((r: any) => {
    const reporter = r.reporter;
    // Privacy-safe display name per display-name privacy rule:
    // use handle (@handle) by default; display_name only if the user has opted in
    // (checked client-side). We never expose real-name columns from the DB here.
    const reporterHandle: string | null =
      reporter?.handle ?? reporter?.username ?? null;
    // Look up visual using the place-scoped compound key
    const priorVisual = visualMap[`${r.image_url}|||${r.place_id}`] ?? null;
    return {
      ...r,
      reporterHandle,
      priorReviewActions: priorVisual
        ? {
            visualId:      priorVisual.id,
            accuracyStatus: priorVisual.accuracy_status,
            verifiedBy:    priorVisual.verified_by,
            verifiedAt:    priorVisual.verified_at,
          }
        : null,
    };
  });

  res.json({
    items,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      hasMore: (count ?? 0) > offset + limit,
    },
  });
}));

// ── GET /admin/place-images/:visualId ─────────────────────────────────────────

router.get("/admin/place-images/:visualId", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc } = admin;

  const { visualId } = req.params;
  if (!isUuid(visualId)) {
    sendError(res, "invalid_payload", "visualId must be a UUID");
    return;
  }

  const { data: visual, error: vErr } = await sc
    .from("generated_visuals")
    .select("*")
    .eq("id", visualId)
    .maybeSingle();

  if (vErr) { sendError(res, "db_error", vErr.message); return; }
  if (!visual) { res.status(404).json({ error: "not_found", message: "Visual not found" }); return; }

  // Fetch canonical place data (if entity_type = 'place')
  let placeData: any = null;
  const placeId = (visual as any).canonical_place_id ?? (visual as any).entity_id ?? null;
  if (placeId && isUuid(placeId)) {
    const { data: place } = await sc
      .from("places")
      .select("id, name, primary_category, city, country_code, latitude, longitude")
      .eq("id", placeId)
      .maybeSingle();
    placeData = place ?? null;
  }

  // Fetch user reports scoped by both image URL and entity_id so we only
  // show reports filed against this specific place's image.
  let userReports: any[] = [];
  const visualEntityId = (visual as any).entity_id;
  if ((visual as any).source_url && visualEntityId) {
    const { data: repRows } = await sc
      .from("place_image_reports")
      .select("*, reporter:profiles!place_image_reports_reported_by_fkey(id, handle, username)")
      .eq("image_url", (visual as any).source_url)
      .eq("place_id", visualEntityId)
      .order("created_at", { ascending: false });
    userReports = repRows ?? [];
  }

  res.json({
    visual,
    place: placeData,
    userReports,
    needsReview: isHighImportance(visual),
  });
}));

// ── POST /admin/place-images/:visualId/approve ────────────────────────────────

router.post("/admin/place-images/:visualId/approve", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc, userId } = admin;

  const { visualId } = req.params;
  if (!isUuid(visualId)) { sendError(res, "invalid_payload", "visualId must be a UUID"); return; }

  const { data: visual, error: vErr } = await sc
    .from("generated_visuals")
    .select("id, accuracy_status, image_source_type, entity_type, entity_id, canonical_place_id")
    .eq("id", visualId)
    .maybeSingle();

  if (vErr) { sendError(res, "db_error", vErr.message); return; }
  if (!visual) { res.status(404).json({ error: "not_found", message: "Visual not found" }); return; }
  if ((visual as any).accuracy_status === "rejected") {
    res.status(409).json({ error: "already_rejected", message: "Rejected images cannot be approved — use unblock first" });
    return;
  }

  // Determine new status: uploaded/real → verified_real; AI-grounded → reference_grounded
  const newStatus = (visual as any).image_source_type === "reference_grounded_ai"
    ? "reference_grounded"
    : "verified_real";

  const now = new Date().toISOString();
  const { error: upErr } = await sc
    .from("generated_visuals")
    .update({
      accuracy_status: newStatus,
      verified_by: userId,
      verified_at: now,
      last_accuracy_reviewed_at: now,
    })
    .eq("id", visualId);

  if (upErr) { sendError(res, "db_error", upErr.message); return; }

  // Evict L1 + L2 cache so the next discovery request re-hydrates this place's image
  if ((visual as any).entity_type === "place") {
    const placeId = (visual as any).canonical_place_id ?? (visual as any).entity_id;
    if (placeId && isUuid(placeId)) {
      evictCacheEntriesForEntity(placeId);
      void evictStoredPlacePhoto(`db/${placeId}`);
      void invalidateDiscoveryCacheForEntity(placeId);
    }
  }

  res.json({ ok: true, visualId, accuracyStatus: newStatus, verifiedAt: now });
}));

// ── POST /admin/place-images/:visualId/reject ─────────────────────────────────

const rejectSchema = z.object({
  reason: z.string().min(1, "reason is required"),
});

router.post("/admin/place-images/:visualId/reject", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc, userId } = admin;

  const { visualId } = req.params;
  if (!isUuid(visualId)) { sendError(res, "invalid_payload", "visualId must be a UUID"); return; }

  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.errors[0]?.message ?? "Invalid body");
    return;
  }

  const { data: visual, error: vErr } = await sc
    .from("generated_visuals")
    .select("id, accuracy_status, entity_type, entity_id, canonical_place_id")
    .eq("id", visualId)
    .maybeSingle();

  if (vErr) { sendError(res, "db_error", vErr.message); return; }
  if (!visual) { res.status(404).json({ error: "not_found", message: "Visual not found" }); return; }
  if ((visual as any).accuracy_status === "rejected") {
    res.status(409).json({ error: "already_rejected", message: "Image is already rejected" });
    return;
  }

  const now = new Date().toISOString();
  const { error: upErr } = await sc
    .from("generated_visuals")
    .update({
      accuracy_status: "rejected",
      verification_status: "rejected",
      verified_by: userId,
      verified_at: now,
      last_accuracy_reviewed_at: now,
      failure_message: parsed.data.reason,
    })
    .eq("id", visualId);

  if (upErr) { sendError(res, "db_error", upErr.message); return; }

  // Clear the place's primary pointer if it points at this visual
  if ((visual as any).entity_type === "place") {
    const placeId = (visual as any).canonical_place_id ?? (visual as any).entity_id;
    if (placeId && isUuid(placeId)) {
      // Defensive: update only if the column exists and points here
      await sc
        .from("places")
        .update({ header_image_generated_id: null } as any)
        .eq("id", placeId)
        .eq("header_image_generated_id" as any, visualId)
        .then(() => { /* best-effort; column may not exist on older schema */ });

      // Evict L1 + L2 cache so resolveHeaderImage re-evaluates on the next request
      evictCacheEntriesForEntity(placeId);
      void evictStoredPlacePhoto(`db/${placeId}`);
      void invalidateDiscoveryCacheForEntity(placeId);
    }
  }

  res.json({ ok: true, visualId, accuracyStatus: "rejected" });
}));

// ── POST /admin/place-images/:visualId/downgrade ──────────────────────────────

router.post("/admin/place-images/:visualId/downgrade", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc, userId } = admin;

  const { visualId } = req.params;
  if (!isUuid(visualId)) { sendError(res, "invalid_payload", "visualId must be a UUID"); return; }

  const { data: visual, error: vErr } = await sc
    .from("generated_visuals")
    .select("id, image_source_type, accuracy_status, entity_type, entity_id, canonical_place_id")
    .eq("id", visualId)
    .maybeSingle();

  if (vErr) { sendError(res, "db_error", vErr.message); return; }
  if (!visual) { res.status(404).json({ error: "not_found", message: "Visual not found" }); return; }
  if ((visual as any).image_source_type !== "reference_grounded_ai") {
    res.status(409).json({
      error: "invalid_state",
      message: "Only reference_grounded_ai images can be downgraded",
    });
    return;
  }

  const now = new Date().toISOString();
  const { error: upErr } = await sc
    .from("generated_visuals")
    .update({
      image_source_type:  "generic_ai_illustration",
      accuracy_status:    "illustrative_only",
      disclaimer_required: true,
      disclaimer_text:    "AI-generated representation — may not depict the actual place",
      verified_by:        userId,
      verified_at:        now,
      last_accuracy_reviewed_at: now,
    })
    .eq("id", visualId);

  if (upErr) { sendError(res, "db_error", upErr.message); return; }

  // Evict L1 + L2 cache so the next discovery request re-hydrates this place's image
  if ((visual as any).entity_type === "place") {
    const placeId = (visual as any).canonical_place_id ?? (visual as any).entity_id;
    if (placeId && isUuid(placeId)) {
      evictCacheEntriesForEntity(placeId);
      void evictStoredPlacePhoto(`db/${placeId}`);
      void invalidateDiscoveryCacheForEntity(placeId);
    }
  }

  res.json({
    ok: true,
    visualId,
    imageSourceType: "generic_ai_illustration",
    accuracyStatus: "illustrative_only",
    disclaimerRequired: true,
  });
}));

// ── POST /admin/place-images/:visualId/replace ────────────────────────────────

const replaceSchema = z.object({
  imageUrl:        z.string().url("imageUrl must be a valid URL"),
  imageSourceType: z.string().min(1, "imageSourceType is required"),
});

router.post("/admin/place-images/:visualId/replace", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc, userId } = admin;

  const { visualId } = req.params;
  if (!isUuid(visualId)) { sendError(res, "invalid_payload", "visualId must be a UUID"); return; }

  const parsed = replaceSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.errors[0]?.message ?? "Invalid body");
    return;
  }

  const { data: visual, error: vErr } = await sc
    .from("generated_visuals")
    .select("*")
    .eq("id", visualId)
    .maybeSingle();

  if (vErr) { sendError(res, "db_error", vErr.message); return; }
  if (!visual) { res.status(404).json({ error: "not_found", message: "Visual not found" }); return; }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  // Archive the old record by stamping replaced_at; preserve original provenance
  const { error: archiveErr } = await sc
    .from("generated_visuals")
    .update({ replaced_at: now })
    .eq("id", visualId);

  if (archiveErr) { sendError(res, "db_error", archiveErr.message); return; }

  // Insert new visual record as the replacement
  const { data: newVisual, error: insertErr } = await sc
    .from("generated_visuals")
    .insert({
      owner_user_id:    (visual as any).owner_user_id,
      entity_type:      (visual as any).entity_type,
      entity_id:        (visual as any).entity_id,
      purpose:          (visual as any).purpose,
      provider:         "admin_upload",
      prompt_version:   "manual",
      prompt_hash:      `replace_${nowMs}`,
      input_snapshot:   {},
      style:            (visual as any).style ?? "portava_editorial",
      aspect_ratio:     (visual as any).aspect_ratio ?? "16:9",
      status:           "ready",
      source_image_url: parsed.data.imageUrl,
      source_url:       parsed.data.imageUrl,
      image_source_type:  parsed.data.imageSourceType,
      accuracy_status:    "unverified",
      canonical_place_id: (visual as any).canonical_place_id,
      provider_place_id:  (visual as any).provider_place_id,
      generated_with_ai:  false,
      disclaimer_required: false,
      verified_by:   userId,
      verified_at:   now,
      last_accuracy_reviewed_at: now,
    })
    .select("id")
    .maybeSingle();

  if (insertErr) { sendError(res, "db_error", insertErr.message); return; }

  // Best-effort: update place's primary pointer to the new visual + evict caches
  if ((visual as any).entity_type === "place") {
    const placeId = (visual as any).canonical_place_id ?? (visual as any).entity_id;
    if (placeId && isUuid(placeId)) {
      if (newVisual?.id) {
        await sc
          .from("places")
          .update({ header_image_generated_id: newVisual.id } as any)
          .eq("id", placeId)
          .then(() => { /* best-effort */ });
      }
      // Evict L1 + L2 cache so the next discovery request re-hydrates this place's image
      evictCacheEntriesForEntity(placeId);
      void evictStoredPlacePhoto(`db/${placeId}`);
      void invalidateDiscoveryCacheForEntity(placeId);
    }
  }

  // Evict L2 cache so the next discovery request re-hydrates with the new image
  if ((visual as any).entity_type === "place") {
    const placeId = (visual as any).canonical_place_id ?? (visual as any).entity_id;
    if (placeId && isUuid(placeId)) {
      void invalidateDiscoveryCacheForEntity(placeId);
    }
  }

  res.json({
    ok: true,
    archivedVisualId: visualId,
    newVisualId: (newVisual as any)?.id ?? null,
  });
}));

// ── POST /admin/place-images/reports/:reportId/resolve ────────────────────────

const resolveSchema = z.object({
  action:     z.enum(["image_replaced", "image_rejected", "no_action"]),
  adminNotes: z.string().optional(),
});

router.post("/admin/place-images/reports/:reportId/resolve", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc, userId } = admin;

  const { reportId } = req.params;
  if (!isUuid(reportId)) { sendError(res, "invalid_payload", "reportId must be a UUID"); return; }

  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.errors[0]?.message ?? "Invalid body");
    return;
  }

  const { data: report, error: repErr } = await sc
    .from("place_image_reports")
    .select("*")
    .eq("id", reportId)
    .maybeSingle();

  if (repErr) { sendError(res, "db_error", repErr.message); return; }
  if (!report) { res.status(404).json({ error: "not_found", message: "Report not found" }); return; }
  // Only pending reports can be reviewed
  if ((report as any).status !== "pending") {
    res.status(409).json({ error: "conflict", message: "Report has already been reviewed" });
    return;
  }

  const now = new Date().toISOString();

  // ── Atomic image rejection: reject the visual FIRST, then update the report.
  // If we cannot apply the image rejection (no matching visual found or DB
  // error) we fail the whole request so the report is never left "reviewed"
  // while the offending image remains active.
  if (parsed.data.action === "image_rejected") {
    const imageUrl = (report as any).image_url;
    if (!imageUrl) {
      res.status(422).json({
        error: "invalid_state",
        message: "Report has no image_url — cannot apply image_rejected action",
      });
      return;
    }

    // Scope by both source_url AND the reported place's entity_id so we
    // never accidentally reject a visual that belongs to a different place
    // that happens to share the same CDN URL.
    //
    // place_image_reports.place_id may arrive as a raw UUID or as a
    // discovery-style "db/<uuid>" prefixed ID — normalise to raw UUID so
    // the entity_id equality check and cache invalidation both work.
    const rawReportPlaceId: string = (report as any).place_id ?? "";
    const reportPlaceId = rawReportPlaceId.startsWith("db/")
      ? rawReportPlaceId.slice(3)
      : rawReportPlaceId;

    const { data: visualRows, error: findErr } = await sc
      .from("generated_visuals")
      .select("id, accuracy_status")
      .eq("source_url", imageUrl)
      .eq("entity_type", "place")
      .eq("entity_id", reportPlaceId)
      .limit(1);

    if (findErr) { sendError(res, "db_error", findErr.message); return; }

    const matchedVisual = visualRows?.[0] ?? null;
    if (!matchedVisual) {
      res.status(422).json({
        error: "invalid_state",
        message: "No place visual found matching the reported image_url and place_id — cannot apply image_rejected action",
      });
      return;
    }

    // Only write if not already rejected (idempotent-safe)
    if ((matchedVisual as any).accuracy_status !== "rejected") {
      const { error: rejectErr } = await sc
        .from("generated_visuals")
        .update({
          accuracy_status:           "rejected",
          verification_status:       "rejected",
          verified_by:               userId,
          verified_at:               now,
          last_accuracy_reviewed_at: now,
          failure_message:           `Rejected via report ${reportId}: ${parsed.data.adminNotes ?? "wrong place image"}`,
        })
        .eq("id", (matchedVisual as any).id);

      if (rejectErr) { sendError(res, "db_error", rejectErr.message); return; }
    }

    // Evict L1 + L2 cache so resolveHeaderImage picks up the rejection on the next request
    if (reportPlaceId && isUuid(reportPlaceId)) {
      evictCacheEntriesForEntity(reportPlaceId);
      void evictStoredPlacePhoto(`db/${reportPlaceId}`);
      void invalidateDiscoveryCacheForEntity(reportPlaceId);
    }
  }

  // Map the three client actions to the two DB status values:
  //   image_rejected → reviewed_rejected  (report accepted; image acted on)
  //   image_replaced → reviewed_accepted  (report accepted; image already replaced)
  //   no_action      → reviewed_accepted  (admin reviewed; no change needed)
  const dbStatus = parsed.data.action === "image_rejected"
    ? "reviewed_rejected"
    : "reviewed_accepted";

  // Visual rejection (if required) succeeded — now mark the report reviewed.
  const { error: upErr } = await sc
    .from("place_image_reports")
    .update({
      status:      dbStatus,
      reviewed_by: userId,
      reviewed_at: now,
    })
    .eq("id", reportId);

  if (upErr) { sendError(res, "db_error", upErr.message); return; }

  res.json({ ok: true, reportId, action: parsed.data.action, status: dbStatus, resolvedAt: now });
}));

export default router;
