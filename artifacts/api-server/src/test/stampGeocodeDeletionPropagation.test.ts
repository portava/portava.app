/**
 * Geocode DELETE propagation — stale-entry eviction on other instances.
 *
 * When an admin deletes a geocode-cache row via DELETE /admin/geocode-cache/:city_key,
 * the handler writes a soft-delete tombstone (deleted_at = now()) and calls
 * evictGeocodeCacheKey() to clear the local in-memory entry immediately.
 * Other instances may still have a warm (positive) entry for that city and
 * will keep serving it until one of two mechanisms fires:
 *
 *   a) On-request probe (evictIfDbCorrected): the next geocodeCityCountry call
 *      for that city after the correction-check interval fires a DB probe,
 *      finds deleted_at set, and evicts the stale entry.
 *
 *   b) Background sweep: every 5 minutes the sweep queries deleted_at >= since,
 *      evicts in-memory entries for all tombstoned cities, and hard-deletes the
 *      tombstone rows — without waiting for any request to arrive for that city.
 *
 * These tests confirm:
 *   1. Path (a): on-request probe evicts when deleted_at is found.
 *   2. Path (a): a transient DB error does NOT evict (network blip ≠ deletion).
 *   3. Path (a): after eviction a fresh Nominatim lookup is made (not stale served).
 *   4. Hard-deleted rows (no deleted_at column) are invisible to the sweep —
 *      the on-request probe remains the only mechanism for that case.
 *   5. Path (b): sweep evicts a tombstoned city and cleans up the tombstone row.
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

/**
 * Supabase client that returns `row` for maybySingle() — or null when row is
 * null (deleted / not found).  Supports the probe path (maybySingle) and the
 * sweep path (then on a select chain), both returning empty by default.
 */
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
        not() { return chain; },
        async maybySingle() {
          opts.onCall?.();
          if (opts.isError) {
            return { data: null, error: { message: "connection refused" } };
          }
          return { data: row, error: null };
        },
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
        not() { return chain; },
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

/**
 * Build a sweep-path client that returns tombstoned rows on the second query
 * (deleted_at pass) and empty on the first (corrected_at pass).
 * Tracks the city_key list passed to the cleanup hard-delete call.
 */
