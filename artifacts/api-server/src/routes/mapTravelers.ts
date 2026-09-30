/**
 * GET /api/map/travelers — travelers visible on the Discovery live map.
 *
 * Auth required. Returns ONLY users who share their location in discovery,
 * at coarsened positions (city centroid or ~2 km grid) — see lib/mapTravelers
 * for the full privacy contract. Blocked relationships are excluded
 * fail-closed: if the block list cannot be read, nobody is returned.
 *
 * Query params:
 *   lat, lng   — map viewport centre (required, finite, in range)
 *   radiusKm   — search radius, clamped to 1..100 (default 50)
 *
 * Response: { travelers: MapTravelerPayload[], generatedAt: string }
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { checkRateLimit } from "../lib/rateLimit";
import { getServiceClient } from "../lib/supabase";
import { listMapTravelersRead } from "../lib/mapTravelers";
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
    const read = await listMapTravelersRead(db, {
      viewerId: user.id,
      lat,
      lng,
      radiusKm,
      blockedSet,
    });
    // `null` means the read (or the block-state lookup it depends on) FAILED.
    // Serving it as `travelers: []` would tell the client the area is empty on
    // the strength of a database error — the defect listMapTravelers' failure
    // channel exists to end. A 5xx is the honest answer.
    if (read === null) {
      sendError(res, "db_error", "Could not load map travelers");
      return;
    }
    res.json({ travelers: read.travelers, generatedAt: new Date().toISOString(), ...(read.truncated ? { truncated: true } : {}) });  // census-discovery §113 (DV-83, D-W11X2-129): a cut scan or slice is said, never served as the whole viewport
  } catch (err) {
    req.log.error({ err }, "map/travelers failed");
    sendError(res, "db_error", "Could not load map travelers", { exposeDetail: true });
  }
});

export default router;
