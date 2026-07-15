/**
 * /api/locations — universal location service endpoints.
 *
 * GET  /api/locations/popular?lat=&lng=&limit=
 *        Popular cities ranked by real traveler activity (posts, trips,
 *        events, saves, presence) with seed fallback. Public.
 *
 * POST /api/locations/resolve          (auth required)
 *        Resolve a selected Place to its canonical location: returns
 *        { canonicalId, place } where place is the input merged with
 *        normalized canonical fields. Called on picker selection so every
 *        saved location shares one location truth.
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { checkRateLimit } from "../lib/rateLimit";
import { getServiceClient } from "../lib/supabase";
import { getPopularCities } from "../lib/popularCities";
import { resolveCanonicalLocation } from "../lib/canonicalLocations";
import { logger as rootLogger } from "../lib/logger";

const router = Router();
const logger = rootLogger.child({ route: "locations" });

// ── GET /api/locations/popular ────────────────────────────────────────────────
router.get("/locations/popular", async (req, res) => {
  const latStr = typeof req.query.lat === "string" ? req.query.lat : undefined;
  const lngStr = typeof req.query.lng === "string" ? req.query.lng : undefined;
  const lat = latStr != null ? parseFloat(latStr) : undefined;
  const lng = lngStr != null ? parseFloat(lngStr) : undefined;

  if (lat != null && (isNaN(lat) || lat < -90 || lat > 90)) {
    res.status(400).json({ error: "invalid_payload", message: "Invalid lat" });
    return;
  }
  if (lng != null && (isNaN(lng) || lng < -180 || lng > 180)) {
    res.status(400).json({ error: "invalid_payload", message: "Invalid lng" });
    return;
  }
  const limitStr = typeof req.query.limit === "string" ? req.query.limit : undefined;
  const limit = limitStr != null ? parseInt(limitStr, 10) : undefined;
  if (limit != null && (isNaN(limit) || limit < 1 || limit > 20)) {
    res.status(400).json({ error: "invalid_payload", message: "limit must be 1-20" });
    return;
  }

  try {
    const db = getServiceClient();
    const places = await getPopularCities(db, { lat, lng, limit });
    res.json({ places });
  } catch (err) {
    logger.warn({ err }, "popular cities failed");
    res.json({ places: [] });
  }
});

// ── POST /api/locations/resolve ───────────────────────────────────────────────
router.post("/locations/resolve", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  // Resolve can create canonical rows (service-role write) — throttle it.
  // Normal picker usage is a handful of calls per minute; 60 is generous.
  const rl = checkRateLimit("locations_resolve", user.id, 60, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many requests. Please wait.");
    return;
  }

  const { place } = (req.body ?? {}) as { place?: any };
  if (
    !place || typeof place !== "object" ||
    typeof place.id !== "string" || !place.id ||
    typeof place.name !== "string" || !place.name.trim() ||
    typeof place.type !== "string"
  ) {
    sendError(res, "invalid_payload", "place.id, place.name and place.type are required");
    return;
  }
  for (const [field, max] of [
    ["id", 300], ["name", 200], ["displayName", 400], ["type", 40],
    ["country", 120], ["countryCode", 8], ["region", 160], ["city", 160],
  ] as const) {
    const v = place[field];
    if (v != null && (typeof v !== "string" || v.length > max)) {
      sendError(res, "invalid_payload", `place.${field} invalid or too long`);
      return;
    }
  }
  for (const field of ["lat", "lng"] as const) {
    const v = place[field];
    if (v != null && (typeof v !== "number" || !isFinite(v) || Math.abs(v) > (field === "lat" ? 90 : 180))) {
      sendError(res, "invalid_payload", `place.${field} out of range`);
      return;
    }
  }

  const db = getServiceClient();
  if (!db) {
    // Server not configured — return the place unresolved rather than failing.
    res.json({ canonicalId: null, place });
    return;
  }

  try {
    const result = await resolveCanonicalLocation(db, place);
    // Merge canonical truth over the raw selection; keep incoming values when
    // the canonical side has nothing better (nulls never overwrite data).
    const merged: any = { ...place, canonicalId: result.canonicalId };
    for (const [k, v] of Object.entries(result.canonical)) {
      if (v != null) merged[k] = v;
    }
    res.json({ canonicalId: result.canonicalId, place: merged });
  } catch (err) {
    logger.warn({ err }, "resolve failed — returning unresolved place");
    res.json({ canonicalId: null, place });
  }
});

export default router;