function makeTombstoneSweepClient(
  tombstonedRows: Array<{ city_key: string }>,
  onCleanupDelete?: (keys: string[]) => void,
): SupabaseClient {
  let sweepQueryCount = 0;
  return {
    from(_table: string) {
      let isDelete = false;
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        gte() { return chain; },
        not() { return chain; },
        delete() { isDelete = true; return chain; },
        in(_col: string, keys: string[]) {
          onCleanupDelete?.(keys);
          return chain;
        },
        then(resolve: (v: any) => void) {
          if (isDelete) {
            resolve({ error: null });
            return;
          }
          const q = sweepQueryCount++;
          if (q === 0) {
            // First sweep pass: corrected_at — nothing to evict
            resolve({ data: [], error: null });
          } else {
            // Second sweep pass: deleted_at — return the tombstoned rows
            resolve({ data: tombstonedRows, error: null });
          }
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("geocode DELETE cross-instance propagation", () => {
  it("evicts a stale entry when the on-request probe finds deleted_at set (tombstoned row)", async () => {
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

    // Phase 1: DB has the live row — initial warm-up uses DB cache directly.
    const { client, switchToDeleted, getCallCount } = makePhasedDbClient({
      country: "Japan",
      country_code: "JP",
      corrected_at: null,
      deleted_at: null,
    });
    _setGeocodeDbClientForTests(client);

    const first = await geocodeCityCountry("Tokyo");
    assert.equal(first?.countryCode, "JP", "pre-condition: initial load returns JP");
    // Should have loaded from DB cache without calling Nominatim.
    assert.equal(nominatimCalls, 0, "no Nominatim call when DB cache hits");

    // Phase 2: Simulate soft-delete on another instance — deleted_at is now set.
    switchToDeleted();

    // Before the check interval elapses the probe must NOT fire.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS - 1_000);
    const beforeInterval = await geocodeCityCountry("Tokyo");
    assert.equal(beforeInterval?.countryCode, "JP", "stale entry still served before interval");
    assert.equal(nominatimCalls, 0, "no re-resolve before interval");

    // Advance past the correction-check interval — probe fires, finds deleted_at, evicts.
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
      makeFixedDbClient({ country: "Japan", country_code: "JP", corrected_at: null, deleted_at: null }),
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
      deleted_at: null,
    });
    _setGeocodeDbClientForTests(client);

    await geocodeCityCountry("Seoul");
    assert.equal(nominatimResults.length, 0, "DB cache hit — no Nominatim call");

    // Admin soft-deletes the row on another instance.
    switchToDeleted();

    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const result = await geocodeCityCountry("Seoul");
    assert.equal(nominatimResults.length, 1, "Nominatim called exactly once after eviction");
    assert.equal(result?.countryCode, "KR",
      "result is still KR — re-resolved fresh from Nominatim");
  });

  // ── Null-result (Nominatim-down) path after admin deletion ───────────────────

  it("caches null for 6 hours when Nominatim is down after deletion-eviction — does NOT write null to DB", async () => {
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    mockNow(T0);

    let nominatimCalls = 0;
    let upsertCalls = 0;

    // Nominatim is down — simulated as a network error throw.
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      throw new Error("network_error");
    });

    // Phase 1: DB has the row — warm-up loads from DB cache.
    const { client, switchToDeleted } = makePhasedDbClient({
      country: "France",
      country_code: "FR",
      corrected_at: null,
    });

    // Wrap the client to count upsert (writeDbCache) calls.
    const trackingClient = {
      from(table: string) {
        const inner = (client as any).from(table);
        return {
          ...inner,
          select() { return this; },
          eq() { return this; },
          gte() { return this; },
          async maybeSingle() { return inner.maybeSingle(); },
          upsert() {
            upsertCalls++;
            return Promise.resolve({ error: null });
          },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(trackingClient);

    const first = await geocodeCityCountry("Paris");
    assert.equal(first?.countryCode, "FR", "pre-condition: DB cache hit returns FR");
    assert.equal(nominatimCalls, 0, "no Nominatim call on DB cache hit");
    assert.equal(upsertCalls, 0, "no writeDbCache on DB cache hit");

    // Admin deletes the row — next probe will find it gone.
    switchToDeleted();

    // Advance past the correction-check interval — probe fires, row is gone, evict.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const afterDeletion = await geocodeCityCountry("Paris");

    assert.equal(afterDeletion, null,
      "null is returned because Nominatim is down after deletion-eviction");
    assert.equal(nominatimCalls, 1, "Nominatim was attempted exactly once");
    assert.equal(upsertCalls, 0,
      "writeDbCache must NOT be called for a null (negative) result — DB row was intentionally deleted");

    // The null result is cached for 6 hours.  A second request within the
    // window should serve the cached null without hitting Nominatim again.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000 + NEGATIVE_TTL_MS - 1_000);
    const withinTtl = await geocodeCityCountry("Paris");
    assert.equal(withinTtl, null, "null is still returned within the 6-hour negative TTL");
    assert.equal(nominatimCalls, 1, "Nominatim not called again within the negative TTL window");
    assert.equal(upsertCalls, 0, "writeDbCache still never called during the negative TTL window");
  });

  it("returns null from cache for a second request within the 6-hour window — no crash, no infinite loop", async () => {
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      throw new Error("nominatim_503");
    });

    const { client, switchToDeleted } = makePhasedDbClient({
      country: "Italy",
      country_code: "IT",
      corrected_at: null,
    });
    _setGeocodeDbClientForTests(client);

    // Warm-up from DB.
    await geocodeCityCountry("Rome");

    switchToDeleted();

    // Trigger eviction and first null-result (Nominatim down).
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);
    const first = await geocodeCityCountry("Rome");
    assert.equal(first, null, "first post-eviction call returns null");
    assert.equal(nominatimCalls, 1, "Nominatim attempted once");

    // Immediately request again — should serve the cached null, not call Nominatim again.
    const second = await geocodeCityCountry("Rome");
    assert.equal(second, null, "second request within window returns null from cache");
    assert.equal(nominatimCalls, 1,
      "Nominatim not called a second time — null is served from the in-memory negative cache");

    // Halfway through the TTL — still cached null.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000 + Math.floor(NEGATIVE_TTL_MS / 2));
    const midTtl = await geocodeCityCountry("Rome");
    assert.equal(midTtl, null, "null still served halfway through the TTL");
    assert.equal(nominatimCalls, 1, "still no additional Nominatim call mid-TTL");
  });

  it("retries Nominatim after the 6-hour negative TTL expires — not stuck null forever", async () => {
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    mockNow(T0);

    let nominatimCalls = 0;
    let nominatimShouldSucceed = false;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      if (nominatimShouldSucceed) {
        return {
          ok: true,
          json: async () => [{ address: { country_code: "es", country: "Spain" } }],
        };
      }
      throw new Error("nominatim_down");
    });

    const { client, switchToDeleted } = makePhasedDbClient({
      country: "Spain",
      country_code: "ES",
      corrected_at: null,
    });
    _setGeocodeDbClientForTests(client);

    // Warm-up from DB.
    await geocodeCityCountry("Barcelona");

    switchToDeleted();

    // Evict + first Nominatim attempt (fails → 6-hour negative cache).
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);
    const firstNull = await geocodeCityCountry("Barcelona");
    assert.equal(firstNull, null, "null after deletion when Nominatim is down");
    assert.equal(nominatimCalls, 1, "one Nominatim attempt");

    // Advance to just after the 6-hour TTL — cache entry is expired.
    // Nominatim is now back up.
    nominatimShouldSucceed = true;
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000 + NEGATIVE_TTL_MS + 1_000);

    const afterTtl = await geocodeCityCountry("Barcelona");
    assert.equal(afterTtl?.countryCode, "ES",
      "geocoder retries Nominatim after the 6-hour negative TTL and resolves successfully");
    assert.equal(nominatimCalls, 2, "Nominatim called again after the TTL expired");
  });

