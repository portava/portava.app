/**
 * Geocode DELETE propagation — stale-entry eviction on other instances.
 *
 * When an admin deletes a geocode-cache row via DELETE /admin/geocode-cache/:city_key,
 * the row is removed from the DB.  The instance that handled the request calls
 * evictGeocodeCacheKey() immediately, so its own in-memory cache is cleared.
 * Other instances, however, may still have a warm (positive) entry for that
 * city and will keep serving it until:
 *
 *   a) The 30-day TTL expires, or
 *   b) The periodic correction-check probe fires and discovers the row is gone.
 *
 * These tests confirm path (b): once the CORRECTION_CHECK_INTERVAL_MS window
 * elapses, the next geocodeCityCountry call probes the DB, finds the row
 * missing, evicts the stale entry, and re-resolves from Nominatim — without
 * waiting for a full 30-day TTL.
 *
 * They also verify that a plain DB *error* (transient, not a clean "not found")
 * does NOT evict, so a flaky connection never incorrectly invalidates the cache.
 *
 * The background sweep is also tested: it cannot detect deletions on its own
 * (it queries corrected_at, and deleted rows have no corrected_at) — the
 * on-request probe is the sole mechanism for cross-instance deletion propagation.
 *
 * Run: node --import tsx/esm --test src/test/stampGeocodeDeletionPropagation.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  geocodeCityCountry,
  _setGeocodeFetchForTests,
  _setGeocodeDbClientForTests,
  _clearCountryGeocodeCache,
  _runCorrectionSweepForTests,
} from "../lib/stamps/countryGeocoder.js";

// ── Timing control ────────────────────────────────────────────────────────────

// Must match the private constant in countryGeocoder.ts.
const CORRECTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;

let _realDateNow: () => number;
let _fakeNow: number | null = null;

function mockNow(t: number): void {
  _fakeNow = t;
}

beforeEach(() => {
  _fakeNow = null;
  _realDateNow = Date.now;
  Date.now = () => (_fakeNow !== null ? _fakeNow : _realDateNow());
  _clearCountryGeocodeCache();
});

afterEach(() => {
  Date.now = _realDateNow;
  _fakeNow = null;
  _clearCountryGeocodeCache();
  _setGeocodeFetchForTests(null);
  _setGeocodeDbClientForTests(undefined);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal Nominatim fake that returns a fixed result for normalised city names. */
function fakeNominatim(
  results: Record<string, { country_code: string; country: string } | null>,
) {
  return async (url: string) => {
    const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "").toLowerCase();
    const hit = results[q] ?? null;
    return {
      ok: true,
      json: async () =>
        hit ? [{ address: { country_code: hit.country_code, country: hit.country } }] : [],
    };
  };
}

