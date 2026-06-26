/**
 * Admin Compass routes — Phase 6 Admin & Ops cockpit.
 *
 * All routes require `requireAdmin` (profiles.role = 'admin').
 * All mutations write an audit row to compass_admin_actions.
 *
 * Dashboard:
 *   GET  /api/admin/compass/dashboard
 *
 * Weight sets:
 *   POST  /api/admin/compass/weights
 *   PATCH /api/admin/compass/weights/:id
 *
 * Algorithm versioning:
 *   POST /api/admin/compass/version
 *   POST /api/admin/compass/rollback
 *
 * Cache & controls:
 *   POST  /api/admin/compass/rebuild-cache
 *   PATCH /api/admin/compass/frontload-rules
 *
 * Boost eligibility:
 *   POST /api/admin/compass/users/:userId/remove-boost-eligibility
 *   POST /api/admin/compass/users/:userId/restore-boost-eligibility
 *
 * Observability:
 *   GET /api/admin/compass/abuse-flags
 *   GET /api/admin/compass/safety-filters
 *   GET /api/admin/compass/active-rewards
 *
 * Testing sandbox:
 *   GET  /api/admin/compass/testing-sandbox
 *   POST /api/admin/compass/testing-sandbox/preview
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { clearL1Cache, invalidate } from "../compass/CompassCacheEngine.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { runSandbox, type TestUserType } from "../compass/CompassTestingSandbox.js";

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

// ── Audit logger ──────────────────────────────────────────────────────────────

async function logAdminAction(
  sc:         any,
  adminId:    string,
  actionType: string,
  targetId?:  string | null,
  payload?:   Record<string, unknown>,
): Promise<void> {
  try {
    await sc.from("compass_admin_actions").insert({
      admin_id:    adminId,
      action_type: actionType,
      target_id:   targetId ?? null,
      payload:     payload ?? null,
    });
  } catch { /* non-fatal */ }
}

// ── GET /api/admin/compass/dashboard ─────────────────────────────────────────

router.get("/admin/compass/dashboard", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();

    const [
      abuseFlagsRes,
      safetyLogRes,
      cacheRes,
      rewardRes,
      notifRes,
      versionRes,
    ] = await Promise.allSettled([
      sc.from("compass_abuse_flags")
        .select("severity, status", { count: "exact" })
        .gte("created_at", thirtyDaysAgo),

      sc.from("compass_safety_filter_logs")
        .select("block_reason", { count: "exact" })
        .gte("created_at", thirtyDaysAgo),

      sc.from("compass_feed_cache")
        .select("entry_type", { count: "exact" }),

      sc.from("compass_active_user_scores")
        .select("user_id, active_user_score, trust_multiplier, boost_eligible")
        .order("active_user_score", { ascending: false })
        .limit(10),

      sc.from("compass_notification_decisions")
        .select("outcome", { count: "exact" })
        .gte("created_at", thirtyDaysAgo),

      sc.from("compass_algorithm_versions")
        .select("id, version_tag, rollout_status, launched_at")
        .eq("rollout_status", "active")
        .order("launched_at", { ascending: false })
        .limit(1),
    ]);

    // Summarise abuse flags by severity
    const abuseRows: any[] = abuseFlagsRes.status === "fulfilled"
      ? (abuseFlagsRes.value.data as any[] ?? [])
      : [];
    const abuseBySeverity: Record<string, number> = {};
    for (const r of abuseRows) {
      abuseBySeverity[r.severity] = (abuseBySeverity[r.severity] ?? 0) + 1;
    }

    // Summarise safety filter blocks by reason
    const safetyRows: any[] = safetyLogRes.status === "fulfilled"
      ? (safetyLogRes.value.data as any[] ?? [])
      : [];
    const safetyByReason: Record<string, number> = {};
    for (const r of safetyRows) {
      safetyByReason[r.block_reason] = (safetyByReason[r.block_reason] ?? 0) + 1;
    }

    // Cache entry count
    const cacheCount = cacheRes.status === "fulfilled"
      ? (cacheRes.value.count ?? 0)
      : 0;

    // Top boosted users
    const topRewardUsers: any[] = rewardRes.status === "fulfilled"
      ? (rewardRes.value.data as any[] ?? [])
      : [];

    // Notification outcome breakdown
    const notifRows: any[] = notifRes.status === "fulfilled"
      ? (notifRes.value.data as any[] ?? [])
      : [];
    const notifByOutcome: Record<string, number> = {};
    for (const r of notifRows) {
      notifByOutcome[r.outcome] = (notifByOutcome[r.outcome] ?? 0) + 1;
    }

    // Active algorithm version
    const activeVersion = versionRes.status === "fulfilled"
      ? ((versionRes.value.data as any[] ?? [])[0] ?? null)
      : null;

    res.json({
      generatedAt:    new Date().toISOString(),
      windowDays:     30,
      activeVersion,
      abuseBySeverity,
      safetyFilterFires: {
        total:    safetyRows.length,
        byReason: safetyByReason,
      },
      cacheEntriesActive: cacheCount,
      topBoostedUsers:    topRewardUsers.map((r) => ({
        userId:         r.user_id,
        score:          r.active_user_score,
        trustMultiplier: r.trust_multiplier,
        boostEligible:  r.boost_eligible,
      })),
      notificationOutcomes: notifByOutcome,
    });
  } catch (err) {
    req.log.error({ err }, "admin/compass/dashboard: query failed");
    sendError(res, "db_error", "Dashboard query failed");
  }
});

