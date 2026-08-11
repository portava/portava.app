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
  const INERT_FLAGS = new Set(["freeze_city", "freeze_event", "freeze_circle", "freeze_booking"]);

  const flags: Record<string, boolean> = {};
  for (const row of data ?? []) {
    if (!INERT_FLAGS.has(row.flag)) flags[row.flag] = row.enabled ?? false;
  }

  return res.json({ flags: resolveFeatureFlags(flags) });
}));

export default router;
