import { Router, type IRouter } from "express";
import { HealthCheckResponse, CleanupHealthCheckResponse } from "@workspace/api-zod";
import { getCleanupStatus, queryCleanupHealth } from "../lib/dailyBriefCleanup.js";
import { purgeOldWeatherCache } from "../lib/weatherCacheCleanup.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/cleanup", async (_req, res) => {
  const inMem = getCleanupStatus();

  // DB-backed check: persists across restarts and is the source of truth for
  // cleanupStatus / lastRunAt. Falls back gracefully if the table is missing.
  const { cleanupStatus, lastRunAt } = await queryCleanupHealth();

  if (cleanupStatus === "critical") {
    logger.error(
      { lastRunAt, consecutiveFailures: inMem.consecutiveFailures },
      "cleanupHealthCheck: cleanup job is critically overdue — immediate attention required",
    );
  } else if (cleanupStatus === "overdue") {
    logger.warn(
      { lastRunAt, consecutiveFailures: inMem.consecutiveFailures },
      "cleanupHealthCheck: cleanup job has not run within the expected window",
    );
  }

  const data = CleanupHealthCheckResponse.parse({
    cleanupStatus,
    lastRunAt,
    lastOutcome: inMem.lastOutcome,
    lastDeletedCount: inMem.lastDeletedCount,
    consecutiveFailures: inMem.consecutiveFailures,
  });
  res.json(data);
});

/**
 * POST /admin/cleanup/weather-cache
 *
 * Internal endpoint — triggers an immediate weather cache purge and returns
 * the number of rows deleted. No external auth required; intended for
 * server-side or scheduled invocation only (not exposed to mobile clients).
 */
router.post("/admin/cleanup/weather-cache", async (req, res) => {
  const secret = process.env.CLEANUP_ADMIN_SECRET;
  if (secret) {
    const provided = req.headers["x-cleanup-secret"];
    if (provided !== secret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }
  const { deleted, error } = await purgeOldWeatherCache();
  if (error) {
    logger.error({ err: error }, "admin/cleanup/weather-cache: purge failed");
    res.status(500).json({ error: "purge_failed" });
    return;
  }
  res.json({ deleted: deleted ?? 0 });
});

export default router;