// ── POST /api/admin/compass/weights ──────────────────────────────────────────

const createWeightSetSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  weights:     z.record(z.number()).default({}),
});

router.post("/admin/compass/weights", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = createWeightSetSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { name, description, weights } = parsed.data;

  try {
    const { data, error } = await sc
      .from("compass_admin_weight_sets")
      .insert({ name, description: description ?? null, weights, created_by: userId })
      .select("id, name, description, weights, is_active, created_at")
      .single();

    if (error) { sendError(res, "db_error", error.message); return; }

    await logAdminAction(sc, userId, "create_weight_set", (data as any).id, { name, weights });
    res.status(201).json({ weightSet: data });
  } catch (err) {
    req.log.error({ err }, "admin/compass/weights: create failed");
    sendError(res, "db_error", "Could not create weight set");
  }
});

// ── PATCH /api/admin/compass/weights/:id ─────────────────────────────────────

const updateWeightSetSchema = z.object({
  name:        z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  weights:     z.record(z.number()).optional(),
});

router.patch("/admin/compass/weights/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const { id } = req.params;
  if (!id) { sendError(res, "invalid_payload", "Missing id"); return; }

  const parsed = updateWeightSetSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name        !== undefined) updates["name"]        = parsed.data.name;
  if (parsed.data.description !== undefined) updates["description"] = parsed.data.description;
  if (parsed.data.weights     !== undefined) updates["weights"]     = parsed.data.weights;

  try {
    const { data, error } = await sc
      .from("compass_admin_weight_sets")
      .update(updates)
      .eq("id", id)
      .select("id, name, description, weights, is_active, updated_at")
      .single();

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!data)  { sendError(res, "not_found", "Weight set not found"); return; }

    await logAdminAction(sc, userId, "update_weight_set", id, updates as Record<string, unknown>);
    res.json({ weightSet: data });
  } catch (err) {
    req.log.error({ err }, "admin/compass/weights/:id: update failed");
    sendError(res, "db_error", "Could not update weight set");
  }
});

// ── POST /api/admin/compass/version ──────────────────────────────────────────

const activateVersionSchema = z.object({
  weightSetId: z.string().uuid(),
  versionTag:  z.string().min(1).max(80),
  notes:       z.string().max(1000).optional(),
});

