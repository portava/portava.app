/**
 * /api/places — place search, reverse geocode, and recent places.
 *
 * GET  /api/places/search?q=&type=&countryCode=&lat=&lng=
 * GET  /api/places/nearby-venue?lat=&lng=&name=  (auth required)
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

  const countryCode = typeof req.query.countryCode === "string" ? req.query.countryCode : undefined;
  const latStr = typeof req.query.lat === "string" ? req.query.lat : undefined;
  const lngStr = typeof req.query.lng === "string" ? req.query.lng : undefined;
  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));

  const cKey = fsqPhotoCacheKey(name, lat, lng);

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
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}:${nameHint.toLowerCase()}`;
  const cached = nearbyVenueCache.get(cacheKey);
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
    const places = (data ?? []).map((row: any) => row.place_snapshot);
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

// ── GET /api/places/google-autocomplete ───────────────────────────────────────
//
// Server-side proxy for the Google Places Autocomplete API. Keeping the call
// server-side avoids CORS restrictions on web and keeps GOOGLE_MAPS_API_KEY
// out of the client bundle.
//
// Returns up to 5 normalized Place-shaped objects (no lat/lng — those come
// from /places/google-details on selection) plus `powered_by: "google"` for
// attribution.
//
// Degrades gracefully: returns { places: [], powered_by: "google" } when the
// key is unconfigured or Google returns a non-OK status.

function inferGoogleType(types: string[]): string {
  if (types.includes("country")) return "country";
  if (types.includes("administrative_area_level_1")) return "region";
  if (types.includes("locality") || types.includes("administrative_area_level_2")) return "city";
  if (types.includes("sublocality") || types.includes("neighborhood")) return "neighborhood";
  if (types.includes("airport")) return "airport";
  return "place";
}

router.get("/places/google-autocomplete", async (req, res) => {
  const input = String(req.query.input ?? "").trim();
  if (!input || input.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "input is required (max 200 chars)" });
    return;
  }

  const key = process.env.FOURSQUARE_API_KEY;

  const existingFlight = fsqPhotoInFlight.get(cKey);
  if (!key) {
    res.json({ places: [], powered_by: "google" });
    return;
  }

  const type = typeof req.query.type === "string" ? req.query.type : "all";
  const countryCode = typeof req.query.countryCode === "string" ? req.query.countryCode : undefined;

  try {
    const params = new URLSearchParams({
      limit: "1",
      ll: `${lat},${lng}`,
      fields: "fsq_place_id,name,tel,website,hours",
    });
    if (type === "city") params.set("types", "(cities)");
    if (countryCode) params.set("components", `country:${countryCode}`);

    const gRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.photos",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!gRes.ok) throw new Error(`Google Place Details HTTP ${gRes.status}`);
    const body: any = await fsqRes.json();

    if (body.status !== "OK" && body.status !== "ZERO_RESULTS") {
      logger.warn({ status: body.status as string, input }, "Google Places Autocomplete non-OK");
      res.json({ places: [], powered_by: "google" });
      return;
    }

    const predictions: any[] = body.predictions ?? [];
    const places = (data ?? []).map((row: any) => row.place_snapshot);

    res.json({ places, powered_by: "google" });
  } catch (err) {
    logger.warn({ err, input }, "Google Places Autocomplete failed — returning empty");
    res.json({ places: [], powered_by: "google" });
  }
});

// ── GET /api/places/google-details ────────────────────────────────────────────
//
// Returns geometry (lat/lng) and formatted_address for a Google place_id.
// Called after the user selects a Google autocomplete result to enrich the
// Place with coordinates before canonical resolution.

router.get("/places/google-details", async (req, res) => {
  const placeId = req.params.id;
  if (!placeId || placeId.length > 500) {
    res.status(400).json({ error: "invalid_payload", message: "place_id is required (max 500 chars)" });
    return;
  }

  const key = process.env.FOURSQUARE_API_KEY;

  const existingFlight = fsqPhotoInFlight.get(cKey);
  if (!key) {
    res.json({ details: null });
    return;
  }

  try {
    const params = new URLSearchParams({
      limit: "1",
      ll: `${lat},${lng}`,
      fields: "fsq_place_id,name,tel,website,hours",
    });
    const gRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.photos",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!gRes.ok) throw new Error(`Google Place Details HTTP ${gRes.status}`);
    const body: any = await fsqRes.json();

    if (body.status !== "OK" || !body.result?.geometry) {
      res.json({ details: null });
      return;
    }

    const { lat, lng } = body.result.geometry.location as { lat: number; lng: number };
    res.json({
      details: {
        lat,
        lng,
        formattedAddress: String(body.result.formatted_address ?? ""),
      },
    });
  } catch (err) {
    logger.warn({ err, placeId }, "Google Place Details failed");
    res.json({ details: null });
  }
});

// ── GET /api/places/photo ──────────────────────────────────────────────────────
//
// Fallback-chain photo lookup for Discovery place cards (called after the
// client-side Foursquare lookup — src/services/fsqPhotoLookup.ts — comes up
// empty). Uses the SAME GOOGLE_MAPS_API_KEY already used above for
// autocomplete/details, via Places API (New) Text Search + Photo media,
// which is the only Google endpoint that returns real photo URLs.
//
// Degrades honestly: on ANY failure (missing key, SERVICE_DISABLED, no
// photos found) this returns { photoUrl: null, reason } and NEVER throws —
// the client falls through to category-appropriate artwork, never a bare
// icon with no visual treatment. `reason` surfaces machine-readable detail
// (e.g. "google_places_api_new_disabled") so we can tell exactly which
// Google Cloud API needs enabling without guessing.
const GOOGLE_PHOTO_DISABLED_LOGGED = { at: 0 };
router.get("/places/photo", async (req, res) => {
  const name = String(req.query.name ?? "").trim();
  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));

  const cKey = fsqPhotoCacheKey(name, lat, lng);

  if (!name || name.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "name is required (max 200 chars)" });
    return;
  }

  const key = process.env.FOURSQUARE_API_KEY;

  const existingFlight = fsqPhotoInFlight.get(cKey);
  if (!key) {
    res.json({ photoUrl: null, reason: "no_google_maps_key" });
    return;
  }

  try {
    const body: any = await fsqRes.json();
    if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
      body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 5000 } };
    }

    const gRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.photos",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });

    if (!gRes.ok) {
      const errBody = await gRes.json().catch(() => null) as any;
      const reason = errBody?.error?.details?.[0]?.reason as string | undefined;
      // Log once per process (not per request) to avoid log spam when the
      // API is disabled project-wide — this fires on every card otherwise.
      if (reason === "SERVICE_DISABLED" && Date.now() - GOOGLE_PHOTO_DISABLED_LOGGED.at > 10 * 60 * 1000) {
        GOOGLE_PHOTO_DISABLED_LOGGED.at = Date.now();
        logger.warn(
          { reason, activationUrl: errBody?.error?.details?.[0]?.metadata?.activationUrl },
          "Places API (New) is disabled on this Google Cloud project — enable it to get real Discovery place photos",
        );
      }
      res.json({ photoUrl: null, reason: reason ? `google_places_api_new_${reason.toLowerCase()}` : "google_places_api_new_error" });
      return;
    }

    const gBody = (await gRes.json()) as any;
    const photoName = gBody?.places?.[0]?.photos?.[0]?.name as string | undefined;
    if (!photoName) {
      res.json({ photoUrl: null, reason: "no_photo_found" });
      return;
    }

    // Photo media endpoint requires its own key param — resolve it here
    // server-side so the client never needs the key.
    const photoUrl = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${key}`;
    res.json({ photoUrl });
  } catch (err) {
    logger.warn({ err, name }, "Google Places (New) photo lookup failed");
    res.json({ photoUrl: null, reason: "request_failed" });
  }
});

// ── GET /api/places/fsq-photo ─────────────────────────────────────────────────
//
// Server-side proxy for Foursquare place-photo lookup on Discovery place cards.
// Calling Foursquare directly from the browser fails with a CORS error because
// Foursquare's API doesn't emit Access-Control-Allow-Origin headers. Routing
// the call through the api-server avoids that — server-to-server fetches are
// not subject to CORS.
//
// Uses FOURSQUARE_API_KEY (server-side env var; never sent to the client).
//
// Honest degradation: every failure path returns { photoUrl: null, reason }
// and NEVER throws — the caller falls through to category-appropriate artwork.
//
// ATTRIBUTION: callers that render the returned photoUrl must display
// "Powered by Foursquare" (FSQ API license requirement).
const FSQ_PHOTO_SEARCH = "https://places-api.foursquare.com/places/search";
const FSQ_PHOTO_API_VERSION = "2025-06-17";
let fsqPhotoAuthLogged = false;

const FSQ_PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 h

let FSQ_PHOTO_CACHE_MAX = 5_000;
  const name = String(req.query.name ?? "").trim();
  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));

  const cKey = fsqPhotoCacheKey(name, lat, lng);

  if (!name || name.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "name is required (max 200 chars)" });
    return;
  }

  const key = process.env.FOURSQUARE_API_KEY;

  const existingFlight = fsqPhotoInFlight.get(cKey);
  if (!key) {
    res.json({ details: null });
    return;
  }

  try {
    const params = new URLSearchParams({
      limit: "1",
      ll: `${lat},${lng}`,
      fields: "fsq_place_id,name,tel,website,hours",
    });
    if (nameHint) params.set("query", nameHint);

    const fsqRes = await fetch(`https://places-api.foursquare.com/places/search?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "X-Places-Api-Version": "2025-06-17" },
      signal: AbortSignal.timeout(3_000),
    });

    if (!fsqRes.ok) {
      logger.warn({ status: fsqRes.status, lat, lng }, "nearby-venue FSQ lookup failed");
      nearbyVenueCache.set(cacheKey, { venue: null, cachedAt: nowMs });
      res.json({ venue: null });
      return;
    }

    const body: any = await fsqRes.json();
    if (typeof p?.prefix !== "string" || typeof p?.suffix !== "string") {
      res.json({ photoUrl: null, reason: "no_photo_found" });
      return;
    }

    res.json({ photoUrl: `${p.prefix}original${p.suffix}` });
  } catch (err) {
    logger.warn({ err, name }, "Foursquare photo proxy lookup failed");
    res.json({ photoUrl: null, reason: "request_failed" });
  }
});

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

// ── GET /api/places/nearby-venue ─────────────────────────────────────────────
//
// Returns contact info (phone, website, opening hours) for the venue nearest
// the given coordinates, resolved via Foursquare Places API.
//
// Query params:
//   lat    — required, numeric latitude  (-90..90)
//   lng    — required, numeric longitude (-180..180)
//   name   — optional venue name hint; used as search query when provided
//
// Response:
//   { venue: { name, phone, website, openingHours } | null }
//
// Graceful degradation: null on any error (no key, timeout, not found).
// Auth required — prevents unauthenticated scraping of FSQ quota.
// In-memory cache: 30-minute TTL per coordinate bucket (~110 m resolution).

const NEARBY_VENUE_CACHE_TTL_MS = 30 * 60 * 1_000;
const nearbyVenueCache = new Map<string, { venue: NearbyVenueInfo | null; cachedAt: number }>();

interface NearbyVenueInfo {
  name: string;
  phone: string | null;
  website: string | null;
  openingHours: Array<{ dayOfWeek: number; open: string; close: string }> | null;
}

/** Convert FSQ "HHMM" to "HH:MM". */
function fmtFsqTime(t: string): string {
  return `${t.slice(0, 2)}:${t.slice(2)}`;
}

