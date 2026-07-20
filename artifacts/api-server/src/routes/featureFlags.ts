import { Router } from "express";
import { getServiceClient } from "../lib/supabase";
import { sendError } from "../lib/http";
import { asyncHandler } from "../lib/asyncHandler";

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

  const flags: Record<string, boolean> = {};
  for (const row of data ?? []) {
    flags[row.flag] = row.enabled ?? false;
  }

  return res.json({ flags });
}));

export default router;
