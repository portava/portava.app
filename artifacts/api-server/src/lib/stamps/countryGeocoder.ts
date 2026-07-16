/**
 * countryGeocoder — geocoding-backed country resolution for stamp locations.
 *
 * Extends the static countryLookup with real geocoding so *any* city — not
 * just the ~250 well-known ones — can resolve to a real ISO 3166-1 alpha-2
 * country code:
 *
 *   1. Static lookup first (free, instant) via resolveCountry().
 *   2. Reverse geocoding when lat/lng are available (existing geocodingService).
 *   3. Forward geocoding of the city name via Nominatim search.
 *
 * Rules:
 *   - Never guesses: a failed/ambiguous geocode leaves the code as "XX".
 *   - Rate-limited: 1.1 s minimum gap between Nominatim forward calls.
 *   - Cached: positive results for 30 days, failures for 6 hours, plus
 *     in-flight deduplication so concurrent awards for the same city make
 *     one request.
 *   - Every geocode outcome is logged as a structured JSON event.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCountry, countryNameFromCode, type ResolvedCountry } from "./countryLookup.js";
import { reverseGeocode } from "../../services/geocodingService.js";
import { getServiceClient } from "../supabase.js";

export interface GeocodedCountry {
  country: string;
  countryCode: string; // real ISO alpha-2, uppercase
}

const VALID_CODE_RE = /^[A-Za-z]{2}$/;

const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;       // 6 hours

interface CacheEntry {
  result: GeocodedCountry | null;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();
const _pending = new Map<string, Promise<GeocodedCountry | null>>();
const MAX_CACHE_SIZE = 2_000;

// ── Rate-limit (Nominatim fair use: 1 req/sec) ───────────────────────────────
let _lastCallAt = 0;
const MIN_GAP_MS = 1_100;
let _throttleChain: Promise<void> = Promise.resolve();
let _throttleDisabled = false; // tests only

function throttled(): Promise<void> {
  if (_throttleDisabled) return Promise.resolve();
  // Serialise waits so concurrent callers each get their own 1.1 s slot.
  const next = _throttleChain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - _lastCallAt);
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    _lastCallAt = Date.now();
  });
  _throttleChain = next.catch(() => {});
  return next;
}

// ── Test hooks ────────────────────────────────────────────────────────────────
type FetchLike = (url: string, init?: any) => Promise<any>;
let _fetchImpl: FetchLike = (url, init) => fetch(url, init);

/**
 * Test-only: swap the fetch implementation (also disables the throttle gap).
 * Setting a fake fetch also detaches the persistent DB cache from the real
 * Supabase client (tests must opt back in via _setGeocodeDbClientForTests).
 */
export function _setGeocodeFetchForTests(f: FetchLike | null): void {
  _fetchImpl = f ?? ((url, init) => fetch(url, init));
  _throttleDisabled = f != null;
  _dbClientOverride = f != null ? null : undefined;
}

/** Test-only: inject a fake Supabase client for the persistent cache (null disables it). */
export function _setGeocodeDbClientForTests(client: SupabaseClient | null | undefined): void {
  _dbClientOverride = client;
}

/** Test-only: clear cached geocode results. */
export function _clearCountryGeocodeCache(): void {
  _cache.clear();
  _pending.clear();
  _lastCallAt = 0;
}

// ── Persistent (DB) cache ─────────────────────────────────────────────────────
//
// Second-level cache in the `city_country_geocode_cache` table so positive
// results survive server restarts. Only POSITIVE results are persisted —
// negative/failed geocodes stay in the short-TTL in-memory cache so transient
// failures retry. All DB access is best-effort: any error falls through to
// the normal geocode path.

const DB_CACHE_TABLE = "city_country_geocode_cache";

let _dbClientOverride: SupabaseClient | null | undefined; // undefined = use real client

function dbClient(): SupabaseClient | null {
  if (_dbClientOverride !== undefined) return _dbClientOverride;
  try {
    return getServiceClient();
  } catch {
    return null;
  }
}

async function readDbCache(key: string): Promise<GeocodedCountry | null> {
  const sc = dbClient();
  if (!sc) return null;
  try {
    const { data, error } = await sc
      .from(DB_CACHE_TABLE)
      .select("country, country_code")
      .eq("city_key", key)
      .maybeSingle();
    if (error || !data) return null;
    return shapeResult((data as any).country_code, (data as any).country);
  } catch {
    return null;
  }
}

async function writeDbCache(key: string, result: GeocodedCountry): Promise<void> {
  const sc = dbClient();
  if (!sc) return;
  try {
    const { error } = await sc.from(DB_CACHE_TABLE).upsert(
      {
        city_key: key,
        country: result.country,
        country_code: result.countryCode,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "city_key" },
    );
    if (error) {
      logEvent("stamp.country_geocode.persist_failed", { city_key: key, error: error.message });
    }
  } catch (e: any) {
    logEvent("stamp.country_geocode.persist_failed", { city_key: key, error: e?.message ?? String(e) });
  }
}