it("sweep does NOT evict a hard-deleted city — the on-request probe handles rows with no deleted_at tombstone", async () => {
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
      makeFixedDbClient({ country: "Germany", country_code: "DE", corrected_at: null, deleted_at: null }),
    );
    const first = await geocodeCityCountry("Berlin");
    assert.equal(first?.countryCode, "DE");

    // Sweep DB returns empty results for both passes: the hard-deleted row has
    // neither corrected_at nor deleted_at visible to the sweep query.
    const sweepClient: SupabaseClient = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache");
        const chain: any = {
          select() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          then(resolve: (v: any) => void) {
            // No rows returned for either sweep pass — hard-deleted row is invisible.
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(sweepClient);

    await _runCorrectionSweepForTests();

    // Sweep found nothing — cache entry should still be in memory.
    // (For hard-deleted rows, eviction only happens via the on-request probe.)
    const afterSweep = await geocodeCityCountry("Berlin");
    assert.equal(afterSweep?.countryCode, "DE",
      "sweep cannot detect hard-deleted rows — stale entry remains after sweep");
    assert.equal(nominatimCalls, 0,
      "no re-resolve after sweep; on-request probe is needed for hard-deleted rows");
  });

  it("PUT correction after soft-delete is read by the geocoder — sweep does not remove the corrected row", async () => {
    // Regression guard: the PUT handler must set deleted_at: null so the corrected
    // row is never skipped by readDbCache or hard-deleted by the tombstone sweep.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "pt", country: "Portugal" } }],
      };
    });

    // Step 1 — tombstoned row (state immediately after admin DELETE, before sweep).
    // readDbCache must skip it and fall through to Nominatim.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({
        country: "Spain",
        country_code: "ES",
        corrected_at: null,
        deleted_at: new Date(T0 - 1_000).toISOString(),
      }),
    );
    const tombstonedResult = await geocodeCityCountry("Madrid");
    assert.equal(tombstonedResult?.countryCode, "PT",
      "tombstoned row is skipped — geocoder fell through to Nominatim");
    assert.equal(nominatimCalls, 1, "Nominatim called because tombstoned row was skipped");

    // Clear the cache so the next call hits the DB fresh.
    _clearCountryGeocodeCache();
    nominatimCalls = 0;

    // Step 2 — corrected row after PUT (deleted_at: null).
    // readDbCache must return the corrected result, not skip it.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({
        country: "Portugal",
        country_code: "PT",
        corrected_at: new Date(T0).toISOString(),
        deleted_at: null, // PUT cleared the tombstone
      }),
    );
    const correctedResult = await geocodeCityCountry("Madrid");
    assert.equal(correctedResult?.countryCode, "PT",
      "revived row (deleted_at: null) is served from the DB — not skipped");
    assert.equal(nominatimCalls, 0,
      "no Nominatim call — corrected DB row hit directly");

    // Step 3 — sweep must NOT evict the corrected entry (deleted_at is null).
    const cleanedUpKeys: string[][] = [];
    _setGeocodeDbClientForTests(
      makeTombstoneSweepClient([], (keys) => { cleanedUpKeys.push(keys); }),
    );
    await _runCorrectionSweepForTests();
    assert.equal(cleanedUpKeys.length, 0,
      "sweep found no tombstones — corrected row not hard-deleted");

    // Cache entry still serves PT after the sweep.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Portugal", country_code: "PT", corrected_at: new Date(T0).toISOString(), deleted_at: null }),
    );
    const afterSweep = await geocodeCityCountry("Madrid");
    assert.equal(afterSweep?.countryCode, "PT",
      "geocoder still returns PT after sweep — entry was not evicted");
  });

  it("sweep evicts a tombstoned city and cleans up the tombstone row within one cycle", async () => {
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

    // Phase 1: seed the in-memory cache via a DB load.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Germany", country_code: "DE", corrected_at: null, deleted_at: null }),
    );
    const first = await geocodeCityCountry("Berlin");
    assert.equal(first?.countryCode, "DE", "pre-condition: initial load returns DE");
    assert.equal(nominatimCalls, 0, "DB cache hit — no Nominatim call during seed");

    // Phase 2: switch to a sweep client that reports "berlin" as tombstoned.
    // The sweep should evict the in-memory entry and hard-delete the tombstone.
    const cleanedUpKeys: string[][] = [];
    const sweepClient = makeTombstoneSweepClient(
      [{ city_key: "berlin" }],
      (keys) => { cleanedUpKeys.push(keys); },
    );
    _setGeocodeDbClientForTests(sweepClient);

    await _runCorrectionSweepForTests();

    // Phase 3: verify the sweep evicted the entry.
    // Switch to a null DB client so the next geocodeCityCountry falls through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const afterSweep = await geocodeCityCountry("Berlin");

    assert.equal(nominatimCalls, 1,
      "Nominatim called once — sweep eviction forced a fresh lookup");
    assert.equal(afterSweep?.countryCode, "DE",
      "fresh Nominatim lookup still returns DE");
    assert.equal(cleanedUpKeys.length, 1,
      "sweep issued exactly one cleanup hard-delete call");
    assert.deepEqual(cleanedUpKeys[0], ["berlin"],
      "sweep cleaned up the correct city_key tombstone");
  });

  it("tombstone hard-delete is guarded by deleted_at IS NOT NULL — a row revived before the DELETE survives", async () => {
    // Regression guard for a race condition: the sweep SELECTs tombstoned rows,
    // then hard-DELETEs them. Between those two operations an admin PUT can
    // clear deleted_at (reviving the row). Without a guard the DELETE would
    // remove the now-live corrected row.
    //
    // This test verifies the DELETE chain includes
    //   .not("deleted_at", "is", null)
    // so only rows that are still tombstoned at DELETE-time are removed.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let deleteNotCol: string | undefined;
    let deleteNotFilter: string | undefined;
    let deleteNotVal: string | undefined;

    let sweepQueryCount = 0;
    const sweepClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not(col: string, filter: string, val: string) {
            if (isDelete) {
              deleteNotCol = col;
              deleteNotFilter = filter;
              deleteNotVal = val;
            }
            return chain;
          },
          delete() { isDelete = true; return chain; },
          in(_col: string, _keys: string[]) { return chain; },
          then(resolve: (v: any) => void) {
            if (isDelete) { resolve({ error: null }); return; }
            const q = sweepQueryCount++;
            if (q === 0) {
              resolve({ data: [], error: null }); // pass 1: corrected_at
            } else {
              resolve({ data: [{ city_key: "oslo" }], error: null }); // pass 2: deleted_at
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(sweepClient);
    await _runCorrectionSweepForTests();

    assert.equal(
      deleteNotCol,
      "deleted_at",
      "hard-delete must chain .not() on the deleted_at column to guard against revived rows",
    );
    assert.equal(
      deleteNotFilter,
      "is",
      "hard-delete .not() guard must use the 'is' filter",
    );
    assert.equal(
      deleteNotVal,
      null,
      "hard-delete .not() guard must check for null — only tombstoned rows should be removed",
    );
  });
});
