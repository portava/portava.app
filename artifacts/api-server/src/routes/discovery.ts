/**
 * GET /api/discovery
 *
 * Destination-scoped place discovery backed by Nominatim + Overpass (OSM).
 * No auth required — returns only public place data.
 *
 * Query params:
 *   destination  string  (required) city / area name e.g. "Paris"
 *   category     string  for_you | places | food | nightlife | activities |
 *                        events | beaches | transport   (default: for_you)
 *   radiusKm     number  search radius 1–100 km  (default: 10)
 *   page         number  1-based page (default: 1); PAGE_SIZE=20
 *
 * Response: { places: DiscoveryPlace[], destination: string, total: number }
 *
 * Caches results per (destination, category, radiusKm) for 2 hours.
 * Graceful degradation: any network/parse error returns an empty list.
 */

import { Router } from "express";
import { getServiceClient, isServiceClientReady } from "../lib/supabase";
import { sendError } from "../lib/http";
import { buildDiscoveryContext } from "../services/location/DiscoveryLocationContext";
import { loadPreferences } from "../services/location/LocationPermissionService";
import type { DiscoveryContext, DiscoveryContextMode } from "../services/location/DiscoveryLocationContext";
import { calculateUserAge } from "../lib/ageEligibility";
import { discoveryPlaceToCompassItem } from "../compass/CompassDiscoveryAdapter";
import { getCompassProfile } from "../compass/CompassProfileService";
import { buildCompassContext, defaultSignals } from "../compass/CompassContextEngine";
import { runPipeline } from "../compass/CompassPipeline";
import { isEnabled } from "../compass/flags";

const router = Router();

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL  = "https://overpass-api.de/api/interpreter";
const FETCH_TIMEOUT_MS = 9_000;
const CACHE_TTL_MS     = 2 * 60 * 60 * 1_000; // 2 hours
const MAX_FETCH        = 60;
const PAGE_SIZE        = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Shape used internally and returned in all API responses. */
export interface DiscoveryPlace {
  id: string;
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  distanceKm: number | null;
  /** OSM venue latitude — public data, safe to expose */
  lat: number | null;
  /** OSM venue longitude — public data, safe to expose */
  lng: number | null;
  tags: string[];
  address: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  rating: number | null;
  isOpenNow: boolean | null;
}

/** Public shape returned in all API responses. */
export type PublicDiscoveryPlace = DiscoveryPlace;

function toPublic(p: DiscoveryPlace): PublicDiscoveryPlace {
  return p;
}

interface CacheEntry {
  places: DiscoveryPlace[];
  cachedAt: number;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

function cacheKey(dest: string, cat: string, radius: number) {
  return `${dest.toLowerCase().trim()}:${cat}:${radius}`;
}

function isFresh(e: CacheEntry) {
  return Date.now() - e.cachedAt < CACHE_TTL_MS;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function geocode(location: string): Promise<{ lat: number; lng: number; display: string } | null> {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy-app; discovery)" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const r = data?.[0];
  if (!r) return null;
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), display: r.display_name };
}

// ── Category → Overpass filter ────────────────────────────────────────────────

