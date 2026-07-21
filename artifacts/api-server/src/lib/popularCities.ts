/**
 * popularCities — ranks cities by REAL traveler activity on the platform:
 * trips created, posts tagged, events hosted, profiles currently there, and
 * discovery-place saves. Falls back to seed cities when activity is sparse
 * (fresh installs, new regions) so the picker is never empty.
 *
 * Results resolve through the canonical location registry so every popular
 * city carries a canonicalId and normalized fields.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeLocationName,
  resolveCanonicalLocation,
  haversineKm,
} from "./canonicalLocations";
import { logger as rootLogger } from "./logger";
import { registerCityCoordinates, cityTimezone } from "../compass/CompassGraphEngine.js";

const logger = rootLogger.child({ lib: "popularCities" });

// ── Seed fallback (used only to top-up sparse activity data) ─────────────────

interface SeedCity {
  name: string; country: string; countryCode: string; lat: number; lng: number;
}

export const SEED_CITIES: SeedCity[] = [
  { name: "Cebu City", country: "Philippines", countryCode: "PH", lat: 10.316, lng: 123.891 },
  { name: "Manila", country: "Philippines", countryCode: "PH", lat: 14.599, lng: 120.984 },
  { name: "Davao City", country: "Philippines", countryCode: "PH", lat: 7.207, lng: 125.395 },
  { name: "Bangkok", country: "Thailand", countryCode: "TH", lat: 13.756, lng: 100.502 },
  { name: "Bali", country: "Indonesia", countryCode: "ID", lat: -8.409, lng: 115.188 },
  { name: "Tokyo", country: "Japan", countryCode: "JP", lat: 35.689, lng: 139.691 },
  { name: "Paris", country: "France", countryCode: "FR", lat: 48.856, lng: 2.351 },
  { name: "Barcelona", country: "Spain", countryCode: "ES", lat: 41.385, lng: 2.173 },
  { name: "New York", country: "USA", countryCode: "US", lat: 40.712, lng: -74.006 },
  { name: "London", country: "UK", countryCode: "GB", lat: 51.507, lng: -0.127 },
  { name: "Singapore", country: "Singapore", countryCode: "SG", lat: 1.352, lng: 103.819 },
  { name: "Istanbul", country: "Turkey", countryCode: "TR", lat: 41.013, lng: 28.979 },
  { name: "Dubai", country: "UAE", countryCode: "AE", lat: 25.204, lng: 55.27 },
  { name: "Ho Chi Minh City", country: "Vietnam", countryCode: "VN", lat: 10.776, lng: 106.701 },
  { name: "Lisbon", country: "Portugal", countryCode: "PT", lat: 38.716, lng: -9.139 },
  { name: "Mexico City", country: "Mexico", countryCode: "MX", lat: 19.432, lng: -99.133 },
];

// ── Activity aggregation ──────────────────────────────────────────────────────

interface CityScore {
  name: string;          // best display variant seen
  country: string | null;
  score: number;
  lat: number | null;
  lng: number | null;
}

const ACTIVITY_WINDOW_DAYS = 90;
const ROW_LIMIT = 2000;

/** key = normalized name | normalized country (country may be empty) */
function cityKey(city: string, country: string | null | undefined): string {
  return `${normalizeLocationName(city)}|${country ? normalizeLocationName(country) : ""}`;
}

function bump(
  map: Map<string, CityScore>,
  city: string | null | undefined,
  country: string | null | undefined,
  weight: number,
  coords?: { lat: number | null; lng: number | null },
) {
  if (!city || typeof city !== "string" || !city.trim()) return;
  // Teach the timezone resolver as coords flow through — brand-new cities
  // get a real coordinate-derived timezone instead of skewing rhythms to UTC.
  if (coords?.lat != null && coords?.lng != null) {
    registerCityCoordinates(city, coords.lat, coords.lng);
  }
  const key = cityKey(city, country ?? null);
  const cur = map.get(key);
  if (cur) {
    cur.score += weight;
    // Prefer the longer variant as display ("Cebu City" over "Cebu")
    if (city.length > cur.name.length) cur.name = city;
    if (!cur.country && country) cur.country = country;
    if (cur.lat == null && coords?.lat != null) { cur.lat = coords.lat; cur.lng = coords.lng ?? null; }
  } else {
    map.set(key, {
      name: city.trim(),
      country: country?.trim() || null,
      score: weight,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
    });
  }
}

