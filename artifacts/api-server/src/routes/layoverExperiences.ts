/** Owner-only executable experiences, using the recommendation-status rollout and the shared canonical snapshot. */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { compile, getCandidates } from "../services/airport/LayoverExperienceService.js";
import type { Response } from "express";

const router = Router();
const body = z.object({ candidateIds: z.array(z.string().min(1).max(200)).min(1).max(6) }).strict();
function refuse(res: Response, reason: string): void {
  if (reason === "not_found") { sendError(res, "not_found", "Session not found"); return; }
  if (reason === "feature_disabled") { sendError(res, "feature_disabled"); return; }
  if (/unreadable|unavailable/.test(reason) && reason !== "candidate_unavailable" && reason !== "candidate_terms_unavailable") {
    sendError(res, "degraded_unavailable", "The experience could not be checked. Please try again."); return;
  }
  res.status(409).json({ error: "conflict", message: "This experience needs to be checked again before it can be used.", reason });
}
router.get("/airport/sessions/:id/experiences", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const db = getServiceClient(); if (!db) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(db, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return; }
  const result = await getCandidates(db, auth.user.id, req.params.id);
  if (!result.ok) { refuse(res, "reason" in result ? result.reason : "candidates_unreadable"); return; }
  res.json(result);
}));
router.post("/airport/sessions/:id/experiences/compile", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const db = getServiceClient(); if (!db) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(db, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return; }
  const parsed = body.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "Choose between one and six experience candidates."); return; }
  const result = await compile(db, auth.user.id, req.params.id, parsed.data.candidateIds);
  if (!result.ok) { refuse(res, result.reason); return; }
  res.json(result);
}));
export default router;