/** Supabase client that returns `row` for maybeSingle() — or null when row is null (deleted). */
function makeFixedDbClient(
  row: Record<string, unknown> | null,
  opts: { isError?: boolean; onCall?: () => void } = {},
): SupabaseClient {
  return {
    from(table: string) {
      assert.equal(table, "city_country_geocode_cache", "unexpected table");
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        gte() { return chain; },
        async maybeSingle() {
          opts.onCall?.();
          if (opts.isError) {
            return { data: null, error: { message: "connection refused" } };
          }
          return { data: row, error: null };
        },
        upsert() { return Promise.resolve({ error: null }); },
        // sweep path uses .then() on a select chain
        then(resolve: (v: any) => void) {
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

/**
 * Build a two-phase DB client:
 *   - During the warm-up phase (initial readDbCache calls) it returns `initialRow`.
 *   - Once `switchToDeleted()` is called, maybySingle() returns null (row deleted).
 */
function makePhasedDbClient(initialRow: Record<string, unknown>) {
  let deleted = false;
  let callCount = 0;
  const client: SupabaseClient = {
    from(table: string) {
      assert.equal(table, "city_country_geocode_cache", "unexpected table");
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        gte() { return chain; },
        async maybySingle() { return { data: null, error: null }; },
        async maybeSingle() {
          callCount++;
          if (deleted) return { data: null, error: null };
          return { data: initialRow, error: null };
        },
        upsert() { return Promise.resolve({ error: null }); },
        then(resolve: (v: any) => void) {
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return {
    client,
    switchToDeleted() { deleted = true; },
    getCallCount() { return callCount; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("geocode DELETE cross-instance propagation", () => {
  it("evicts a stale entry when the on-request probe finds the DB row has been deleted", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async (url: string) => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
      };
    });

    // Phase 1: DB has the row — initial warm-up uses DB cache directly.
    const { client, switchToDeleted, getCallCount } = makePhasedDbClient({
      country: "Japan",
      country_code: "JP",
      corrected_at: null,
    });
    _setGeocodeDbClientForTests(client);

    const first = await geocodeCityCountry("Tokyo");
    assert.equal(first?.countryCode, "JP", "pre-condition: initial load returns JP");
    // Should have loaded from DB cache without calling Nominatim.
    assert.equal(nominatimCalls, 0, "no Nominatim call when DB cache hits");

    // Phase 2: Simulate DELETE on another instance — the DB row is now gone.
    switchToDeleted();

    // Before the check interval elapses the probe must NOT fire.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS - 1_000);
    const beforeInterval = await geocodeCityCountry("Tokyo");
    assert.equal(beforeInterval?.countryCode, "JP", "stale entry still served before interval");
    assert.equal(nominatimCalls, 0, "no re-resolve before interval");

    // Advance past the correction-check interval — probe fires, finds row gone, evicts.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);
    const afterDeletion = await geocodeCityCountry("Tokyo");

    // The stale entry was evicted; the geocoder re-resolved via Nominatim.
    assert.equal(nominatimCalls, 1, "Nominatim called once after deletion-eviction");
    assert.equal(afterDeletion?.countryCode, "JP",
      "result is still JP (Nominatim agrees), but it was re-resolved fresh");
  });

  it("does NOT evict when the probe returns a DB error (transient failure, not a clean delete)", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return { ok: true, json: async () => [] };
    });

    // Initial load from DB cache.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Japan", country_code: "JP", corrected_at: null }),
    );
    const first = await geocodeCityCountry("Osaka");
    assert.equal(first?.countryCode, "JP");

    // Switch to an error-returning client.
    let probeCalls = 0;
    _setGeocodeDbClientForTests(
      makeFixedDbClient(null, {
        isError: true,
        onCall: () => { probeCalls++; },
      }),
    );

    // Advance past the interval so the probe fires.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const second = await geocodeCityCountry("Osaka");
    assert.equal(second?.countryCode, "JP",
      "cached value should be kept when the probe hits a DB error");
    assert.equal(nominatimCalls, 0,
      "Nominatim must not be called when the DB error leaves the cache intact");
    assert.equal(probeCalls, 1, "probe was attempted exactly once");
  });

  it("re-resolves from Nominatim after deletion, not from a stale in-memory result", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    const nominatimResults: string[] = [];
    _setGeocodeFetchForTests(async () => {
      // After deletion the fresh Nominatim result is still the same country —
      // what matters is that the geocoder performed a fresh lookup.
      nominatimResults.push("called");
      return {
        ok: true,
        json: async () => [{ address: { country_code: "kr", country: "South Korea" } }],
      };
    });

    // DB has the row for the warm-up.
    const { client, switchToDeleted } = makePhasedDbClient({
      country: "South Korea",
      country_code: "KR",
      corrected_at: null,
    });
    _setGeocodeDbClientForTests(client);

    await geocodeCityCountry("Seoul");
    assert.equal(nominatimResults.length, 0, "DB cache hit — no Nominatim call");

    // Admin deletes the row on another instance.
    switchToDeleted();

    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const result = await geocodeCityCountry("Seoul");
    assert.equal(nominatimResults.length, 1, "Nominatim called exactly once after eviction");
    assert.equal(result?.countryCode, "KR",
      "result is still KR — re-resolved fresh from Nominatim");
  });

  it("sweep does NOT evict a deleted city — deletion propagation relies solely on the on-request probe", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "de", country: "Germany" } }],
      };
    });

    // Seed the in-memory cache via a DB load.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Germany", country_code: "DE", corrected_at: null }),
    );
    const first = await geocodeCityCountry("Berlin");
    assert.equal(first?.countryCode, "DE");

    // Sweep DB returns empty results (deleted row has no corrected_at, so it
    // doesn't appear in the sweep query at all).
    const sweepClient: SupabaseClient = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache");
        const chain: any = {
          select() { return chain; },
          gte() { return chain; },
          then(resolve: (v: any) => void) {
            // No rows returned — the deleted row isn't visible to the sweep.
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(sweepClient);

    await _runCorrectionSweepForTests();

    // Sweep found nothing — cache entry should still be in memory.
    // (Deletion propagation only happens via the on-request probe.)
    const afterSweep = await geocodeCityCountry("Berlin");
    assert.equal(afterSweep?.countryCode, "DE",
      "sweep cannot detect deletions — stale entry is still in memory after sweep");
    assert.equal(nominatimCalls, 0,
      "no re-resolve after sweep; on-request probe is needed to detect the deletion");
  });
});
