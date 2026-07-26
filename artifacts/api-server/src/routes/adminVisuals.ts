/**
 * Admin Visual Generation routes
 *
 * Mounted at /api (full paths: /api/admin/visuals/...)
 * All routes require admin role + ai_visual_admin_review_enabled feature flag.
 *
 * GET    /admin/visuals/stats             — aggregate metrics, provider status, queue depth
 * GET    /admin/visuals/pending-review    — place visuals awaiting verification
 * GET    /admin/visuals/history           — paginated, filterable
 * POST   /admin/visuals/:id/verify        — mark visual verified (sets accepted_at)
 * POST   /admin/visuals/:id/disable       — set status → blocked
 * POST   /admin/visuals/:id/regenerate    — trigger a fresh generation job
 * POST   /admin/visuals/:id/block-entity  — block entity from future generation
 * DELETE /admin/visuals/:id              — delete visual record (returns JSON)
 * PUT    /admin/feature-flags/:flag       — toggle a feature flag
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { requestGeneration } from "../lib/visuals/service.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

const AI_VISUAL_COST_PER_IMAGE = Number(process.env.AI_VISUAL_COST_PER_IMAGE ?? "0.04") || 0.04;

// ── Admin + flag guard ────────────────────────────────────────────────────────

async function requireVisualAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; displayName: string | null; client: any; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data, error } = await client
    .from("profiles")
    .select("role, display_name, username, handle")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  const sc = getServiceClient() ?? client;

  // Gate: ai_visual_admin_review_enabled must be on
  const flagEnabled = await isFlagEnabled(sc, "ai_visual_admin_review_enabled");
  if (!flagEnabled) {
    res.status(403).json({ error: "feature_disabled", message: "AI visual admin is not enabled" });
    return null;
  }

  const displayName: string | null =
    (data as any).display_name ?? (data as any).username ?? (data as any).handle ?? null;
  return { userId: user.id, displayName, client, sc };
}

// ── GET /admin/visuals/stats ──────────────────────────────────────────────────

router.get("/admin/visuals/stats", asyncHandler(async (req, res) => {
  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  weekStart.setUTCHours(0, 0, 0, 0);

  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  try {
    // Fetch all rows this month for aggregation (bounded)
    const { data: monthRows, error: monthErr } = await sc
      .from("generated_visuals")
      .select("id, entity_type, status, provider, style, attempt_count, created_at, generated_at")
      .gte("created_at", monthStart.toISOString())
      .limit(5000);

    if (monthErr) { sendError(res, "db_error", monthErr.message); return; }

    const rows: any[] = monthRows ?? [];

    const todayIso = todayStart.toISOString();
    const weekIso  = weekStart.toISOString();

    const generationsToday = rows.filter((r) => r.created_at >= todayIso).length;
    const generationsWeek  = rows.filter((r) => r.created_at >= weekIso).length;

    // By entity_type
    const byType: Record<string, number> = {};
    for (const r of rows) {
      byType[r.entity_type] = (byType[r.entity_type] ?? 0) + 1;
    }

    // By status
    const byStatus: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }

    // Queue depth (all time, not just month)
    const { count: queueDepth } = await sc
      .from("generated_visuals")
      .select("id", { count: "exact", head: true })
      .in("status", ["queued", "generating"]);

    // Avg attempts per success (ready rows this month)
    const readyRows = rows.filter((r) => r.status === "ready");
    const avgAttempts = readyRows.length > 0
      ? readyRows.reduce((sum: number, r: any) => sum + (r.attempt_count ?? 1), 0) / readyRows.length
      : 0;

    // Estimated cost: openai ready rows this month
    const billableCount = rows.filter(
      (r) => r.status === "ready" && r.provider === "openai",
    ).length;
    const estimatedCost = billableCount * AI_VISUAL_COST_PER_IMAGE;

    // Avg generation duration (ms) for ready rows that have both created_at and generated_at
    const timedRows = readyRows.filter((r: any) => r.generated_at);
    const avgDurationMs = timedRows.length > 0
      ? timedRows.reduce((sum: number, r: any) => {
          const dur = new Date(r.generated_at).getTime() - new Date(r.created_at).getTime();
          return sum + dur;
        }, 0) / timedRows.length
      : null;

    // Top 5 styles by usage
    const styleCounts: Record<string, number> = {};
    for (const r of rows) {
      if (r.style) styleCounts[r.style] = (styleCounts[r.style] ?? 0) + 1;
    }
    const topStyles = Object.entries(styleCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([style, count]) => ({ style, count }));

    // Regeneration rate = replaced / (ready + replaced + failed + blocked)
    const replacedCount  = byStatus["replaced"]  ?? 0;
    const completedCount = (byStatus["ready"] ?? 0) + (byStatus["failed"] ?? 0) + (byStatus["blocked"] ?? 0) + replacedCount;
    const regenerationRate = completedCount > 0 ? replacedCount / completedCount : 0;

    // Provider status from feature flags
    const [providerEnabled, eventHeadersEnabled, placeHeadersEnabled] = await Promise.all([
      isFlagEnabled(sc, "ai_visual_provider_enabled"),
      isFlagEnabled(sc, "ai_event_headers_enabled"),
      isFlagEnabled(sc, "ai_place_headers_enabled"),
    ]);

    const providerStatus = !providerEnabled ? "disabled"
      : (byStatus["failed"] ?? 0) > Math.max(generationsToday * 0.2, 5) ? "degraded"
      : "healthy";

    res.json({
      generationsToday,
      generationsWeek,
      byType,
      byStatus: {
        success: byStatus["ready"]      ?? 0,
        failed:  byStatus["failed"]     ?? 0,
        blocked: byStatus["blocked"]    ?? 0,
        reused:  byStatus["replaced"]   ?? 0,
        queued:  byStatus["queued"]     ?? 0,
        generating: byStatus["generating"] ?? 0,
      },
      avgAttemptsPerSuccess: Math.round(avgAttempts * 100) / 100,
      estimatedCostThisMonth: Math.round(estimatedCost * 100) / 100,
      billableCount,
      costPerImage: AI_VISUAL_COST_PER_IMAGE,
      providerStatus,
      providerEnabled,
      eventHeadersEnabled,
      placeHeadersEnabled,
      queueDepth: queueDepth ?? 0,
      avgGenerationDurationMs: avgDurationMs !== null ? Math.round(avgDurationMs) : null,
      topStyles,
      regenerationRate: Math.round(regenerationRate * 1000) / 1000,
    });
  } catch (e: any) {
    sendError(res, "db_error", e?.message ?? "stats query failed");
  }
}));

// ── GET /admin/visuals/pending-review ─────────────────────────────────────────

// Single string literal so the column check can statically resolve it.
const PENDING_SELECT = "id, entity_type, entity_id, purpose, status, style, source_image_url, thumbnail_path, card_path, hero_path, moderation_status, attempt_count, generated_at, created_at, accepted_at";

router.get("/admin/visuals/pending-review", asyncHandler(async (req, res) => {
  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page  = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error, count } = await sc
    .from("generated_visuals")
    .select(PENDING_SELECT, { count: "exact" })
    .eq("status", "ready")
    .eq("entity_type", "place")
    .is("accepted_at", null)
    .is("moderation_status", null)
    .order("created_at", { ascending: true })
    .range((page - 1) * limit, page * limit - 1);

  if (error) { sendError(res, "db_error", error.message); return; }

  // Enrich with place name + category
  const visuals = data ?? [];
  const entityIds = [...new Set(visuals.map((v: any) => v.entity_id))];
  let placeMap: Record<string, { name: string; category: string | null }> = {};

  if (entityIds.length > 0) {
    const { data: places } = await sc
      .from("discovery_places")
      .select("id, name, category")
      .in("id", entityIds);
    for (const p of (places ?? [])) {
      placeMap[p.id] = { name: p.name, category: p.category ?? null };
    }
  }

  const enriched = visuals.map((v: any) => ({
    ...v,
    verifiedAt:    v.accepted_at ?? null,
    placeName:     placeMap[v.entity_id]?.name ?? null,
    placeCategory: placeMap[v.entity_id]?.category ?? null,
  }));

  res.json({ visuals: enriched, total: count ?? 0, page });
}));

// ── GET /admin/visuals/history ─────────────────────────────────────────────────

// Single string literal so the column check can statically resolve it.
const HISTORY_SELECT = "id, entity_type, entity_id, purpose, provider, model, prompt_version, prompt_hash, input_snapshot, final_prompt, negative_prompt, style, aspect_ratio, status, source_image_url, storage_path, thumbnail_path, card_path, hero_path, share_path, moderation_status, moderation_details, failure_code, failure_message, attempt_count, generation_cost_estimate, generated_at, accepted_at, replaced_at, created_at, updated_at, owner_user_id";

router.get("/admin/visuals/history", asyncHandler(async (req, res) => {
  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page       = Math.max(1, Number(req.query.page) || 1);
  const limit      = Math.min(100, Number(req.query.limit) || 50);
  const entityType = (req.query.entity_type as string | undefined) || null;
  const entityId   = (req.query.entity_id   as string | undefined) || null;
  const status     = (req.query.status       as string | undefined) || null;
  const startDate  = (req.query.start_date   as string | undefined) || null;
  const endDate    = (req.query.end_date     as string | undefined) || null;

  // Admin sees prompt fields (input_snapshot, final_prompt) that are never exposed to regular users.
  let query = sc
    .from("generated_visuals")
    .select(HISTORY_SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (entityType) query = query.eq("entity_type", entityType);
  if (entityId)   query = query.eq("entity_id",   entityId);
  if (status)     query = query.eq("status",       status);
  if (startDate)  query = query.gte("created_at",  startDate);
  if (endDate)    query = query.lte("created_at",  endDate);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  const visuals = (data ?? []).map((v: any) => ({
    ...v,
    verifiedAt: v.accepted_at ?? null,
    derivativeUrls: {
      hero:      v.source_image_url ?? null,
      card:      v.card_path        ?? null,
      thumbnail: v.thumbnail_path   ?? null,
      share:     v.share_path       ?? null,
    },
  }));

  res.json({ visuals, total: count ?? 0, page });
}));

// ── POST /admin/visuals/:id/verify ────────────────────────────────────────────

router.post("/admin/visuals/:id/verify", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid visual id"); return; }

  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const now = new Date().toISOString();
  const { data, error } = await sc
    .from("generated_visuals")
    .update({ accepted_at: now, updated_at: now })
    .eq("id", id)
    .eq("status", "ready")
    .select("id, status, accepted_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Visual not found or not in ready status"); return; }
  res.json({ visual: { ...data, verifiedAt: data.accepted_at } });
}));

// ── POST /admin/visuals/:id/disable ──────────────────────────────────────────

router.post("/admin/visuals/:id/disable", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid visual id"); return; }

  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const now = new Date().toISOString();
  const { data, error } = await sc
    .from("generated_visuals")
    .update({ status: "blocked", moderation_status: "admin_disabled", updated_at: now })
    .eq("id", id)
    .neq("status", "blocked")
    .select("id, status, moderation_status")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Visual not found or already blocked"); return; }
  res.json({ visual: data });
}));

// ── POST /admin/visuals/:id/regenerate ───────────────────────────────────────

router.post("/admin/visuals/:id/regenerate", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid visual id"); return; }

  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  // Look up the existing visual to get entity info
  const { data: existing, error: fetchErr } = await sc
    .from("generated_visuals")
    .select("id, entity_type, entity_id, purpose, style, owner_user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) { sendError(res, "db_error", fetchErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Visual not found"); return; }

  const outcome = await requestGeneration({
    entityType:  existing.entity_type,
    entityId:    existing.entity_id,
    purpose:     existing.purpose,
    ownerUserId: existing.owner_user_id ?? admin.userId,
    style:       existing.style,
    force:       true,
  });

  if (!outcome.ok) {
    if (outcome.status === "rate_limited") return sendError(res, "rate_limited", outcome.error);
    if (outcome.status === "disabled")     return sendError(res, "feature_disabled", outcome.error);
    if (outcome.status === "blocked")      return sendError(res, "forbidden", outcome.error ?? "entity_blocked");
    if (outcome.status === "no_reference_fallback") {
      // Expected policy outcome for specific named real places without reference images.
      // Return 200 — not an error — with the fallback contract for the admin client.
      return res.json({
        status: "no_reference_fallback",
        entityType: existing.entity_type,
        entityId: existing.entity_id,
        disclaimerRequired: true,
        disclaimerText: "Representative image — not a photo of the actual location.",
        message: "Regeneration skipped: specific real places require verified reference images.",
      });
    }
    return sendError(res, "db_error", outcome.error);
  }

  // Do NOT call processJob directly — the VisualGenerationWorker polls for
  // queued jobs and owns lock acquisition + retry logic. Calling processJob
  // here would duplicate the provider call and violate the queue contract.
  res.json({ visualId: outcome.visualId, status: outcome.status });
}));

// ── POST /admin/visuals/:id/block-entity ─────────────────────────────────────

router.post("/admin/visuals/:id/block-entity", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid visual id"); return; }

  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  // Look up the visual to get entity info
  const { data: existing, error: fetchErr } = await sc
    .from("generated_visuals")
    .select("id, entity_type, entity_id, purpose")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) { sendError(res, "db_error", fetchErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Visual not found"); return; }

  const now = new Date().toISOString();

  // Phase 1: Write the entity-block sentinel on ALL rows for this entity,
  // regardless of their current status (failed / replaced / blocked / ready / …).
  // requestGeneration checks for moderation_status='entity_blocked', so this
  // sentinel MUST be written even when the triggering visual is not active.
  // Since we already confirmed `existing` is found above, at least one row is
  // always updated here — the endpoint never silently succeeds with zero writes.
  const { error: sentinelErr } = await sc
    .from("generated_visuals")
    .update({
      moderation_status:  "entity_blocked",
      moderation_details: { blocked_by: admin.userId, blocked_at: now, reason: "admin_entity_block" },
      updated_at:         now,
    })
    .eq("entity_type", existing.entity_type)
    .eq("entity_id", existing.entity_id);

  if (sentinelErr) { sendError(res, "db_error", sentinelErr.message); return; }

  // Phase 2: Also flip status → blocked for rows still in an active state.
  // Best-effort: a failure here does not undo the sentinel written above.
  await sc
    .from("generated_visuals")
    .update({ status: "blocked", updated_at: now })
    .eq("entity_type", existing.entity_type)
    .eq("entity_id", existing.entity_id)
    .in("status", ["queued", "generating", "ready"]);

  res.json({
    ok:         true,
    entityType: existing.entity_type,
    entityId:   existing.entity_id,
    blocked:    true,
  });
}));

// ── DELETE /admin/visuals/:id ─────────────────────────────────────────────────
// Returns JSON (not 204) so the shared adminDelete helper can call res.json() successfully.

router.delete("/admin/visuals/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid visual id"); return; }

  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { error } = await sc.from("generated_visuals").delete().eq("id", id);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true, id });
}));

// ── PUT /admin/feature-flags/:flag ────────────────────────────────────────────
// Alias for PATCH — same logic, supports both HTTP verbs from the dashboard.

const toggleFlagSchema = z.object({ enabled: z.boolean() });

async function toggleFlagHandler(req: any, res: any): Promise<void> {
  const admin = await requireVisualAdmin(req, res);
  if (!admin) return;
  const { userId, displayName, sc } = admin;

  const parsed = toggleFlagSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", "Body must have { enabled: boolean }");
    return;
  }

  const { data: rows, error: rpcErr } = await sc.rpc("toggle_feature_flag_with_audit", {
    p_flag:          req.params.flag,
    p_new_enabled:   parsed.data.enabled,
    p_changed_by_id: userId,
  });

  if (rpcErr) {
    if (rpcErr.code === "42883") {
      res.status(503).json({
        error: "server_not_configured",
        message: "toggle_feature_flag_with_audit function missing — apply migration 0119",
      });
      return;
    }
    if (rpcErr.message?.includes("Flag not found") || rpcErr.code === "P0002") {
      sendError(res, "not_found", `Flag '${req.params.flag}' not found`);
    } else {
      sendError(res, "db_error", rpcErr.message);
    }
    return;
  }

  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) { sendError(res, "not_found", `Flag '${req.params.flag}' not found`); return; }

  res.json({
    flag: {
      flag:        row.flag,
      enabled:     row.enabled,
      description: row.description,
      updated_at:  row.updated_at,
      last_change: {
        changed_at:      row.changed_at,
        old_enabled:     row.old_enabled,
        new_enabled:     row.enabled,
        changed_by_name: displayName,
      },
    },
  });
}

router.put("/admin/feature-flags/:flag",            asyncHandler(toggleFlagHandler));
router.patch("/admin/visuals/feature-flags/:flag",  asyncHandler(toggleFlagHandler));

export default router;
