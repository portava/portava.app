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
import { classifyApiKey, apiKeyFailureReason, apiKeyFailureMessage } from "../lib/apiKeyState";
import { newApiErrorReason } from "../lib/googlePlacesReason";
import {
  normalisePlaceKey,
  readStoredPlacePhoto,
  writeStoredPlacePhoto,
  mintPhotoUrl,
} from "../lib/discoveryPlacePhotoStore.js";
import { namespaceGooglePlaceId, denamespaceGooglePlaceId } from "../lib/googlePlaceId";

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

// ── GET /api/places/google-autocomplete ───────────────────────────────────────
//
// Server-side proxy for Google Places Autocomplete, on **Places API (New)**
// (`places.googleapis.com/v1/places:autocomplete`). Keeping the call
// server-side avoids CORS restrictions on web and keeps GOOGLE_MAPS_API_KEY
// out of the client bundle.
//
// MIGRATED 2026-08-15 from the legacy `maps.googleapis.com` Places API, which
// was returning empty for every input on this project while the same key
// succeeded against Places API (New). Two reasons, in order:
//
//   1. Places API (New) is ALREADY ENABLED and demonstrably working with this
//      key, so the migration depends on nothing from the project owner.
//   2. The legacy Places API is being deprecated by Google, so enabling it
//      would buy a fix that has to be redone.
//
// NOT YET CONFIRMED AS THE REMEDY. The legacy failure's exact cause is still
// unknown — the observability fix that would reveal it has not reached
// production. If the underlying fault is key- or referer-scoped rather than
// API-enablement, it applies to this surface too and this migration will not
// fix it. See docs/places/google-legacy-places-api-returns-nothing.md.
//
// The key travels in the X-Goog-Api-Key HEADER, not the query string.
//
// Returns up to 5 normalized Place-shaped objects (no lat/lng — those come
// from /places/google-details on selection) plus `powered_by: "google"` for
// attribution.
//
// ID CONTRACT: this route OWNS the `google-` namespacing of `Place.id`, via
// lib/googlePlaceId.ts. /places/google-details accepts exactly what this emits.
// The round trip is pinned by test — see googlePlaceIdRoundTrip in
// src/test/googlePlacesNewApi.test.ts.
//
// Degrades gracefully AND AUDIBLY: returns { places: [], powered_by: "google" }
// on every failure, plus a machine-readable `reason` saying which failure it
// was. The reason field is additive — callers that only read `places` are
// unaffected.
//
// It did not always. Until 2026-08-15 all four failure conditions — missing
// key, non-OK HTTP, non-OK status body, and a genuine no-match — returned the
// SAME bare empty list, so "there is no such city" and "the API is switched
// off" were indistinguishable. Destination search returned empty for
// Barcelona, Madrid and New York with a demonstrably working key and nothing
// surfaced it. See docs/places/google-legacy-places-api-returns-nothing.md.
//
// `reason` is absent when `places` is non-empty, and absent on a genuine
// ZERO_RESULTS: an empty answer that Google actually gave is not a fault, and
// reporting it as one would be the same defect wearing the opposite sign.

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

  // Same empty-vs-absent distinction as the photo route (#64): an
  // empty-but-present secret is the case that looks configured and is not.
  const rawKey = process.env.GOOGLE_MAPS_API_KEY;
  const keyState = classifyApiKey(rawKey);
  if (keyState !== "present") {
    if (Date.now() - GOOGLE_AUTOCOMPLETE_KEY_LOGGED.at > 10 * 60 * 1000) {
      GOOGLE_AUTOCOMPLETE_KEY_LOGGED.at = Date.now();
      logger.warn(
        { envVar: "GOOGLE_MAPS_API_KEY", keyState },
        apiKeyFailureMessage(keyState, "GOOGLE_MAPS_API_KEY"),
      );
    }
    res.json({
      places: [],
      powered_by: "google",
      reason: apiKeyFailureReason(keyState, "google"),
    });
    return;
  }
  const key = rawKey as string;

  const type = typeof req.query.type === "string" ? req.query.type : "all";
  const countryCode = typeof req.query.countryCode === "string" ? req.query.countryCode : undefined;

  try {
    // Places API (New). The key travels in the X-Goog-Api-Key HEADER, not the
    // query string — the same shape already proven authorized for this key by
    // /places/photo, and it keeps the secret out of any URL that might be
    // logged by an intermediary.
    const body: Record<string, unknown> = { input, languageCode: "en" };
    // Legacy `types=(cities)` — the New API accepts the same type collection.
    if (type === "city") body.includedPrimaryTypes = ["(cities)"];
    // Legacy `components=country:XX` → CLDR region codes.
    if (countryCode) body.includedRegionCodes = [countryCode.toLowerCase()];

    const gRes = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });

    if (!gRes.ok) {
      const errBody = await gRes.json().catch(() => null);
      const reason = newApiErrorReason(errBody, gRes.status);
      if (Date.now() - GOOGLE_AUTOCOMPLETE_ERROR_LOGGED.at > 10 * 60 * 1000) {
        GOOGLE_AUTOCOMPLETE_ERROR_LOGGED.at = Date.now();
        logger.warn(
          {
            httpStatus: gRes.status,
            reason,
            // Google puts the actionable sentence here, including which API to
            // enable and where.
            message: (errBody as any)?.error?.message as string | undefined,
            activationUrl: (errBody as any)?.error?.details?.find(
              (d: any) => typeof d?.metadata?.activationUrl === "string",
            )?.metadata?.activationUrl as string | undefined,
          },
          "Google Places (New) Autocomplete failed",
        );
      }
      res.json({ places: [], powered_by: "google", reason });
      return;
    }

    const gBody = (await gRes.json()) as any;
    const suggestions: any[] = gBody?.suggestions ?? [];

    // An empty suggestion list is the New API's ZERO_RESULTS: Google answered,
    // and the answer is "nothing matches". That is NOT a fault and carries no
    // reason — see googlePlacesReason.ts.
    const places = suggestions
      .map((sg: any) => sg?.placePrediction)
      .filter((pred: any) => pred && typeof pred.placeId === "string")
      .slice(0, 5)
      .map((pred: any) => {
        const description: string = pred.text?.text ?? "";
        const mainText: string = pred.structuredFormat?.mainText?.text ?? description;
        const types: string[] = pred.types ?? [];
        return {
          id: namespaceGooglePlaceId(pred.placeId as string),
          type: inferGoogleType(types),
          name: mainText,
          displayName: String(description || mainText),
          country: null,
          countryCode: null,
          region: null,
          city: null,
          district: null,
          lat: null,
          lng: null,
          timezone: null,
          source: "google" as const,
          formattedAddress: String(description || mainText),
        };
      });

    res.json({ places, powered_by: "google" });
  } catch (err) {
    logger.warn({ err, input }, "Google Places (New) Autocomplete failed — returning empty");
    res.json({ places: [], powered_by: "google", reason: "request_failed" });
  }
});

