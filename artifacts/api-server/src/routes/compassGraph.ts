/**
 * Phase 15 — Travel Intelligence Graph routes.
 *
 * POST /api/compass/graph/rebuild   (admin)
 *   Runs the batch builders: existing app data → graph nodes/edges →
 *   per-city Destination World Models → city-confidence index. Returns the
 *   rebuild report including the strongest launch city.
 *
 * GET /api/compass/graph/status     (admin)
 *   Aggregate graph counts + per-city confidence overview.
 *
 * GET /api/compass/city-confidence?city=Cebu   (authenticated)
 *   The city-confidence record for one city — aggregates only (score, tier,
 *   signal counts). Unknown cities return an honest `tier: "thin"` default.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  rebuildIntelligenceGraph,
  getCityConfidence,
  cityConfidenceNote,
} from "../compass/CompassGraphEngine.js";

const router = Router();

async function requireAdmin(req: any, res: any) {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { data, error } = await auth.client
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }
  return auth;
}

router.post("/compass/graph/rebuild", asyncHandler(async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const report = await rebuildIntelligenceGraph(sc);
  res.json(report);
}));

router.get("/compass/graph/status", asyncHandler(async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const [{ count: nodeCount }, { count: edgeCount }, { data: cities }] = await Promise.all([
    sc.from("compass_graph_nodes").select("id", { count: "exact", head: true }),
    sc.from("compass_graph_edges").select("id", { count: "exact", head: true }),
    sc.from("compass_city_confidence")
      .select("city, depth_score, tier, computed_at")
      .order("depth_score", { ascending: false })
      .limit(50),
  ]);

  res.json({
    nodes:  nodeCount ?? 0,
    edges:  edgeCount ?? 0,
    cities: (cities as any[]) ?? [],
    strongestCity: ((cities as any[]) ?? [])[0]?.city ?? null,
  });
}));

router.get("/compass/city-confidence", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const city = String(req.query.city ?? "").trim();
  if (!city) {
    sendError(res, "invalid_payload", "city query parameter is required");
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const conf = await getCityConfidence(sc, city);
  // Aggregates only — never user ids/handles/coordinates.
  res.json({
    city,
    depthScore: conf?.depthScore ?? 0,
    tier:       conf?.tier ?? "thin",
    note:       cityConfidenceNote(conf, city),
    computedAt: conf?.computedAt ?? null,
  });
}));

export default router;
