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
// How often to re-probe the DB for corrected_at on a warm in-memory hit.
// Limits DB load while still bounding how long a correction takes to propagate
// to instances that didn't handle the admin request.
const CORRECTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

interface CacheEntry {
  result: GeocodedCountry | null;
  expiresAt: number;
  writtenAt: number;           // epoch ms when this entry was placed in the cache
  correctionCheckedAt?: number; // epoch ms of the last corrected_at probe for this key
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

// ── Background correction sweep ───────────────────────────────────────────────
//
// Periodically queries the DB for rows that were admin-corrected in the last
// hour and evicts any stale in-memory entries whose writtenAt predates the
// correction.  This ensures corrections propagate to instances that haven't
// handled a geocode request for the affected city recently — not only to the
// instance that received the admin PUT/DELETE.
//
// The sweep is NOT started automatically; call startCorrectionSweep() from the
// server entry-point after the app is listening.  Tests run the sweep
// synchronously via _runCorrectionSweepForTests() without touching timers.

const CORRECTION_SWEEP_WINDOW_MS = 60 * 60 * 1_000; // look back 1 hour

async function runCorrectionSweep(): Promise<void> {
  const sc = dbClient();
  if (!sc) return;
  try {
    const since = new Date(Date.now() - CORRECTION_SWEEP_WINDOW_MS).toISOString();
    const { data, error } = await sc
      .from(DB_CACHE_TABLE)
      .select("city_key, corrected_at")
      .gte("corrected_at", since);
    if (error || !data) return;
    for (const row of data as Array<{ city_key: string; corrected_at: string }>) {
      const entry = _cache.get(row.city_key);
      if (!entry) continue;
      const correctedMs = new Date(row.corrected_at).getTime();
      if (entry.writtenAt < correctedMs) {
        _cache.delete(row.city_key);
        _pending.delete(row.city_key);
        logEvent("stamp.country_geocode.sweep_evicted", { city_key: row.city_key });
      }
    }
  } catch {
    // Best-effort — any transient DB error is silently swallowed so the sweep
    // never crashes the process.
  }
}

let _sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background correction sweep.
 * Returns a stop function that clears the interval — call it on server shutdown.
 * Safe to call multiple times: a second call replaces the previous interval.
 */
export function startCorrectionSweep(intervalMs = 5 * 60 * 1_000): () => void {
  if (_sweepTimer !== null) clearInterval(_sweepTimer);
  _sweepTimer = setInterval(() => { runCorrectionSweep().catch(() => {}); }, intervalMs);
  // setInterval refs the event loop — unref so it doesn't prevent a clean exit
  // when the server decides to shut down without explicitly calling stop.
  if (typeof (_sweepTimer as any).unref === "function") (_sweepTimer as any).unref();
  return function stopCorrectionSweep() {
    if (_sweepTimer !== null) {
      clearInterval(_sweepTimer);
      _sweepTimer = null;
    }
  };
}

/** Test-only: run one sweep cycle synchronously (no timer involved). */
export async function _runCorrectionSweepForTests(): Promise<void> {
  return runCorrectionSweep();
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

/**
 * Test-only: set correctionCheckedAt to 0 for a given key so the next
 * geocodeCityCountry call immediately re-probes the DB for corrected_at,
 * without waiting for CORRECTION_CHECK_INTERVAL_MS to elapse naturally.
 */
export function _backdateGeocodeCacheEntryForTests(cityKey: string): void {
  const entry = _cache.get(cityKey);
  if (entry) _cache.set(cityKey, { ...entry, correctionCheckedAt: 0 });
}

/**
 * Evict a single city_key from the in-memory cache.
 * Called by the admin correction endpoint so the next geocode re-resolves
 * using the updated DB row (or a fresh Nominatim lookup if the row was deleted).
 */
export function evictGeocodeCacheKey(cityKey: string): void {
  _cache.delete(cityKey);
  _pending.delete(cityKey);
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

/**
 * Probe the DB for corrected_at on a single key and evict the in-memory entry
 * if it pre-dates the correction.  Returns true when the caller should re-resolve
 * (entry was evicted), false when the cached value is still valid.
 * Best-effort: returns false on any DB error so the cached value is kept.
 */
async function evictIfDbCorrected(key: string, entry: CacheEntry): Promise<boolean> {
  const sc = dbClient();
  if (!sc) return false;
  try {
    const { data, error } = await sc
      .from(DB_CACHE_TABLE)
      .select("corrected_at")
      .eq("city_key", key)
      .maybeSingle();
    if (error) return false; // Transient DB error — keep the cache, retry next interval.
    if (!data) {
      // Row is gone (admin DELETE on another instance).  Evict so the next
      // geocodeCityCountry call re-resolves from a fresh Nominatim lookup
      // instead of serving the now-invalid stale entry indefinitely.
      _cache.delete(key);
      _pending.delete(key);
      logEvent("stamp.country_geocode.deletion_evicted", { city_key: key });
      return true;
    }
    const correctedAt = (data as any).corrected_at;
    if (!correctedAt) return false;
    if (new Date(correctedAt).getTime() > entry.writtenAt) {
      _cache.delete(key);
      _pending.delete(key);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function readDbCache(key: string): Promise<GeocodedCountry | null> {
  const sc = dbClient();
  if (!sc) return null;
  try {
    const { data, error } = await sc
      .from(DB_CACHE_TABLE)
      .select("country, country_code, corrected_at")
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
  if (cached && Date.now() < cached.expiresAt) {
    // Periodically probe the DB for admin corrections written on other instances.
    // Only positive entries are ever admin-corrected; skip the probe for null entries.
    if (cached.result != null) {
      const lastCheck = cached.correctionCheckedAt ?? cached.writtenAt;
      if (Date.now() - lastCheck >= CORRECTION_CHECK_INTERVAL_MS) {
        const evicted = await evictIfDbCorrected(key, cached);
        if (!evicted) {
          // Still fresh — bump the checked timestamp so we don't re-probe for another interval.
          _cache.set(key, { ...cached, correctionCheckedAt: Date.now() });
          return cached.result;
        }
        // Entry was evicted — fall through to re-resolve from the DB.
      } else {
        return cached.result;
      }
    } else {
      return cached.result;
    }
  }

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
        const now = Date.now();
        _cache.set(key, { result: persisted, expiresAt: now + POSITIVE_TTL_MS, writtenAt: now, correctionCheckedAt: now });
        return persisted;
      }

      const result = await forwardGeocodeCity(city);
      if (_cache.size >= MAX_CACHE_SIZE) {
        const firstKey = _cache.keys().next().value;
        if (firstKey !== undefined) _cache.delete(firstKey);
      }
      const now = Date.now();
      _cache.set(key, {
        result,
        expiresAt: now + (result ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
        writtenAt: now,
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
      const now = Date.now();
      _cache.set(key, { result: null, expiresAt: now + NEGATIVE_TTL_MS, writtenAt: now });
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
