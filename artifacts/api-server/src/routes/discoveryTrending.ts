/**
 * `11` §4 — the Trending API, the READ-ONLY half (census-discovery §58).
 *
 *   trend explanation   GET /v1/discovery/trending/explanations?recommendationIds=a,b,…
 *
 * `11` §4 lists five actions. Where the other four stand, stated so this file
 * is not mistaken for the set:
 *
 *   trending by Trail       routes/trails.ts GET /v1/discovery/trails/:id/trending (P7, §51)
 *   trending by location    GET …/trending/places   (§84, W10-R1: the v2 run's
 *                           `city`, ordered by claim then normalised velocity)
 *   personalized trending   GET …/trending/for-you  (§84: the viewer's category
 *                           affinity first, then as by location)
 *   emerging places/Trails  GET …/trending/emerging (§84: places from the run;
 *                           Trails by the v2 model over their place members)
 *   Local Pulse (`03` §3)   GET …/trending/areas    (§84: named neighbourhoods)
 *                           — all four behind discovery_trend_lists_enabled too
 *
 * WHAT THIS ROUTE DOES NOT DO: change an order anywhere else. It reads what
 * `rebuild_place_momentum` stored (lib/discoveryTrendExplanation); only the
 * emerging Trails are computed on the request. No serve path imports it.
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
} from "../lib/discoveryTrendExplanation.js"; import { parseDestination, trendingByLocation, personalizedTrending, emergingPlacesAndTrails, localPulse } from "../lib/discoveryTrendExplanation.js";  // §84 (W10-R1)

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
  res.json(explainExposures(ids, exposures.bindings, snapshot.run, snapshot.rows, Date.now(), snapshot.areas ?? []));  // §84: a v2 run's Local Pulse rows, for the neighbourhood k-floor
}));

// ── census-discovery §84 (lane W10-R1, DC-21, DV-29): the three list actions and Local Pulse ──
//
//   trending by location    GET /v1/discovery/trending/places?destination=…
//   personalized trending   GET /v1/discovery/trending/for-you?destination=…
//   emerging places/Trails  GET /v1/discovery/trending/emerging?destination=…
//   Local Pulse             GET /v1/discovery/trending/areas?destination=…
//
// Behind BOTH discovery_trending_api_enabled (3410) and discovery_trend_lists_enabled
// (3475), each seeded FALSE and read per request, fail-closed. Every list reads
// the newest STORED run (nothing is computed on a request except the emerging
// Trails' fold), discloses a state only above the k-floor, names only places
// this viewer may be served (active, author policy, protected zones), and
// carries no number (`11` §4). `11` §9's errors as above; an unapplied rule is a
// 503 `eligibility_read_failed`, never a list served without it.
//
// Q12 (owner, 2026-10-04) — "at least 15 travellers AND suppress contributions
// inside protected zones" — applies to all four, not only the ones that name a
// place: `areas` withholds a neighbourhood a protected zone fed, and the
// `emerging` Trails fold drops a withheld place member before counting it.
// An unreadable zone policy on `areas` is that same 503, never an empty pulse.
type ListAction = "places" | "for-you" | "emerging" | "areas";
function listHandler(action: ListAction) {
  return asyncHandler(async (req: Request, res: Response) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) return sendError(res, "degraded_unavailable", "trending lists are not available in this deployment", { reason: "no_service_client" });
    // Literals at the read site (check:flag-polarity reads call sites).
    if (!(await isFlagEnabled(sc, "discovery_trending_api_enabled")) || !(await isFlagEnabled(sc, "discovery_trend_lists_enabled"))) {
      return sendError(res, "feature_disabled", "trending lists are not enabled");
    }
    const destination = parseDestination(req.query["destination"]);
    if (!destination) return sendError(res, "invalid_payload", "destination must be a city name of 1-80 letters, digits, spaces, dots, apostrophes or hyphens");
    const nowMs = Date.now();
    const out = action === "places" ? await trendingByLocation(sc, auth.user.id, destination, nowMs)
      : action === "for-you" ? await personalizedTrending(sc, auth.user.id, destination, nowMs)
      : action === "emerging" ? await emergingPlacesAndTrails(sc, auth.user.id, destination, nowMs)
      : await localPulse(sc, destination, nowMs);
    if (!out.ok) return sendError(res, "degraded_unavailable", "the stored trend states could not be read", { reason: out.reason });
    res.setHeader("Cache-Control", "private, no-store");
    res.json("basis" in out && out.basis ? { ...out.body, basis: out.basis } : out.body);
  });
}
router.get("/v1/discovery/trending/places", listHandler("places"));
router.get("/v1/discovery/trending/for-you", listHandler("for-you"));
router.get("/v1/discovery/trending/emerging", listHandler("emerging"));
router.get("/v1/discovery/trending/areas", listHandler("areas"));

export default router;
