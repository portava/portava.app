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
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { randomUUID } from "crypto";
import { invalidateCatalogCache } from "../lib/stamps/StampCatalogService.js";
import { STYLE_VERSION } from "../lib/stamps/artDirection.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

// ── Admin guard ───────────────────────────────────────────────────────────────

async function requireAdmin(req: any, res: any): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

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
  await sc.from("stamp_admin_audit_log").insert({
    admin_id:          adminId,
    action,
    catalog_id:        opts.catalogId ?? null,
    version_id:        opts.versionId ?? null,
    target_catalog_id: opts.targetCatalogId ?? null,
    notes:             opts.notes ?? null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /stamps/catalog/batch (POST for bulk) ─────────────────────────────────

router.post("/stamps/catalog/batch", async (req, res) => {
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
});

// ── GET /stamps/catalog/:canonicalKeyOrId ─────────────────────────────────────

router.get("/stamps/catalog/:canonicalKeyOrId", async (req, res) => {
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
});

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

router.get("/admin/stamps/catalog", async (req, res) => {
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
});

// ── GET /admin/stamps/queue ───────────────────────────────────────────────────

router.get("/admin/stamps/queue", async (req, res) => {
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
});

// ── GET /admin/stamps/duplicates ──────────────────────────────────────────────

router.get("/admin/stamps/duplicates", async (req, res) => {
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
});

// ── GET /admin/stamps/catalog/:id ─────────────────────────────────────────────

router.get("/admin/stamps/catalog/:id", async (req, res) => {
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
});

// ── GET /admin/stamps/catalog/:id/earners ─────────────────────────────────────

router.get("/admin/stamps/catalog/:id/earners", async (req, res) => {
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
});

// ── POST /admin/stamps/catalog ─────────────────────────────────────────────────

const createCatalogSchema = z.object({
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

router.post("/admin/stamps/catalog", async (req, res) => {
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
});

// ── PATCH /admin/stamps/catalog/:id/activate-version ─────────────────────────

const activateVersionSchema = z.object({
  versionId: z.string().uuid(),
  notes:     z.string().optional(),
});

router.patch("/admin/stamps/catalog/:id/activate-version", async (req, res) => {
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

  // Approve the version row
  const { data: versionRow, error: vErr } = await sc
    .from("stamp_artwork_versions")
    .update({
      status:              "approved",
      reviewed_by_admin_id: adminId,
      reviewed_at:         new Date().toISOString(),
    })
    .eq("id", versionId)
    .eq("catalog_id", id)
    .select("id, public_url")
    .maybeSingle();

  if (vErr || !versionRow) {
    sendError(res, "not_found", "Version not found for this catalog entry");
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
});

// ── PATCH /admin/stamps/catalog/:id/reject ────────────────────────────────────

const rejectCatalogSchema = z.object({
  reason: z.string().min(1).max(500),
});

router.patch("/admin/stamps/catalog/:id/reject", async (req, res) => {
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
});

// ── POST /admin/stamps/catalog/:id/regenerate ─────────────────────────────────

router.post("/admin/stamps/catalog/:id/regenerate", async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid catalog id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  // Archive existing candidate versions
  await sc
    .from("stamp_artwork_versions")
    .update({ status: "archived" })
    .eq("catalog_id", id)
    .eq("status", "candidate");

  // Archive existing active queue job (if review_required)
  await sc
    .from("stamp_generation_queue")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("catalog_id", id)
    .eq("status", "review_required");

  // Reset failed jobs to queued (admin action also resets the auto-requeue cap).
  // Chain .select() so PostgREST returns the affected rows — without it the
  // data field is null even when rows were updated. We need the count to know
  // whether a state change happened (used for audit-log gating below).
  const { data: resetRows } = await sc
    .from("stamp_generation_queue")
    .update({ status: "queued", attempts: 0, requeue_count: 0, last_error: null, updated_at: new Date().toISOString() })
    .eq("catalog_id", id)
    .in("status", ["retryable_failed", "permanently_failed"])
    .select();

  const hadFailedReset = Array.isArray(resetRows) && resetRows.length > 0;

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

  // Reset catalog status to pending_artwork if it was rejected
  await sc
    .from("universal_stamp_catalog")
    .update({ status: "pending_artwork", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "rejected");

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
});

// ── POST /admin/stamps/queue/:jobId/requeue ───────────────────────────────────
// Re-queue a generation job stuck in retryable_failed or permanently_failed
// (resets attempts and the auto-requeue round counter to 0).

router.post("/admin/stamps/queue/:jobId/requeue", async (req, res) => {
  const { jobId } = req.params;
  if (!isUuid(jobId)) { sendError(res, "invalid_payload", "Invalid job id"); return; }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const { data, error } = await sc
    .from("stamp_generation_queue")
    .update({
      status:              "queued",
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
});

// ── POST /admin/stamps/catalog/:id/upload ─────────────────────────────────────

router.post("/admin/stamps/catalog/:id/upload", async (req, res) => {
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
});

// ── POST /admin/stamps/catalog/:id/merge-into/:targetId ──────────────────────

router.post("/admin/stamps/catalog/:id/merge-into/:targetId", async (req, res) => {
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

  // Verify both exist
  const [sourceRes, targetRes] = await Promise.all([
    sc.from("universal_stamp_catalog").select("id, canonical_location_key, stamp_type, status").eq("id", sourceId).maybeSingle(),
    sc.from("universal_stamp_catalog").select("id").eq("id", targetId).maybeSingle(),
  ]);

  if (!sourceRes.data) { sendError(res, "not_found", "Source catalog entry not found"); return; }
  if (!targetRes.data) { sendError(res, "not_found", "Target catalog entry not found"); return; }

  // Guard: if source was already archived by a prior merge call, return success
  // without re-running the re-point or writing a duplicate audit entry.
  if ((sourceRes.data as any).status === "archived") {
    res.json({ ok: true, mergedIntoId: targetId });
    return;
  }

  // Re-point all user ownership records to target
  await Promise.all([
    sc.from("passport_stamps").update({ catalog_id: targetId }).eq("catalog_id", sourceId),
    sc.from("user_stamps").update({ catalog_id: targetId }).eq("catalog_id", sourceId),
  ]);

  // Archive source catalog entry (don't delete to preserve history)
  await sc
    .from("universal_stamp_catalog")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", sourceId);

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
});

export default router;
