/** Explicit owner selection/start; no client plan JSON or legal assertion is accepted. */
import { Router, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { mutateExperiencePlan, readExperiencePlan } from "../services/airport/LayoverExperiencePlans.js";

const router = Router();
const selection = z.object({ requestId: z.string().uuid(), expectedStopIds: z.array(z.string().uuid()).min(1).max(6) }).strict();
const start = selection.extend({ selectedPlanId: z.string().uuid(), confirmed: z.literal(true) }).strict();
function refuse(res: Response, result: { reason: string; actionId?: string }) {
  if (result.reason === "not_found") { sendError(res, "not_found", "Session not found"); return; }
  if (result.reason === "feature_disabled") { sendError(res, "feature_disabled"); return; }
  res.status(/unreadable|unavailable/.test(result.reason) ? 503 : 409).json({ ok: false, ...result });
}
router.get("/airport/sessions/:id/experiences/plan", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const db = getServiceClient(); if (!db) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(db, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return; }
  const result = await readExperiencePlan(db, auth.user.id, req.params.id);
  if (!result.ok) { refuse(res, result); return; } res.json(result);
}));
function operationHandler(operation: "select" | "start") {
  return asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res); if (!auth) return;
    const parsed = (operation === "select" ? selection : start).safeParse(req.body);
    if (!parsed.success) { sendError(res, "invalid_payload", "Choose the saved stops and explicitly confirm a current plan before starting."); return; }
    const db = getServiceClient(); if (!db) { sendError(res, "server_not_configured"); return; }
    if (!(await isFlagEnabled(db, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return; }
    const result = await mutateExperiencePlan(db, auth.user.id, req.params.id, { ...parsed.data, operation });
    if (!result.ok) { refuse(res, result); return; } res.json(result);
  });
}
router.post("/airport/sessions/:id/experiences/plan/select", operationHandler("select"));
router.post("/airport/sessions/:id/experiences/plan/start", operationHandler("start"));
export default router;

import { readExperienceGeometry } from '../services/airport/LayoverExperienceGeometry.js';
const mapQuery=z.object({planId:z.string().uuid(),version:z.coerce.number().int().positive()}).strict();
router.get('/airport/sessions/:id/experiences/plan/map',asyncHandler(async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  const auth=await requireUser(req,res);if(!auth)return;
  const parsed=mapQuery.safeParse(req.query);if(!parsed.success){sendError(res,'invalid_payload','Choose the current reviewed plan.');return;}
  const db=getServiceClient();if(!db){sendError(res,'server_not_configured');return;}
  if(!await isFlagEnabled(db,'airport_mode_enabled')){sendError(res,'feature_disabled');return;}
  const result=await readExperienceGeometry(db,auth.user.id,req.params.id,parsed.data);
  if(!result.ok){refuse(res,result);return;}res.json(result);
}));
