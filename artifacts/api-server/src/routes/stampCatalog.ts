/**
 * Universal Stamp Catalog Routes — Public + Admin
 *
 * Mounted at /api (full paths: /api/stamps/catalog/...)
 *
 * Public (no auth required for approved entries):
 *   GET  /stamps/catalog/:canonicalKeyOrId   — single approved catalog entry
 *   POST /stamps/catalog/batch               — bulk approved entries by IDs
 *
 * Admin (requireAdmin):
 *   GET    /admin/stamps/catalog                     — paginated list with filters + status counts
 *   GET    /admin/stamps/catalog/:id                 — full detail: metadata + artwork + earn history + queue
 *   GET    /admin/stamps/queue                       — generation queue list
 *   GET    /admin/stamps/duplicates                  — potential duplicate detection
 *   POST   /admin/stamps/catalog                     — manually create catalog entry
 *   PATCH  /admin/stamps/catalog/:id/activate-version — approve a version, set as active
 *   PATCH  /admin/stamps/catalog/:id/reject          — reject catalog entry
 *   POST   /admin/stamps/catalog/:id/regenerate      — archive candidates, re-queue
 *   POST   /admin/stamps/catalog/:id/upload          — multipart upload replacement image
 *   POST   /admin/stamps/catalog/:id/merge-into/:targetId — merge duplicate into canonical
 *   GET    /admin/stamps/catalog/:id/earners         — paginated earner list
 *   POST   /admin/stamps/reconcile                   — run catalog reconciliation (idempotent)
 *   GET    /admin/stamps/reconcile/runs              — recent reconciler run history (parsed counts)
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { z } from "zod";
import { sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { randomUUID } from "crypto";
import { invalidateCatalogCache } from "../lib/stamps/StampCatalogService.js";
import { STYLE_VERSION } from "../lib/stamps/artDirection.js";
import { runReconciliation, RUN_SUMMARY_SOURCE_TABLE } from "../lib/stamps/reconcileStampCatalog.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

// ── Write admin audit log ─────────────────────────────────────────────────────

async function writeAuditLog(
  sc: any,
  adminId: string,
  action: string,
  opts: {
    catalogId?: string;
    versionId?: string;
    targetCatalogId?: string;
    notes?: string;
  } = {}
): Promise<void> {
  const { error } = await sc.from("stamp_admin_audit_log").insert({
    admin_id:          adminId,
    action,
    catalog_id:        opts.catalogId ?? null,
    version_id:        opts.versionId ?? null,
    target_catalog_id: opts.targetCatalogId ?? null,
    notes:             opts.notes ?? null,
  });
  if (error) {
    console.error(
      "[stamp-admin-audit] failed to write audit log entry",
      JSON.stringify({
        action,
        catalog_id: opts.catalogId ?? null,
        admin_id:   adminId,
        error:      error.message ?? String(error),
      })
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /stamps/catalog/batch (POST for bulk) ─────────────────────────────────

router.post("/stamps/catalog/batch", asyncHandler(async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { catalogIds } = req.body ?? {};
  if (!Array.isArray(catalogIds) || catalogIds.length === 0) {
    res.json({ entries: [] });
    return;
  }

  const ids = catalogIds.filter(isUuid).slice(0, 100);

  const { data, error } = await sc
    .from("universal_stamp_catalog")
    .select(
      "id, canonical_location_key, stamp_type, display_name, country, country_code, " +
      "region, city, neighborhood, status, active_version_id, earn_count, created_at, " +
      "stamp_artwork_versions!fk_catalog_active_version(public_url)"
    )
    .in("id", ids)
    .eq("status", "approved");

  if (error) { sendError(res, "db_error", error.message); return; }

  const entries = ((data ?? []) as any[]).map(shapePublicEntry);
  res.json({ entries });
}));

// ── GET /stamps/catalog/:canonicalKeyOrId ─────────────────────────────────────

router.get("/stamps/catalog/:canonicalKeyOrId", asyncHandler(async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { canonicalKeyOrId } = req.params;
  const isId = isUuid(canonicalKeyOrId);

  let query = sc
    .from("universal_stamp_catalog")
    .select(
      "id, canonical_location_key, stamp_type, display_name, country, country_code, " +
      "region, city, neighborhood, status, active_version_id, earn_count, created_at, " +
      "stamp_artwork_versions!fk_catalog_active_version(public_url)"
    )
    .eq("status", "approved");

  if (isId) {
    query = (query as any).eq("id", canonicalKeyOrId);
  } else {
    query = (query as any).eq("canonical_location_key", canonicalKeyOrId);
  }

  const { data, error } = await (query as any).maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Catalog entry not found"); return; }

  res.json({ entry: shapePublicEntry(data as any) });
}));

function shapePublicEntry(row: any) {
  const activeVersion = Array.isArray(row.stamp_artwork_versions)
    ? row.stamp_artwork_versions[0]
    : row.stamp_artwork_versions;
  return {
    id:                    row.id,
    canonicalLocationKey:  row.canonical_location_key,
    stampType:             row.stamp_type,
    displayName:           row.display_name,
    country:               row.country,
    countryCode:           row.country_code,
    region:                row.region ?? null,
    city:                  row.city ?? null,
    neighborhood:          row.neighborhood ?? null,
    status:                row.status,
    activeVersionId:       row.active_version_id ?? null,
    activeArtworkUrl:      activeVersion?.public_url ?? null,
    earnCount:             row.earn_count ?? 0,
    createdAt:             row.created_at,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /admin/stamps/catalog ─────────────────────────────────────────────────

router.get("/admin/stamps/catalog", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page      = Math.max(1, Number(req.query.page) || 1);
  const limit     = Math.min(100, Number(req.query.limit) || 50);
  const status    = req.query.status as string | undefined;
  const stampType = req.query.stamp_type as string | undefined;
  const cc        = req.query.country_code as string | undefined;
  const search    = req.query.search as string | undefined;

  let q = sc
    .from("universal_stamp_catalog")
    .select(
      "id, canonical_location_key, stamp_type, display_name, country, country_code, " +
      "status, active_version_id, earn_count, created_at, updated_at",
      { count: "exact" }
    )
    .order("updated_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status)    q = (q as any).eq("status", status);
  if (stampType) q = (q as any).eq("stamp_type", stampType);
  if (cc)        q = (q as any).eq("country_code", cc.toUpperCase());
  if (search)    q = (q as any).ilike("display_name", `%${search}%`);

  const { data, error, count } = await q;
  if (error) { sendError(res, "db_error", error.message); return; }

  // Attach queue last_error to review_required entries so the list can flag
  // degraded generations (e.g. candidate_shortfall) without opening each row.
  const entries: any[] = (data ?? []) as any[];
  const reviewIds = entries.filter((e) => e.status === "review_required").map((e) => e.id);
  if (reviewIds.length > 0) {
    const { data: queueRows } = await sc
      .from("stamp_generation_queue")
      .select("catalog_id, last_error")
      .in("catalog_id", reviewIds)
      .eq("status", "review_required");
    const errByCatalog = new Map<string, string | null>(
      ((queueRows ?? []) as any[]).map((r) => [r.catalog_id, r.last_error ?? null])
    );
    for (const e of entries) {
      if (errByCatalog.has(e.id)) e.last_error = errByCatalog.get(e.id);
    }
  }

  // Attach active queue status (queued/processing) to any entry that has a
  // live job, regardless of catalog status. This surfaces partial-failure
  // states (e.g. a stale "rejected" status after a regenerate whose catalog
  // status reset failed) without requiring the operator to open each row.
  if (entries.length > 0) {
    const { data: activeRows } = await sc
      .from("stamp_generation_queue")
      .select("catalog_id, status")
      .in("catalog_id", entries.map((e) => e.id))
      .in("status", ["queued", "processing"]);
    const activeByCatalog = new Map<string, string>(
      ((activeRows ?? []) as any[]).map((r) => [r.catalog_id, r.status])
    );
    for (const e of entries) {
      if (activeByCatalog.has(e.id)) e.queue_status = activeByCatalog.get(e.id);
    }
  }

  // Status counts
  const { data: counts } = await sc
    .from("universal_stamp_catalog")
    .select("status")
    .then((r: any) => r);

  const statusCounts: Record<string, number> = {
    pending_artwork: 0,
    approved: 0,
    rejected: 0,
    archived: 0,
    review_required: 0,
    retryable_failed: 0,
  };

  // Queue review_required count
  const { count: reviewCount } = await sc
    .from("stamp_generation_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "review_required");

  statusCounts.review_required = reviewCount ?? 0;

  // Queue failed count (jobs that exhausted retries, incl. permanently failed)
  const { count: failedCount } = await sc
    .from("stamp_generation_queue")
    .select("id", { count: "exact", head: true })
    .in("status", ["retryable_failed", "permanently_failed"]);

  statusCounts.retryable_failed = failedCount ?? 0;

  for (const row of ((counts ?? []) as any[])) {
    if (statusCounts[row.status] !== undefined) {
      statusCounts[row.status]++;
    }
  }

  res.json({
    entries,
    total: count ?? 0,
    page,
    statusCounts,
  });
}));

// ── GET /admin/stamps/queue ───────────────────────────────────────────────────

router.get("/admin/stamps/queue", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page   = Math.max(1, Number(req.query.page) || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 50);
  const status = req.query.status as string | undefined;

  let q = sc
    .from("stamp_generation_queue")
    .select(
      "id, catalog_id, status, priority, attempts, max_attempts, last_error, " +
      "cleanup_error, cleanup_error_paths, " +
      "requeue_count, locked_until, triggered_by_action, created_at, updated_at, " +
      "universal_stamp_catalog(display_name, stamp_type, country_code)",
      { count: "exact" }
    )
    .order("priority")
    .order("created_at")
    .range((page - 1) * limit, page * limit - 1);

  // `status` accepts a comma-separated list, e.g. "retryable_failed,permanently_failed"
  if (status) {
    const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
    q = statuses.length > 1 ? (q as any).in("status", statuses) : (q as any).eq("status", statuses[0]);
  }

  const { data, error, count } = await q;
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ jobs: data ?? [], total: count ?? 0, page });
}));

// ── GET /admin/stamps/duplicates ──────────────────────────────────────────────

router.get("/admin/stamps/duplicates", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  // Detect potential duplicates: same stamp_type, close lat/lng (0.5° grid)
  const { data, error } = await sc
    .from("universal_stamp_catalog")
    .select("id, canonical_location_key, stamp_type, display_name, country_code, lat, lng, earn_count, status")
    .not("lat", "is", null)
    .not("lng", "is", null)
    .limit(500);

  if (error) { sendError(res, "db_error", error.message); return; }

  const rows = (data ?? []) as any[];
  const duplicates: Array<{ a: any; b: any; reason: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];

      if (a.stamp_type !== b.stamp_type) continue;

      // Coordinate proximity check (0.5° ≈ 55 km at equator)
      const dlat = Math.abs((a.lat ?? 0) - (b.lat ?? 0));
      const dlng = Math.abs((a.lng ?? 0) - (b.lng ?? 0));
      if (dlat < 0.5 && dlng < 0.5) {
        duplicates.push({ a, b, reason: "coordinate_proximity" });
        continue;
      }

      // Simple name similarity: same country_code + similar display_name
      if (a.country_code === b.country_code) {
        const an = a.display_name?.toLowerCase() ?? "";
        const bn = b.display_name?.toLowerCase() ?? "";
        // Check if one is a substring of the other
        if ((an.includes(bn) || bn.includes(an)) && Math.abs(an.length - bn.length) <= 5) {
          duplicates.push({ a, b, reason: "name_similarity" });
        }
      }
    }
  }

  res.json({ duplicates: duplicates.slice(0, 100) });
}));

// ── GET /admin/stamps/catalog/:id ─────────────────────────────────────────────

router.get("/admin/stamps/catalog/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid catalog id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const [catalogRes, versionsRes, queueRes, auditRes, earnRes] = await Promise.all([
    sc.from("universal_stamp_catalog")
      .select("*")
      .eq("id", id)
      .maybeSingle(),
    sc.from("stamp_artwork_versions")
      .select("*")
      .eq("catalog_id", id)
      .order("created_at", { ascending: false }),
    sc.from("stamp_generation_queue")
      .select("*")
      .eq("catalog_id", id)
      .not("status", "in", '("archived")')
      .maybeSingle(),
    sc.from("stamp_admin_audit_log")
      .select("id, admin_id, action, version_id, notes, created_at")
      .eq("catalog_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    sc.from("user_stamps")
      .select("id, user_id, earned_at, source_type")
      .eq("catalog_id", id)
      .order("earned_at", { ascending: false })
      .limit(10),
  ]);

  if (catalogRes.error || !catalogRes.data) {
    sendError(res, "not_found", "Catalog entry not found"); return;
  }

  res.json({
    entry:    catalogRes.data,
    versions: versionsRes.data ?? [],
    queue:    queueRes.data ?? null,
    audit:    auditRes.data ?? [],
    earnSample: earnRes.data ?? [],
  });
}));

// ── GET /admin/stamps/catalog/:id/earners ─────────────────────────────────────

router.get("/admin/stamps/catalog/:id/earners", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid catalog id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page  = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error, count } = await sc
    .from("user_stamps")
    .select("id, user_id, earned_at, source_type, profiles!user_stamps_user_id_fkey(username, display_name)", { count: "exact" })
    .eq("catalog_id", id)
    .order("earned_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ earners: data ?? [], total: count ?? 0, page });
}));

// ── POST /admin/stamps/catalog ─────────────────────────────────────────────────

export const createCatalogSchema = z.object({
  canonicalLocationKey: z.string().min(1),
  stampType:            z.string().min(1),
  displayName:          z.string().min(1).max(200),
  country:              z.string().min(1),
  countryCode:          z.string().length(2),
  region:               z.string().optional(),
  city:                 z.string().optional(),
  neighborhood:         z.string().optional(),
  lat:                  z.number().optional(),
  lng:                  z.number().optional(),
});

router.post("/admin/stamps/catalog", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const parsed = createCatalogSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }
  const d = parsed.data;

  const { data, error } = await sc
    .from("universal_stamp_catalog")
    .insert({
      canonical_location_key: d.canonicalLocationKey,
      stamp_type:             d.stampType,
      display_name:           d.displayName,
      country:                d.country,
      country_code:           d.countryCode.toUpperCase(),
      region:                 d.region ?? null,
      city:                   d.city ?? null,
      neighborhood:           d.neighborhood ?? null,
      lat:                    d.lat ?? null,
      lng:                    d.lng ?? null,
      status:                 "pending_artwork",
      prompt_template_version: STYLE_VERSION,
    })
    .select()
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }

  await writeAuditLog(sc, adminId, "create", {
    catalogId: (data as any).id,
    notes:     `Manually created: ${d.displayName}`,
  });

  res.status(201).json({ entry: data });
}));

// ── PATCH /admin/stamps/catalog/:id/activate-version ─────────────────────────

const activateVersionSchema = z.object({
  versionId: z.string().uuid(),
  notes:     z.string().optional(),
});

router.patch("/admin/stamps/catalog/:id/activate-version", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid catalog id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const parsed = activateVersionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }
  const { versionId, notes } = parsed.data;

  // Approve the version row.
  // Guard: .neq("status","approved") ensures a second call with the same
  // versionId finds no matching row and returns null — preventing a duplicate
  // audit log entry.
  const { data: versionRow, error: vErr } = await sc
    .from("stamp_artwork_versions")
    .update({
      status:              "approved",
      reviewed_by_admin_id: adminId,
      reviewed_at:         new Date().toISOString(),
    })
    .eq("id", versionId)
    .eq("catalog_id", id)
    .neq("status", "approved")
    .select("id, public_url")
    .maybeSingle();

  if (vErr) {
    sendError(res, "db_error", vErr.message);
    return;
  }

  if (!versionRow) {
    // Either the version doesn't exist for this catalog entry, or it is
    // already approved.  Fetch the current row to distinguish the two cases.
    const { data: existingVersion } = await sc
      .from("stamp_artwork_versions")
      .select("id, public_url")
      .eq("id", versionId)
      .eq("catalog_id", id)
      .maybeSingle();

    if (!existingVersion) {
      sendError(res, "not_found", "Version not found for this catalog entry");
      return;
    }

    // Already approved — idempotent success, no duplicate audit log.
    const { data: existingCatalog, error: catFetchErr } = await sc
      .from("universal_stamp_catalog")
      .select()
      .eq("id", id)
      .maybeSingle();

    if (catFetchErr) {
      sendError(res, "db_error", catFetchErr.message);
      return;
    }

    if (!existingCatalog) {
      sendError(res, "not_found", "Catalog entry not found");
      return;
    }

    res.json({ entry: existingCatalog, version: existingVersion });
    return;
  }

  // Update catalog entry: set active version, approve status
  const { data: catalogRow, error: catErr } = await sc
    .from("universal_stamp_catalog")
    .update({
      active_version_id: versionId,
      status:            "approved",
      updated_at:        new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (catErr || !catalogRow) {
    sendError(res, "db_error", catErr?.message ?? "Catalog update failed");
    return;
  }

  // Archive other candidate versions for this catalog entry
  await sc
    .from("stamp_artwork_versions")
    .update({ status: "archived" })
    .eq("catalog_id", id)
    .eq("status", "candidate")
    .neq("id", versionId);

  // Invalidate cache
  invalidateCatalogCache(
    (catalogRow as any).canonical_location_key,
    (catalogRow as any).stamp_type
  );

  await writeAuditLog(sc, adminId, "activate_version", {
    catalogId: id,
    versionId,
    notes:     notes ?? `Activated version ${versionId}`,
  });

  console.log(JSON.stringify({ event: "stamp.admin.approved", catalog_id: id, version_id: versionId, admin_id: adminId }));

  res.json({ entry: catalogRow, version: versionRow });
}));

// ── PATCH /admin/stamps/catalog/:id/reject ────────────────────────────────────

const rejectCatalogSchema = z.object({
  reason: z.string().min(1).max(500),
});

router.patch("/admin/stamps/catalog/:id/reject", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid catalog id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const parsed = rejectCatalogSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message);
    return;
  }

  const { data, error } = await sc
    .from("universal_stamp_catalog")
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", id)
    .neq("status", "rejected") // Guard: skip update (and audit log) if already rejected
    .select()
    .maybeSingle();

  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  if (!data) {
    // Either the entry doesn't exist or it was already rejected.
    // Fetch the current row to distinguish the two cases.
    const { data: existing } = await sc
      .from("universal_stamp_catalog")
      .select()
      .eq("id", id)
      .maybeSingle();

    if (!existing) {
      sendError(res, "not_found", "Catalog entry not found");
      return;
    }

    // Already rejected — idempotent success, no duplicate audit log.
    res.json({ entry: existing });
    return;
  }

  invalidateCatalogCache((data as any).canonical_location_key, (data as any).stamp_type);

  await writeAuditLog(sc, adminId, "reject", {
    catalogId: id,
    notes:     parsed.data.reason,
  });

  res.json({ entry: data });
}));

// ── POST /admin/stamps/catalog/:id/regenerate ─────────────────────────────────

router.post("/admin/stamps/catalog/:id/regenerate", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid catalog id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  // Archive existing candidate versions.
  // Non-fatal on failure: the regenerate still proceeds, but the failure must
  // be observable in server logs — otherwise stale candidate versions silently
  // remain visible to the generation worker.
  const { error: versionArchiveErr } = await sc
    .from("stamp_artwork_versions")
    .update({ status: "archived" })
    .eq("catalog_id", id)
    .eq("status", "candidate");

  if (versionArchiveErr) {
    console.error(
      "[stamp-regenerate] failed to archive candidate artwork versions",
      JSON.stringify({
        catalog_id: id,
        error: versionArchiveErr.message ?? String(versionArchiveErr),
      })
    );
  }

  // Archive existing active queue job (if review_required).
  // Must check the error: if this fails and we proceed to insert a new queued
  // row, both the original review_required row and the new queued row become
  // active simultaneously — a worker could pick up both and generate duplicates.
  const { error: archiveErr } = await sc
    .from("stamp_generation_queue")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("catalog_id", id)
    .eq("status", "review_required");

  if (archiveErr) {
    sendError(res, "db_error", archiveErr.message);
    return;
  }

  // Archive `generating` jobs whose lock has expired — a crashed worker never
  // released them. The partial unique index uix_queue_catalog_active counts
  // `generating` as an active row, so without freeing this slot the fresh insert
  // below hits 23505 and is swallowed as success while the entry stays stuck
  // forever (audit STAMP·H4). Only stale rows (lock past expiry) are touched; a
  // row a worker is actively generating (lock still valid) is left alone so we
  // never orphan in-flight work. The staleness cutoff is evaluated in-process
  // (rather than a DB-side comparison); a single clock read governs both the
  // cutoff and the archive's updated_at stamp.
  const staleGenAt     = new Date();
  const staleGenNowMs  = staleGenAt.getTime();
  const staleGenNowIso = staleGenAt.toISOString();
  const { data: genRows, error: genReadErr } = await sc
    .from("stamp_generation_queue")
    .select("id, locked_until")
    .eq("catalog_id", id)
    .eq("status", "generating");

  if (genReadErr) {
    sendError(res, "db_error", genReadErr.message, { exposeDetail: true });
    return;
  }

  const staleGenIds = ((genRows ?? []) as Array<{ id: string; locked_until: string | null }>)
    .filter((r) => r.locked_until != null && new Date(r.locked_until).getTime() < staleGenNowMs)
    .map((r) => r.id);

  if (staleGenIds.length > 0) {
    // Must check the error for the same reason as the review_required archive
    // above: proceeding to insert after a failed archive would trip the unique
    // index and report a misleading success. The `.eq("status","generating")`
    // guard keeps this idempotent against a concurrent reclaim sweep.
    const { error: staleGenErr } = await sc
      .from("stamp_generation_queue")
      .update({ status: "archived", updated_at: staleGenNowIso })
      .in("id", staleGenIds)
      .eq("status", "generating");

    if (staleGenErr) {
      // Admin-only diagnostic route — expose the underlying failure (mirrors the
      // archive-extras / survivor-reset error handling below).
      sendError(res, "db_error", staleGenErr.message, { exposeDetail: true });
      return;
    }
  }

  // Reset failed jobs to queued (admin action also resets the auto-requeue cap).
  //
  // An entry can accumulate multiple failed rows (e.g. one retryable_failed AND
  // one permanently_failed, from a race). The partial unique index
  // uix_queue_catalog_active permits only one active row per catalog entry, so
  // a single UPDATE promoting every failed row to "queued" would violate the
  // index — Postgres raises 23505 and rolls the whole statement back, leaving
  // ALL rows still failed while the handler reports ok. To reset both failed
  // statuses in one regenerate: archive all but the most recent failed row
  // first, then reset the survivor to queued.
  const { data: failedRows } = await sc
    .from("stamp_generation_queue")
    .select("id, status, created_at")
    .eq("catalog_id", id)
    .in("status", ["retryable_failed", "permanently_failed"]);

  let hadFailedReset = false;

  if (Array.isArray(failedRows) && failedRows.length > 0) {
    const sorted = [...failedRows].sort((a: any, b: any) =>
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    );
    const survivor = sorted[sorted.length - 1] as any;
    const extraIds = sorted.slice(0, -1).map((r: any) => r.id);

    if (extraIds.length > 0) {
      // Archive the older failed rows so resetting the survivor cannot trip
      // the unique index. Must check the error: if this fails and we still
      // reset the survivor, the reset would violate the index and roll back.
      const { error: archiveExtrasErr } = await sc
        .from("stamp_generation_queue")
        .update({ status: "archived", updated_at: new Date().toISOString() })
        .in("id", extraIds);

      if (archiveExtrasErr) {
        // Admin-only diagnostic route: the operator needs the underlying
        // failure to tell a constraint violation from a transient error, so
        // this opts out of the default db_error sanitisation in lib/http.ts.
        sendError(res, "db_error", archiveExtrasErr.message, { exposeDetail: true });
        return;
      }
    }

    // Chain .select() so PostgREST returns the affected rows — without it the
    // data field is null even when rows were updated. We need the count to know
    // whether a state change happened (used for audit-log gating below).
    const { data: resetRows, error: resetErr } = await sc
      .from("stamp_generation_queue")
      .update({ status: "queued", priority: 1, triggered_by_action: `admin_regenerate:${adminId}`, attempts: 0, requeue_count: 0, last_error: null, cleanup_error: null, cleanup_error_paths: null, updated_at: new Date().toISOString() })
      .eq("id", survivor.id)
      .in("status", ["retryable_failed", "permanently_failed"])
      .select();

    // Must check the error: if the survivor reset fails, the row stays failed
    // and the subsequent insert would hit the unique index (23505), so the
    // handler could report a misleading result while the job remains stuck.
    if (resetErr) {
      // Admin-only diagnostic route — see the archive-extras note above.
      sendError(res, "db_error", resetErr.message, { exposeDetail: true });
      return;
    }

    hadFailedReset = Array.isArray(resetRows) && resetRows.length > 0;
  }

  // Enqueue a new job
  const { error: queueErr } = await sc
    .from("stamp_generation_queue")
    .insert({
      catalog_id:          id,
      status:              "queued",
      priority:            1, // Higher priority for admin-triggered regeneration
      triggered_by_action: `admin_regenerate:${adminId}`,
    });

  if (queueErr && (queueErr as any).code !== "23505") {
    sendError(res, "db_error", queueErr.message);
    return;
  }

  // Reset catalog status to pending_artwork if it was rejected.
  // The error is intentionally non-fatal: the queue insert already succeeded,
  // so the regeneration job is live. A catalog-reset failure leaves the status
  // stale (e.g. still "rejected") but does not lose the job. We log the error
  // so operators can observe and correct the stale status — the audit log alone
  // records the queue action but not whether this secondary step succeeded.
  const { error: catalogResetErr } = await sc
    .from("universal_stamp_catalog")
    .update({ status: "pending_artwork", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "rejected");

  if (catalogResetErr) {
    console.error(
      `[stampCatalog] regenerate: catalog status reset failed for catalog_id=${id}:`,
      catalogResetErr.message,
      `(code: ${(catalogResetErr as any).code ?? "unknown"})`,
      "— catalog status may be stale; operator review required",
    );
    // Also surface the partial failure in the admin audit trail so operators
    // don't need server-log access to discover the stale catalog status.
    await writeAuditLog(sc, adminId, "regenerate_catalog_reset_failed", {
      catalogId: id,
      notes:     `Catalog status reset failed: ${catalogResetErr.message ?? String(catalogResetErr)} — catalog status may be stale`,
    });
  }

  // Write the audit log whenever state actually changed:
  //   • queueErr is null  → a fresh job was inserted
  //   • hadFailedReset    → a failed row was reset to queued by this request
  //                         (the subsequent insert hits 23505, but state did change)
  // A 23505 with no prior failed reset means a rapid duplicate click where the
  // first call already logged the action — skip the duplicate write in that case.
  if (!queueErr || hadFailedReset) {
    await writeAuditLog(sc, adminId, "regenerate", {
      catalogId: id,
      notes:     "Regeneration triggered by admin",
    });
  }

  res.json({ ok: true });
}));

// ── POST /admin/stamps/queue/:jobId/requeue ───────────────────────────────────
// Re-queue a generation job stuck in retryable_failed or permanently_failed
// (resets attempts and the auto-requeue round counter to 0).

router.post("/admin/stamps/queue/:jobId/requeue", asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  if (!isUuid(jobId)) { sendError(res, "invalid_payload", "Invalid job id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const { data, error } = await sc
    .from("stamp_generation_queue")
    .update({
      status:              "queued",
      priority:            1, // Admin re-queue jumps the queue, matching admin regenerate
      triggered_by_action: `admin_requeue:${adminId}`,
      attempts:            0,
      requeue_count:       0, // Manual admin re-queue resets the auto-requeue cap
      last_error:          null,
      cleanup_error:       null,
      cleanup_error_paths: null,
      locked_until:        null,
      locked_by:           null,
      updated_at:          new Date().toISOString(),
    })
    .eq("id", jobId)
    .in("status", ["retryable_failed", "permanently_failed"]) // Guard: only re-queue failed jobs
    .select("id, catalog_id, status, attempts")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) {
    sendError(res, "not_found", "Job not found or not in a failed status");
    return;
  }

  await writeAuditLog(sc, adminId, "requeue_failed_job", {
    catalogId: (data as any).catalog_id,
    notes:     `Re-queued failed generation job ${jobId}`,
  });

  console.log(JSON.stringify({
    event:      "stamp.queue.requeued",
    job_id:     jobId,
    catalog_id: (data as any).catalog_id,
    admin_id:   adminId,
  }));

  res.json({ job: data });
}));

// ── POST /admin/stamps/queue/:jobId/clear-cleanup-error ───────────────────────
// Lets operators dismiss the orphaned-files warning after manually removing
// the files from the stamp-artwork bucket. Nulls out cleanup_error and
// cleanup_error_paths on the queue row so the badge clears in the UI.

router.post("/admin/stamps/queue/:jobId/clear-cleanup-error", asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  if (!isUuid(jobId)) { sendError(res, "invalid_payload", "Invalid job id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const { data, error } = await sc
    .from("stamp_generation_queue")
    .update({
      cleanup_error:       null,
      cleanup_error_paths: null,
      updated_at:          new Date().toISOString(),
    })
    .eq("id", jobId)
    .not("cleanup_error", "is", null) // Only update rows that actually have a cleanup error
    .select("id, catalog_id, status, cleanup_error, cleanup_error_paths")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) {
    // Either job not found or cleanup_error was already null — fetch to distinguish
    const { data: existing } = await sc
      .from("stamp_generation_queue")
      .select("id, catalog_id, status, cleanup_error, cleanup_error_paths")
      .eq("id", jobId)
      .maybeSingle();

    if (!existing) {
      sendError(res, "not_found", "Job not found");
      return;
    }
    // Already cleared — idempotent success
    res.json({ job: existing });
    return;
  }

  await writeAuditLog(sc, adminId, "clear_cleanup_error", {
    catalogId: (data as any).catalog_id,
    notes:     `Operator marked orphaned files as cleaned for job ${jobId}`,
  });

  console.log(JSON.stringify({
    event:      "stamp.queue.cleanup_error_cleared",
    job_id:     jobId,
    catalog_id: (data as any).catalog_id,
    admin_id:   adminId,
  }));

  res.json({ job: data });
}));

// ── POST /admin/stamps/catalog/:id/upload ─────────────────────────────────────

router.post("/admin/stamps/catalog/:id/upload", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid catalog id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  // Expect base64-encoded image in JSON body for simplicity
  // (clients can also send multipart — this accepts base64 JSON for mobile compat)
  const { imageBase64, mimeType, fileName } = req.body ?? {};

  const ALLOWED_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);
  const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

  if (!imageBase64 || typeof imageBase64 !== "string") {
    sendError(res, "invalid_payload", "imageBase64 is required");
    return;
  }

  if (!ALLOWED_TYPES.has(mimeType)) {
    sendError(res, "invalid_payload", "mimeType must be image/png, image/webp, or image/jpeg");
    return;
  }

  const buffer = Buffer.from(imageBase64, "base64");
  if (buffer.byteLength > MAX_SIZE_BYTES) {
    sendError(res, "invalid_payload", "Image exceeds 5MB limit");
    return;
  }

  const versionId = randomUUID();
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  const path = `catalog/${id}/${versionId}.${ext}`;

  const { error: uploadErr } = await sc.storage
    .from("stamp-artwork")
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (uploadErr) {
    sendError(res, "db_error", `Storage upload failed: ${uploadErr.message}`);
    return;
  }

  const { data: urlData } = sc.storage.from("stamp-artwork").getPublicUrl(path);
  const publicUrl = urlData?.publicUrl ?? path;

  const { data: versionRow, error: vErr } = await sc
    .from("stamp_artwork_versions")
    .insert({
      id:                      versionId,
      catalog_id:              id,
      status:                  "candidate",
      storage_path:            path,
      public_url:              publicUrl,
      generation_source:       "admin_upload",
      created_by_admin_id:     adminId,
      generation_metadata:     { original_filename: fileName ?? null },
    })
    .select()
    .single();

  if (vErr) {
    sendError(res, "db_error", vErr.message);
    return;
  }

  await writeAuditLog(sc, adminId, "upload", {
    catalogId: id,
    versionId,
    notes:     `Admin uploaded replacement image`,
  });

  res.status(201).json({ version: versionRow });
}));

// ── POST /admin/stamps/catalog/:id/recompose ──────────────────────────────────
// Stamp Wave 2: re-run the COMPOSITION ONLY (no AI call, no queue) from a
// version's stored hero art — e.g. to try a different rarity treatment or
// template family, or after a compositor upgrade. Produces a NEW candidate
// version (never mutates the source); normal admin review applies.
//
// Body: { versionId?, rarity?, family? } — versionId defaults to the active
// version; it must carry hero_path (i.e. was generated by the premium path).

router.post("/admin/stamps/catalog/:id/recompose", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid catalog id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const { versionId: bodyVersionId, rarity: bodyRarity, family: bodyFamily } = req.body ?? {};

  const { data: catalogRow, error: catErr } = await sc
    .from("universal_stamp_catalog")
    .select("id, canonical_location_key, stamp_type, display_name, country, country_code, region, city, neighborhood, identity_key, active_version_id")
    .eq("id", id)
    .maybeSingle();
  if (catErr || !catalogRow) { sendError(res, "not_found", "Catalog entry not found"); return; }

  const sourceVersionId = typeof bodyVersionId === "string" && isUuid(bodyVersionId)
    ? bodyVersionId
    : (catalogRow as any).active_version_id;
  if (!sourceVersionId) {
    sendError(res, "invalid_payload", "No versionId given and catalog has no active version");
    return;
  }

  const { data: sourceVersion, error: vErr } = await sc
    .from("stamp_artwork_versions")
    .select("id, catalog_id, hero_path, composition")
    .eq("id", sourceVersionId)
    .eq("catalog_id", id)
    .maybeSingle();
  if (vErr || !sourceVersion) { sendError(res, "not_found", "Source version not found"); return; }
  if (!(sourceVersion as any).hero_path) {
    sendError(res, "invalid_payload", "Source version has no stored hero art (pre-premium version) — regenerate instead");
    return;
  }

  // Download the stored hero art.
  const { data: heroFile, error: dlErr } = await sc.storage
    .from("stamp-artwork")
    .download((sourceVersion as any).hero_path);
  if (dlErr || !heroFile) {
    sendError(res, "db_error", `Hero art download failed: ${dlErr?.message ?? "not found"}`);
    return;
  }
  const heroBuffer = Buffer.from(await heroFile.arrayBuffer());

  const { resolveIdentity } = await import("../lib/stamps/composition/identities.js");
  const { composeStamp, templateFamilyForType, normalizeRarity, TEMPLATE_FAMILIES } =
    await import("../lib/stamps/composition/compositor.js");
  const { rasterizeStamp, validateComposedPng } = await import("../lib/stamps/composition/rasterize.js");

  const family = typeof bodyFamily === "string" && bodyFamily in TEMPLATE_FAMILIES
    ? (bodyFamily as keyof typeof TEMPLATE_FAMILIES)
    : templateFamilyForType((catalogRow as any).stamp_type);
  const rarity = normalizeRarity(typeof bodyRarity === "string" ? bodyRarity : null);

  const identity = await resolveIdentity(sc, catalogRow as any);
  const newVersionId = randomUUID();
  const composed = composeStamp({
    identity,
    title:    ((catalogRow as any).display_name ?? (catalogRow as any).city ?? "DESTINATION").toUpperCase(),
    subtitle: ((catalogRow as any).country ?? "").toUpperCase(),
    family,
    rarity,
    heroImageDataUrl: `data:image/png;base64,${heroBuffer.toString("base64")}`,
    uid: newVersionId.slice(0, 8),
  });
  const raster = await rasterizeStamp(composed.svg);
  const qc = await validateComposedPng(raster.full);
  if (!qc.passed) { sendError(res, "db_error", qc.reason ?? "Composed QC failed"); return; }

  const fullPath  = `catalog/${id}/${newVersionId}.png`;
  const thumbPath = `catalog/${id}/${newVersionId}_thumb.png`;
  const up1 = await sc.storage.from("stamp-artwork").upload(fullPath, raster.full, { contentType: "image/png", upsert: false });
  if (up1.error) { sendError(res, "db_error", `Storage upload failed: ${up1.error.message}`); return; }
  const up2 = await sc.storage.from("stamp-artwork").upload(thumbPath, raster.thumbnail, { contentType: "image/png", upsert: false });
  if (up2.error) { sendError(res, "db_error", `Storage upload failed: ${up2.error.message}`); return; }
  const publicUrl = sc.storage.from("stamp-artwork").getPublicUrl(fullPath).data?.publicUrl ?? fullPath;
  const thumbUrl  = sc.storage.from("stamp-artwork").getPublicUrl(thumbPath).data?.publicUrl ?? thumbPath;

  const { data: versionRow, error: insErr } = await sc
    .from("stamp_artwork_versions")
    .insert({
      id:                  newVersionId,
      catalog_id:          id,
      status:              "candidate",
      storage_path:        fullPath,
      public_url:          publicUrl,
      generation_source:   "recomposed",
      created_by_admin_id: adminId,
      width:               raster.width,
      height:              raster.height,
      format:              "png",
      hero_path:           (sourceVersion as any).hero_path,
      thumbnail_path:      thumbPath,
      thumbnail_url:       thumbUrl,
      qc_status:           "passed",
      qc_metadata:         { composed: qc.checks },
      composition:         { ...composed.manifest, recomposed_from: sourceVersionId },
      generation_metadata: { recomposed_from: sourceVersionId, rarity, family },
    })
    .select()
    .single();
  if (insErr) { sendError(res, "db_error", insErr.message); return; }

  await writeAuditLog(sc, adminId, "recompose", {
    catalogId: id,
    versionId: newVersionId,
    notes:     `Recomposed from ${sourceVersionId} (family=${family}, rarity=${rarity})`,
  });

  res.status(201).json({ version: versionRow });
}));

// ── POST /admin/stamps/catalog/:id/merge-into/:targetId ──────────────────────

router.post("/admin/stamps/catalog/:id/merge-into/:targetId", asyncHandler(async (req, res) => {
  const { id: sourceId, targetId } = req.params;
  if (!isUuid(sourceId) || !isUuid(targetId)) {
    sendError(res, "invalid_payload", "Invalid catalog ids");
    return;
  }
  if (sourceId === targetId) {
    sendError(res, "invalid_payload", "Source and target must differ");
    return;
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  // Verify both exist. earn_count is read here so the merge can carry the
  // source's earns onto the survivor instead of dropping them (audit STAMP·H5).
  const [sourceRes, targetRes] = await Promise.all([
    sc.from("universal_stamp_catalog").select("id, canonical_location_key, stamp_type, status, earn_count").eq("id", sourceId).maybeSingle(),
    sc.from("universal_stamp_catalog").select("id, earn_count").eq("id", targetId).maybeSingle(),
  ]);

  if (!sourceRes.data) { sendError(res, "not_found", "Source catalog entry not found"); return; }
  if (!targetRes.data) { sendError(res, "not_found", "Target catalog entry not found"); return; }

  // Guard: if source was already archived by a prior merge call, return success
  // without re-running the re-point or writing a duplicate audit entry.
  if ((sourceRes.data as any).status === "archived") {
    res.json({ ok: true, mergedIntoId: targetId });
    return;
  }

  // Re-point all user ownership records to target.
  //
  // These writes MUST be checked before archiving the source (audit STAMP·H5):
  // if a re-point fails and we archive anyway, the earners it left behind still
  // point at the now-archived source, and the passport read path only resolves
  // artwork for `status = 'approved'` catalog rows (see buildCatalogArtworkMap
  // in routes/stamps.ts) — so their stamp artwork silently disappears. On any
  // failure we abort WITHOUT archiving: the source stays active (its artwork
  // still renders) and re-running the merge retries the re-point idempotently.
  //
  // passport_stamps is optional on some deployments, so "relation does not
  // exist" is tolerated (mirrors reconcile / xx-repair); every other error, and
  // any user_stamps error, blocks the archive.
  const [psRepoint, usRepoint] = await Promise.all([
    sc.from("passport_stamps").update({ catalog_id: targetId }).eq("catalog_id", sourceId),
    sc.from("user_stamps").update({ catalog_id: targetId }).eq("catalog_id", sourceId),
  ]);

  if (psRepoint.error && !/does not exist/i.test(psRepoint.error.message)) {
    sendError(res, "db_error", psRepoint.error.message);
    return;
  }
  if (usRepoint.error) {
    sendError(res, "db_error", usRepoint.error.message);
    return;
  }

  // Carry the source's earn_count onto the survivor. Read-add-write (mirrors
  // mergeCatalogEntry in xxCatalogRepair); target presence is already verified
  // above. Done before the archive so a mid-merge failure leaves the source
  // active (recoverable) rather than archived-with-earns-stranded.
  const sourceEarn = Number((sourceRes.data as any).earn_count ?? 0);
  if (sourceEarn > 0) {
    const targetEarn = Number((targetRes.data as any).earn_count ?? 0);
    const { error: earnErr } = await sc
      .from("universal_stamp_catalog")
      .update({ earn_count: targetEarn + sourceEarn, updated_at: new Date().toISOString() })
      .eq("id", targetId);
    if (earnErr) {
      sendError(res, "db_error", earnErr.message);
      return;
    }
  }

  // Archive source catalog entry (don't delete to preserve history). Only
  // reached once every earner has been re-pointed and earn_count carried over.
  const { error: archiveSourceErr } = await sc
    .from("universal_stamp_catalog")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", sourceId);

  if (archiveSourceErr) {
    sendError(res, "db_error", archiveSourceErr.message);
    return;
  }

  // Invalidate caches
  invalidateCatalogCache(
    (sourceRes.data as any).canonical_location_key,
    (sourceRes.data as any).stamp_type
  );

  await writeAuditLog(sc, adminId, "merge", {
    catalogId:        sourceId,
    targetCatalogId:  targetId,
    notes:            `Merged ${sourceId} → ${targetId}`,
  });

  res.json({ ok: true, mergedIntoId: targetId });
}));

// ── POST /admin/stamps/reconcile ─────────────────────────────────────────────
// Runs the stamp catalog reconciliation idempotently.
// Resolves every distinct (stamp_type, country, city) combo in user_stamps and
// passport_stamps to a universal_stamp_catalog entry and writes back catalog_id.
// Safe to call from CI post-deploy hooks or a nightly cron job.

router.post("/admin/stamps/reconcile", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  console.log(JSON.stringify({
    event:    "stamp.reconcile.started",
    admin_id: adminId,
  }));

  let stats: { resolved: number; flagged: number; skipped: number; enqueued: number };
  try {
    stats = await runReconciliation(sc);
  } catch (err: any) {
    console.error("[stamp-reconcile] reconciliation failed:", err?.message ?? String(err));
    sendError(res, "db_error", err?.message ?? "Reconciliation failed");
    return;
  }

  console.log(JSON.stringify({
    event:    "stamp.reconcile.complete",
    admin_id: adminId,
    ...stats,
  }));

  await writeAuditLog(sc, adminId, "reconcile", {
    notes: `Reconciliation complete — resolved:${stats.resolved} flagged:${stats.flagged} skipped:${stats.skipped} enqueued:${stats.enqueued}`,
  });

  res.json({ ok: true, stats });
}));

// ── GET /admin/stamps/reconcile/runs ─────────────────────────────────────────
// Recent reconciler run history — reads the run-summary rows the reconciler
// writes to stamp_reconciliation_log (source_table = "reconciliation_run",
// counts JSON in review_reason) so "did it run?" is answerable in-app.

router.get("/admin/stamps/reconcile/runs", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const { data, error } = await sc
    .from("stamp_reconciliation_log")
    .select("id, source_id, review_reason, processed_at")
    .eq("source_table", RUN_SUMMARY_SOURCE_TABLE)
    .order("processed_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }

  const runs = ((data ?? []) as any[]).map((row) => {
    let counts: Record<string, unknown> = {};
    let parseError = false;
    try {
      const parsed = JSON.parse(row.review_reason ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) counts = parsed;
      else parseError = true;
    } catch {
      parseError = true;
    }
    const fatalError =
      typeof counts.fatal_error === "string" ? (counts.fatal_error as string) : null;
    return {
      id:         row.id ?? null,
      runId:      row.source_id ?? null,
      ranAt:      row.processed_at ?? null,
      resolved:   Number(counts.resolved ?? 0),
      flagged:    Number(counts.flagged ?? 0),
      skipped:    Number(counts.skipped ?? 0),
      enqueued:   Number(counts.enqueued ?? 0),
      combos:     Number(counts.combos ?? 0),
      fatalError,
      ok:         !parseError && !fatalError,
      ...(parseError ? { parseError: true } : {}),
    };
  });

  res.json({ runs, total: runs.length });
}));

// ── Criteria engine (Stamp Wave 3) ────────────────────────────────────────────

// GET /admin/stamps/criteria/metrics — the metric vocabulary authors can use.
router.get("/admin/stamps/criteria/metrics", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { knownMetricNames, CONTEXT_ONLY_METRICS } = await import("../lib/stamps/criteria/index.js");
  const all = knownMetricNames();
  const contextOnly = new Set(CONTEXT_ONLY_METRICS);
  res.json({
    metrics: all.map((name) => ({ name, kind: contextOnly.has(name) ? "context" : "db" })),
    schemaExample: { version: 1, all: [{ metric: "trips_completed", gte: 5 }] },
  });
}));

// POST /admin/stamps/criteria/evaluate { userId, slug?, dryRun? }
// Evaluate a single definition's criteria for a user (dry-run by default) or,
// with no slug, evaluate+award all automatic criteria-bearing definitions.
router.post("/admin/stamps/criteria/evaluate", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const userId = String(req.body?.userId ?? "");
  if (!isUuid(userId)) { sendError(res, "invalid_payload", "Valid userId required"); return; }
  const slug = typeof req.body?.slug === "string" ? req.body.slug : null;
  const dryRun = req.body?.dryRun !== false; // default true

  const { evaluateCriteria, evaluateAndAwardCriteria } = await import("../lib/stamps/criteria/index.js");

  if (slug) {
    const { data: def } = await sc
      .from("stamp_definitions")
      .select("slug, criteria, criteria_type, is_active")
      .eq("slug", slug)
      .maybeSingle();
    if (!def) { sendError(res, "not_found", "Definition not found"); return; }
    if ((def as any).criteria == null) {
      res.json({ slug, hasCriteria: false, note: "Definition has no authored criteria" });
      return;
    }
    const result = await evaluateCriteria(sc, userId, (def as any).criteria);
    res.json({ slug, hasCriteria: true, dryRun: true, result });
    return;
  }

  // No slug → evaluate all automatic criteria definitions; award unless dryRun.
  if (dryRun) {
    const { data: defs } = await sc
      .from("stamp_definitions")
      .select("slug, criteria")
      .eq("is_active", true)
      .eq("criteria_type", "automatic")
      .not("criteria", "is", null);
    const results = [];
    for (const d of (defs ?? []) as any[]) {
      results.push({ slug: d.slug, result: await evaluateCriteria(sc, userId, d.criteria) });
    }
    res.json({ dryRun: true, evaluated: results.length, results });
    return;
  }

  const outcomes = await evaluateAndAwardCriteria(sc, userId, { sourceType: "criteria_admin", sourceId: "none" });
  res.json({ dryRun: false, outcomes });
}));

// ── POST /admin/stamps/criteria/backfill-globe-trotters ───────────────────────
// One-time (idempotent) backfill: awards globe_trotter_5 / globe_trotter_10 to
// every user who already has ≥5 distinct countries in user_stamps but joined
// before the criteria engine existed.
//
// Intentionally bypasses the `stamp_criteria_engine_enabled` feature flag:
// this is a one-shot operational backfill, not part of the live engine pipeline.
// Calling evaluateAndAwardCriteria would silently return [] when the flag is
// off — so we call evaluateCriteria + awardStamp directly instead.
//
// Safe to re-run: awardStamp dedupes on (user, definition, sourceType, sourceId).
// Streams all non-revoked (user_id, country) rows in pages of 1 000 to build
// a per-user distinct-country count without pulling the whole table at once.

router.post("/admin/stamps/criteria/backfill-globe-trotters", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const { evaluateCriteria } = await import("../lib/stamps/criteria/index.js");
  const { awardStamp }       = await import("../services/passport/StampAwardEngine.js");

  // ── 1. Fetch definitions directly (no flag gate) ────────────────────────────
  const SLUGS = ["globe_trotter_5", "globe_trotter_10"];
  const { data: defRows, error: defErr } = await sc
    .from("stamp_definitions")
    .select("slug, criteria")
    .in("slug", SLUGS)
    .eq("is_active", true)
    .not("criteria", "is", null);

  if (defErr) { sendError(res, "db_error", `stamp_definitions fetch failed: ${defErr.message}`); return; }
  const defs = (defRows ?? []) as Array<{ slug: string; criteria: unknown }>;

  // ── 2. Collect distinct countries per user ──────────────────────────────────
  const userCountries = new Map<string, Set<string>>();
  const PAGE = 1000;
  let from = 0;
  let done = false;

  while (!done) {
    const { data, error } = await sc
      .from("user_stamps")
      .select("user_id, country")
      .eq("is_revoked", false)
      .not("country", "is", null)
      .range(from, from + PAGE - 1);

    if (error) { sendError(res, "db_error", `user_stamps page fetch failed: ${error.message}`); return; }

    const rows = (data ?? []) as Array<{ user_id: string; country: string }>;
    for (const row of rows) {
      if (!row.user_id || !row.country?.trim()) continue;
      const key = row.country.trim().toLowerCase();
      let set = userCountries.get(row.user_id);
      if (!set) { set = new Set(); userCountries.set(row.user_id, set); }
      set.add(key);
    }

    if (rows.length < PAGE) done = true;
    else from += PAGE;
  }

  // ── 3. Filter users with ≥5 distinct countries ──────────────────────────────
  const eligibleUsers = [...userCountries.entries()]
    .filter(([, countries]) => countries.size >= 5)
    .map(([userId]) => userId);

  console.log(JSON.stringify({
    event:          "stamp.backfill.globe_trotters.started",
    admin_id:       adminId,
    eligible_users: eligibleUsers.length,
    definitions:    defs.length,
  }));

  // ── 4. Evaluate + award for each eligible user ──────────────────────────────
  const results: Array<{ userId: string; outcomes: any[] }> = [];
  let awarded5 = 0;
  let awarded10 = 0;
  let errors = 0;

  for (const userId of eligibleUsers) {
    const outcomes: any[] = [];
    try {
      for (const def of defs) {
        const result = await evaluateCriteria(sc, userId, def.criteria, {});
        if (!result.met) {
          outcomes.push({ slug: def.slug, met: false, awarded: false, reason: result.reason });
          continue;
        }
        try {
          const award = await awardStamp(sc, {
            userId,
            definitionSlug: def.slug,
            sourceType:     "backfill",
            sourceId:       "globe_trotter_backfill",
          });
          outcomes.push({ slug: def.slug, met: true, awarded: award.awarded, reason: award.reason, userStampId: award.userStampId });
          if (award.awarded) {
            if (def.slug === "globe_trotter_5")  awarded5++;
            if (def.slug === "globe_trotter_10") awarded10++;
          }
        } catch (awardErr: any) {
          outcomes.push({ slug: def.slug, met: true, awarded: false, reason: "award_error", error: awardErr?.message ?? String(awardErr) });
          errors++;
        }
      }
    } catch (err: any) {
      errors++;
      outcomes.push({ error: err?.message ?? String(err) });
    }
    results.push({ userId, outcomes });
  }

  console.log(JSON.stringify({
    event:          "stamp.backfill.globe_trotters.complete",
    admin_id:       adminId,
    eligible_users: eligibleUsers.length,
    awarded5,
    awarded10,
    errors,
  }));

  await writeAuditLog(sc, adminId, "backfill_globe_trotters", {
    notes: `globe_trotter backfill — eligible:${eligibleUsers.length} awarded5:${awarded5} awarded10:${awarded10} errors:${errors}`,
  });

  res.json({
    ok:             true,
    eligibleUsers:  eligibleUsers.length,
    awarded5,
    awarded10,
    errors,
    results,
  });
}));

export default router;
