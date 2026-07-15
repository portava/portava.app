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
import { listMapTravelers } from "../lib/mapTravelers";

const router = Router();

/** Blocked-user set, both directions. Returns null on error — callers MUST
 *  treat null as "show nobody" (same contract as discoverySearch). */
async function fetchBlockedSet(sc: any, userId: string): Promise<Set<string> | null> {
  try {
    const { data, error } = await sc
      .from("blocks")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
    if (error) return null;
    const set = new Set<string>();
    for (const b of data ?? []) {
      if ((b as any).blocker_id === userId) set.add((b as any).blocked_id);
      else set.add((b as any).blocker_id);
    }
    return set;
  } catch {
    return null;
  }
}

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
    const travelers = await listMapTravelers(db, {
      viewerId: user.id,
      lat,
      lng,
      radiusKm,
      blockedSet,
    });
    res.json({ travelers, generatedAt: new Date().toISOString() });
  } catch (err) {
    req.log.error({ err }, "map/travelers failed");
    sendError(res, "db_error", "Could not load map travelers");
  }
});

export default router;