/**
 * Convert FSQ hours.regular (day 1=Mon…7=Sun) to NormalizedOpeningHours
 * (dayOfWeek 0=Sun…6=Sat, JS Date convention).
 */
function normalizeFsqHours(
  regular: Array<{ day: number; open: string; close: string }> | undefined,
): NearbyVenueInfo["openingHours"] {
  if (!Array.isArray(regular) || regular.length === 0) return null;
  return regular
    .filter((h) => h.day >= 1 && h.day <= 7 && h.open && h.close)
    .map((h) => ({
      dayOfWeek: h.day % 7, // 1→1 Mon, …, 6→6 Sat, 7→0 Sun
      open:  fmtFsqTime(String(h.open)),
      close: fmtFsqTime(String(h.close)),
    }));
}

router.get("/places/nearby-venue", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));

  const cKey = fsqPhotoCacheKey(name, lat, lng);

  if (isNaN(lat) || lat < -90 || lat > 90) {
    res.status(400).json({ error: "invalid_payload", message: "Valid lat is required" });
    return;
  }
  if (isNaN(lng) || lng < -180 || lng > 180) {
    res.status(400).json({ error: "invalid_payload", message: "Valid lng is required" });
    return;
  }

  const nameHint = typeof req.query.name === "string" ? req.query.name.trim().slice(0, 200) : "";

  // Cache key: coordinate bucket (~110 m) + name hint
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}:${nameHint.toLowerCase()}`;
  const nowMs = Date.now();
  const cached = nearbyVenueCache.get(cacheKey);
  if (cached && nowMs - cached.cachedAt < NEARBY_VENUE_CACHE_TTL_MS) {
    res.json({ venue: cached.venue });
    return;
  }

  const apiKey = process.env.FOURSQUARE_API_KEY;
  if (!apiKey) {
    res.json({ venue: null });
    return;
  }

  try {
    const params = new URLSearchParams({
      limit: "1",
      ll: `${lat},${lng}`,
      fields: "fsq_place_id,name,tel,website,hours",
    });
    if (nameHint) params.set("query", nameHint);

    const fsqRes = await fetch(`https://places-api.foursquare.com/places/search?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "X-Places-Api-Version": "2025-06-17" },
      signal: AbortSignal.timeout(3_000),
    });

    if (!fsqRes.ok) {
      logger.warn({ status: fsqRes.status, lat, lng }, "nearby-venue FSQ lookup failed");
      nearbyVenueCache.set(cacheKey, { venue: null, cachedAt: nowMs });
      res.json({ venue: null });
      return;
    }

    const body: any = await fsqRes.json();
    const r = Array.isArray(body?.results) ? body.results[0] : null;

    if (!r?.fsq_place_id) {
      nearbyVenueCache.set(cacheKey, { venue: null, cachedAt: nowMs });
      res.json({ venue: null });
      return;
    }

    const venue: NearbyVenueInfo = {
      name:    String(r.name ?? ""),
      phone:   typeof r.tel === "string" && r.tel ? r.tel : null,
      website: typeof r.website === "string" && r.website ? r.website : null,
      openingHours: normalizeFsqHours(r.hours?.regular),
    };

    nearbyVenueCache.set(cacheKey, { venue, cachedAt: nowMs });
    res.json({ venue });
  } catch (err) {
    logger.warn({ err, lat, lng }, "nearby-venue lookup error");
    nearbyVenueCache.set(cacheKey, { venue: null, cachedAt: nowMs });
    res.json({ venue: null });
  }
});

