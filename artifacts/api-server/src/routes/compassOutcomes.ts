/**
 * Phase 14 — Outcome Learning routes.
 *
 * POST /api/compass/outcomes
 *   Records one stage of the recommendation outcome chain for the caller.
 *   Body: { recommendationId?: string, itemId?: string, stage: OutcomeStage }
 *   At least one of recommendationId / itemId is required. The stage is tied
 *   back to the originating compass_served_recommendations row; when the item
 *   was never recommended, the call no-ops with { recorded: false }.
 *
 * GET /api/compass/value-delivered   (admin)
 *   The north-star "value delivered" aggregate computed from the outcome
 *   chain — explicitly NOT chat-length or session-time based.
 *   Query: ?days=30 (1–90)
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  OUTCOME_STAGES,
  recordOutcome,
  computeValueDelivered,
} from "../compass/CompassOutcomeEngine.js";

const router = Router();

const outcomeBodySchema = z
  .object({
    recommendationId: z.string().min(1).max(2000).optional(),
    itemId:           z.string().min(1).max(200).optional(),
    stage:            z.enum(OUTCOME_STAGES),
  })
  .refine((b) => Boolean(b.recommendationId || b.itemId), {
    message: "recommendationId or itemId is required",
  });

router.post("/compass/outcomes", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = outcomeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const result = await recordOutcome(sc, user.id, {
    recommendationId: parsed.data.recommendationId,
    itemId:           parsed.data.itemId,
    stage:            parsed.data.stage,
    source:           "client",
  });

  res.json(result);
}));

router.get("/compass/value-delivered", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  // Admin only — analytics surface
  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const rawDays = parseInt((req.query.days as string) ?? "30");
  const report = await computeValueDelivered(sc, { days: isNaN(rawDays) ? 30 : rawDays });
  res.json(report);
}));

export default router;
