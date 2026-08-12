import { Router } from "express";
import { getServiceClient } from "../lib/supabase";
import { sendError } from "../lib/http";
import { asyncHandler } from "../lib/asyncHandler";
import { resolveFeatureFlags } from "../lib/featureFlags";

const router = Router();

/**
 * GET /api/feature-flags
 * Returns all feature flags from the feature_flags table.
 * Public endpoint — flags only control UI behavior, contain no sensitive data.
 */
router.get("/feature-flags", asyncHandler(async (req, res) => {
  const sc = getServiceClient();
  if (!sc) {
    return sendError(res, "server_not_configured");
  }

  const { data, error } = await sc
    .from("feature_flags")
    .select("flag, enabled, description")
    .order("flag");

  if (error) {
    req.log.error({ err: error }, "feature-flags: query failed");
    return sendError(res, "db_error");
  }

  // Inert seeded flags (seeded but no readers anywhere) are excluded so client
  // bundles don't expose toggles that produce no observable effect.
  // The ten added 2026-08-12 are the wire-or-drop retirements of
  // 2080_retire_inert_seeded_flags.sql — see HIDDEN_INERT_FLAGS in routes/admin.ts
  // for why each was dropped rather than wired. They are filtered here as well as
  // there because this endpoint is what the mobile app's FeatureFlagsContext
  // fetches: an inert name reaching the client is a toggle a future screen could
  // gate on, believing it works.
  const INERT_FLAGS = new Set([
    "freeze_city", "freeze_event", "freeze_circle", "freeze_booking",
    "COMPASS_FRONTLOAD_ENABLED",
    "COMPASS_ACTIVE_REWARD_ENABLED",
    "COMPASS_EXPLAIN_WHY_ENABLED",
    "COMPASS_ADMIN_CONTROLS_ENABLED",
    "COMPASS_ABUSE_DEFENSE_ENABLED",
    "COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED",
    "notifications_enabled",
    "notification_digests_enabled",
    "realtime_activity_enabled",
    "safety_notifications_enabled",
  ]);

  const flags: Record<string, boolean> = {};
  for (const row of data ?? []) {
    if (!INERT_FLAGS.has(row.flag)) flags[row.flag] = row.enabled ?? false;
  }

  return res.json({ flags: resolveFeatureFlags(flags) });
}));

export default router;