router.post("/admin/compass/version", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = activateVersionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { weightSetId, versionTag, notes } = parsed.data;

  try {
    // Retire any currently active version
    await sc
      .from("compass_algorithm_versions")
      .update({ rollout_status: "retired", retired_at: new Date().toISOString() })
      .eq("rollout_status", "active");

    // Activate the weight set
    await sc
      .from("compass_admin_weight_sets")
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq("id", weightSetId);

    // Create new algorithm version row
    const { data, error } = await sc
      .from("compass_algorithm_versions")
      .insert({
        weight_set_id:        weightSetId,
        version_tag:          versionTag,
        launched_by_admin_id: userId,
        rollout_status:       "active",
        rollback_available:   true,
        notes:                notes ?? null,
      })
      .select("id, version_tag, rollout_status, launched_at")
      .single();

    if (error) { sendError(res, "db_error", error.message); return; }

    // Clear L1 cache so the new weights take effect on next build
    clearL1Cache();

    await logAdminAction(sc, userId, "activate_version", (data as any).id, { weightSetId, versionTag });
    res.status(201).json({ version: data });
  } catch (err) {
    req.log.error({ err }, "admin/compass/version: activate failed");
    sendError(res, "db_error", "Could not activate version");
  }
});

// ── POST /api/admin/compass/rollback ─────────────────────────────────────────

const rollbackSchema = z.object({
  reason: z.string().max(500).optional(),
});

router.post("/admin/compass/rollback", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = rollbackSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  try {
    // Find current active version
    const { data: activeVersions } = await sc
      .from("compass_algorithm_versions")
      .select("id, version_tag, weight_set_id")
      .eq("rollout_status", "active")
      .order("launched_at", { ascending: false })
      .limit(1);

    const currentVersion = ((activeVersions as any[]) ?? [])[0] ?? null;

    // Find previous stable version (most recent non-rolled-back before the current)
    const { data: prevVersions } = await sc
      .from("compass_algorithm_versions")
      .select("id, version_tag, weight_set_id")
      .eq("rollout_status", "retired")
      .eq("rollback_available", true)
      .order("launched_at", { ascending: false })
      .limit(1);

    const prevVersion = ((prevVersions as any[]) ?? [])[0] ?? null;

    if (!currentVersion) {
      sendError(res, "not_found", "No active algorithm version to roll back");
      return;
    }

    // Mark current version as rolled_back
    await sc
      .from("compass_algorithm_versions")
      .update({ rollout_status: "rolled_back", retired_at: new Date().toISOString() })
      .eq("id", currentVersion.id);

    // Reactivate previous version if available
    if (prevVersion) {
      await sc
        .from("compass_algorithm_versions")
        .update({ rollout_status: "active", retired_at: null })
        .eq("id", prevVersion.id);

      // Re-activate the corresponding weight set
      if (prevVersion.weight_set_id) {
        await sc
          .from("compass_admin_weight_sets")
          .update({ is_active: true, updated_at: new Date().toISOString() })
          .eq("id", prevVersion.weight_set_id);
      }
    }

    // Write rollback audit row
    const { data: rollbackRow } = await sc
      .from("compass_rollbacks")
      .insert({
        from_version_id: currentVersion.id,
        to_version_id:   prevVersion?.id ?? null,
        rolled_back_by:  userId,
        reason:          parsed.data.reason ?? null,
      })
      .select("id, from_version_id, to_version_id, created_at")
      .single();

    // Clear in-process cache globally so rolled-back weights don't serve
    clearL1Cache();

    await logAdminAction(sc, userId, "rollback", currentVersion.id, {
      fromVersion: currentVersion.version_tag,
      toVersion:   prevVersion?.version_tag ?? null,
      reason:      parsed.data.reason ?? null,
    });

    res.json({
      rollback:    rollbackRow,
      fromVersion: currentVersion,
      toVersion:   prevVersion ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "admin/compass/rollback: failed");
    sendError(res, "db_error", "Rollback failed");
  }
});

// ── POST /api/admin/compass/rebuild-cache ────────────────────────────────────