function overpassFilter(cat: string, radius: number, lat: number, lng: number): string {
  const r = radius;
  const c = `${lat},${lng}`;

  switch (cat) {
    case "places":
      return `(
  node["tourism"~"^(attraction|museum|viewpoint|gallery|castle|ruins|artwork|monument|historic)$"](around:${r},${c});
  way["tourism"~"^(attraction|museum|viewpoint|gallery|castle|ruins|artwork|monument|historic)$"](around:${r},${c});
  node["historic"~"^(castle|monument|memorial|ruins|building|church|fort|palace)$"](around:${r},${c});
  way["historic"~"^(castle|monument|memorial|ruins|building|church|fort|palace)$"](around:${r},${c});
);`;

    case "food":
      return `(
  node["amenity"~"^(restaurant|cafe|fast_food|bistro|food_court|bakery|ice_cream)$"](around:${r},${c});
  way["amenity"~"^(restaurant|cafe|fast_food|bistro|food_court|bakery|ice_cream)$"](around:${r},${c});
);`;

    case "nightlife":
      return `(
  node["amenity"~"^(bar|pub|nightclub|casino|biergarten|cocktail_bar)$"](around:${r},${c});
  way["amenity"~"^(bar|pub|nightclub|casino|biergarten|cocktail_bar)$"](around:${r},${c});
);`;

    case "activities":
      return `(
  node["leisure"~"^(park|sports_centre|fitness_centre|swimming_pool|golf_course|marina|water_park|miniature_golf|bowling_alley|stadium)$"](around:${r},${c});
  way["leisure"~"^(park|sports_centre|fitness_centre|swimming_pool|golf_course|marina|water_park|miniature_golf|bowling_alley|stadium)$"](around:${r},${c});
  node["tourism"~"^(theme_park|zoo|aquarium)$"](around:${r},${c});
  way["tourism"~"^(theme_park|zoo|aquarium)$"](around:${r},${c});
);`;

    case "events":
      return `(
  node["amenity"~"^(marketplace|community_centre|events_venue|theatre|cinema|arts_centre)$"](around:${r},${c});
  way["amenity"~"^(marketplace|community_centre|events_venue|theatre|cinema|arts_centre)$"](around:${r},${c});
  node["tourism"="gallery"](around:${r},${c});
  way["tourism"="gallery"](around:${r},${c});
);`;

    case "beaches":
      return `(
  node["natural"="beach"](around:${r},${c});
  way["natural"="beach"](around:${r},${c});
  relation["natural"="beach"](around:${r},${c});
  node["leisure"="beach_resort"](around:${r},${c});
  way["leisure"="beach_resort"](around:${r},${c});
);`;

    case "transport":
      return `(
  node["amenity"~"^(bus_station|ferry_terminal|taxi|car_rental|bicycle_rental)$"](around:${r},${c});
  node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](around:${r},${c});
  node["aeroway"~"^(aerodrome|terminal)$"](around:${r},${c});
  way["aeroway"~"^(aerodrome|terminal)$"](around:${r},${c});
);`;

    case "for_you":
    default:
      return `(
  node["tourism"~"^(attraction|museum|viewpoint|gallery)$"](around:${r},${c});
  way["tourism"~"^(attraction|museum|viewpoint|gallery)$"](around:${r},${c});
  node["amenity"~"^(restaurant|cafe)$"](around:${r},${c});
  node["natural"="beach"](around:${r},${c});
  way["natural"="beach"](around:${r},${c});
  node["leisure"~"^(park|sports_centre)$"](around:${r},${c});
  way["leisure"~"^(park|sports_centre)$"](around:${r},${c});
);`;
  }
}

// ── Haversine ─────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Tag extraction ────────────────────────────────────────────────────────────

function friendlyType(tags: Record<string, string>): string | null {
  if (tags.tourism)  return tags.tourism.replace(/_/g, " ");
  if (tags.amenity)  return tags.amenity.replace(/_/g, " ");
  if (tags.leisure)  return tags.leisure.replace(/_/g, " ");
  if (tags.natural)  return tags.natural.replace(/_/g, " ");
  if (tags.historic) return tags.historic.replace(/_/g, " ");
  if (tags.railway)  return "rail station";
  if (tags.aeroway)  return "airport";
  return null;
}

function extractTags(tags: Record<string, string>): string[] {
  const out: string[] = [];
  if (tags.cuisine)    out.push(tags.cuisine.split(/[;,]/)[0]!.trim().replace(/_/g, " "));
  if (tags.tourism)    out.push(tags.tourism.replace(/_/g, " "));
  if (tags.amenity)    out.push(tags.amenity.replace(/_/g, " "));
  if (tags.leisure)    out.push(tags.leisure.replace(/_/g, " "));
  if (tags.natural)    out.push(tags.natural);
  if (tags.historic)   out.push(tags.historic.replace(/_/g, " "));
  if (tags.sport)      out.push(tags.sport.split(";")[0]!.trim());
  return [...new Set(out)].filter(Boolean).slice(0, 3);
}

