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

const router = Router();

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL  = "https://overpass-api.de/api/interpreter";
const FETCH_TIMEOUT_MS = 9_000;
const CACHE_TTL_MS     = 2 * 60 * 60 * 1_000; // 2 hours
const MAX_FETCH        = 60;
const PAGE_SIZE        = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryPlace {
  id: string;
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  distanceKm: number | null;
  lat: number | null;
  lng: number | null;
  tags: string[];
  address: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  rating: number | null;
  isOpenNow: boolean | null;
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

// ── Route ─────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = ["for_you", "places", "food", "nightlife", "activities", "events", "beaches", "transport"];

router.get("/discovery", async (req, res) => {
  const destination = (req.query.destination as string | undefined)?.trim();
  if (!destination) {
    res.status(400).json({ error: "invalid_payload", message: "destination is required" });
    return;
  }

  const category  = VALID_CATEGORIES.includes(req.query.category as string)
    ? (req.query.category as string)
    : "for_you";
  const radiusKm  = Math.max(1, Math.min(100, parseFloat(req.query.radiusKm as string) || 10));
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

  if (cached && isFresh(cached)) {
    const filtered = applyFilters(cached.places);
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    res.json({ places: slice, total: filtered.length, destination, cached: true });
    return;
  }

  try {
    const coords = await geocode(destination);
    if (!coords) {
      res.json({ places: [], total: 0, destination, cached: false });
      return;
    }

    const places = await queryOverpass(coords.lat, coords.lng, radiusM, category);
    // Only cache when we have results — avoids locking out a destination for
    // 2 hours if Overpass timed out or returned nothing transiently.
    if (places.length > 0) {
      cache.set(key, { places, cachedAt: Date.now() });
    }

    const filtered = applyFilters(places);
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    res.json({ places: slice, total: filtered.length, destination, cached: false });
  } catch (err) {
    req.log.error({ err }, "discovery route failed");
    res.json({ places: [], total: 0, destination, cached: false });
  }
});

export default router;