router.post("/admin/compass/rebuild-cache", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  try {
    // Clear the in-process L1 cache immediately
    clearL1Cache();

    // Delete all DB-side cache rows (best-effort)
    let purgedRows = 0;
    try {
      const { count } = await sc
        .from("compass_feed_cache")
        .delete()
        .gte("created_at", "1970-01-01T00:00:00Z") // matches all rows
        .select("id", { count: "exact", head: true });
      purgedRows = count ?? 0;
    } catch { /* non-fatal */ }

    await logAdminAction(sc, userId, "rebuild_cache", null, { purgedRows });
    res.json({ ok: true, message: "Cache cleared", purgedRows });
  } catch (err) {
    req.log.error({ err }, "admin/compass/rebuild-cache: failed");
    sendError(res, "db_error", "Cache rebuild failed");
  }
});

// ── PATCH /api/admin/compass/frontload-rules ─────────────────────────────────

const frontloadRulesSchema = z.object({
  rules: z.array(z.object({
    flag:    z.string().min(1).max(120),
    enabled: z.boolean(),
  })).min(1).max(20),
});

router.patch("/admin/compass/frontload-rules", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = frontloadRulesSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  try {
    const results: Array<{ flag: string; enabled: boolean; ok: boolean }> = [];

    for (const { flag, enabled } of parsed.data.rules) {
      try {
        await sc
          .from("feature_flags")
          .upsert({ flag, enabled }, { onConflict: "flag" });
        results.push({ flag, enabled, ok: true });
      } catch {
        results.push({ flag, enabled, ok: false });
      }
    }

    // Invalidate the Compass flags cache so routes pick up new values immediately
    invalidateFlagsCache();

    await logAdminAction(sc, userId, "update_frontload_rules", null, {
      rules: parsed.data.rules,
    });
    res.json({ updated: results });
  } catch (err) {
    req.log.error({ err }, "admin/compass/frontload-rules: failed");
    sendError(res, "db_error", "Could not update rules");
  }
});

// ── POST /api/admin/compass/users/:userId/remove-boost-eligibility ────────────

router.post("/admin/compass/users/:userId/remove-boost-eligibility", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const targetUserId = req.params["userId"];
  if (!targetUserId) { sendError(res, "invalid_payload", "Missing userId"); return; }

  try {
    await sc
      .from("compass_active_user_scores")
      .upsert(
        { user_id: targetUserId, boost_eligible: false },
        { onConflict: "user_id" },
      );

    await invalidate(sc, targetUserId, "admin_boost_eligibility_removed");
    await logAdminAction(sc, adminId, "remove_boost_eligibility", targetUserId);
    res.json({ ok: true, userId: targetUserId, boostEligible: false });
  } catch (err) {
    req.log.error({ err }, "admin/compass/remove-boost-eligibility: failed");
    sendError(res, "db_error", "Could not update boost eligibility");
  }
});

// ── POST /api/admin/compass/users/:userId/restore-boost-eligibility ──────────

router.post("/admin/compass/users/:userId/restore-boost-eligibility", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const targetUserId = req.params["userId"];
  if (!targetUserId) { sendError(res, "invalid_payload", "Missing userId"); return; }

  try {
    await sc
      .from("compass_active_user_scores")
      .upsert(
        { user_id: targetUserId, boost_eligible: true },
        { onConflict: "user_id" },
      );

    await invalidate(sc, targetUserId, "admin_boost_eligibility_restored");
    await logAdminAction(sc, adminId, "restore_boost_eligibility", targetUserId);
    res.json({ ok: true, userId: targetUserId, boostEligible: true });
  } catch (err) {
    req.log.error({ err }, "admin/compass/restore-boost-eligibility: failed");
    sendError(res, "db_error", "Could not update boost eligibility");
  }
});

// ── GET /api/admin/compass/abuse-flags ───────────────────────────────────────

router.get("/admin/compass/abuse-flags", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const severity = req.query["severity"] as string | undefined;
  const status   = req.query["status"]   as string | undefined;
  const limit    = Math.min(100, Number(req.query["limit"]) || 50);

  try {
    let query = sc
      .from("compass_abuse_flags")
      .select("id, pattern_type, involved_users, severity, status, evidence, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (severity) query = query.eq("severity", severity);
    if (status)   query = query.eq("status",   status);

    const { data, error } = await query;
    if (error) { sendError(res, "db_error", error.message); return; }
    res.json({ flags: data ?? [] });
  } catch (err) {
    req.log.error({ err }, "admin/compass/abuse-flags: query failed");
    sendError(res, "db_error", "Could not fetch abuse flags");
  }
});