async function aggregateActivity(db: SupabaseClient): Promise<Map<string, CityScore>> {
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const map = new Map<string, CityScore>();

  const [posts, trips, events, profiles, discovery] = await Promise.allSettled([
    db.from("posts")
      .select("location_city, location_country, like_count, comment_count")
      .not("location_city", "is", null)
      .gte("created_at", since)
      .limit(ROW_LIMIT),
    db.from("trips")
      .select("destination_city, destination_country, destination_lat, destination_lng")
      .not("destination_city", "is", null)
      .gte("created_at", since)
      .limit(ROW_LIMIT),
    db.from("events")
      .select("city, location_lat, location_lng")
      .not("city", "is", null)
      .gte("created_at", since)
      .limit(ROW_LIMIT),
    db.from("profiles")
      .select("current_city, home_city, home_country")
      .limit(ROW_LIMIT),
    db.from("discovery_places")
      .select("city, lat, lng, saved_count")
      .not("city", "is", null)
      .gt("saved_count", 0)
      .limit(ROW_LIMIT),
  ]);

  if (posts.status === "fulfilled" && !posts.value.error) {
    for (const r of (posts.value.data ?? []) as any[]) {
      const engagement = Math.min(2, 0.05 * ((r.like_count ?? 0) + (r.comment_count ?? 0)));
      bump(map, r.location_city, r.location_country, 1 + engagement);
    }
  }
  if (trips.status === "fulfilled" && !trips.value.error) {
    for (const r of (trips.value.data ?? []) as any[]) {
      bump(map, r.destination_city, r.destination_country, 3, {
        lat: r.destination_lat ?? null, lng: r.destination_lng ?? null,
      });
    }
  }
  if (events.status === "fulfilled" && !events.value.error) {
    for (const r of (events.value.data ?? []) as any[]) {
      bump(map, r.city, null, 2, { lat: r.location_lat ?? null, lng: r.location_lng ?? null });
    }
  }
  if (profiles.status === "fulfilled" && !profiles.value.error) {
    for (const r of (profiles.value.data ?? []) as any[]) {
      bump(map, r.current_city, null, 1);
      bump(map, r.home_city, r.home_country, 0.5);
    }
  }
  if (discovery.status === "fulfilled" && !discovery.value.error) {
    for (const r of (discovery.value.data ?? []) as any[]) {
      bump(map, r.city, null, 0.5 + Math.min(3, (r.saved_count ?? 0) * 0.2), {
        lat: r.lat ?? null, lng: r.lng ?? null,
      });
    }
  }

  return map;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface PopularCityPlace {
  id: string;
  canonicalId: string | null;
  type: "city";
  name: string;
  displayName: string;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string;
  district: null;
  lat: number | null;
  lng: number | null;
  /** IANA timezone when resolvable (static map, learned cache, or coords). */
  timezone: string | null;
  source: "canonical";
  /** Relative activity score — clients may show ranking hints. */
  activityScore: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { places: PopularCityPlace[]; ts: number }>();
const inFlight = new Map<string, Promise<PopularCityPlace[]>>();

function cacheKeyFor(lat: number | undefined, lng: number | undefined, limit: number): string {
  // 1-decimal bucket (~11 km) — nearby users share the ranking
  const l = lat != null && lng != null ? `${lat.toFixed(1)},${lng.toFixed(1)}` : "global";
  return `${l}:${limit}`;
}

export async function getPopularCities(
  db: SupabaseClient | null,
  opts: { lat?: number; lng?: number; limit?: number } = {},
): Promise<PopularCityPlace[]> {
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 20);
  const key = cacheKeyFor(opts.lat, opts.lng, limit);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.places;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = computePopular(db, opts.lat, opts.lng, limit)
    .then((places) => {
      cache.set(key, { places, ts: Date.now() });
      return places;
    })
    .catch((err) => {
      logger.warn({ err }, "popular cities failed — serving seeds");
      return seedPlaces(limit, opts.lat, opts.lng);
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

function seedPlaces(limit: number, lat?: number, lng?: number): PopularCityPlace[] {
  const seeds = SEED_CITIES.map((s) => toPlace(s.name, s.country, s.countryCode, s.lat, s.lng, null, 0));
  return sortByProximity(seeds, lat, lng).slice(0, limit);
}

function toPlace(
  name: string, country: string | null, countryCode: string | null,
  lat: number | null, lng: number | null, canonicalId: string | null, score: number,
): PopularCityPlace {
  return {
    id: canonicalId ? `canonical-${canonicalId}` : `popular-${normalizeLocationName(name).replace(/\s+/g, "-")}`,
    canonicalId,
    type: "city",
    name,
    displayName: country ? `${name}, ${country}` : name,
    country,
    countryCode,
    region: null,
    city: name,
    district: null,
    lat, lng,
    timezone: cityTimezone(name, { lat, lng }),
    source: "canonical",
    activityScore: Math.round(score * 10) / 10,
  };
}

function sortByProximity<T extends { lat: number | null; lng: number | null }>(
  places: T[], lat?: number, lng?: number,
): T[] {
  if (lat == null || lng == null) return places;
  return [...places].sort((a, b) => {
    const da = a.lat != null && a.lng != null ? haversineKm(lat, lng, a.lat, a.lng) : Infinity;
    const dbb = b.lat != null && b.lng != null ? haversineKm(lat, lng, b.lat, b.lng) : Infinity;
    return da - dbb;
  });
}

async function computePopular(
  db: SupabaseClient | null,
  lat: number | undefined,
  lng: number | undefined,
  limit: number,
): Promise<PopularCityPlace[]> {
  if (!db) return seedPlaces(limit, lat, lng);

  const activity = await aggregateActivity(db);

  // Score + optional proximity boost, then take a generous top slice.
  // Guard against junk city strings from free-text profile fields ("san",
  // "idk", one-letter typos): require a plausible name or a strong signal.
  const scored = [...activity.values()]
    .filter((c) => normalizeLocationName(c.name).length >= 4 || c.score >= 5)
    .map((c) => {
      let s = c.score;
      if (lat != null && lng != null && c.lat != null && c.lng != null) {
        const d = haversineKm(lat, lng, c.lat, c.lng);
        s *= 1 + 0.6 * Math.max(0, 1 - d / 400); // boost within ~400 km
      }
      return { ...c, score: s };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 2);

  // Resolve through the canonical registry (also backfills coords over time).
  // Variants of one location ("New York" / "New York, USA") share a canonical
  // id — collapse them, keeping the most complete entry and summing scores.
  const resolved: PopularCityPlace[] = [];
  const byCanonical = new Map<string, PopularCityPlace>();
  for (const c of scored) {
    if (resolved.length >= limit) break;
    const res = await resolveCanonicalLocation(db, {
      id: `activity-${normalizeLocationName(c.name)}`,
      type: "city",
      name: c.name,
      displayName: c.country ? `${c.name}, ${c.country}` : c.name,
      city: c.name,
      country: c.country,
      lat: c.lat,
      lng: c.lng,
    });
    const merged = res.canonical;
    const entry = toPlace(
      merged.name ?? c.name,
      merged.country ?? c.country,
      merged.countryCode ?? null,
      merged.lat ?? c.lat,
      merged.lng ?? c.lng,
      res.canonicalId,
      c.score,
    );
    if (res.canonicalId && byCanonical.has(res.canonicalId)) {
      const prev = byCanonical.get(res.canonicalId)!;
      prev.activityScore = Math.round((prev.activityScore + entry.activityScore) * 10) / 10;
      if (!prev.country && entry.country) {
        // Later variant carries richer data — adopt its display fields.
        prev.name = entry.name;
        prev.displayName = entry.displayName;
        prev.country = entry.country;
        prev.countryCode = entry.countryCode;
        if (prev.lat == null) { prev.lat = entry.lat; prev.lng = entry.lng; }
      }
      continue;
    }
    if (res.canonicalId) byCanonical.set(res.canonicalId, entry);
    resolved.push(entry);
  }

  // Top-up with seeds the activity data didn't already produce.
  if (resolved.length < limit) {
    const have = new Set(resolved.map((p) => cityKey(p.name, p.country)));
    for (const s of SEED_CITIES) {
      if (resolved.length >= limit) break;
      if (have.has(cityKey(s.name, s.country))) continue;
      const res = await resolveCanonicalLocation(db, {
        id: `seed-${normalizeLocationName(s.name)}`,
        type: "city",
        name: s.name,
        displayName: `${s.name}, ${s.country}`,
        city: s.name,
        country: s.country,
        countryCode: s.countryCode,
        lat: s.lat,
        lng: s.lng,
      });
      // Same canonical location already listed from activity ("Cebu" vs seed
      // "Cebu City") — enrich the existing entry instead of duplicating it.
      if (res.canonicalId && byCanonical.has(res.canonicalId)) {
        const prev = byCanonical.get(res.canonicalId)!;
        if (!prev.country) {
          prev.name = s.name;
          prev.displayName = `${s.name}, ${s.country}`;
          prev.country = s.country;
          prev.countryCode = s.countryCode;
          if (prev.lat == null) { prev.lat = s.lat; prev.lng = s.lng; }
        }
        have.add(cityKey(s.name, s.country));
        continue;
      }
      const entry = toPlace(s.name, s.country, s.countryCode, s.lat, s.lng, res.canonicalId, 0);
      if (res.canonicalId) byCanonical.set(res.canonicalId, entry);
      resolved.push(entry);
      have.add(cityKey(s.name, s.country));
    }
  }

  return sortByProximity(resolved, lat, lng).slice(0, limit);
}