function parseRating(tags: Record<string, string>): number | null {
  const raw = tags["stars"] ?? tags["rating"] ?? null;
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** Best-effort open-now check from an OSM opening_hours string. */
function determineOpenNow(hours: string | null): boolean | null {
  if (!hours) return null;
  const now = new Date();
  const dayAbbr = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][now.getDay()];
  if (dayAbbr && !hours.includes(dayAbbr)) return false;
  const match = hours.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
  if (!match) return null; // present but unparseable — unknown
  const hh    = now.getHours() * 100 + now.getMinutes();
  const open  = parseInt(match[1]!) * 100 + parseInt(match[2]!);
  const close = parseInt(match[3]!) * 100 + parseInt(match[4]!);
  return hh >= open && hh <= close;
}

function buildAddress(tags: Record<string, string>): string | null {
  const parts: string[] = [];
  if (tags["addr:housenumber"] && tags["addr:street"]) {
    parts.push(`${tags["addr:housenumber"]} ${tags["addr:street"]}`);
  } else if (tags["addr:street"]) {
    parts.push(tags["addr:street"]);
  }
  if (tags["addr:city"]) parts.push(tags["addr:city"]);
  return parts.length ? parts.join(", ") : null;
}

// ── Overpass query ────────────────────────────────────────────────────────────

type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

