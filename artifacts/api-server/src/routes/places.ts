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
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine";
import { reverseGeocode } from "../services/geocodingService";
import { searchFoursquare } from "../lib/foursquarePlaces";
import {
  getLiveVenueStatus,
  makeConfidence,
  CANT_VERIFY_NOTE,
} from "../lib/liveIntelligence";
import { normalizeLocationName } from "../lib/canonicalLocations";
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
  type?: string,
): string {
  // Round lat/lng to 2 decimal places (~1 km) so nearby identical queries share a cache entry
  const latKey = lat != null ? lat.toFixed(2) : "";
  const lngKey = lng != null ? lng.toFixed(2) : "";
  return `${q.toLowerCase()}:${countryCode ?? ""}:${latKey}:${lngKey}:${type ?? ""}`;
}

/** In-flight request dedup: identical concurrent searches share one Promise. */
const inFlightSearches = new Map<string, Promise<any[]>>();

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
  opts: { countryCode?: string; lat?: number; lng?: number; limit?: number; featureType?: string },
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
  // "settlement" = state down to neighbourhood; used for city-only pickers
  if (opts.featureType) params.set("featuretype", opts.featureType);

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

/** Map Nominatim class/addresstype onto our PlaceType vocabulary. */
function inferNominatimType(raw: any): string {
  const at = String(raw.addresstype ?? "");
  const cls = String(raw.class ?? "");
  if (at === "country") return "country";
  if (["state", "province", "region", "county"].includes(at)) return "region";
  if (["city", "municipality"].includes(at)) return "city";
  if (["town", "village", "hamlet"].includes(at)) return "town";
  if (["suburb", "neighbourhood", "quarter", "borough"].includes(at)) return "neighborhood";
  if (["city_district", "district"].includes(at)) return "district";
  if (at === "aerodrome" || cls === "aeroway") return "airport";
  if (["tourism", "historic", "leisure", "natural"].includes(cls)) return "landmark";
  if (["amenity", "shop", "building", "office", "highway"].includes(cls)) return "place";
  if (cls === "place") return "city";
  return "place";
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
    type: inferNominatimType(raw),
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

  const typeParam = typeof req.query.type === "string" ? req.query.type : undefined;

  // Check server-side cache
  const cacheKey = makeSearchCacheKey(q, countryCode, lat, lng, typeParam);
  const cached = getSearchCached(cacheKey);
  if (cached) {
    res.json({ places: cached });
    return;
  }

  try {
    let promise = inFlightSearches.get(cacheKey);
    if (!promise) {
      promise = runUniversalSearch(q, { countryCode, lat, lng, type: typeParam })
        .finally(() => inFlightSearches.delete(cacheKey));
      inFlightSearches.set(cacheKey, promise);
    }
    const places = await promise;
    setSearchCached(cacheKey, places);
    res.json({ places });
  } catch (err) {
    logger.warn({ err, q }, "place search failed — returning empty");
    res.json({ places: [] });
  }
});

// ── Universal search: provider fan-out + merge ────────────────────────────────

const CITY_CLASS_TYPES = new Set(["city", "town", "region", "country", "district", "neighborhood"]);

/** Same real-world place? Normalized-name equal + within ~1 km when both have coords. */
function samePlace(a: any, b: any): boolean {
  if (normalizeLocationName(a.name) !== normalizeLocationName(b.name)) return false;
  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    return Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lng - b.lng) < 0.01;
  }
  return true;
}

/**
 * Fan out to Nominatim (cities/regions/addresses) and Foursquare
 * (venues/hotels/landmarks) in parallel, then merge. Either provider failing
 * degrades gracefully to the other's results.
 */
async function runUniversalSearch(
  q: string,
  opts: { countryCode?: string; lat?: number; lng?: number; type?: string },
): Promise<any[]> {
  const cityOnly = opts.type === "city";
  const wantVenues = !cityOnly && !CITY_CLASS_TYPES.has(opts.type ?? "");

  const [nom, fsq] = await Promise.allSettled([
    searchNominatim(q, {
      countryCode: opts.countryCode,
      lat: opts.lat,
      lng: opts.lng,
      featureType: cityOnly ? "settlement" : undefined,
    }),
    wantVenues
      ? searchFoursquare(q, { lat: opts.lat, lng: opts.lng, limit: 5 })
      : Promise.resolve([] as any[]),
  ]);

  if (nom.status === "rejected") logger.warn({ err: nom.reason, q }, "nominatim search failed");
  const nomPlaces =
    nom.status === "fulfilled" && Array.isArray(nom.value) ? nom.value.map(normalizeNominatim) : [];
  const fsqPlaces = fsq.status === "fulfilled" ? fsq.value : [];

  // Cities/admin areas first, venues appended, duplicates collapsed.
  const merged: any[] = [...nomPlaces];
  for (const venue of fsqPlaces) {
    if (!merged.some((p) => samePlace(p, venue))) merged.push(venue);
  }

  const filtered = cityOnly
    ? merged.filter((p) => ["city", "town", "district", "neighborhood", "region"].includes(p.type))
    : merged;

  // Exact-name city/town hits outrank broader admin areas ("Cebu City" the
  // city above "Cebu" the province when the user typed "cebu").
  const qNorm = normalizeLocationName(q);
  const exactness = (p: any) =>
    (["city", "town"].includes(p.type) && normalizeLocationName(p.name) === qNorm) ? 0 : 1;
  const ranked = filtered
    .map((p, i) => ({ p, i }))
    .sort((a, b) => exactness(a.p) - exactness(b.p) || a.i - b.i)
    .map(({ p }) => p);

  return ranked.slice(0, 12);
}

