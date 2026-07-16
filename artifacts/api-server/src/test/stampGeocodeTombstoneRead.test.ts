/**
 * Tombstoned geocode-cache rows must be treated as a miss — not served as live data.
 *
 * Migration 0141 adds `deleted_at` to `city_country_geocode_cache`.  The
 * `readDbCache` function must return null (not-found) for any row whose
 * `deleted_at` is non-null, so a soft-deleted entry is never served to clients
 * while the background sweep collects it.
 *
 * Run: node --import tsx/esm --test src/test/stampGeocodeTombstoneRead.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  geocodeCityCountry,
  _setGeocodeFetchForTests,
  _setGeocodeDbClientForTests,
  _clearCountryGeocodeCache,
} from "../lib/stamps/countryGeocoder.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a DB client that returns a fixed row from maybeSingle(). */
function makeFixedDbClient(
  row: Record<string, unknown> | null,
): SupabaseClient {
  return {
    from(_table: string) {
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        gte() { return chain; },
        not() { return chain; },
        async maybeSingle() {
          return { data: row, error: null };
        },
        upsert() { return Promise.resolve({ error: null }); },
        then(resolve: (v: any) => void) {
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

/** Nominatim fake that always errors — geocoder must NOT be reached. */
function forbiddenNominatim() {
  return async (_url: string) => {
    throw new Error("geocoder should not be called when testing DB cache read");
  };
}

/** Nominatim fake that returns a known result for a city. */
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

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  _clearCountryGeocodeCache();
  _setGeocodeFetchForTests(null);
  _setGeocodeDbClientForTests(undefined);
});

afterEach(() => {
  _clearCountryGeocodeCache();
  _setGeocodeFetchForTests(null);
  _setGeocodeDbClientForTests(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("readDbCache tombstone handling", () => {
  it("returns null for a row with deleted_at set — not the stored country data", async () => {
    // Arrange: DB has a geocode row that has been soft-deleted (deleted_at set).
    const tombstonedRow = {
      city_key: "reykjavik",
      country: "Iceland",
      country_code: "IS",
      corrected_at: null,
      deleted_at: new Date().toISOString(), // <-- tombstone
    };
    // IMPORTANT: set fetch BEFORE DB client — _setGeocodeFetchForTests resets
    // _dbClientOverride to null when a non-null fetch is provided, so the DB
    // override must be applied after the fetch override.
    // Geocoder must not be reached if the tombstone check itself is broken and
    // tries to return data; forbid it to make accidental pass-throughs obvious.
    _setGeocodeFetchForTests(forbiddenNominatim());
    _setGeocodeDbClientForTests(makeFixedDbClient(tombstonedRow));

    // Act: clear the in-memory cache so readDbCache is actually called.
    _clearCountryGeocodeCache();
    // geocodeCityCountry falls back to the DB when the in-memory cache is cold.
    // With a forbidden Nominatim, any non-null result must have come from the DB.
    // The tombstoned row must be treated as not-found, so geocodeCityCountry
    // hits Nominatim — which throws — and the error must cause null to be
    // returned (not the tombstoned country data).
    //
    // We verify this by confirming the result is null.  If readDbCache served
    // the tombstoned row the result would be { country: "Iceland", countryCode: "IS" }.
    let result: Awaited<ReturnType<typeof geocodeCityCountry>>;
    try {
      result = await geocodeCityCountry("Reykjavik");
    } catch {
      // A throw from the forbidden Nominatim propagating up is also acceptable
      // — it proves the tombstoned row was NOT returned directly.
      result = null;
    }

    assert.equal(
      result,
      null,
      "expected null for a tombstoned row; got live data instead",
    );
  });

  it("returns live data for a non-tombstoned row (deleted_at IS NULL)", async () => {
    // Sanity-check: a row without deleted_at must still be served normally.
    const liveRow = {
      city_key: "tallinn",
      country: "Estonia",
      country_code: "EE",
      corrected_at: null,
      deleted_at: null, // <-- live row
    };
    // Set fetch BEFORE DB client (see first test for explanation).
    _setGeocodeFetchForTests(forbiddenNominatim());
    _setGeocodeDbClientForTests(makeFixedDbClient(liveRow));
    _clearCountryGeocodeCache();

    const result = await geocodeCityCountry("Tallinn");

    assert.deepEqual(
      result,
      { country: "Estonia", countryCode: "EE" },
      "expected live data for a non-tombstoned row",
    );
  });

  it("returns null for a row with deleted_at set — even when deleted_at is far in the past", async () => {
    // A row that was tombstoned long ago (before the sweep ran) must still be
    // treated as a miss, not as live data.
    const oldTombstone = {
      city_key: "plovdiv",
      country: "Bulgaria",
      country_code: "BG",
      corrected_at: null,
      deleted_at: new Date(Date.now() - 10 * 60 * 1_000).toISOString(), // 10 min ago
    };
    // Set fetch BEFORE DB client (see first test for explanation).
    _setGeocodeFetchForTests(forbiddenNominatim());
    _setGeocodeDbClientForTests(makeFixedDbClient(oldTombstone));
    _clearCountryGeocodeCache();

    let result: Awaited<ReturnType<typeof geocodeCityCountry>>;
    try {
      result = await geocodeCityCountry("Plovdiv");
    } catch {
      result = null;
    }

    assert.equal(
      result,
      null,
      "expected null for an old tombstone; got live data instead",
    );
  });

  it("does NOT populate the in-memory cache when the DB row is tombstoned", async () => {
    // If readDbCache returns null for a tombstoned row, the in-memory cache
    // must also not be populated with live data.  Subsequent calls must
    // re-probe (or hit the geocoder), not serve a stale positive from memory.
    const tombstonedRow = {
      city_key: "dubrovnik",
      country: "Croatia",
      country_code: "HR",
      corrected_at: null,
      deleted_at: new Date().toISOString(),
    };

    let dbReadCount = 0;
    const countingClient = {
      from(_table: string) {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            dbReadCount++;
            return { data: tombstonedRow, error: null };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) { resolve({ data: [], error: null }); },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    // Set fetch BEFORE DB client (see first test for explanation).
    _setGeocodeFetchForTests(fakeNominatim({}));
    _setGeocodeDbClientForTests(countingClient);
    _clearCountryGeocodeCache();

    // Two calls to the same city.
    await geocodeCityCountry("Dubrovnik");
    await geocodeCityCountry("Dubrovnik");

    // The second call must not have been served from a warm positive in-memory
    // entry.  If it was, dbReadCount would be 1; if the tombstone caused a miss
    // each time, the DB will have been read at least once per non-cached call.
    // We simply confirm neither call returned live data (Croatia).
    // (In-memory negative caching after a miss is acceptable — the key property
    //  is that the tombstoned country is never returned.)
    const third = await geocodeCityCountry("Dubrovnik");
    assert.equal(
      third,
      null,
      "expected null; tombstoned row must never populate a positive in-memory entry",
    );
  });
});