async function queryOverpass(
  lat: number,
  lng: number,
  radiusM: number,
  category: string,
): Promise<DiscoveryPlace[]> {
  const filter = overpassFilter(category, radiusM, lat, lng);
  const query  = `[out:json][timeout:8];\n${filter}\nout body center qt ${MAX_FETCH};`;

  // GET avoids Content-Type 406 issues with undici (Node built-in fetch).
  const url = `${OVERPASS_URL}?data=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy-app; discovery)" },
  });

  if (!res.ok) return [];

  const data = (await res.json()) as { elements: OsmElement[] };
  if (!data?.elements?.length) return [];

  return data.elements
    .filter((el) => el.tags?.name && el.tags.name.trim())
    .map((el): DiscoveryPlace => {
      const elLat = el.lat ?? el.center?.lat ?? null;
      const elLng = el.lon ?? el.center?.lon ?? null;
      const tags  = el.tags ?? {};
      return {
        id:          `${el.type}/${el.id}`,
        name:        tags.name!,
        category,
        type:        friendlyType(tags),
        description: tags.description ?? tags["note"] ?? null,
        distanceKm:  elLat != null && elLng != null
          ? Math.round(haversineKm(lat, lng, elLat, elLng) * 10) / 10
          : null,
        lat:         elLat,
        lng:         elLng,
        tags:         extractTags(tags),
        address:      buildAddress(tags),
        website:      tags.website ?? tags.url ?? null,
        phone:        tags.phone ?? tags["contact:phone"] ?? null,
        openingHours: tags.opening_hours ?? null,
        rating:       parseRating(tags),
        isOpenNow:    determineOpenNow(tags.opening_hours ?? null),
      };
    })
    .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999))
    .slice(0, MAX_FETCH);
}

// ── Composite ranking ─────────────────────────────────────────────────────────
//
// When a DiscoveryContext is present (authenticated caller), re-sort places
// using a weighted composite score so that:
//   - Verified/trusted places (from GeoZoneService) are boosted
//   - Distance weight is dialled per mode (near_me → high, in_city → low)
//   - Trip/vibe context elevates relevant categories
//   - Safety-score weight lifts well-tagged places for safe_nearby mode
//
// PRIVACY: no exact coords are used in scoring. Distance is expressed in km
// from the OSM element centre (already computed by queryOverpass).

const MAX_DISTANCE_KM = 20; // distance normalisation ceiling

function scoreWithContext(places: DiscoveryPlace[], ctx: DiscoveryContext): DiscoveryPlace[] {
  const w = ctx.weights;
  const verifiedSet = new Set(ctx.verifiedPlaceIds);

  function score(p: DiscoveryPlace): number {
    let s = 0;

    // Distance factor (inverted — closer = higher score)
    if (w.distance > 0 && p.distanceKm != null) {
      const distFactor = Math.max(0, 1 - p.distanceKm / MAX_DISTANCE_KM);
      s += w.distance * distFactor;
    }

    // Verified places boost — from GeoZoneService (curated, trust-reviewed)
    if (w.verifiedPlaces > 0 && verifiedSet.has(p.id)) {
      s += w.verifiedPlaces;
    }

    // Rating signal — boosts well-reviewed places slightly (consistent across modes)
    if (p.rating != null && p.rating > 0) {
      s += 0.15 * (p.rating / 5);
    }

    // City match — all results are already in the city, constant contribution
    s += w.cityMatch * 0.4;

    // Trip match boost — adds lift when going_soon context is active
    if (w.tripMatch > 0) {
      s += w.tripMatch * 0.3;
    }

    // Safety signal — prefer places with structured opening hours (proxy for legitimacy)
    if (w.safetyScore > 0 && p.openingHours) {
      s += w.safetyScore * 0.2;
    }

    // Vibe match — currently a constant lift per mode (trip / vibe data not local)
    if (w.vibeMatch > 0) {
      s += w.vibeMatch * 0.2;
    }

    return s;
  }

  return [...places].sort((a, b) => score(b) - score(a));
}

// ── Route ─────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = ["for_you", "places", "food", "nightlife", "activities", "events", "beaches", "transport"];
const VALID_CONTEXT_MODES = ["near_me", "in_city", "going_soon", "around_crew", "safe_nearby"];

// OSM venue types considered adult-only (require 18+). Used to filter results
// for callers whose effective age resolves to under 18.
const ADULT_OSM_VENUE_TYPES = new Set([
  "nightclub", "casino", "stripclub", "adult_gaming_centre",
  "brothel", "swingerclub", "bar", "pub",
]);

/**
 * Context mode labels returned to the client. Never includes exact coords.
 */
function contextModeLabel(mode: string, city: string | null): string {
  switch (mode) {
    case "near_me":      return "Near me";
    case "in_city":      return city ? `In ${city}` : "In this city";
    case "going_soon":   return city ? `Going to ${city}` : "Going soon";
    case "around_crew":  return "Around my crew";
    case "safe_nearby":  return "Safe nearby";
    default:             return city ? `In ${city}` : "Discovery";
  }
}

router.get("/discovery", async (req, res) => {
  const destinationParam = (req.query.destination as string | undefined)?.trim() || undefined;

  // Optional auth — enrich with DiscoveryLocationContext when present.
  // When authenticated + no destination param, we use discoveryCtx.targetCity as
  // the effective destination so context-driven modes (near_me/going_soon) work
  // without requiring the client to geocode first.
  let discoveryCtx: DiscoveryContext | null = null;
  let callerUserId: string | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ") && isServiceClientReady) {
    try {
      const token = authHeader.slice(7).trim();
      const sc = getServiceClient()!;
      const { data: authData } = await sc.auth.getUser(token);
      if (authData?.user) {
        callerUserId = authData.user.id;
        const rawMode = (req.query.context as string | undefined) ?? "";
        const mode: DiscoveryContextMode = VALID_CONTEXT_MODES.includes(rawMode)
          ? (rawMode as DiscoveryContextMode)
          : "in_city";

        const [prefs, locState] = await Promise.all([
          loadPreferences(sc, authData.user.id),
          sc.from("user_location_state")
            .select("city, country, lat, lng")
            .eq("user_id", authData.user.id)
            .maybeSingle(),
        ]);

        const currentCity    = (locState.data as any)?.city ?? null;
        const currentCountry = (locState.data as any)?.country ?? null;

        discoveryCtx = await buildDiscoveryContext({
          db: sc, userId: authData.user.id, prefs, mode,
          currentCity, currentCountry,
        });
      }
    } catch { /* degrade — non-fatal */ }
  }

  // Resolve effective destination: explicit query param takes priority; fall back
  // to DiscoveryContext.targetCity so context-driven modes work without client geocoding.
  const destination = destinationParam ?? discoveryCtx?.targetCity ?? undefined;
  if (!destination) {
    res.status(400).json({ error: "invalid_payload", message: "destination is required" });
    return;
  }

  // Context mode: near_me | in_city | going_soon | around_crew | safe_nearby
  const contextMode = VALID_CONTEXT_MODES.includes(req.query.context as string)
    ? (req.query.context as string)
    : null;

  // Adjust radius based on context mode (DiscoveryContext overrides when available)
  const defaultRadius = discoveryCtx?.radiusKm ?? (
    contextMode === "near_me" ? 5
    : contextMode === "safe_nearby" ? 3
    : contextMode === "going_soon" ? 15
    : 10
  );

  const category  = VALID_CATEGORIES.includes(req.query.category as string)
    ? (req.query.category as string)
    : "for_you";
  const radiusKm  = Math.max(1, Math.min(100, parseFloat(req.query.radiusKm as string) || defaultRadius));
  const page      = Math.max(1, parseInt(req.query.page as string) || 1);
  const radiusM   = Math.round(radiusKm * 1000);
  const openNow   = req.query.openNow === "1";
  const minRating = req.query.minRating ? parseFloat(req.query.minRating as string) : null;

  // ── Age filter params ──────────────────────────────────────────────────────
  const VALID_AGE_FILTERS = ["any", "open_to_me", "18_plus", "21_plus", "under_30", "30_plus", "custom"] as const;
  type AgeFilterType = typeof VALID_AGE_FILTERS[number];
  const rawAgeFilter = req.query.ageFilter as string | undefined;
  const ageFilter: AgeFilterType = VALID_AGE_FILTERS.includes(rawAgeFilter as any)
    ? (rawAgeFilter as AgeFilterType)
    : "any";
  const customMinAge = req.query.customMinAge ? parseInt(req.query.customMinAge as string) : null;
  const customMaxAge = req.query.customMaxAge ? parseInt(req.query.customMaxAge as string) : null;

  // Resolve caller age when ageFilter = open_to_me
  let callerAge: number | null = null;
  let callerDobMissing = false;
  if (ageFilter === "open_to_me" && callerUserId) {
    const sc = getServiceClient();
    if (sc) {
      const { data: profileRow } = await sc
        .from("profiles")
        .select("date_of_birth")
        .eq("id", callerUserId)
        .maybeSingle();
      const dob = (profileRow as any)?.date_of_birth ?? null;
      callerAge = calculateUserAge(dob);
      if (callerAge === null) callerDobMissing = true;
    }
  }

  /** Derive effective min/max age from the chosen filter preset */
  function ageFilterBounds(): { min: number | null; max: number | null } | null {
    switch (ageFilter) {
      case "any":        return null;
      case "18_plus":    return { min: 18, max: null };
      case "21_plus":    return { min: 21, max: null };
      case "under_30":   return { min: null, max: 29 };
      case "30_plus":    return { min: 30, max: null };
      case "custom":     return { min: customMinAge, max: customMaxAge };
      case "open_to_me": return callerAge !== null ? { min: callerAge, max: callerAge } : null;
      default:           return null;
    }
  }

  const key    = cacheKey(destination, category, radiusKm);
  const cached = cache.get(key);
  /** Apply openNow / minRating / age filters to a set of places */
  function applyFilters(raw: DiscoveryPlace[]): DiscoveryPlace[] {
    let list = raw;
    if (openNow) {
      list = list.filter((p) => {
        if (p.isOpenNow === null) return true; // no data → optimistic include
        return p.isOpenNow === true;
      });
    }
    if (minRating !== null && Number.isFinite(minRating)) {
      list = list.filter((p) => {
        if (p.rating === null) return true; // no rating data → include
        return p.rating >= minRating!;
      });
    }
    // Age-based category filter: OSM venues don't store explicit age limits, so
    // we proxy by known adult-only venue types. Filter them out only when the
    // effective caller age resolves to < 18 (e.g. open_to_me for a minor, or
    // custom range capped below 18).
    const ageBounds = ageFilterBounds();
    if (ageBounds !== null) {
      const effectiveMin = ageBounds.min ?? (ageBounds.max !== null && ageBounds.max < 18 ? ageBounds.max : null);
      if (effectiveMin !== null && effectiveMin < 18) {
        list = list.filter((p) => !ADULT_OSM_VENUE_TYPES.has((p.category ?? "").toLowerCase()));
      }
    }
    return list;
  }

  const cityLabel = destination.split(",")[0]?.trim() ?? null;
  // discoveryCtx.label (from DiscoveryLocationContext) takes precedence over generic label
  const ctxLabel  = discoveryCtx?.label ?? (contextMode ? contextModeLabel(contextMode, cityLabel) : null);

  const ageFilterMeta = {
    ageFilter,
    callerDobMissing: ageFilter === "open_to_me" ? callerDobMissing : false,
    bounds: ageFilterBounds(),
  };

  if (cached && isFresh(cached)) {
    const filtered = applyFilters(cached.places);
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
    res.json({ places: slice, total: filtered.length, destination, context: ctxLabel, cached: true, ageFilterMeta });
    return;
  }

  try {
    const coords = await geocode(destination);
    if (!coords) {
      res.json({ places: [], total: 0, destination, context: ctxLabel, cached: false, ageFilterMeta });
      return;
    }

    const places = await queryOverpass(coords.lat, coords.lng, radiusM, category);
    // Only cache when we have results — avoids locking out a destination for
    // 2 hours if Overpass timed out or returned nothing transiently.
    if (places.length > 0) {
      cache.set(key, { places, cachedAt: Date.now() });
    }

    // COMPASS_V1_RULE_BASED_ENABLED: for for_you tab, use Compass pipeline scoring
    // instead of the rule-based scoreWithContext to rank OSM places.
    if (category === "for_you" && callerUserId && isServiceClientReady) {
      const compassSc = getServiceClient();
      if (compassSc) {
        try {
          const compassFlagOn = await isEnabled(compassSc, "COMPASS_V1_RULE_BASED_ENABLED");
          if (compassFlagOn) {
            const compassProfile = await getCompassProfile(compassSc, callerUserId);
            const compassContext = buildCompassContext(compassProfile, defaultSignals(compassProfile));
            const compassItems   = places.map(discoveryPlaceToCompassItem);

            // Run the full pipeline on ALL candidate items and sort by finalScore.
            // We use runPipeline directly (not buildFeed) so no page-size cap
            // is applied — the full ranked list is available for discovery's
            // own pagination logic.
            const { results } = await runPipeline(
              compassItems, compassProfile, compassContext, compassSc,
            );
            // Sort descending by Compass score
            const scored = results.slice().sort((a, b) => b.finalScore - a.finalScore);

            // Build lookup so we can restore all original DiscoveryPlace fields
            const placeById = new Map(places.map((p) => [p.id, p]));
            const compassRanked: DiscoveryPlace[] = scored.map((r) => {
              const originalId = r.item.id.replace(/^discovery:/, "");
              return placeById.get(originalId) ?? {
                id: originalId, name: String(r.item.contentBody ?? ""),
                category: (r.item.interestTags ?? [])[0] ?? "places",
                type: null, description: null, distanceKm: null,
                lat: null, lng: null, tags: [], address: null,
                website: null, phone: null, openingHours: null,
                rating: null, isOpenNow: null,
              };
            });
            // Items blocked/rejected by Compass pipeline fall to the back
            const passedIds = new Set(compassRanked.map((p) => p.id));
            const unranked  = places.filter((p) => !passedIds.has(p.id));
            // Full ranked list — discovery does its own pagination below
            const merged    = [...compassRanked, ...unranked];
            const cFiltered  = applyFilters(merged);
            const cSlice     = cFiltered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
            res.json({ places: cSlice, total: cFiltered.length, destination, context: ctxLabel, cached: false, ageFilterMeta });
            return;
          }
        } catch { /* fall through to normal rule-based path */ }
      }
    }

    // Apply context-aware composite ranking when DiscoveryContext is available
    const ranked  = discoveryCtx ? scoreWithContext(places, discoveryCtx) : places;
    const filtered = applyFilters(ranked);
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
    res.json({ places: slice, total: filtered.length, destination, context: ctxLabel, cached: false, ageFilterMeta });
  } catch (err) {
    req.log.error({ err }, "discovery route failed");
    res.json({ places: [], total: 0, destination, context: ctxLabel ?? null, cached: false, ageFilterMeta: null });
  }
});

// ── Community discovery route ──────────────────────────────────────────────────
//
// GET /api/discovery/community?city=Cebu[&type=hidden_gem|traveler_pick|all][&limit=20]
//
// Queries the `discovery_places` table and joins `profiles` to resolve
// submitted_by → { id, name, avatarUrl } so HighlightRing can fire on real UUIDs.
// No auth required — all community places are publicly readable.

export interface CommunityDiscoveryItem {
  id: string;
  city: string;
  name: string;
  placeType: "hidden_gem" | "traveler_pick";
  category: string;
  neighborhood: string | null;
  blurb: string | null;
  imageUrl: string | null;
  submittedBy: { id: string; name: string; avatarUrl: string | null } | null;
  savedCount: number;
  tag: string | null;
  note: string | null;
  rating: number | null;
  source: string;
  status: string;
  verified: boolean;
  createdAt: string;
}

const VALID_PLACE_TYPES = new Set(["hidden_gem", "traveler_pick", "all"]);

router.get("/discovery/community", async (req, res) => {
  const city = (req.query.city as string | undefined)?.trim();
  if (!city) {
    sendError(res, "invalid_payload", "city is required");
    return;
  }

  if (!isServiceClientReady) {
    res.json({ items: [], city, total: 0 });
    return;
  }

  const rawType  = req.query.type as string | undefined;
  const typeFilter = VALID_PLACE_TYPES.has(rawType ?? "") ? rawType! : "all";
  const limit    = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));

  // Age filter params for community discovery
  const VALID_AGE_FILTERS_COMM = ["any", "open_to_me", "18_plus", "21_plus", "under_30", "30_plus", "custom"] as const;
  const rawAgeFilter = req.query.ageFilter as string | undefined;
  const ageFilterComm = VALID_AGE_FILTERS_COMM.includes(rawAgeFilter as any)
    ? (rawAgeFilter as typeof VALID_AGE_FILTERS_COMM[number])
    : "any";
  const customMinAge = req.query.customMinAge ? parseInt(req.query.customMinAge as string) : null;
  const customMaxAge = req.query.customMaxAge ? parseInt(req.query.customMaxAge as string) : null;

  // Optional auth — needed only for open_to_me to resolve caller DOB
  let commCallerAge: number | null = null;
  let commCallerDobMissing = false;
  if (ageFilterComm === "open_to_me" && isServiceClientReady) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const sc = getServiceClient();
      if (sc) {
        try {
          const token = authHeader.slice(7).trim();
          const { data: authData } = await sc.auth.getUser(token);
          if (authData?.user) {
            const { data: profileRow } = await sc
              .from("profiles")
              .select("date_of_birth")
              .eq("id", authData.user.id)
              .maybeSingle();
            const dob = (profileRow as any)?.date_of_birth ?? null;
            commCallerAge = calculateUserAge(dob);
          }
        } catch { /* degrade gracefully */ }
      }
    }
    if (commCallerAge === null) commCallerDobMissing = true;
  }

  function communityAgeBounds(): { min: number | null; max: number | null } | null {
    switch (ageFilterComm) {
      case "any":        return null;
      case "18_plus":    return { min: 18, max: null };
      case "21_plus":    return { min: 21, max: null };
      case "under_30":   return { min: null, max: 29 };
      case "30_plus":    return { min: 30, max: null };
      case "custom":     return (customMinAge !== null || customMaxAge !== null)
                           ? { min: customMinAge, max: customMaxAge }
                           : null;
      case "open_to_me": return commCallerAge !== null
                           ? { min: commCallerAge, max: commCallerAge }
                           : null;
      default:           return null;
    }
  }

  try {
    const sc = getServiceClient()!;

    let query = sc
      .from("discovery_places")
      .select(`
        id,
        city,
        name,
        place_type,
        category,
        neighborhood,
        blurb,
        image_url,
        submitted_by,
        saved_count,
        tag,
        note,
        rating,
        source,
        status,
        verified,
        created_at,
        profiles:submitted_by ( id, display_name, name, avatar_url )
      `)
      .ilike("city", city.trim())
      .order("created_at", { ascending: false })
      .limit(limit);

    if (typeFilter !== "all") {
      query = query.eq("place_type", typeFilter);
    }

    // Age filtering: show only places accessible to the effective caller age.
    // Interpretation: a place is accessible to someone of age X when
    //   min_age IS NULL OR min_age <= X  (place doesn't require more than X years)
    //   max_age IS NULL OR max_age >= X  (place doesn't cap at below X years)
    const ageBoundsComm = communityAgeBounds();
    if (ageBoundsComm) {
      if (ageBoundsComm.min !== null) {
        query = query.or(`min_age.is.null,min_age.lte.${ageBoundsComm.min}`);
      }
      if (ageBoundsComm.max !== null) {
        query = query.or(`max_age.is.null,max_age.gte.${ageBoundsComm.max}`);
      }
    }

    const { data, error } = await query;

    if (error) {
      req.log.error({ err: error }, "discovery/community query failed");
      res.json({ items: [], city, total: 0 });
      return;
    }

    const items: CommunityDiscoveryItem[] = (data ?? []).map((row: any) => {
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      return {
        id:           row.id,
        city:         row.city,
        name:         row.name,
        placeType:    (row.place_type ?? "hidden_gem") as "hidden_gem" | "traveler_pick",
        category:     row.category ?? "hidden_gem",
        neighborhood: row.neighborhood ?? null,
        blurb:        row.blurb ?? null,
        imageUrl:     row.image_url ?? null,
        submittedBy:  profile
          ? {
              id:        profile.id as string,
              name:      (profile.display_name ?? profile.name ?? "Traveler") as string,
              avatarUrl: (profile.avatar_url ?? null) as string | null,
            }
          : null,
        savedCount: (row.saved_count as number) ?? 0,
        tag:       row.tag ?? null,
        note:      row.note ?? null,
        rating:    row.rating != null ? parseFloat(row.rating) : null,
        source:    row.source ?? "traveler",
        status:    row.status ?? "provisional",
        verified:  Boolean(row.verified),
        createdAt: row.created_at as string,
      };
    });

    res.json({
      items,
      city,
      total: items.length,
      ageFilterMeta: {
        ageFilter:         ageFilterComm,
        callerDobMissing:  ageFilterComm === "open_to_me" ? commCallerDobMissing : false,
        bounds:            communityAgeBounds(),
      },
    });
  } catch (err) {
    req.log.error({ err }, "discovery/community route failed");
    res.json({ items: [], city, total: 0 });
  }
});

export default router;
