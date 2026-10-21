import { Router, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { readObjectiveIntent, saveObjectiveIntent, publishObjectiveFact, retractObjectiveFact } from "../services/airport/LayoverObjectiveEvidenceStore.js";
const router = Router();
function refusal(res: Response, reason: string) {
  res.status(reason === "feature_disabled" || reason === "not_found" || reason.endsWith("_not_found") ? 404 : reason.startsWith("invalid_") ? 400 : /unreadable|unavailable/.test(reason) ? 503 : 409).json({ ok: false, reason });
}
router.get("/airport/sessions/:id/objective-intent", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const db = getServiceClient(); if (!db) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(db, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return; }
  const result = await readObjectiveIntent(db, auth.user.id, req.params.id);
  if (!result.ok) { refusal(res, result.reason); return; } res.json(result);
}));
router.put("/airport/sessions/:id/objective-intent", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const db = getServiceClient(); if (!db) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(db, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return; }
  const result = await saveObjectiveIntent(db, auth.user.id, req.params.id, req.body);
  if (!result.ok) { refusal(res, result.reason); return; } res.json(result);
}));
router.post("/admin/airport/profiles/:airportId/places/:placeId/objective-evidence", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  const result = await publishObjectiveFact(admin.sc, admin.userId, req.params.airportId, req.params.placeId, req.body);
  if (!result.ok) { refusal(res, result.reason); return; } res.status(201).json(result);
}));
router.post("/admin/airport/objective-evidence/:id/retract", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  const result = await retractObjectiveFact(admin.sc, req.params.id);
  if (!result.ok) { refusal(res, result.reason); return; } res.json(result);
}));
export default router;