// ── GET /api/places/reverse ───────────────────────────────────────────────────
router.get("/places/reverse", async (req, res) => {
  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));

  const cKey = fsqPhotoCacheKey(name, lat, lng);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "invalid_payload", message: "Valid lat and lng are required" });
    return;
  }

  try {
    const result = await reverseGeocode(lat, lng);

  const lookup = (async (): Promise<FsqPhotoLookupResult> => {
    try {
      const params = new URLSearchParams({
        query:  name,
        limit:  "1",
        fields: "photos",
      });
      if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
        params.set("ll", `${lat},${lng}`);
      }

      const fsqRes = await fetch(`${FSQ_PHOTO_SEARCH}?${params}`, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "X-Places-Api-Version": FSQ_PHOTO_API_VERSION,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (fsqRes.status === 401 || fsqRes.status === 403) {
        if (!fsqPhotoAuthLogged) {
          fsqPhotoAuthLogged = true;
          logger.warn(
            { status: fsqRes.status },
            "Foursquare photo proxy auth failure — check FOURSQUARE_API_KEY",
          );
        }
        return { photoUrl: null, reason: "foursquare_auth_error", cacheable: false };
      }

      if (!fsqRes.ok) {
        return { photoUrl: null, reason: `foursquare_http_${fsqRes.status}`, cacheable: false };
      }

      const body = (await fsqRes.json()) as {
        results?: Array<{ photos?: Array<{ prefix?: string; suffix?: string }> }>;
      };
      const photos = body?.results?.[0]?.photos ?? [];
      if (!photos.length) {
        // FSQ has no photo record for this place — cache (24 h) so subsequent
        // requests for the same OSM place are served without hitting FSQ.
        return { photoUrl: null, reason: "no_photo_found", cacheable: true };
      }

      const p = photos[0];
      if (typeof p?.prefix !== "string" || typeof p?.suffix !== "string") {
        // Malformed photo entry — treat same as "no photo" and cache.
        return { photoUrl: null, reason: "no_photo_found", cacheable: true };
      }

      const photoUrl = `${p.prefix}original${p.suffix}`;

      // Foursquare's search index can return a photo reference whose CDN file
      // has since been removed (404) — the client has no way to detect this
      // itself and was rendering a permanent broken-image fallback for these.
      // A quick HEAD check keeps the client contract honest: a returned
      // photoUrl is guaranteed loadable, or the caller gets no_photo_found and
      // falls through to category artwork exactly like the "no photo" case.
      // Dead CDN links are NOT cached (transient CDN issue — might recover).
      try {
        const headRes = await fetch(photoUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(2500),
        });
        if (!headRes.ok) {
          return { photoUrl: null, reason: "dead_photo_link", cacheable: false };
        }
      } catch {
        // Liveness check itself failed (network blip, HEAD unsupported) — serve
        // the URL so the client can attempt to load it, but do NOT cache: the
        // URL is unverified and may be dead, so the next request must retry
        // rather than being stranded on a broken URL for 24 h.
        return { photoUrl, reason: undefined, cacheable: false };
      }

      // Positive result — verified loadable photo URL, cache for 24 h.
      return { photoUrl, cacheable: true };
    } catch (err) {
      logger.warn({ err, name }, "Foursquare photo proxy lookup failed");
      return { photoUrl: null, reason: "request_failed", cacheable: false };
    } finally {
      fsqPhotoInFlight.delete(cKey);
    }
  })();
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
  if (!db) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const { data, error } = await db
    .from("media_dedup_groups")
    .select("id, representative_media_id, member_count, sample_media_ids, bucket_key, updated_at")
    .eq("canonical_place_id", placeId)
    .order("member_count", { ascending: false })
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
    sendError(res, "db_error", "Failed to save recent place", { exposeDetail: true });
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
    sendError(res, "db_error", "Failed to save recent place", { exposeDetail: true });
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

  // Verify the place exists before inserting the report.
  // place_id is TEXT matching discovery_places.id (OSM/text keys like "db/<uuid>"),
  // NOT a UUID foreign key to the `places` table — see migration comment.
  const { data: placeExists } = await db
    .from("discovery_places")
    .select("id")
    .eq("id", placeId)
    .maybeSingle();
  if (!placeExists) {
    res.status(404).json({ error: "not_found", message: "Place not found" });
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
    sendError(res, "db_error", "Failed to submit report", { exposeDetail: true });
    return;
  }

  res.json({ ok: true });
});

