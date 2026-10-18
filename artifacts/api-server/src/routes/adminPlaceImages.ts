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

import { requireAdmin } from "../lib/requireAdmin.js"; import { exactListCount, listTotalRefusal, parseListPage, readEveryRow } from "../lib/moderationCounts.js";

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

  // wave 5: `Number("abc")` is NaN and NaN survived Math.max, so ?page=abc served `.range(NaN, NaN)` — an empty queue page.
  // A page or limit that is not a positive whole number is the default (the house rule); `pagination` names what was served.
  const { page, limit, offset } = parseListPage(req.query, 20, 100);

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

  const { data: visuals, error: visErr, count } = hasReportsFilter === undefined ? await query : await queuePageFilteredByReports(sc, { accuracyStatus, imageSourceType }, hasReportsFilter, offset, limit); // has_reports is applied BEFORE paging (wave 5): it filtered the page after the count, so `total` counted the unfiltered queue and pages came back short
  if (visErr) { sendError(res, "db_error", visErr.message, { exposeDetail: (visErr as any).named === true }); return; } const total = exactListCount(count, visuals, offset); // never `count ?? 0` (wave 5)
  if (total === null) { sendError(res, "db_error", listTotalRefusal("place-image review queue"), { exposeDetail: true }); return; }
  const rows: any[] = visuals as any[];

  // Fetch report counts scoped by (image_url, place_id) so counts from one
  // place never bleed into another even when the same CDN URL is reused.
  const sourceUrls = rows.map((v) => v.source_url).filter(Boolean);
  const reportCountMap = new Map<string, number>();
  if (sourceUrls.length > 0) {
    const { data: repRows, error: repCountErr } = await sc
      .from("place_image_reports")
      .select("image_url, place_id")
      .in("image_url", sourceUrls)
      .eq("status", "pending");
    if (repCountErr || !Array.isArray(repRows)) { sendError(res, "db_error", `The images' pending reports could not be read (reportCount): ${repCountErr?.message ?? "no rows answered"}. A reportCount of 0 would read as "nobody reported this image". Retry.`, { exposeDetail: true }); return; } for (const r of repRows) {
      const key = `${r.image_url}|||${r.place_id}`;
      reportCountMap.set(key, (reportCountMap.get(key) ?? 0) + 1);
    }
  }

  const items = rows.map((v) => {
    // entity_id is the canonical place identifier when entity_type = 'place'
    const placeKey = `${v.source_url}|||${v.entity_id}`;
    return {
      ...v,
      reportCount: reportCountMap.get(placeKey) ?? 0,
      needsReview: isHighImportance(v),
    };
  });

  // has_reports is NOT re-applied here: the page and its `total` were chosen by it above (queuePageFilteredByReports).
  // A report resolved between that read and the reportCount read shows as reportCount 0 on a has_reports=true page —
  // a measured 0, and the image stays on the page it was counted on, so `total` and the pages still agree.

  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      hasMore: total > offset + limit,
    },
  });
}));

// ── GET /admin/place-images/reports ──────────────────────────────────────────