// ── Core forward geocode ──────────────────────────────────────────────────────

function normCity(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function shapeResult(countryCodeRaw: string | null | undefined, countryRaw: string | null | undefined): GeocodedCountry | null {
  if (!countryCodeRaw || !VALID_CODE_RE.test(countryCodeRaw.trim())) return null;
  const countryCode = countryCodeRaw.trim().toUpperCase();
  // Prefer the canonical English name from the static table; fall back to the
  // provider's name (may be localised) so the country column is never empty.
  const country = countryNameFromCode(countryCode) ?? countryRaw ?? countryCode;
  return { country, countryCode };
}

async function forwardGeocodeCity(city: string): Promise<GeocodedCountry | null> {
  await throttled();
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}` +
    `&format=json&limit=1&addressdetails=1&featureType=settlement`;
  const res = await _fetchImpl(url, {
    headers: { "User-Agent": "TravelBuddyApp/1.0 (stamp country resolution)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`nominatim_${res.status}`);
  const data: any = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  if (!first) return null;
  const addr = first.address ?? {};
  return shapeResult(addr.country_code, addr.country);
}

/**
 * Resolve the country of an arbitrary city via forward geocoding.
 * Cached + rate-limited + deduplicated. Returns null when the city cannot be
 * confidently resolved (never guesses).
 */
export async function geocodeCityCountry(city: string): Promise<GeocodedCountry | null> {
  const key = normCity(city);
  if (!key) return null;

  const cached = _cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  const existing = _pending.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      // Second-level persistent cache — positive results survive restarts.
      const persisted = await readDbCache(key);
      if (persisted) {
        if (_cache.size >= MAX_CACHE_SIZE) {
          const firstKey = _cache.keys().next().value;
          if (firstKey !== undefined) _cache.delete(firstKey);
        }
        _cache.set(key, { result: persisted, expiresAt: Date.now() + POSITIVE_TTL_MS });
        return persisted;
      }

      const result = await forwardGeocodeCity(city);
      if (_cache.size >= MAX_CACHE_SIZE) {
        const firstKey = _cache.keys().next().value;
        if (firstKey !== undefined) _cache.delete(firstKey);
      }
      _cache.set(key, {
        result,
        expiresAt: Date.now() + (result ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
      });
      if (result) {
        await writeDbCache(key, result);
        logEvent("stamp.country_geocode.resolved", { city, country_code: result.countryCode });
      } else {
        logEvent("stamp.country_geocode.unresolved", { city });
      }
      return result;
    } catch (e: any) {
      // Transient failure — cache negatively for a short while so a flapping
      // provider doesn't get hammered, but retry after the TTL.
      _cache.set(key, { result: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
      logEvent("stamp.country_geocode.failed", { city, error: e?.message ?? String(e) });
      return null;
    } finally {
      _pending.delete(key);
    }
  })();

  _pending.set(key, p);
  return p;
}

// ── Combined resolution ───────────────────────────────────────────────────────

/**
 * Best-effort country resolution: static lookup first, then geocoding.
 *
 * Priority: explicit code → country-name map → well-known-city map →
 * reverse geocode (lat/lng) → forward geocode (city) → "XX".
 *
 * Never throws and never guesses — geocoding failures leave "XX".
 */
export async function resolveCountryWithGeocoding(input: {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
}): Promise<ResolvedCountry> {
  const staticResult = resolveCountry(input);
  if (staticResult.countryCode !== "XX") return staticResult;

  // Reverse geocode when coordinates exist — most precise signal.
  if (typeof input.lat === "number" && typeof input.lng === "number") {
    try {
      const place = await reverseGeocode(input.lat, input.lng);
      const shaped = shapeResult(place.countryCode, place.country);
      if (shaped) {
        logEvent("stamp.country_geocode.resolved", {
          lat: input.lat, lng: input.lng, country_code: shaped.countryCode, via: "reverse",
        });
        return { country: input.country ?? shaped.country, countryCode: shaped.countryCode };
      }
    } catch (e: any) {
      logEvent("stamp.country_geocode.failed", {
        lat: input.lat, lng: input.lng, via: "reverse", error: e?.message ?? String(e),
      });
    }
  }

  // Forward geocode the city name.
  if (input.city) {
    const geo = await geocodeCityCountry(input.city);
    if (geo) return { country: input.country ?? geo.country, countryCode: geo.countryCode };
  }

  return staticResult; // still XX — visible via the logged events above
}
