/**
 * GET /api/map/travelers — travelers visible on the Discovery live map.
 *
 * Auth required. Returns ONLY users who share their location in discovery,
 * at coarsened positions (city centroid or ~2 km grid) — see lib/mapTravelers
 * for the full privacy contract. Blocked relationships are excluded
 * fail-closed: if the block list cannot be read, nobody is returned.
 *
 * A FAILED READ IS NOT AN EMPTY MAP. `listMapTravelers` refuses (it does not
 * return an empty list) when the block set is unresolvable or when the
 * candidate or privacy reads fail, and this route answers `db_error` for all
 * three — the same answer it has always given when the read THREW. supabase-js
 * returns its errors rather than throwing, so before this the identical failure
 * arrived as 200 { travelers: [] }: "nobody is on the map".
 *
 * Query params:
 *   lat, lng   — map viewport centre (required, finite, in range)
 *   radiusKm   — search radius, clamped to 1..100 (default 50)
 *
 * Response: { travelers: MapTravelerPayload[], generatedAt: string }
 *           or the standard db_error envelope (500) when the read refused.
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { checkRateLimit } from "../lib/rateLimit";
import { getServiceClient } from "../lib/supabase";
import { listMapTravelers } from "../lib/mapTravelers";
import { fetchBlockedSet } from "../lib/blocks";

const router = Router();

router.get("/map/travelers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  // Polling endpoint (client polls every 45 s) — generous but bounded.
  const rl = checkRateLimit("map_travelers", user.id, 30, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many requests. Please wait.");
    return;
  }

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    sendError(res, "invalid_payload", "lat and lng are required and must be in range");
    return;
  }
  const radiusRaw = Number(req.query.radiusKm);
  const radiusKm = isFinite(radiusRaw) ? Math.min(100, Math.max(1, radiusRaw)) : 50;

  const db = getServiceClient();
  if (!db) {
    sendError(res, "server_not_configured");
    return;
  }

  try {
    const blockedSet = await fetchBlockedSet(db, user.id);
    const read = await listMapTravelers(db, {
      viewerId: user.id,
      lat,
      lng,
      radiusKm,
      blockedSet,
    });
    if (!read.ok) {
      // This route ALREADY answers db_error when the read THROWS (see the catch
      // below). supabase-js returns its errors instead of throwing, so the same
      // failure used to arrive here as an empty list and was served as 200
      // "nobody is on the map". One failure, one answer.
      req.log.error({ reason: read.reason }, "map/travelers read refused");
      sendError(res, "db_error", "Could not load map travelers", { exposeDetail: true });
      return;
    }
    res.json({ travelers: read.travelers, generatedAt: new Date().toISOString() });
  } catch (err) {
    req.log.error({ err }, "map/travelers failed");
    sendError(res, "db_error", "Could not load map travelers", { exposeDetail: true });
  }
});

export default router;
