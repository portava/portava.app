import { Router, type IRouter } from "express";
import { HealthCheckResponse, CleanupHealthCheckResponse } from "@workspace/api-zod";
import { getCleanupStatus } from "../lib/dailyBriefCleanup.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/cleanup", (_req, res) => {
  const status = getCleanupStatus();
  const data = CleanupHealthCheckResponse.parse(status);
  res.json(data);
});

export default router;