// ── GET /api/places/live-status ───────────────────────────────────────────────
//
// Live open-now lookup for Explore / place detail surfaces. Reuses the same
// Foursquare-backed getLiveVenueStatus (10-minute cache, strict timeout) that
// powers Compass chat cards, and returns the identical confidence-labeled
// liveStatus shape:
//
//   { liveStatus: { available: true,  openNow, source, checkedAt, confidence } }
//   { liveStatus: { available: false, openNow: null, dataNote, confidence } }
//
// Honest degradation: when the live source can't verify (no key, outage,
// timeout, venue not found), available=false with an explicit dataNote —
// a status is NEVER invented. openNow may also be null when the source
// responded but had no hours data.
router.get("/places/live-status", async (req, res) => {
  const name = String(req.query.name ?? "").trim();
  if (!name || name.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "name is required (max 200 chars)" });
    return;
  }
  const cityRaw = typeof req.query.city === "string" ? req.query.city.trim() : "";
  const city = cityRaw && cityRaw.length <= 200 ? cityRaw : null;

  const live = await getLiveVenueStatus(name, city);
  const liveStatus = live
    ? {
        available:  true as const,
        openNow:    live.openNow,
        source:     live.source,
        checkedAt:  live.checkedAt,
        confidence: makeConfidence("verified_live"),
      }
    : {
        available:  false as const,
        openNow:    null,
        dataNote:   CANT_VERIFY_NOTE,
        confidence: makeConfidence("historical", CANT_VERIFY_NOTE),
      };
  res.json({ liveStatus });
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

  // Remove existing entry for this place_id, then insert fresh (keeps it sorted)
  const { error: delError } = await db
    .from("user_recent_places")
    .delete()
    .eq("user_id", user.id)
    .eq("place_snapshot->>id", place.id as string);
  if (delError) {
    logger.warn({ err: delError }, "failed to save recent place (delete)");
    sendError(res, "db_error", "Failed to save recent place");
    return;
  }

  const { error: insError } = await db.from("user_recent_places").insert({
    user_id: user.id,
    place_snapshot: place,
    used_for: usedFor ?? null,
    used_at: new Date().toISOString(),
  });
  if (insError) {
    logger.warn({ err: insError }, "failed to save recent place (insert)");
    sendError(res, "db_error", "Failed to save recent place");
    return;
  }

  // Trim to 10 (non-fatal — the insert already succeeded)
  const { data: all, error: listError } = await db
    .from("user_recent_places")
    .select("id")
    .eq("user_id", user.id)
    .order("used_at", { ascending: false });
  if (listError) {
    logger.warn({ err: listError }, "recent-places trim list failed (non-fatal)");
  } else if (all && all.length > 10) {
    const toDelete = (all as { id: string }[]).slice(10).map((r) => r.id);
    const { error: trimError } = await db.from("user_recent_places").delete().in("id", toDelete);
    if (trimError) logger.warn({ err: trimError }, "recent-places trim delete failed (non-fatal)");
  }

  // Phase 14 — a repeat visit to a recommended place is a "returned" outcome
  // when the place was previously recommended; linkOutcomeSignal no-ops otherwise.
  void linkOutcomeSignal(db, user.id, String(place.id), "returned", "route:recent_place");

  res.json({ ok: true });
});

// ── POST /api/places/:id/image-report ─────────────────────────────────────────
//
// Accepts a user report that an image does not match a place.
// Requires authentication. Writes a pending row to place_image_reports.
// Returns { ok: true } without leaking internal review state.
//
router.post("/places/:id/image-report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const placeId = req.params.id;
  if (!placeId || placeId.length > 500) {
    sendError(res, "invalid_payload", "Invalid place id");
    return;
  }

  const { imageUrl, reason } = (req.body ?? {}) as {
    imageUrl?: unknown;
    reason?: unknown;
  };

  if (typeof imageUrl !== "string" || !imageUrl.trim() || imageUrl.length > 2000) {
    sendError(res, "invalid_payload", "imageUrl is required (max 2000 chars)");
    return;
  }

  const VALID_REASONS = new Set(["wrong_place"]);
  if (typeof reason !== "string" || !VALID_REASONS.has(reason)) {
    sendError(res, "invalid_payload", "reason must be 'wrong_place'");
    return;
  }

  const db = getServiceClient();
  if (!db) {
    sendError(res, "server_not_configured");
    return;
  }

  const { error } = await db.from("place_image_reports").insert({
    place_id: placeId,
    image_url: imageUrl.trim(),
    reported_by: user.id,
    report_reason: reason,
    status: "pending",
  });

  if (error) {
    logger.warn({ err: error, placeId }, "failed to insert place_image_report");
    sendError(res, "db_error", "Failed to submit report");
    return;
  }

  res.json({ ok: true });
});

export default router;
