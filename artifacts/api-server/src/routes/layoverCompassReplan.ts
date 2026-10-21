/** Explicit owner approval is separate from model tool execution. */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { executeCompassReplan } from "../services/airport/LayoverCompassReplan.js";

const router = Router();
const approval = z.object({ actionId: z.string().uuid(), confirmed: z.literal(true) }).strict();
router.post("/airport/sessions/:id/compass/replan", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const parsed = approval.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "Explicit confirmation of the offered action is required."); return; }
  const db = getServiceClient(); if (!db) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(db, "airport_mode_enabled")) || !(await isFlagEnabled(db, "layover_compass_enabled"))) { sendError(res, "feature_disabled"); return; }
  const outcome = await executeCompassReplan(db, auth.user.id, req.params.id, parsed.data.actionId);
  if (!outcome.ok) {
    if (outcome.reason === "not_found") { sendError(res, "not_found", "Action not found"); return; }
    if (outcome.reason === "feature_disabled") { sendError(res, "feature_disabled"); return; }
    res.status(/unavailable|unreadable/.test(outcome.reason) ? 503 : 409).json(outcome); return;
  }
  res.status(outcome.result.state === "applied" ? 200 : 503).json(outcome);
}));
export default router;