// ── GET /api/admin/compass/safety-filters ────────────────────────────────────

router.get("/admin/compass/safety-filters", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(200, Number(req.query["limit"]) || 100);
  const since = req.query["since"] as string | undefined;

  try {
    let query = sc
      .from("compass_safety_filter_logs")
      .select("id, viewer_id, item_id, item_type, block_reason, author_id, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (since) query = query.gte("created_at", since);

    const { data, error } = await query;
    if (error) { sendError(res, "db_error", error.message); return; }

    // Summarise by reason
    const rows: any[] = data ?? [];
    const byReason: Record<string, number> = {};
    for (const r of rows) {
      byReason[r.block_reason] = (byReason[r.block_reason] ?? 0) + 1;
    }

    res.json({ total: rows.length, byReason, logs: rows });
  } catch (err) {
    req.log.error({ err }, "admin/compass/safety-filters: query failed");
    sendError(res, "db_error", "Could not fetch safety filter logs");
  }
});

// ── GET /api/admin/compass/active-rewards ─────────────────────────────────────

router.get("/admin/compass/active-rewards", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Number(req.query["limit"]) || 50);

  try {
    const { data, error } = await sc
      .from("compass_active_user_scores")
      .select("user_id, active_user_score, trust_multiplier, boost_eligible, boost_visibility_enabled, updated_at")
      .order("active_user_score", { ascending: false })
      .limit(limit);

    if (error) { sendError(res, "db_error", error.message); return; }
    res.json({ rewards: data ?? [] });
  } catch (err) {
    req.log.error({ err }, "admin/compass/active-rewards: query failed");
    sendError(res, "db_error", "Could not fetch active rewards");
  }
});

// ── GET /api/admin/compass/testing-sandbox ────────────────────────────────────

router.get("/admin/compass/testing-sandbox", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  try {
    const { data, error } = await sc
      .from("compass_testing_scenarios")
      .select("id, name, scenario, last_result, created_by, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(50);

    if (error) { sendError(res, "db_error", error.message); return; }
    res.json({ scenarios: data ?? [] });
  } catch (err) {
    req.log.error({ err }, "admin/compass/testing-sandbox: query failed");
    sendError(res, "db_error", "Could not fetch testing scenarios");
  }
});

// ── POST /api/admin/compass/testing-sandbox/preview ──────────────────────────

const VALID_USER_TYPES: TestUserType[] = ["traveler", "buddy", "new_user", "creator"];

const sandboxPreviewSchema = z.object({
  userType:   z.enum(["traveler", "buddy", "new_user", "creator"]),
  city:       z.string().min(1).max(120),
  intentMode: z.string().min(1).max(80).default("explore_now"),
  saveName:   z.string().max(200).optional(), // optional: save scenario for re-use
});

router.post("/admin/compass/testing-sandbox/preview", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = sandboxPreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { userType, city, intentMode, saveName } = parsed.data;

  try {
    // Run sandbox — intentionally passes null for db (no production reads/writes)
    const result = await runSandbox(null, { userType, city, intentMode });

    // Optionally save the scenario for future re-use
    if (saveName) {
      try {
        const scenario = { userType, city, intentMode };
        const { data: savedRow } = await sc
          .from("compass_testing_scenarios")
          .upsert(
            {
              name:        saveName,
              created_by:  userId,
              scenario,
              last_result: result,
              updated_at:  new Date().toISOString(),
            },
            { onConflict: "name" },
          )
          .select("id")
          .single();
        await logAdminAction(sc, userId, "save_testing_scenario", (savedRow as any)?.id, { scenario });
      } catch { /* non-fatal */ }
    }

    await logAdminAction(sc, userId, "run_testing_sandbox", null, { userType, city, intentMode });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "admin/compass/testing-sandbox/preview: failed");
    sendError(res, "db_error", "Sandbox preview failed");
  }
});

export default router;
