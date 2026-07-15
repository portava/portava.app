/**
 * /api/places — place search, reverse geocode, and recent places.
 *
 * GET  /api/places/search?q=&type=&countryCode=&lat=&lng=
 * GET  /api/places/reverse?lat=&lng=
 * GET  /api/me/recent-places          (auth required)
 * POST /api/me/recent-places          (auth required)
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { reverseGeocode } from "../services/geocodingService";
import { logger as rootLogger } from "../lib/logger";

const router = Router();
const logger = rootLogger.child({ route: "places" });

/** In-process rate limiter for Nominatim (1 req/sec per TOS) */
let nominatimLastCall = 0;
async function nominatimRateLimit() {
  const now = Date.now();
  const wait = 1100 - (now - nominatimLastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nominatimLastCall = Date.now();
}

// ── Server-side search result cache (5-minute TTL) ────────────────────────────

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

interface SearchCacheEntry {
  places: any[];
  ts: number;
}

const searchCache = new Map<string, SearchCacheEntry>();

function makeSearchCacheKey(
  q: string,
  countryCode: string | undefined,
  lat: number | undefined,
  lng: number | undefined,
): string {
  // Round lat/lng to 2 decimal places (~1 km) so nearby identical queries share a cache entry
  const latKey = lat != null ? lat.toFixed(2) : "";
  const lngKey = lng != null ? lng.toFixed(2) : "";
  return `${q.toLowerCase()}:${countryCode ?? ""}:${latKey}:${lngKey}`;
}

function getSearchCached(key: string): any[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.places;
}

function setSearchCached(key: string, places: any[]): void {
  searchCache.set(key, { places, ts: Date.now() });
}

// ── Nominatim helpers ─────────────────────────────────────────────────────────

async function searchNominatim(
  q: string,
  opts: { countryCode?: string; lat?: number; lng?: number; limit?: number },
) {
  await nominatimRateLimit();
  const params = new URLSearchParams({
    q,
    format: "json",
    addressdetails: "1",
    namedetails: "1",
    limit: String(opts.limit ?? 8),
    dedupe: "1",
  });
  if (opts.countryCode) params.set("countrycodes", opts.countryCode.toLowerCase());

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    {
      headers: {
        "User-Agent": "TravelBuddyApp/1.0",
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return res.json() as Promise<any[]>;
}

function normalizeNominatim(raw: any) {
  const addr = raw.address ?? {};
  const city =
    addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.county ?? null;
  const district = addr.suburb ?? addr.neighbourhood ?? addr.quarter ?? null;
  const country = addr.country ?? null;
  const countryCode = addr.country_code?.toUpperCase() ?? null;
  const region = addr.state ?? addr.province ?? null;

  const name =
    raw.namedetails?.name ??
    addr.city ?? addr.town ?? addr.village ?? addr.municipality ??
    (raw.display_name as string | undefined)?.split(",")[0] ?? "Unknown";

  const displayParts: string[] = [name];
  if (district && district !== name) displayParts.push(district);
  if (city && city !== name) displayParts.push(city);
  if (country) displayParts.push(country);

  return {
    id: `nominatim-${raw.place_id as string}`,
    type: "city" as const,
    name,
    displayName: displayParts.join(", "),
    country,
    countryCode,
    region,
    city,
    district,
    lat: raw.lat != null ? parseFloat(raw.lat as string) : null,
    lng: raw.lon != null ? parseFloat(raw.lon as string) : null,
    timezone: null,
    source: "nominatim" as const,
  };
}

// ── GET /api/places/search ────────────────────────────────────────────────────
router.get("/places/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "q is required (max 200 chars)" });
    return;
  }

  const countryCode =
    typeof req.query.countryCode === "string" ? req.query.countryCode : undefined;
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

  // Check server-side cache
  const cacheKey = makeSearchCacheKey(q, countryCode, lat, lng);
  const cached = getSearchCached(cacheKey);
  if (cached) {
    res.json({ places: cached });
    return;
  }

  try {
    const raw = await searchNominatim(q, { countryCode, lat, lng });
    const places = Array.isArray(raw) ? raw.map(normalizeNominatim) : [];
    setSearchCached(cacheKey, places);
    res.json({ places });
  } catch (err) {
    logger.warn({ err, q }, "place search failed — returning empty");
    res.json({ places: [] });
  }
});

// ── GET /api/places/reverse ───────────────────────────────────────────────────
router.get("/places/reverse", async (req, res) => {
  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "invalid_payload", message: "Valid lat and lng are required" });
    return;
  }

  try {
    const result = await reverseGeocode(lat, lng);
    if (!result) {
      res.json({ place: null });
      return;
    }
    const place = {
      id: `reverse-${lat.toFixed(4)}-${lng.toFixed(4)}`,
      type: "city" as const,
      name: result.city ?? result.country ?? "Unknown",
      displayName: [result.city, result.country].filter(Boolean).join(", "),
      country: result.country ?? null,
      countryCode: result.countryCode ?? null,
      region: null,
      city: result.city ?? null,
      district: result.district ?? null,
      lat,
      lng,
      timezone: null,
      source: "nominatim" as const,
    };
    res.json({ place });
  } catch (err) {
    logger.warn({ err }, "reverse geocode failed");
    res.json({ place: null });
  }
});

// ── GET /api/me/recent-places ─────────────────────────────────────────────────
router.get("/me/recent-places", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const db = getServiceClient();
  if (!db) { res.json({ places: [] }); return; }

  try {
    const { data, error } = await db
      .from("user_recent_places")
      .select("id, place_snapshot, used_for, used_at")
      .eq("user_id", user.id)
      .order("used_at", { ascending: false })
      .limit(10);

    if (error) throw error;
    const places = (data ?? []).map((row: any) => row.place_snapshot);
    res.json({ places });
  } catch (err) {
    logger.warn({ err }, "failed to fetch recent places");
    res.json({ places: [] });
  }
});

// ── POST /api/me/recent-places ────────────────────────────────────────────────
router.post("/me/recent-places", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const db = getServiceClient();

  if (!db) { sendError(res, "server_not_configured"); return; }

  const { place, usedFor } = (req.body ?? {}) as { place?: any; usedFor?: string };
  if (!place || typeof place !== "object" || !place.id || !place.name) {
    sendError(res, "invalid_payload", "place.id and place.name are required");
    return;
  }

  try {
    // Remove existing entry for this place_id, then insert fresh (keeps it sorted)
    await db
      .from("user_recent_places")
      .delete()
      .eq("user_id", user.id)
      .eq("place_snapshot->>id", place.id as string);

    await db.from("user_recent_places").insert({
      user_id: user.id,
      place_snapshot: place,
      used_for: usedFor ?? null,
      used_at: new Date().toISOString(),
    });

    // Trim to 10
    const { data: all } = await db
      .from("user_recent_places")
      .select("id")
      .eq("user_id", user.id)
      .order("used_at", { ascending: false });

    if (all && all.length > 10) {
      const toDelete = (all as { id: string }[]).slice(10).map((r) => r.id);
      await db.from("user_recent_places").delete().in("id", toDelete);
    }

    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err }, "failed to save recent place");
    sendError(res, "db_error", "Failed to save recent place");
  }
});

export default router;