// ── GET /api/places/google-details ────────────────────────────────────────────
//
// Returns geometry (lat/lng) and formattedAddress for a Google place_id.
// Called after the user selects a Google autocomplete result to enrich the
// Place with coordinates before canonical resolution.
//
// MIGRATED 2026-08-15 to Places API (New), alongside the autocomplete route
// above and for the same reasons.
//
// WHY `GET /v1/places/{id}` AND NOT `places:searchText`. This route is handed
// an EXACT place id by the autocomplete route. `searchText` resolves free text
// and can legitimately return a different place, so using it here would let a
// user's chosen destination silently become a nearby one — a wrong answer that
// looks entirely normal. Place Details is the correct mapping for a lookup by
// id; searchText is the correct mapping for the photo route, which genuinely
// starts from a name.

router.get("/places/google-details", async (req, res) => {
  // Accept the id in the form /places/google-autocomplete EMITS
  // (`google-<id>`) as well as the bare form the current client sends after
  // stripping the prefix itself. One definition, in lib/googlePlaceId.ts —
  // never a second hardcoded "google-" at a call site, which is precisely how
  // the two halves of this flow drifted apart for three weeks.
  const placeId = denamespaceGooglePlaceId(String(req.query.place_id ?? "").trim());
  if (!placeId || placeId.length > 500) {
    res.status(400).json({ error: "invalid_payload", message: "place_id is required (max 500 chars)" });
    return;
  }

  const rawKey = process.env.GOOGLE_MAPS_API_KEY;
  const keyState = classifyApiKey(rawKey);
  if (keyState !== "present") {
    if (Date.now() - GOOGLE_DETAILS_KEY_LOGGED.at > 10 * 60 * 1000) {
      GOOGLE_DETAILS_KEY_LOGGED.at = Date.now();
      logger.warn(
        { envVar: "GOOGLE_MAPS_API_KEY", keyState },
        apiKeyFailureMessage(keyState, "GOOGLE_MAPS_API_KEY"),
      );
    }
    res.json({ details: null, reason: apiKeyFailureReason(keyState, "google") });
    return;
  }
  const key = rawKey as string;

  try {
    // Places API (New) Place Details is a GET on the place resource, NOT
    // places:searchText. searchText resolves a free-text QUERY; we already have
    // an exact place id from autocomplete, and round-tripping it through a text
    // search would be able to return a DIFFERENT place. The field mask is
    // mandatory here — omitting it is an error, not a default.
    const gRes = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "location,formattedAddress,displayName,addressComponents",
        },
        signal: AbortSignal.timeout(4000),
      },
    );

    if (!gRes.ok) {
      const errBody = await gRes.json().catch(() => null);
      const reason = newApiErrorReason(errBody, gRes.status);
      if (Date.now() - GOOGLE_DETAILS_ERROR_LOGGED.at > 10 * 60 * 1000) {
        GOOGLE_DETAILS_ERROR_LOGGED.at = Date.now();
        logger.warn(
          {
            httpStatus: gRes.status,
            reason,
            message: (errBody as any)?.error?.message as string | undefined,
            placeId,
          },
          "Google Places (New) Place Details failed",
        );
      }
      res.json({ details: null, reason });
      return;
    }

    const body = (await gRes.json()) as any;
    const loc = body?.location as { latitude?: number; longitude?: number } | undefined;

    if (typeof loc?.latitude !== "number" || typeof loc?.longitude !== "number") {
      // Google answered and the place genuinely carries no usable location.
      // Distinct from a refusal, and reported as such.
      res.json({ details: null, reason: "no_geometry" });
      return;
    }

    res.json({
      details: {
        lat: loc.latitude,
        lng: loc.longitude,
        formattedAddress: String(body.formattedAddress ?? ""),
      },
    });
  } catch (err) {
    logger.warn({ err, placeId }, "Google Places (New) Place Details failed");
    res.json({ details: null, reason: "request_failed" });
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
const GOOGLE_AUTOCOMPLETE_KEY_LOGGED = { at: 0 };
const GOOGLE_AUTOCOMPLETE_ERROR_LOGGED = { at: 0 };
const GOOGLE_DETAILS_ERROR_LOGGED = { at: 0 };
const GOOGLE_DETAILS_KEY_LOGGED = { at: 0 };
const GOOGLE_KEY_STATE_LOGGED = { at: 0 };
const FSQ_KEY_STATE_LOGGED = { at: 0 };
router.get("/places/photo", async (req, res) => {
  const name = String(req.query.name ?? "").trim();
  const lat = req.query.lat != null ? Number(req.query.lat) : null;
  const lng = req.query.lng != null ? Number(req.query.lng) : null;
  const placeKey = normalisePlaceKey(req.query.placeKey as string | undefined);

  if (!name || name.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "name is required (max 200 chars)" });
    return;
  }

  // STORED PHOTO FIRST — deliberately ahead of the key check.
  //
  // A photo we already resolved is a fact about the place, not a fact about our
  // current credentials. Serving it before the key check means a rotated or
  // missing Google key stops NEW resolutions without blanking every card that
  // was already resolved.
  const stored = placeKey ? await readStoredPlacePhoto(placeKey) : null;
  if (stored) {
    const mintedUrl = mintPhotoUrl(stored);
    if (mintedUrl) {
      res.json({ photoUrl: mintedUrl, source: stored.source, cached: true });
      return;
    }
  }

  // NOTE ON WHICH VARIABLE THIS IS. This route reads GOOGLE_MAPS_API_KEY, and
  // that is the only name the repository uses for it — `GOOGLE_PLACES_API_KEY`
  // appears nowhere in this codebase. Populating a secret by that name has no
  // effect here, and would present as "I configured the key and nothing
  // changed". If the Places key is ever separated from the Maps key, this line
  // is the one that has to change with it.
  const rawKey = process.env.GOOGLE_MAPS_API_KEY;
  const keyState = classifyApiKey(rawKey);
  if (keyState !== "present") {
    // Absent and empty are DIFFERENT faults needing different fixes, and the
    // old `!key` check reported both as "no key". An operator who has just
    // added the secret is told the thing they know is untrue, so they doubt
    // the report rather than the value.
    if (Date.now() - GOOGLE_KEY_STATE_LOGGED.at > 10 * 60 * 1000) {
      GOOGLE_KEY_STATE_LOGGED.at = Date.now();
      logger.warn(
        { envVar: "GOOGLE_MAPS_API_KEY", keyState },
        apiKeyFailureMessage(keyState, "GOOGLE_MAPS_API_KEY"),
      );
    }
    res.json({ photoUrl: null, reason: apiKeyFailureReason(keyState, "google") });
    return;
  }
  const key = rawKey as string;

  try {
    const body: Record<string, unknown> = { textQuery: name };
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

    // Persist the REFERENCE, never this URL: it carries the API key, and a
    // stored key-bearing URL becomes a dead link the day the key rotates.
    if (placeKey) {
      void writeStoredPlacePhoto(placeKey, {
        source: "google",
        photoUrl: null,
        photoRef: photoName,
      });
    }

    res.json({ photoUrl, source: "google" });
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
// Server-side cache: positive (24 h) and negative (24 h) results are cached
// per place to prevent repeated Foursquare API calls for the same place cards.
// Dead CDN links (HEAD 404) are NOT cached — they may recover, and the next
// request must retry rather than being locked into a permanent null for 24 h.
//
// ATTRIBUTION: callers that render the returned photoUrl must display
// "Powered by Foursquare" (FSQ API license requirement).
const FSQ_PHOTO_SEARCH = "https://places-api.foursquare.com/places/search";
const FSQ_PHOTO_API_VERSION = "2025-06-17";
let fsqPhotoAuthLogged = false;
let fsqPhotoQuotaLogged = false;

const FSQ_PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 h

let FSQ_PHOTO_CACHE_MAX = 5_000;

interface FsqPhotoCacheEntry {
  photoUrl: string | null;
  reason?: string;
  ts: number;
}

interface FsqPhotoLookupResult {
  photoUrl: string | null;
  reason?: string;
  /** When true the result should be stored in the server-side cache. */
  cacheable: boolean;
}

const fsqPhotoCache = new Map<string, FsqPhotoCacheEntry>();
const fsqPhotoInFlight = new Map<string, Promise<FsqPhotoLookupResult>>();

/** Normalise a place name + coords into a stable cache key. */
function fsqPhotoCacheKey(
  name: string,
  lat: number | null,
  lng: number | null,
): string {
  const n = name.toLowerCase().trim().replace(/\s+/g, " ");
  return `${n}|${lat != null && Number.isFinite(lat) ? lat.toFixed(3) : "_"}|${lng != null && Number.isFinite(lng) ? lng.toFixed(3) : "_"}`;
}

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

router.get("/places/fsq-photo", async (req, res) => {
  const name = String(req.query.name ?? "").trim();
  const lat = req.query.lat != null ? Number(req.query.lat) : null;
  const lng = req.query.lng != null ? Number(req.query.lng) : null;
  const placeKey = normalisePlaceKey(req.query.placeKey as string | undefined);

  if (!name || name.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "name is required (max 200 chars)" });
    return;
  }

  // STORED PHOTO FIRST, and ahead of the key check for the same reason as the
  // Google route: an already-resolved photo does not depend on our credentials.
  //
  // This is where the repeated external-provider work actually disappears. This
  // route is the FIRST link in the chain, so a hit here means neither Foursquare
  // nor Google is called for this card at all — and it can legitimately return
  // a photo Google resolved earlier, because what is stored is the CANONICAL
  // resolved photo for the place rather than this provider's answer. `source`
  // travels with it so attribution stays truthful about which provider it was.
  const stored = placeKey ? await readStoredPlacePhoto(placeKey) : null;
  if (stored) {
    const mintedUrl = mintPhotoUrl(stored);
    if (mintedUrl) {
      res.json({ photoUrl: mintedUrl, source: stored.source, cached: true });
      return;
    }
  }

  // Same distinction as the Google route above, and the same reason for it: an
  // empty-but-present secret is the case that looks configured and is not.
  const rawKey = process.env.FOURSQUARE_API_KEY;
  const keyState = classifyApiKey(rawKey);
  if (keyState !== "present") {
    if (Date.now() - FSQ_KEY_STATE_LOGGED.at > 10 * 60 * 1000) {
      FSQ_KEY_STATE_LOGGED.at = Date.now();
      logger.warn(
        { envVar: "FOURSQUARE_API_KEY", keyState },
        apiKeyFailureMessage(keyState, "FOURSQUARE_API_KEY"),
      );
    }
    res.json({ photoUrl: null, reason: apiKeyFailureReason(keyState, "foursquare") });
    return;
  }
  const key = rawKey as string;

  const cKey = fsqPhotoCacheKey(name, lat, lng);

  // Serve from cache when available.
  const cachedEntry = getFsqPhotoCached(cKey);
  if (cachedEntry) {
    const { ts: _ts, ...body } = cachedEntry;
    res.json(body);
    return;
  }

  // Deduplicate concurrent requests for the same place.
  const existingFlight = fsqPhotoInFlight.get(cKey);
  if (existingFlight) {
    const result = await existingFlight;
    const { cacheable: _c, ...body } = result;
    res.json(body);
    return;
  }

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

      // 429 here is NOT ordinary rate limiting that will pass on retry: Foursquare
      // returns it for "your account has no API credits remaining", which is a
      // billing state that persists until someone tops the account up. Confirmed
      // by direct call on 2026-08-15 — every place, not merely OSM-only ones.
      // Naming it explicitly keeps a dead account from reading as a busy minute.
      //
      // NOT cacheable: caching it would pin "no photo" for 24 h per place and
      // then keep serving that answer after the credits are restored.
      if (fsqRes.status === 429) {
        if (!fsqPhotoQuotaLogged) {
          fsqPhotoQuotaLogged = true;
          logger.warn(
            { status: 429 },
            "Foursquare photo proxy: account has no API credits remaining — NO place will return a photo from Foursquare until credits are restored. Cards fall back to category artwork, which is indistinguishable from a place that has no photo.",
          );
        }
        return { photoUrl: null, reason: "foursquare_quota_exhausted", cacheable: false };
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

  fsqPhotoInFlight.set(cKey, lookup);

  const result = await lookup;

  if (result.cacheable) {
    writeFsqPhotoCached(cKey, { photoUrl: result.photoUrl, reason: result.reason, ts: Date.now() });
  }

  // PERSIST ONLY A VERIFIED PHOTO. `cacheable` is already this route's own
  // signal for "we HEAD-checked this URL and it loaded" — an unverified URL is
  // served to the client but deliberately not cached, because it may be a dead
  // CDN link. Persisting one for 30 days would strand exactly the broken image
  // the existing liveness check was added to prevent, so the same gate governs
  // both, and the durable store never gets a weaker guarantee than the L1 one.
  if (placeKey && result.cacheable && result.photoUrl) {
    void writeStoredPlacePhoto(placeKey, {
      source: "foursquare",
      photoUrl: result.photoUrl,
      photoRef: null,
    });
  }

  const { cacheable: _c, ...responseBody } = result;
  res.json(result.photoUrl ? { ...responseBody, source: "foursquare" } : responseBody);
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
