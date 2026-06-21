import { Router, type IRouter } from "express";
import { HealthCheckResponse, CleanupHealthCheckResponse } from "@workspace/api-zod";
import { getCleanupStatus, queryCleanupHealth } from "../lib/dailyBriefCleanup.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/cleanup", async (_req, res) => {
  const inMem = getCleanupStatus();

  // DB-backed check: persists across restarts and is the source of truth for
  // cleanupHealthy / lastRunAt. Falls back gracefully if the table is missing.
  const { cleanupHealthy, lastRunAt } = await queryCleanupHealth();

  if (!cleanupHealthy) {
    logger.warn(
      { lastRunAt, consecutiveFailures: inMem.consecutiveFailures },
      "cleanupHealthCheck: cleanup job has not run within the expected window",
    );
  }

  const data = CleanupHealthCheckResponse.parse({
    cleanupHealthy,
    lastRunAt,
    lastOutcome: inMem.lastOutcome,
    lastDeletedCount: inMem.lastDeletedCount,
    consecutiveFailures: inMem.consecutiveFailures,
  });
  res.json(data);
});

export default router;
