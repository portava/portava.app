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
  persistFailed?: boolean;      // true when the best-effort DB persist failed — retried on the next warm hit
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
  const since = new Date(Date.now() - CORRECTION_SWEEP_WINDOW_MS).toISOString();

  // Pass 1 — admin corrections (corrected_at updated on existing rows).
  try {
    const { data, error } = await sc
      .from(DB_CACHE_TABLE)
      .select("city_key, corrected_at")
      .gte("corrected_at", since);
    if (!error && data) {
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
    }
  } catch (e: any) {
    logEvent("stamp.country_geocode.sweep_pass1_error", { error: e?.message ?? String(e) });
  }

  // Pass 2 — tombstoned rows (soft-deleted by the admin DELETE handler).
  // Deleted rows have no corrected_at so they're invisible to pass 1.
  // The sweep evicts in-memory entries for tombstoned cities, then hard-deletes
  // the tombstone rows so they don't accumulate indefinitely.
  try {
    const { data: tombstoned, error: tombErr } = await sc
      .from(DB_CACHE_TABLE)
      .select("city_key")
      .gte("deleted_at", since)
      .not("deleted_at", "is", null);
    if (!tombErr && tombstoned && (tombstoned as any[]).length > 0) {
      const keys = (tombstoned as Array<{ city_key: string }>).map((r) => r.city_key);
      for (const key of keys) {
        _cache.delete(key);
        _pending.delete(key);
        logEvent("stamp.country_geocode.sweep_tombstone_evicted", { city_key: key });
      }
      // Hard-delete the tombstone rows so they don't re-appear in future sweeps.
      // Guard: only delete rows that are still tombstoned (deleted_at IS NOT NULL).
      // A concurrent PUT can revive a row between this sweep's select and delete;
      // adding the guard prevents the sweep from discarding a freshly-revived row.
      await sc.from(DB_CACHE_TABLE).delete().in("city_key", keys).not("deleted_at", "is", null);
    }
  } catch (e: any) {
    // Best-effort — transient DB errors never abort the sweep, but they must
    // be visible to operators.
    logEvent("stamp.country_geocode.sweep_pass2_error", { error: e?.message ?? String(e) });
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
 * This setter is independent of the DB-client override — calling it does NOT
 * reset _dbClientOverride.  Use _setGeocodeDbClientForTests separately to
 * control the persistent cache client.
 */
export function _setGeocodeFetchForTests(f: FetchLike | null): void {
  _fetchImpl = f ?? ((url, init) => fetch(url, init));
  _throttleDisabled = f != null;
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

/** Test-only: read a single cache entry by city key (after normCity). */
export function _getGeocodeCacheEntryForTests(cityKey: string): CacheEntry | undefined {
  return _cache.get(cityKey);
}

/** Test-only: return the current number of entries in the in-memory cache. */
export function _getCacheSizeForTests(): number {
  return _cache.size;
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
      .select("corrected_at, deleted_at")
      .eq("city_key", key)
      .maybeSingle();
    if (error) return false; // Transient DB error — keep the cache, retry next interval.
    if (!data || (data as any).deleted_at) {
      // Row is gone or soft-deleted (tombstoned by the admin DELETE handler on
      // another instance).  Evict so the next geocodeCityCountry call
      // re-resolves from a fresh Nominatim lookup instead of serving the
      // now-invalid stale entry indefinitely.
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
      .select("country, country_code, corrected_at, deleted_at")
      .eq("city_key", key)
      .maybeSingle();
    // Treat tombstoned rows (deleted_at set) the same as "not found" so a
    // soft-deleted row is never served as a cached positive result.
    if (error || !data || (data as any).deleted_at) return null;
    return shapeResult((data as any).country_code, (data as any).country);
  } catch {
    return null;
  }
}

/**
 * Persist a positive result to the DB cache. Best-effort — never throws.
 *
 * Outcomes:
 *   - "ok":         the upsert succeeded.
 *   - "failed":     the upsert (or its pre-check) hit a DB error — callers mark
 *                   the in-memory entry for a later retry.
 *   - "tombstoned": the row carries a tombstone (deleted_at) written AT or
 *                   AFTER `startedAtMs` — i.e. an admin DELETE landed on
 *                   another instance while this geocode was in flight. The
 *                   persist is skipped entirely so the upsert (which clears
 *                   deleted_at) cannot revive the freshly-deleted row. Callers
 *                   should evict their local entry and must NOT schedule a
 *                   retry.
 *
 * Cross-instance revival guard: the local _pending check in geocodeCityCountry
 * only protects against a DELETE handled by the SAME instance (the handler
 * calls evictGeocodeCacheKey locally). A DELETE on another instance writes the
 * tombstone straight to the shared DB, so we re-check deleted_at here, just
 * before the upsert. Tombstones OLDER than the geocode start are legitimately
 * cleared — the fresh geocode supersedes a deletion that happened before it
 * began (readDbCache already treated the tombstoned row as a miss).
 *
 * Residual window: a tombstone written between this pre-check SELECT and the
 * upsert can still be clobbered. That window is a single network round-trip
 * (milliseconds) — vs. the multi-second Nominatim flight it replaces — and is
 * accepted as best-effort; the admin can re-issue the DELETE.
 */
type WriteDbCacheOutcome = "ok" | "failed" | "tombstoned";

async function writeDbCache(key: string, result: GeocodedCountry, startedAtMs: number): Promise<WriteDbCacheOutcome> {
  const sc = dbClient();
  if (!sc) return "failed";
  try {
    // Set when the pre-upsert tombstone re-check errors/throws: if the upsert
    // then succeeds, a mid-flight tombstone may have been silently revived —
    // emit a structured event so operators know to re-issue the DELETE.
    let precheckError: string | null = null;
    // Pre-upsert tombstone re-check (see doc comment above).
    try {
      const { data: existing, error: checkErr } = await sc
        .from(DB_CACHE_TABLE)
        .select("deleted_at")
        .eq("city_key", key)
        .maybeSingle();
      if (!checkErr && existing && (existing as any).deleted_at) {
        const tombstonedAt = new Date((existing as any).deleted_at).getTime();
        if (tombstonedAt >= startedAtMs) {
          logEvent("stamp.country_geocode.persist_skipped_tombstoned", {
            city_key: key,
            deleted_at: (existing as any).deleted_at,
          });
          return "tombstoned";
        }
      }
      if (checkErr) precheckError = checkErr.message ?? String(checkErr);
      // Pre-check DB error: fall through to the upsert (best-effort — a
      // transient read failure must not block persistence; the upsert itself
      // will surface any real outage).
      //
      // Accepted trade-off: in the rare reader/writer split-brain where this
      // SELECT errors but the upsert still succeeds, a tombstone written
      // mid-flight IS revived (deleted_at cleared). In the common full-outage
      // case the upsert fails too, the entry is flagged persistFailed, and the
      // retry's pre-check sees the tombstone once reads recover. Pinned by
      // stampGeocodeDeletionPropagation.test.ts ("pre-check SELECT error"
      // suite) — flip those assertions deliberately if this is ever tightened.
    } catch (precheckEx: any) {
      // Same: best-effort pre-check only.
      precheckError = precheckEx?.message ?? String(precheckEx);
    }
    const { error } = await sc.from(DB_CACHE_TABLE).upsert(
      {
        city_key: key,
        country: result.country,
        country_code: result.countryCode,
        updated_at: new Date().toISOString(),
        // Clear any soft-delete tombstone written by a prior admin deletion —
        // this row now has a fresh geocode result and must be treated as live.
        deleted_at: null,
        // IMPORTANT: corrected_at is deliberately ABSENT from this payload.
        // Do NOT add `corrected_at: null` here (even to mirror the
        // deleted_at line above) — the upsert must leave any existing
        // admin-correction timestamp untouched. Wiping it would silently
        // erase admin corrections on the next re-geocode and break the
        // on-request probe and the background sweep's ordering logic.
      },
      { onConflict: "city_key" },
    );
    if (error) {
      logEvent("stamp.country_geocode.persist_failed", { city_key: key, error: error.message });
      return "failed";
    }
    if (precheckError !== null) {
      // The pre-check couldn't verify tombstone state but the upsert succeeded:
      // a mid-flight admin deletion may have been revived (deleted_at cleared).
      // Surface it so operators know to re-issue the DELETE if one was in flight.
      logEvent("stamp.country_geocode.persist_precheck_errored", {
        city_key: key,
        error: precheckError,
      });
    }
    return "ok";
  } catch (e: any) {
    logEvent("stamp.country_geocode.persist_failed", { city_key: key, error: e?.message ?? String(e) });
    return "failed";
  }
}

/**
 * Retry a previously-failed DB persist for a warm in-memory entry.
 * Best-effort: never throws and never affects the value returned to the caller.
 * The persistFailed flag is cleared optimistically before awaiting so a
 * concurrent warm hit doesn't fire a duplicate upsert; it is restored when the
 * retry fails again so the next warm hit retries once more.
 */
async function retryPersist(key: string, cached: CacheEntry): Promise<void> {
  if (!cached.result) return;
  const current = _cache.get(key);
  if (!current || !current.persistFailed || current.result !== cached.result) return;
  _cache.set(key, { ...current, persistFailed: false });
  // startedAtMs: the entry's writtenAt is when this result was resolved — any
  // tombstone written after that point is a newer admin deletion and must win.
  const outcome = await writeDbCache(key, cached.result, cached.writtenAt);
  if (outcome === "failed") {
    const after = _cache.get(key);
    // Only re-flag if the entry is still the same result (not evicted/replaced).
    if (after && after.result === cached.result) {
      _cache.set(key, { ...after, persistFailed: true });
    }
  } else if (outcome === "tombstoned") {
    // An admin deletion superseded this result — drop the local entry too and
    // never retry the persist (retrying would only re-hit the tombstone).
    const after = _cache.get(key);
    if (after && after.result === cached.result) {
      _cache.delete(key);
      _pending.delete(key);
    }
  } else {
    logEvent("stamp.country_geocode.persist_retried", { city_key: key });
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
      // A prior best-effort DB persist failed — retry it on this warm hit so
      // the positive result isn't lost on restart. Never affects the returned
      // result (retryPersist swallows all errors).
      if (cached.persistFailed) {
        await retryPersist(key, cached);
      }
      const lastCheck = cached.correctionCheckedAt ?? cached.writtenAt;
      if (Date.now() - lastCheck >= CORRECTION_CHECK_INTERVAL_MS) {
        // Optimistically bump correctionCheckedAt BEFORE awaiting the probe.
        // A concurrent caller arriving at the same warm entry will re-read the
        // cache, see the freshly-bumped timestamp, and skip the probe entirely —
        // preventing two simultaneous DB round-trips for the same key.
        _cache.set(key, { ...cached, correctionCheckedAt: Date.now() });
        const evicted = await evictIfDbCorrected(key, cached);
        if (!evicted) {
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

  // `let p!` (definite-assignment assertion) allows self-reference inside the
  // async body.  At runtime `p` is always assigned before any `await` resolves,
  // so `_pending.get(key) === p` is safe.
  let p!: Promise<GeocodedCountry | null>;
  // Captured before any await: writeDbCache uses this to distinguish tombstones
  // written BEFORE the geocode began (legitimately superseded — clear them)
  // from tombstones written WHILE it was in flight (a concurrent admin DELETE
  // on another instance — never clobber those).
  const startedAtMs = Date.now();
  p = (async () => {
    try {
      // Second-level persistent cache — positive results survive restarts.
      const persisted = await readDbCache(key);
      if (persisted) {
        // Guard: skip the cache write if evictGeocodeCacheKey ran while we
        // were awaiting readDbCache — the promise is no longer ours to commit.
        if (_pending.get(key) === p) {
          if (_cache.size >= MAX_CACHE_SIZE) {
            const firstKey = _cache.keys().next().value;
            if (firstKey !== undefined) _cache.delete(firstKey);
          }
          const now = Date.now();
          _cache.set(key, { result: persisted, expiresAt: now + POSITIVE_TTL_MS, writtenAt: now, correctionCheckedAt: now });
        }
        return persisted;
      }

      const result = await forwardGeocodeCity(city);
      // Guard: skip the cache write if evictGeocodeCacheKey ran while the
      // Nominatim fetch was in-flight.  Without this check a null result from
      // a tombstoned/unresolvable city would re-poison the cache entry that
      // the PUT revival just cleared, causing the next caller to receive null
      // instead of re-resolving from the freshly-written DB row.
      if (_pending.get(key) === p) {
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
      }
      if (result) {
        // Guard: skip the DB persist when evictGeocodeCacheKey ran while the
        // geocode was in flight (e.g. an admin DELETE tombstoned the row and
        // evicted the key).  writeDbCache upserts deleted_at: null, so writing
        // here would silently REVIVE the row the admin just deleted — on every
        // instance, since the DB cache is shared.  The in-memory guard above
        // only protects this instance's memory cache; this one protects the DB.
        if (_pending.get(key) === p) {
          const outcome = await writeDbCache(key, result, startedAtMs);
          if (outcome === "failed") {
            // Mark the entry so the next warm hit re-attempts the persist —
            // otherwise the result lives only in memory and is lost on restart.
            const entry = _cache.get(key);
            if (entry && entry.result === result) {
              _cache.set(key, { ...entry, persistFailed: true });
            }
          } else if (outcome === "tombstoned") {
            // A cross-instance admin DELETE landed while the geocode was in
            // flight. The DB persist was skipped (tombstone preserved); also
            // drop the local in-memory entry written above so this instance
            // doesn't keep serving a result the admin just deleted. No retry:
            // persistFailed stays unset.
            const entry = _cache.get(key);
            if (entry && entry.result === result) {
              _cache.delete(key);
            }
          }
        } else {
          logEvent("stamp.country_geocode.persist_skipped_evicted", { city_key: key });
        }
        logEvent("stamp.country_geocode.resolved", { city, country_code: result.countryCode });
      } else {
        logEvent("stamp.country_geocode.unresolved", { city });
      }
      return result;
    } catch (e: any) {
      // Transient failure — cache negatively for a short while so a flapping
      // provider doesn't get hammered, but retry after the TTL.
      // Guard: skip the write if we were evicted while the request was in-flight.
      if (_pending.get(key) === p) {
        // Same LRU cap guard as the success path: trim the oldest entry only
        // when the cache is at or over MAX_CACHE_SIZE, so a negative re-seed
        // never grows the cache past the cap.
        if (_cache.size >= MAX_CACHE_SIZE) {
          const firstKey = _cache.keys().next().value;
          if (firstKey !== undefined) _cache.delete(firstKey);
        }
        const now = Date.now();
        _cache.set(key, { result: null, expiresAt: now + NEGATIVE_TTL_MS, writtenAt: now });
      }
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