// ── GET /api/places/:id/dedup-groups ──────────────────────────────────────────
//
// Internal endpoint used by the living destination page API (and future feed
// services) to surface the top near-duplicate media clusters for a place.
//
// Returns the top 10 dedup groups by member_count, with up to 3 sample media
// ids per group for the collapsed-view chip.
//
// Requires authentication. Does NOT leak private post data — only media ids
// and member counts are returned.
//
router.get("/places/:id/dedup-groups", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const placeId = req.params.id;
  if (!placeId || placeId.length > 500) {
    sendError(res, "invalid_payload", "Invalid place id");
    return;
  }

  const db = getServiceClient();
  if (!db) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const { data, error } = await db
    .from("media_dedup_groups")
    .select("id, representative_media_id, member_count, sample_media_ids, bucket_key, updated_at")
    .eq("canonical_place_id", placeId)
    .order("member_count", { ascending: false })
    .limit(10);

  if (error) {
    logger.warn({ err: error, placeId }, "failed to fetch media_dedup_groups");
    sendError(res, "db_error", "Failed to fetch dedup groups", { exposeDetail: true });
    return;
  }

  res.json({ groups: data ?? [] });
});

export default router;

interface FsqPhotoCacheEntry {
  photoUrl: string | null;
  ts: number;
}

  const cachedEntry = getFsqPhotoCached(cKey);

