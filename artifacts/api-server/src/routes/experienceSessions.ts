import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  closeExperienceSession,
  computeExperienceCalibration,
  recordExperienceOutcome,
  startExperienceSession,
  SIGNIFICANT_OUTCOMES,
} from "../services/experience/ExperienceSessionService.js";

const router = Router();
const startSchema = z.object({
  recommendationId: z.string().min(1).max(240),
  purpose: z.enum(["recommendation", "world_moment", "forecast"]).optional(),
});
const outcomeSchema = z.object({
  sessionId: z.string().min(1).max(240),
  outcome: z.enum(SIGNIFICANT_OUTCOMES),
  occurredAt: z.string().datetime().optional(),
  confirmMemory: z.boolean().optional(),
});

router.post("/experience/sessions", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }
  const result = await startExperienceSession(getServiceClient(), auth.user.id, parsed.data);
  if (!result.ok && result.reason === "db_unavailable") { sendError(res, "server_not_configured", "Service client not available"); return; }
  res.status(result.ok ? 201 : 400).json(result);
}));

router.post("/experience/sessions/:sessionId/outcomes", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = outcomeSchema.safeParse({ ...req.body, sessionId: req.params.sessionId });
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }
  const result = await recordExperienceOutcome(getServiceClient(), auth.user.id, parsed.data);
  res.status(result.ok || result.reason === "duplicate" ? 200 : result.reason === "not_found" ? 404 : 400).json(result);
}));

router.post("/experience/sessions/:sessionId/close", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const status = req.body?.status === "abandoned" ? "abandoned" : "completed";
  const result = await closeExperienceSession(getServiceClient(), auth.user.id, req.params.sessionId, status);
  res.status(result.ok ? 200 : result.reason === "not_found" ? 404 : 400).json(result);
}));

router.get("/experience/calibration", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  // Calibration is owner-agnostic analytics; restrict this aggregate to admins.
  const { data } = await auth.client.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((data as any)?.role !== "admin") { res.status(403).json({ error: "forbidden", message: "Admin role required" }); return; }
  const days = Number(req.query.days);
  res.json(await computeExperienceCalibration(getServiceClient(), { days: Number.isFinite(days) ? days : 30 }));
}));

export default router;