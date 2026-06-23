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

const router = Router();

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL  = "https://overpass-api.de/api/interpreter";
const FETCH_TIMEOUT_MS = 9_000;
const CACHE_TTL_MS     = 2 * 60 * 60 * 1_000; // 2 hours
const MAX_FETCH        = 60;
const PAGE_SIZE        = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Internal shape — keeps lat/lng for distance computation only; never returned to clients. */
export interface DiscoveryPlace {
  id: string;
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  distanceKm: number | null;
  /** @internal never expose in API responses */
  lat: number | null;
  /** @internal never expose in API responses */
  lng: number | null;
  tags: string[];
  address: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  rating: number | null;
  isOpenNow: boolean | null;
}

/** Public shape returned in all API responses — no exact coordinates. */
export type PublicDiscoveryPlace = Omit<DiscoveryPlace, "lat" | "lng">;

function toPublic(p: DiscoveryPlace): PublicDiscoveryPlace {
  const { lat: _lat, lng: _lng, ...pub } = p;
  return pub;
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
  const destination = (req.query.destination as string | undefined)?.trim();
  if (!destination) {
    res.status(400).json({ error: "invalid_payload", message: "destination is required" });
    return;
  }

  // Optional auth — enrich with DiscoveryLocationContext when present.
  // Never blocks unauthenticated callers; degrades gracefully.
  let discoveryCtx: DiscoveryContext | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ") && isServiceClientReady) {
    try {
      const token = authHeader.slice(7).trim();
      const sc = getServiceClient()!;
      const { data: authData } = await sc.auth.getUser(token);
      if (authData?.user) {
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

  const key    = cacheKey(destination, category, radiusKm);
  const cached = cache.get(key);
  /** Apply openNow / minRating filters to a set of places */
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
    return list;
  }

  const cityLabel = destination.split(",")[0]?.trim() ?? null;
  // discoveryCtx.label (from DiscoveryLocationContext) takes precedence over generic label
  const ctxLabel  = discoveryCtx?.label ?? (contextMode ? contextModeLabel(contextMode, cityLabel) : null);

  if (cached && isFresh(cached)) {
    const filtered = applyFilters(cached.places);
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
    res.json({ places: slice, total: filtered.length, destination, context: ctxLabel, cached: true });
    return;
  }

  try {
    const coords = await geocode(destination);
    if (!coords) {
      res.json({ places: [], total: 0, destination, context: ctxLabel, cached: false });
      return;
    }

    const places = await queryOverpass(coords.lat, coords.lng, radiusM, category);
    // Only cache when we have results — avoids locking out a destination for
    // 2 hours if Overpass timed out or returned nothing transiently.
    if (places.length > 0) {
      cache.set(key, { places, cachedAt: Date.now() });
    }

    // Apply context-aware composite ranking when DiscoveryContext is available
    const ranked  = discoveryCtx ? scoreWithContext(places, discoveryCtx) : places;
    const filtered = applyFilters(ranked);
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
    res.json({ places: slice, total: filtered.length, destination, context: ctxLabel, cached: false });
  } catch (err) {
    req.log.error({ err }, "discovery route failed");
    res.json({ places: [], total: 0, destination, context: ctxLabel ?? null, cached: false });
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

    res.json({ items, city, total: items.length });
  } catch (err) {
    req.log.error({ err }, "discovery/community route failed");
    res.json({ items: [], city, total: 0 });
  }
});

export default router;