const fsqPhotoCache = new Map<string, FsqPhotoCacheEntry>();

/** Normalise a place name + coords into a stable cache key (mirrors client). */
function fsqPhotoCacheKey(
  name: string,
  lat: number | null,
  lng: number | null,
): string {
  const n = name.toLowerCase().trim().replace(/\s+/g, " ");
  return `${n}|${lat != null ? lat.toFixed(3) : "_"}|${lng != null ? lng.toFixed(3) : "_"}`;
}

interface FsqPhotoLookupResult {
  photoUrl: string | null;
  reason?: string;
  /** When true the result should be stored in the server-side cache. */
  cacheable: boolean;
}

const fsqPhotoInFlight = new Map<string, Promise<FsqPhotoLookupResult>>();

function getFsqPhotoCached(key: string): FsqPhotoCacheEntry | undefined {
  const entry = fsqPhotoCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > FSQ_PHOTO_CACHE_TTL_MS) {
    fsqPhotoCache.delete(key);
    return undefined;
  }
  return entry;
}

/**
 * Write an entry to the FSQ photo cache with active eviction:
 *   1. Sweep all expired entries on every write (prevent silent TTL pile-up).
 *   2. If capacity is still at or above the limit after the sweep, evict the
 *      oldest entries (Map insertion order) until there is room for the new one.
 *
 * Deleting the existing entry for `key` before re-inserting refreshes its
 * position in insertion order so it won't be evicted by subsequent writers.
 */
function writeFsqPhotoCached(key: string, entry: FsqPhotoCacheEntry): void {
  // Remove any existing entry for this key so the re-insert lands at the end.
  fsqPhotoCache.delete(key);

  // Sweep expired entries.
  const now = Date.now();
  for (const [k, v] of fsqPhotoCache) {
    if (now - v.ts > FSQ_PHOTO_CACHE_TTL_MS) fsqPhotoCache.delete(k);
  }

  // Evict oldest entries until there is room for the new one.
  while (fsqPhotoCache.size >= FSQ_PHOTO_CACHE_MAX) {
    const oldest = fsqPhotoCache.keys().next().value;
    if (oldest !== undefined) fsqPhotoCache.delete(oldest);
    else break;
  }

  fsqPhotoCache.set(key, entry);
}

/**
 * Override the FSQ photo cache capacity for tests.
 * Clears the cache so tests start from a clean state.
 * Must be restored after the test (pass Infinity to reset to default).
 */
export function _setFsqPhotoCacheMaxForTest(n: number): void {
  FSQ_PHOTO_CACHE_MAX = n === Infinity ? 5_000 : n;
  fsqPhotoCache.clear();
}
