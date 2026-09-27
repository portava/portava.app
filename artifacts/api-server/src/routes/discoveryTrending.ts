/**
 * `11` §4 — the Trending API, the READ-ONLY half (census-discovery §58).
 *
 *   trend explanation   GET /v1/discovery/trending/explanations?recommendationIds=a,b,…
 *
 * `11` §4 lists five actions. Where the other four stand, stated so this file
 * is not mistaken for the set:
 *
 *   trending by Trail       routes/trails.ts GET /v1/discovery/trails/:id/trending (P7, §51)
 *   trending by location    NOT BUILT — needs a location axis the trend model
 *                           does not have (DV-29) and an ORDER over places, which
 *                           is ranking machinery under the 2026-08-15 hold
 *   personalized trending   NOT BUILT — a viewer × trend combination is a new
 *                           ranking term (held)
 *   emerging places/Trails  NOT BUILT — a place list is an order plus a
 *                           location scope (as above); a Trail has no trend
 *                           STATE, only a momentum boolean
 *
 * WHAT THIS ROUTE DOES NOT DO: compute anything. It reads what
 * `rebuild_place_momentum` stored (lib/discoveryTrendExplanation), and changes
 * no order anywhere. No serve path imports it.
 *
 * Behind `discovery_trending_api_enabled` (3410, seeded FALSE; read per request
 * with isFlagEnabled, so revoking it takes effect on the next request and an
 * unreadable flag reads OFF). Signed-in only: the answer is scoped to the
 * viewer's own exposures, which an anonymous serve does not have.
 *
 * `11` §9's error semantics: 401 unauthenticated · 404 feature_disabled ·
 * 400 invalid_payload · 503 degraded_unavailable with a closed `reason`
 * (exposure_read_failed | trend_store_absent | trend_read_failed). A failed read
 * never answers 200 with empty explanations.
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  explainExposures, parseRecommendationIds, readViewerExposures, readTrendSnapshot,
  TREND_EXPLANATIONS_MAX_IDS,
} from "../lib/discoveryTrendExplanation.js";

const router = Router();

router.get("/v1/discovery/trending/explanations", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) return sendError(res, "degraded_unavailable", "trend explanations are not available in this deployment", { reason: "no_service_client" });

  // Literal at the read site (check:flag-polarity reads call sites).
  if (!(await isFlagEnabled(sc, "discovery_trending_api_enabled"))) {
    return sendError(res, "feature_disabled", "trend explanations are not enabled");
  }

  const ids = parseRecommendationIds(req.query["recommendationIds"]);
  if (!ids) {
    return sendError(res, "invalid_payload",
      `recommendationIds must be 1-${TREND_EXPLANATIONS_MAX_IDS} served recommendation ids, comma-separated`);
  }

  const exposures = await readViewerExposures(sc, auth.user.id, ids);
  if (!exposures.ok) {
    return sendError(res, "degraded_unavailable", "the served exposures could not be read", { reason: exposures.reason });
  }

  const snapshot = await readTrendSnapshot(sc, exposures.bindings.map((b) => b.itemId));
  if (!snapshot.ok) {
    return sendError(res, "degraded_unavailable", "the stored trend states could not be read", { reason: snapshot.reason });
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.json(explainExposures(ids, exposures.bindings, snapshot.run, snapshot.rows, Date.now()));
}));

export default router;