router.get("/admin/place-images/reports", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { withDisplayName: true });
  if (!admin) return;
  const { sc } = admin;

  // wave 5: ?page=abc was NaN (NaN survived Math.max), so the list served `.range(NaN, NaN)`. Not a positive whole number = the default.
  const { page, limit, offset } = parseListPage(req.query, 20, 100);
  // (the house rule: admin.ts /admin/reports, the trips and events queues, the trust review queue)
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
  if (repErr) { sendError(res, "db_error", repErr.message); return; } const total = exactListCount(count, reports, offset); // never `count ?? 0` (wave 5)
  if (total === null) { sendError(res, "db_error", listTotalRefusal("place-image report"), { exposeDetail: true }); return; }
  // Fetch prior review actions scoped by (source_url, entity_id) so we never
  // show actions from a different place that happens to share the same CDN URL.
  const imageUrls = (reports as any[]).map((r: any) => r.image_url).filter(Boolean);
  const visualMap: Record<string, any> = {};
  if (imageUrls.length > 0) {
    const { data: vrows, error: vErr } = await sc
      .from("generated_visuals")
      .select("id, source_url, entity_id, accuracy_status, image_source_type, verified_by, verified_at, canonical_place_id")
      .in("source_url", imageUrls)
      .eq("entity_type", "place");
    if (vErr || !Array.isArray(vrows)) { sendError(res, "db_error", `The reported images' review history could not be read (priorReviewActions): ${vErr?.message ?? "no rows answered"}. A null would read as "never reviewed". Retry.`, { exposeDetail: true }); return; } for (const v of vrows) {
      if (v.source_url && v.entity_id) {
        // Keyed by (url, entity_id) so different places never collide
        const key = `${v.source_url}|||${v.entity_id}`;
        visualMap[key] = v;
      }
    }
  }

  const items = (reports as any[]).map((r: any) => {
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
      total,
      hasMore: total > offset + limit,
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
    const { data: place, error: placeErr } = await sc
      .from("places")
      .select("id, name, primary_category, city, country_code, latitude, longitude")
      .eq("id", placeId)
      .maybeSingle();
    if (placeErr) { sendError(res, "db_error", `The image's place could not be read (place): ${placeErr.message}. A null place would read as "no such place". Retry.`, { exposeDetail: true }); return; } placeData = place ?? null;
  }

  // Fetch user reports scoped by both image URL and entity_id so we only
  // show reports filed against this specific place's image.
  let userReports: any[] = [];
  const visualEntityId = (visual as any).entity_id;
  if ((visual as any).source_url && visualEntityId) {
    const { data: repRows, error: userRepErr } = await sc
      .from("place_image_reports")
      .select("*, reporter:profiles!place_image_reports_reported_by_fkey(id, handle, username)")
      .eq("image_url", (visual as any).source_url)
      .eq("place_id", visualEntityId)
      .order("created_at", { ascending: false });
    if (userRepErr || !Array.isArray(repRows)) { sendError(res, "db_error", `The image's user reports could not be read (userReports): ${userRepErr?.message ?? "no rows answered"}. An empty list would read as "nobody reported this image". Retry.`, { exposeDetail: true }); return; } userReports = repRows;
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

/**
 * GET /admin/place-images/queue?has_reports=true|false — the page, and the
 * filtered queue's total, chosen BEFORE paging (wave 5, the remaining seven).
 *
 * The route paged the queue with an exact count and only then dropped the rows
 * the filter excluded, so `total` counted the UNFILTERED queue, `hasMore` paged
 * on it, and a page held anywhere from 0 to `limit` rows. A reported image on
 * page 3 of the unfiltered order was on no has_reports=true page a moderator
 * could reach by paging until hasMore went false.
 *
 * "Has a report" is the queue's own reportCount rule: a PENDING
 * place_image_reports row on the image's (source_url, place) pair — keyed by
 * both, so a CDN URL reused by another place never counts. The pair cannot be
 * put to PostgREST as one filter, so: every pending report pair is read; every
 * place visual the queue's other filters admit is read (id, pair, created_at —
 * paged past the row cap, lib/moderationCounts.ts readEveryRow); the ones the
 * filter keeps are ordered as the queue is (created_at, newest first), counted,
 * and sliced; then the page's rows are read whole. Answered like a supabase-js
 * read, `{ data, error, count }`, so the route's exactListCount check runs on
 * it unchanged. Any read that fails, answers no list or no exact count, or a
 * page row that vanished before it was read whole, is `error`: never a short
 * page or an unfiltered total.
 */
async function queuePageFilteredByReports(
  sc: any,
  filters: { accuracyStatus?: string; imageSourceType?: string },
  hasReports: boolean,
  offset: number,
  limit: number,
): Promise<{ data: any[] | null; error: { message: string; named?: boolean } | null; count: number | null }> {
  const refuse = (what: string, why: string) => ({ data: null, error: { message: `The has_reports filter could not be applied (${what}): ${why}. A page filtered after paging would miscount the queue. Retry.`, named: true }, count: null });
  const reports = await readEveryRow((from, to) => sc
    .from("place_image_reports")
    .select("id, image_url, place_id", { count: "exact" })
    .eq("status", "pending")
    .order("id", { ascending: true })
    .range(from, to));
  if (reports.error || !reports.data) return refuse("pending reports", reports.error?.message ?? "no rows answered");
  const reported = new Set(reports.data.map((r: any) => `${r.image_url}|||${r.place_id}`));

  const candidates = await readEveryRow((from, to) => {
    let q = sc
      .from("generated_visuals")
      .select("id, source_url, entity_id, created_at", { count: "exact" })
      .eq("entity_type", "place")
      .not("accuracy_status", "eq", "rejected");
    if (filters.accuracyStatus) q = q.eq("accuracy_status", filters.accuracyStatus);
    if (filters.imageSourceType) q = q.eq("image_source_type", filters.imageSourceType);
    return q.order("id", { ascending: true }).range(from, to);
  });
  if (candidates.error || !candidates.data) return refuse("queue", candidates.error?.message ?? "no rows answered");

  const kept = candidates.data
    .filter((v: any) => (Boolean(v.source_url) && reported.has(`${v.source_url}|||${v.entity_id}`)) === hasReports)
    .sort((a: any, b: any) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || String(b.id).localeCompare(String(a.id)));
  const pageIds: string[] = kept.slice(offset, offset + limit).map((v: any) => v.id);
  if (pageIds.length === 0) return { data: [], error: null, count: kept.length };

  const page = await readEveryRow((from, to) => sc.from("generated_visuals").select("*", { count: "exact" }).in("id", pageIds).order("id", { ascending: true }).range(from, to));
  if (page.error || !page.data) return refuse("page rows", page.error?.message ?? "no rows answered");
  const byId = new Map(page.data.map((r: any) => [r.id, r]));
  if (pageIds.some((id) => !byId.has(id))) return refuse("page rows", "an image on this page was removed while the page was read");
  return { data: pageIds.map((id) => byId.get(id)), error: null, count: kept.length };
}

export default router;
