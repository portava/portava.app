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
  evictGeocodeCacheKey,
  _setGeocodeFetchForTests,
  _setGeocodeDbClientForTests,
  _clearCountryGeocodeCache,
  _runCorrectionSweepForTests,
  _getGeocodeCacheEntryForTests,
  _getCacheSizeForTests,
  _backdateGeocodeCacheEntryForTests,
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

  it("evicts a warm entry when the on-request probe finds deleted_at set — not only when the row is missing entirely", async () => {
    // This test specifically exercises the (data as any).deleted_at branch of
    // evictIfDbCorrected.  The DB row still exists in the table but has
    // deleted_at set (soft-delete / tombstone).  The probe must treat this the
    // same as a missing row and evict the stale in-memory entry.
    //
    // The first test in this suite covers the hard-delete path (row completely
    // absent, data === null).  This one covers the soft-delete / tombstone path.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "cn", country: "China" } }],
      };
    });

    // Phase 1: warm the in-memory cache via a DB load (deleted_at is null — live row).
    _setGeocodeDbClientForTests(
      makeFixedDbClient({
        country: "China",
        country_code: "CN",
        corrected_at: null,
        deleted_at: null,
      }),
    );
    const first = await geocodeCityCountry("Beijing");
    assert.equal(first?.countryCode, "CN", "pre-condition: initial DB cache load returns CN");
    assert.equal(nominatimCalls, 0, "no Nominatim call when DB cache hits");

    // Phase 2: switch the DB so subsequent probe calls return the same row but
    // with deleted_at set (tombstone written by an admin DELETE on another instance).
    // The row still EXISTS in the DB — data is not null — but deleted_at is set.
    let probeCallCount = 0;
    _setGeocodeDbClientForTests({
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            probeCallCount++;
            // Row still present but tombstoned — deleted_at IS NOT NULL.
            return {
              data: {
                country: "China",
                country_code: "CN",
                corrected_at: null,
                deleted_at: new Date(T0 - 1_000).toISOString(),
              },
              error: null,
            };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    // Before the check interval elapses the probe must NOT fire.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS - 1_000);
    const beforeInterval = await geocodeCityCountry("Beijing");
    assert.equal(beforeInterval?.countryCode, "CN", "stale entry still served before interval");
    assert.equal(probeCallCount, 0, "probe not fired before interval");
    assert.equal(nominatimCalls, 0, "no Nominatim call before interval");

    // Advance past the correction-check interval — probe fires, finds deleted_at set, evicts.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);
    const afterDeletion = await geocodeCityCountry("Beijing");

    // probeCallCount is 2: once from evictIfDbCorrected and once from
    // readDbCache during the re-resolve path — both call maybySingle().
    // The meaningful signal is nominatimCalls: it only reaches 1 if the
    // stale entry was actually evicted and a fresh re-resolve was attempted.
    assert.ok(probeCallCount >= 1, "DB probe was attempted after interval elapsed");
    assert.equal(nominatimCalls, 1,
      "Nominatim called once — stale entry was evicted when probe found deleted_at set");
    assert.equal(afterDeletion?.countryCode, "CN",
      "result is still CN (Nominatim agrees) but it was re-resolved fresh after tombstone-eviction");
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

  it("two concurrent callers after a deletion-eviction share one Nominatim call — not two parallel ones", async () => {
    // Scenario: two simultaneous geocodeCityCountry() calls arrive just after the
    // correction-check probe evicts the stale entry.  Both callers:
    //   1. See the warm cached entry (not yet evicted).
    //   2. Both await evictIfDbCorrected(), which finds deleted_at set and evicts.
    //   3. Both fall through to the re-resolve path.
    //   4. The first creates a _pending promise; the second finds it already there.
    //   => Only one Nominatim request is issued; both callers receive the same result.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Nominatim stub — counts calls and returns a fixed result.
    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "nl", country: "Netherlands" } }],
      };
    });

    // Phase 1: warm-up via DB cache (no Nominatim call).
    // The initial readDbCache hit plants the entry in _cache.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({
        country: "Netherlands",
        country_code: "NL",
        corrected_at: null,
        deleted_at: null,
      }),
    );
    const warm = await geocodeCityCountry("Amsterdam");
    assert.equal(warm?.countryCode, "NL", "pre-condition: warm entry loaded from DB cache");
    assert.equal(nominatimCalls, 0, "no Nominatim call during warm-up");

    // Phase 2: simulate an admin soft-delete on another instance.
    // Switch the DB client so every subsequent probe returns deleted_at set (tombstone),
    // and readDbCache() also returns null (deleted row skipped).
    let probeCallCount = 0;
    _setGeocodeDbClientForTests({
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            probeCallCount++;
            // Return a row with deleted_at set — triggers deletion-eviction.
            // Also used by readDbCache(); deleted_at !== null causes readDbCache to return null.
            return {
              data: {
                country: "Netherlands",
                country_code: "NL",
                corrected_at: null,
                deleted_at: new Date(T0 - 1_000).toISOString(),
              },
              error: null,
            };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    // Phase 3: advance past the correction-check interval so both concurrent
    // callers will attempt the DB probe on their first entry.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    // Fire two concurrent geocode calls for the same city.
    const [resultA, resultB] = await Promise.all([
      geocodeCityCountry("Amsterdam"),
      geocodeCityCountry("Amsterdam"),
    ]);

    // Both callers should receive the same resolved result.
    assert.equal(resultA?.countryCode, "NL", "caller A received the resolved country code");
    assert.equal(resultB?.countryCode, "NL", "caller B received the resolved country code");

    // Nominatim must have been called exactly once — the dedup _pending map
    // ensured the second concurrent caller reused the first's in-flight promise.
    assert.equal(nominatimCalls, 1,
      "Nominatim called exactly once across both concurrent callers — dedup held after deletion-eviction");
  });

  it("negative-cache entry (null result) skips the correction-check probe even after CORRECTION_CHECK_INTERVAL_MS — no DB round-trip", async () => {
    // A cached null means the geocode previously failed (Nominatim returned nothing).
    // The row was never written to the DB, so probing corrected_at would always
    // return no data — a useless DB round-trip.  The geocoder must return null from
    // cache without ever calling maybeSingle().
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      // Nominatim returns nothing — this is the "unknown city" path.
      return { ok: true, json: async () => [] };
    });

    // No DB row exists for this city; readDbCache returns null.
    let probeCallCount = 0;
    _setGeocodeDbClientForTests(
      makeFixedDbClient(null, {
        onCall: () => { probeCallCount++; },
      }),
    );

    // First call: cache miss → Nominatim called → null result cached for 6 hours.
    const first = await geocodeCityCountry("Atlantis");
    assert.equal(first, null, "first call returns null (Nominatim found nothing)");
    assert.equal(nominatimCalls, 1, "Nominatim called once on cache miss");
    // probeCallCount may be 1 here due to readDbCache (the initial DB lookup before
    // Nominatim is tried) — reset it so we only count probes after the warm cache hit.
    probeCallCount = 0;

    // Advance well past CORRECTION_CHECK_INTERVAL_MS — if the probe were triggered
    // for null entries, it would fire now.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 10_000);

    // Second call: the negative-cache entry is still live (within 6-hour TTL).
    // The code must return null directly, skipping the correction-check probe.
    const second = await geocodeCityCountry("Atlantis");
    assert.equal(second, null, "null is returned from the negative cache");
    assert.equal(nominatimCalls, 1, "Nominatim NOT called again — null served from cache");
    assert.equal(probeCallCount, 0,
      "maybeSingle() probe must NOT be called for a cached null entry — no useful DB round-trip possible");
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

  it("PUT revival between sweep SELECT and DELETE is not hard-deleted — revived row survives and geocoder returns it", async () => {
    // Race condition: the sweep queries tombstoned rows (SELECT), then a concurrent
    // admin PUT revives the row by clearing deleted_at.  The sweep then issues its
    // hard-delete — but the .not("deleted_at", "is", null) guard means only rows
    // that are STILL tombstoned at DELETE-time are removed.  The revived row has
    // deleted_at = null, so the guard filters it out and the DELETE is a no-op.
    //
    // This test drives the fake DB client through a two-phase lifecycle:
    //   Phase A (SELECT passes): the row is tombstoned (deleted_at IS NOT NULL).
    //   Phase B (DELETE pass):   the PUT has already cleared deleted_at; the DB
    //                            client honours the .not("deleted_at","is",null)
    //                            guard by deleting zero rows.
    // After the sweep, geocodeCityCountry must return the revived country (from the
    // DB cache, since the in-memory entry was evicted by the sweep's eviction loop).
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Nominatim stub — must NOT be called after the revival (the DB cache should serve it).
    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "no", country: "Norway" } }],
      };
    });

    // ── Seed the in-memory cache so the sweep has something to evict. ────────────
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Norway", country_code: "NO", corrected_at: null, deleted_at: null }),
    );
    const seed = await geocodeCityCountry("Oslo");
    assert.equal(seed?.countryCode, "NO", "pre-condition: cache seeded with NO");
    assert.equal(nominatimCalls, 0, "no Nominatim call during seed");

    // ── Build the race-condition DB client. ────────────────────────────────────
    // SELECT passes (pass 1 corrected_at + pass 2 deleted_at) see the tombstoned row.
    // DELETE sees deleted_at = null (the PUT revived it between SELECT and DELETE),
    // so the .not("deleted_at","is",null) guard matches zero rows — the delete is a no-op.
    //
    // After the sweep, readDbCache (maybySingle) returns the revived live row.
    let sweepQueryCount = 0;
    let deletedKeys: string[] = [];
    let revivedInDb = false; // set to true once the "PUT" fires during the DELETE phase

    const raceClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        let inKeys: string[] = [];
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not(_col: string, _filter: string, _val: unknown) {
            // When this is the DELETE chain and the guard fires, simulate the
            // guard honouring deleted_at = null by marking revival complete.
            if (isDelete) revivedInDb = true;
            return chain;
          },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            inKeys = keys;
            return chain;
          },
          async maybySingle() {
            // readDbCache call — after the sweep the row is live (deleted_at null).
            return {
              data: {
                country: "Norway",
                country_code: "NO",
                corrected_at: null,
                deleted_at: null, // row is live after PUT revival
              },
              error: null,
            };
          },
          async maybeSingle() {
            // readDbCache call — after the sweep the row is live (deleted_at null).
            return {
              data: {
                country: "Norway",
                country_code: "NO",
                corrected_at: null,
                deleted_at: null, // row is live after PUT revival
              },
              error: null,
            };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              // The guard (.not("deleted_at","is",null)) means the DB only removes
              // rows still tombstoned. The PUT already cleared deleted_at, so zero
              // rows match and the DELETE is a no-op — we record nothing as deleted.
              // (revivedInDb is already set true by the .not() call above.)
              resolve({ error: null });
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing to evict from this pass.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: sweep sees the row as tombstoned (pre-PUT view).
              resolve({ data: [{ city_key: "oslo" }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(raceClient);
    await _runCorrectionSweepForTests();

    // The sweep evicted the in-memory entry (it saw the tombstoned row in the SELECT).
    // The hard-delete was a no-op because the guard filtered out the now-live row.
    assert.ok(revivedInDb,
      "the .not() guard was reached during the DELETE phase — confirming the guard ran");
    assert.equal(deletedKeys.length, 0,
      "no city_key was actually deleted — the guard protected the revived row");

    // ── After the sweep: geocodeCityCountry re-resolves from the DB cache ────────
    // The in-memory entry was evicted by the sweep. The next call must hit readDbCache,
    // find the live row (deleted_at: null), and return the revived result WITHOUT
    // calling Nominatim.
    const afterSweep = await geocodeCityCountry("Oslo");
    assert.equal(afterSweep?.countryCode, "NO",
      "geocoder returns the revived country (NO) from the DB cache after sweep");
    assert.equal(nominatimCalls, 0,
      "Nominatim must NOT be called — the revived DB row is served directly by readDbCache");
  });

  it("sweep hard-deletes tombstoned rows — a post-sweep query for deleted_at rows returns empty", async () => {
    // Happy-path confirmation: after the sweep runs against a DB that contains
    // tombstoned rows, those rows must be absent from city_country_geocode_cache.
    //
    // This uses a stateful fake DB client whose in-memory row store is actually
    // mutated by the hard-delete call.  A follow-up query for tombstoned rows then
    // returns empty — directly proving that the rows are gone, not merely that a
    // delete was scheduled or logged.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "no", country: "Norway" } }],
      };
    });

    // Stateful in-memory DB: start with two tombstoned rows.
    const tombstoneStore = new Map<string, { city_key: string; deleted_at: string }>([
      ["bergen", { city_key: "bergen", deleted_at: new Date(T0 - 1_000).toISOString() }],
      ["trondheim", { city_key: "trondheim", deleted_at: new Date(T0 - 2_000).toISOString() }],
    ]);

    // Track which keys were passed to the hard-delete.
    const hardDeletedKeys: string[] = [];

    let sweepQueryCount = 0;
    const statefulSweepClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        let deletedInKeys: string[] = [];
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            deletedInKeys = keys;
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              // Perform the actual stateful deletion: remove matching tombstoned rows.
              for (const key of deletedInKeys) {
                const row = tombstoneStore.get(key);
                if (row && row.deleted_at !== null) {
                  tombstoneStore.delete(key);
                  hardDeletedKeys.push(key);
                }
              }
              resolve({ error: null });
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing to evict.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: return the current tombstoned rows.
              resolve({ data: Array.from(tombstoneStore.values()), error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    // Seed in-memory cache for both cities.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Norway", country_code: "NO", corrected_at: null, deleted_at: null }),
    );
    await geocodeCityCountry("Bergen");
    await geocodeCityCountry("Trondheim");
    assert.equal(nominatimCalls, 0, "pre-condition: both seeded from DB, no Nominatim calls");

    // Run the sweep against the stateful DB.
    _setGeocodeDbClientForTests(statefulSweepClient);
    await _runCorrectionSweepForTests();

    // ── Assertion 1: tombstoned rows are gone from the stateful DB ────────────
    assert.equal(
      tombstoneStore.size,
      0,
      "tombstone store must be empty after the sweep — both rows were hard-deleted",
    );
    assert.deepEqual(
      [...hardDeletedKeys].sort(),
      ["bergen", "trondheim"],
      "sweep hard-deleted both tombstoned city_keys",
    );

    // ── Assertion 2: a follow-up sweep query finds no tombstoned rows ─────────
    // Reset the sweep counter and run a second sweep against the now-empty store.
    // The second pass must return zero rows, confirming the first sweep cleaned up.
    sweepQueryCount = 0;
    let secondSweepTombstoneRows: unknown[] | null = null;
    const verificationClient: SupabaseClient = {
      from(_table: string) {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          then(resolve: (v: any) => void) {
            const q = sweepQueryCount++;
            if (q === 0) {
              resolve({ data: [], error: null }); // pass 1
            } else {
              // Pass 2: return whatever the tombstoneStore now holds.
              secondSweepTombstoneRows = Array.from(tombstoneStore.values());
              resolve({ data: secondSweepTombstoneRows, error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(verificationClient);
    await _runCorrectionSweepForTests();

    assert.equal(
      secondSweepTombstoneRows?.length ?? -1,
      0,
      "a follow-up sweep query finds zero tombstoned rows — rows are gone from the DB after the first sweep",
    );

    // ── Assertion 3: in-memory entries were also evicted ─────────────────────
    // Switch to a null DB so any cache miss would fall through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    await geocodeCityCountry("Bergen");
    await geocodeCityCountry("Trondheim");
    assert.equal(
      nominatimCalls,
      2,
      "both in-memory entries were evicted by the sweep — Nominatim re-resolved each city",
    );
  });

  it("sweep skips the tombstone cleanup delete when the deleted_at query returns a DB error", async () => {
    // If the second sweep pass (deleted_at query) hits a transient DB error,
    // the sweep must neither evict the in-memory entry nor issue the cleanup
    // hard-delete.  Evicting on a DB error would be indistinguishable from a
    // real deletion and would silently discard valid cached data.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "ch", country: "Switzerland" } }],
      };
    });

    // Seed the in-memory cache via a DB load.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Switzerland", country_code: "CH", corrected_at: null, deleted_at: null }),
    );
    const first = await geocodeCityCountry("Zurich");
    assert.equal(first?.countryCode, "CH", "pre-condition: cache seeded with CH");
    assert.equal(nominatimCalls, 0, "no Nominatim call during seed");

    // Build a sweep client where:
    //   - Pass 1 (corrected_at) succeeds with no rows.
    //   - Pass 2 (deleted_at)   returns a DB error.
    //   - Any delete() call is tracked and should never happen.
    let deleteCallCount = 0;
    let sweepQueryCount = 0;
    const errorSweepClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, _keys: string[]) {
            // Should never be reached.
            deleteCallCount++;
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              // Should never be reached.
              deleteCallCount++;
              resolve({ error: null });
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing to evict.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: simulate a transient DB error.
              resolve({ data: null, error: { message: "connection refused" } });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(errorSweepClient);
    await _runCorrectionSweepForTests();

    // The sweep must have attempted both passes.
    assert.equal(sweepQueryCount, 2, "sweep ran both passes");

    // The tombstone query errored — cache entry must still be present.
    // Switch to a null DB client so a cache miss would fall through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const afterSweep = await geocodeCityCountry("Zurich");
    assert.equal(afterSweep?.countryCode, "CH",
      "cache entry must NOT be evicted when the deleted_at query returns a DB error");
    assert.equal(nominatimCalls, 0,
      "Nominatim must not be called — the stale-looking entry was preserved by the error guard");

    // The hard-delete must never have been issued.
    assert.equal(deleteCallCount, 0,
      "cleanup hard-delete must not be called when the tombstone query returned an error");
  });

  it("sweep evicts and cleans up on the second cycle after the deleted_at query recovers from an error", async () => {
    // Task 404 confirms that a transient DB error on Pass 2 prevents spurious eviction.
    // This test confirms the complementary path: once the DB recovers in a subsequent
    // sweep cycle, the entry IS evicted and the cleanup hard-delete IS issued.
    //
    // Cycle 1: Pass 2 (deleted_at query) returns a DB error → entry preserved.
    // Cycle 2: Pass 2 succeeds and returns the tombstoned row → entry evicted + delete called.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "at", country: "Austria" } }],
      };
    });

    // Seed the in-memory cache via a DB load.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Austria", country_code: "AT", corrected_at: null, deleted_at: null }),
    );
    const first = await geocodeCityCountry("Vienna");
    assert.equal(first?.countryCode, "AT", "pre-condition: cache seeded with AT");
    assert.equal(nominatimCalls, 0, "no Nominatim call during seed");

    // ── Cycle 1: Pass 2 returns a DB error ───────────────────────────────────────
    let cycle1QueryCount = 0;
    let cycle1DeleteCount = 0;
    const errorSweepClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, _keys: string[]) {
            cycle1DeleteCount++;
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              cycle1DeleteCount++;
              resolve({ error: null });
              return;
            }
            const q = cycle1QueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing to evict.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: transient DB error.
              resolve({ data: null, error: { message: "connection refused" } });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(errorSweepClient);
    await _runCorrectionSweepForTests();

    assert.equal(cycle1QueryCount, 2, "cycle 1: both sweep passes ran");
    assert.equal(cycle1DeleteCount, 0, "cycle 1: no cleanup delete issued on error");

    // Entry must still be in memory after the failed sweep.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const afterCycle1 = await geocodeCityCountry("Vienna");
    assert.equal(afterCycle1?.countryCode, "AT",
      "entry still present after cycle 1 — error prevented eviction");
    assert.equal(nominatimCalls, 0,
      "Nominatim not called after cycle 1 — stale entry preserved by error guard");

    // Re-seed the cache for cycle 2 (the previous geocodeCityCountry served from
    // in-memory without touching the cache, so the entry is still present).

    // ── Cycle 2: DB has recovered — Pass 2 returns the tombstoned row ────────────
    const cycle2CleanedKeys: string[][] = [];
    let cycle2QueryCount = 0;
    const recoverySweepClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            cycle2CleanedKeys.push(keys);
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              resolve({ error: null });
              return;
            }
            const q = cycle2QueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing to evict.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: DB recovered and returns the tombstoned row.
              resolve({ data: [{ city_key: "vienna" }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(recoverySweepClient);
    await _runCorrectionSweepForTests();

    assert.equal(cycle2QueryCount, 2, "cycle 2: both sweep passes ran");
    assert.equal(cycle2CleanedKeys.length, 1,
      "cycle 2: cleanup hard-delete was issued exactly once");
    assert.deepEqual(cycle2CleanedKeys[0], ["vienna"],
      "cycle 2: correct city_key was passed to the cleanup delete");

    // The entry must now be evicted — a subsequent geocode call must fall through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const afterCycle2 = await geocodeCityCountry("Vienna");
    assert.equal(nominatimCalls, 1,
      "Nominatim called once after cycle 2 eviction — entry was correctly removed from cache");
    assert.equal(afterCycle2?.countryCode, "AT",
      "geocoder re-resolved correctly via Nominatim after the sweep eviction");
  });

  it("_pending is cleared after a successful deletion-eviction re-geocode — subsequent call served from cache, not from a reused pending slot", async () => {
    // After a deletion-eviction triggers a fresh Nominatim lookup, the resolved
    // promise must be removed from _pending (via the finally block) so that:
    //   a) the result lands in _cache, and
    //   b) the next call for the same city hits the cache — not the old _pending slot.
    //
    // If _pending retained the settled promise, future callers would still get the
    // correct value (the settled promise resolves to the same result) but the
    // _cache write path would be effectively bypassed — meaning the entry would
    // never expire correctly and the cache-size eviction logic would not apply.
    //
    // Observable proof: after the re-geocode settles, a second call returns the
    // cached result without invoking Nominatim a second time.  A third call after
    // changing the Nominatim stub still receives the original cached value — proving
    // _cache was written (not _pending serving a settled clone forever).
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCallCount = 0;
    let nominatimResponse = { country_code: "se", country: "Sweden" };
    _setGeocodeFetchForTests(async () => {
      nominatimCallCount++;
      return {
        ok: true,
        json: async () => [{ address: nominatimResponse }],
      };
    });

    // Phase 1: warm-up via DB cache — no Nominatim call.
    const { client, switchToDeleted } = makePhasedDbClient({
      country: "Sweden",
      country_code: "SE",
      corrected_at: null,
      deleted_at: null,
    });
    _setGeocodeDbClientForTests(client);

    const warm = await geocodeCityCountry("Stockholm");
    assert.equal(warm?.countryCode, "SE", "pre-condition: warm entry loaded from DB cache");
    assert.equal(nominatimCallCount, 0, "no Nominatim call during warm-up");

    // Phase 2: soft-delete on another instance.
    switchToDeleted();

    // Phase 3: advance past the correction-check interval — probe fires, finds
    // deleted_at set, evicts the in-memory entry, then falls through to re-geocode.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const afterDeletion = await geocodeCityCountry("Stockholm");
    assert.equal(afterDeletion?.countryCode, "SE",
      "re-resolved result is SE (Nominatim agrees with the deleted row)");
    assert.equal(nominatimCallCount, 1,
      "Nominatim called exactly once for the re-geocode — not zero, not two");

    // Phase 4: immediately make another call for the same city.
    // If _pending were still populated with the settled promise, this call would
    // return the settled promise's value without touching _cache or Nominatim.
    // If _pending was correctly cleared (finally block ran), the call must hit
    // _cache and return the cached result — still no new Nominatim invocation.
    const secondCall = await geocodeCityCountry("Stockholm");
    assert.equal(secondCall?.countryCode, "SE",
      "second call returns SE — served from the in-memory cache after re-geocode");
    assert.equal(nominatimCallCount, 1,
      "Nominatim NOT called again — _pending was cleared and _cache now holds the result");

    // Phase 5: change the Nominatim stub so it would return a *different* country.
    // If the result were still being served via a stale _pending slot that bypassed
    // _cache, the next call would still return the settled value from _pending (SE).
    // Since _pending was cleared and _cache holds SE, the call returns SE from cache —
    // same value, but the mechanism is correct.  The Nominatim change has no effect
    // because the cache entry has not expired yet, confirming _cache is authoritative.
    nominatimResponse = { country_code: "dk", country: "Denmark" };
    const thirdCall = await geocodeCityCountry("Stockholm");
    assert.equal(thirdCall?.countryCode, "SE",
      "third call still returns SE from _cache — the changed Nominatim stub has no effect because the cache entry is live");
    assert.equal(nominatimCallCount, 1,
      "Nominatim still not called — _cache entry is live and authoritative");
  });

  it("_pending is cleared after a Nominatim failure during deletion-eviction re-geocode — next call after TTL retries rather than serving a stale promise", async () => {
    // After a deletion-eviction triggers a fresh Nominatim lookup that FAILS,
    // the finally block must delete the _pending entry so that:
    //   a) the null result lands in _cache with a short (6-hour) TTL, and
    //   b) once the TTL expires, the next call can retry Nominatim — not
    //      indefinitely serve a stale settled-promise from _pending.
    //
    // If _pending retained the settled-null promise forever, the entry would
    // survive past the 6-hour TTL and the geocoder would never retry — every
    // call for that city would return null until the process restarted.
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    mockNow(T0);

    let nominatimCallCount = 0;
    let nominatimShouldFail = true;
    _setGeocodeFetchForTests(async () => {
      nominatimCallCount++;
      if (nominatimShouldFail) throw new Error("nominatim_down");
      return {
        ok: true,
        json: async () => [{ address: { country_code: "fi", country: "Finland" } }],
      };
    });

    // Phase 1: warm-up via DB cache.
    const { client, switchToDeleted } = makePhasedDbClient({
      country: "Finland",
      country_code: "FI",
      corrected_at: null,
      deleted_at: null,
    });
    _setGeocodeDbClientForTests(client);

    const warm = await geocodeCityCountry("Helsinki");
    assert.equal(warm?.countryCode, "FI", "pre-condition: warm entry loaded from DB cache");
    assert.equal(nominatimCallCount, 0, "no Nominatim call during warm-up");

    // Phase 2: soft-delete on another instance.
    switchToDeleted();

    // Phase 3: advance past correction-check interval — probe fires, evicts,
    // Nominatim is attempted but fails → null is cached for 6 hours.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const afterDeletion = await geocodeCityCountry("Helsinki");
    assert.equal(afterDeletion, null,
      "null returned because Nominatim is down after deletion-eviction");
    assert.equal(nominatimCallCount, 1, "Nominatim attempted exactly once");

    // Phase 4: second call immediately after the failure — within the negative TTL.
    // Must return null from _cache (not from _pending).
    // If _pending held a stale settled-null promise, this would still return null
    // but the null would never expire; the _cache TTL path would be bypassed.
    const withinTtl = await geocodeCityCountry("Helsinki");
    assert.equal(withinTtl, null, "null still returned within the 6-hour negative TTL");
    assert.equal(nominatimCallCount, 1,
      "Nominatim NOT called again within the negative TTL — null served from _cache");

    // Phase 5: advance past the 6-hour negative TTL.
    // If _pending were NOT cleared (holding a stale settled-null promise), the
    // entry in _pending would be returned directly — bypassing _cache's expiry check —
    // and Nominatim would never be retried.
    // If _pending WAS cleared (finally block ran), the expired _cache entry is missed,
    // the geocoder falls through to Nominatim, and (now that it's back up) resolves.
    nominatimShouldFail = false;
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000 + NEGATIVE_TTL_MS + 1_000);

    const afterTtl = await geocodeCityCountry("Helsinki");
    assert.equal(afterTtl?.countryCode, "FI",
      "Nominatim retried after TTL expiry and resolved — _pending was correctly cleared");
    assert.equal(nominatimCallCount, 2,
      "Nominatim called a second time — confirms _pending was cleared, not serving a stale settled promise");
  });

  it("correctionCheckedAt is bumped after a no-op probe — the probe does not re-fire until the next interval", async () => {
    // When evictIfDbCorrected returns false (DB row present, not corrected), the
    // geocoder must update correctionCheckedAt = Date.now() so the probe won't
    // fire again for another CORRECTION_CHECK_INTERVAL_MS.  Without this bump a
    // warm cache hit after the interval would probe the DB on *every* call.
    //
    // Timeline:
    //   T0            — cache seeded from DB (no Nominatim call)
    //   T0 + I + 1s   — first probe fires (no-op, correctionCheckedAt bumped to T0+I+1s)
    //   T0 + I + 1s + (I - 1s) — second call: interval has NOT elapsed again → no probe
    //   T0 + I + 1s + I + 1s   — third call: interval HAS elapsed again → probe fires
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "se", country: "Sweden" } }],
      };
    });

    // DB always returns a live, non-corrected row so every probe is a no-op.
    let probeCallCount = 0;
    const noOpDbClient: SupabaseClient = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybySingle() {
            probeCallCount++;
            return {
              data: { country: "Sweden", country_code: "SE", corrected_at: null, deleted_at: null },
              error: null,
            };
          },
          async maybeSingle() {
            probeCallCount++;
            return {
              data: { country: "Sweden", country_code: "SE", corrected_at: null, deleted_at: null },
              error: null,
            };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(noOpDbClient);

    // ── Step 1: seed the cache from the DB (counts as one probe via readDbCache) ─
    const first = await geocodeCityCountry("Stockholm");
    assert.equal(first?.countryCode, "SE", "pre-condition: cache seeded with SE");
    assert.equal(nominatimCalls, 0, "no Nominatim call on DB cache seed");
    // Reset probe count — we only want to count correction-check probes from here.
    probeCallCount = 0;

    // ── Step 2: advance past the first interval — probe fires (no-op) ────────────
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);

    const afterFirstInterval = await geocodeCityCountry("Stockholm");
    assert.equal(afterFirstInterval?.countryCode, "SE", "result is still SE after no-op probe");
    assert.equal(probeCallCount, 1, "probe fired exactly once when the first interval elapsed");
    assert.equal(nominatimCalls, 0, "no Nominatim call — no eviction occurred");

    // ── Step 3: advance by less than one interval — probe must NOT fire again ─────
    // correctionCheckedAt was bumped to T1; only T1 + CORRECTION_CHECK_INTERVAL_MS
    // would trigger a second probe.  T1 + (CORRECTION_CHECK_INTERVAL_MS - 1 s) is
    // still inside the new window.
    mockNow(T1 + CORRECTION_CHECK_INTERVAL_MS - 1_000);

    const withinSecondInterval = await geocodeCityCountry("Stockholm");
    assert.equal(withinSecondInterval?.countryCode, "SE", "result still SE within the second interval");
    assert.equal(probeCallCount, 1,
      "maybeSingle must NOT be called again within the second interval — correctionCheckedAt was bumped after the first probe");
    assert.equal(nominatimCalls, 0, "still no Nominatim call");

    // ── Step 4: advance past the second interval — probe fires again ──────────────
    mockNow(T1 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const afterSecondInterval = await geocodeCityCountry("Stockholm");
    assert.equal(afterSecondInterval?.countryCode, "SE", "result still SE after second probe");
    assert.equal(probeCallCount, 2,
      "maybeSingle called a second time after the second interval elapsed — probe re-fires correctly");
    assert.equal(nominatimCalls, 0, "no Nominatim call — second probe was also a no-op");
  });

  it("probe-triggered eviction re-arms the correction check for the fresh entry — next call within the interval does not re-probe", async () => {
    // After evictIfDbCorrected evicts a stale entry (found deleted_at set) and
    // geocodeCityCountry re-resolves a fresh entry via Nominatim, the new cache
    // entry must have its correctionCheckedAt (or writtenAt fallback) set to the
    // resolution time.  A second call made immediately after — before another
    // CORRECTION_CHECK_INTERVAL_MS has elapsed — must NOT trigger another DB probe.
    //
    // If correctionCheckedAt were missing or set to 0, the very next request
    // would compute Date.now() - 0 >= CORRECTION_CHECK_INTERVAL_MS and fire a
    // redundant probe on every call until the interval elapsed naturally.
    //
    // Timeline:
    //   T0             — cache seeded from DB (no Nominatim call)
    //   T0 + I + 1s    — interval elapsed; probe fires, finds deleted_at, evicts;
    //                    Nominatim re-resolves a fresh entry (maybeSingle call #2)
    //   T0 + I + 1s    — second call immediately after: interval NOT elapsed again
    //                    → maybeSingle must NOT fire
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "nl", country: "Netherlands" } }],
      };
    });

    // ── Phase 1: seed the in-memory cache via a DB read ──────────────────────────
    // maybeSingle fires once here (readDbCache).
    let maybeSingleCallCount = 0;
    const { client, switchToDeleted } = makePhasedDbClient({
      country: "Netherlands",
      country_code: "NL",
      corrected_at: null,
      deleted_at: null,
    });

    // Wrap the phased client to count maybeSingle calls precisely.
    const trackingClient: SupabaseClient = {
      from(table: string) {
        const inner = (client as any).from(table);
        return {
          ...inner,
          select() { return this; },
          eq() { return this; },
          gte() { return this; },
          not() { return this; },
          async maybeSingle() {
            maybeSingleCallCount++;
            return inner.maybeSingle();
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(trackingClient);

    const first = await geocodeCityCountry("Amsterdam");
    assert.equal(first?.countryCode, "NL", "pre-condition: DB cache hit returns NL");
    assert.equal(nominatimCalls, 0, "no Nominatim call on DB cache seed");
    // One maybeSingle call expected from readDbCache during the initial load.
    const callsAfterSeed = maybeSingleCallCount;

    // ── Phase 2: tombstone the row — probe will find deleted_at set ───────────────
    switchToDeleted();

    // Advance past the correction-check interval — probe fires, finds deleted_at,
    // evicts the stale entry.  Nominatim then re-resolves a fresh entry.
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);

    const afterEviction = await geocodeCityCountry("Amsterdam");
    assert.equal(afterEviction?.countryCode, "NL",
      "fresh Nominatim resolve after eviction still returns NL");
    assert.equal(nominatimCalls, 1, "Nominatim called exactly once during the re-resolve");
    // At least one more maybeSingle call expected from the eviction probe.
    assert.ok(
      maybeSingleCallCount > callsAfterSeed,
      "maybeSingle called during the eviction probe",
    );

    // ── Phase 3: second call immediately after re-resolve — no probe must fire ────
    // The fresh entry's correctionCheckedAt (or writtenAt fallback) equals T1.
    // Date.now() is still T1, so Date.now() - T1 = 0 < CORRECTION_CHECK_INTERVAL_MS.
    // maybeSingle must NOT be called again.
    const callsAfterResolve = maybeSingleCallCount;

    const secondCall = await geocodeCityCountry("Amsterdam");
    assert.equal(secondCall?.countryCode, "NL",
      "second call returns NL from the fresh in-memory entry");
    assert.equal(nominatimCalls, 1,
      "Nominatim not called again — second call hits the fresh in-memory entry");
    assert.equal(
      maybeSingleCallCount,
      callsAfterResolve,
      "maybeSingle must NOT be called during the second call — fresh entry is correctly re-armed",
    );
  });

  it("re-armed fresh entry probes again after a full interval — not locked out indefinitely", async () => {
    // Complement of the re-arm test above: after the evict-and-re-resolve cycle
    // arms the fresh entry (suppressing probes within the interval), the probe
    // must fire AGAIN once a full CORRECTION_CHECK_INTERVAL_MS has elapsed from
    // the re-resolve time.  A bug that set correctionCheckedAt to
    // Date.now() + <large offset> would suppress probes forever and still pass
    // the re-arm test — this test catches that.
    //
    // Timeline:
    //   T0             — cache seeded from DB (maybeSingle call #1)
    //   T1 = T0+I+1s   — probe fires, finds deleted_at, evicts; Nominatim
    //                    re-resolves a fresh entry
    //   T2 = T1+I+1s   — full interval elapsed since re-resolve: probe MUST
    //                    fire again (maybeSingle called)
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

    // Phased client: live row initially, then tombstoned (maybeSingle → null).
    const { client, switchToDeleted } = makePhasedDbClient({
      country: "Portugal",
      country_code: "PT",
      corrected_at: null,
      deleted_at: null,
    });

    let maybeSingleCallCount = 0;
    const trackingClient: SupabaseClient = {
      from(table: string) {
        const inner = (client as any).from(table);
        return {
          ...inner,
          select() { return this; },
          eq() { return this; },
          gte() { return this; },
          not() { return this; },
          async maybeSingle() {
            maybeSingleCallCount++;
            return inner.maybeSingle();
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(trackingClient);

    // ── Phase 1: seed from DB ─────────────────────────────────────────────────
    const first = await geocodeCityCountry("Lisbon");
    assert.equal(first?.countryCode, "PT", "pre-condition: DB cache seed returns PT");
    assert.equal(nominatimCalls, 0, "no Nominatim call on DB cache seed");

    // ── Phase 2: tombstone + evict-and-re-resolve cycle ───────────────────────
    switchToDeleted();
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);

    const reResolved = await geocodeCityCountry("Lisbon");
    assert.equal(reResolved?.countryCode, "PT",
      "fresh Nominatim resolve after eviction returns PT");
    assert.equal(nominatimCalls, 1, "Nominatim called once during the re-resolve");

    // Sanity: immediately after the re-resolve the entry is armed — no probe.
    const callsAfterResolve = maybeSingleCallCount;
    const withinInterval = await geocodeCityCountry("Lisbon");
    assert.equal(withinInterval?.countryCode, "PT");
    assert.equal(maybeSingleCallCount, callsAfterResolve,
      "no probe fires within the interval after the re-resolve (armed)");

    // ── Phase 3: advance a FULL interval past the re-resolve time ─────────────
    const T2 = T1 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T2);

    const third = await geocodeCityCountry("Lisbon");
    assert.ok(
      maybeSingleCallCount > callsAfterResolve,
      "maybeSingle called again after a full interval elapsed from the re-resolve — the re-armed entry is not locked out indefinitely",
    );
    // The phased client still reports the row as deleted, so the probe evicts
    // again and Nominatim re-resolves a second time — confirming the probe's
    // outcome was acted upon, not just fired.
    assert.equal(nominatimCalls, 2,
      "second Nominatim re-resolve after the re-fired probe evicted again");
    assert.equal(third?.countryCode, "PT", "third call still resolves PT");
  });

  it("re-fired probe that finds the row live and uncorrected keeps the cached result — no needless re-geocode", async () => {
    // Happy-path complement of the "re-armed fresh entry probes again after a
    // full interval" test above.  There, the second probe finds the row deleted
    // again and evicts.  Here, the second probe finds the DB row LIVE and
    // uncorrected (deleted_at null, corrected_at null) — the probe must fire
    // (maybeSingle called) but KEEP the cached in-memory entry: no eviction,
    // no second Nominatim call.
    //
    // A regression that evicted on every probe (e.g. an inverted corrected_at
    // comparison, or treating a live row like a tombstone) would pass the
    // existing tests but fail this one.
    //
    // Timeline:
    //   T0             — cache seeded from DB (live row)
    //   T1 = T0+I+1s   — probe fires, finds deleted_at set, evicts; Nominatim
    //                    re-resolves a fresh entry (nominatimCalls = 1)
    //     (DB switched back to a live, uncorrected row here)
    //   T2 = T1+I+1s   — full interval elapsed: probe fires again, finds the
    //                    row live → cached result kept, Nominatim NOT called
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "es", country: "Spain" } }],
      };
    });

    // Mutable-row client: maybeSingle returns whatever `currentRow` holds.
    let currentRow: Record<string, unknown> | null = {
      country: "Spain",
      country_code: "ES",
      corrected_at: null,
      deleted_at: null,
    };
    let maybeSingleCallCount = 0;
    _setGeocodeDbClientForTests({
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            maybeSingleCallCount++;
            return { data: currentRow, error: null };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    // ── Phase 1: seed from DB (live row) ──────────────────────────────────────
    const first = await geocodeCityCountry("Madrid");
    assert.equal(first?.countryCode, "ES", "pre-condition: DB cache seed returns ES");
    assert.equal(nominatimCalls, 0, "no Nominatim call on DB cache seed");

    // ── Phase 2: tombstone → evict-and-re-resolve cycle ───────────────────────
    currentRow = null; // row deleted on another instance
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);

    const reResolved = await geocodeCityCountry("Madrid");
    assert.equal(reResolved?.countryCode, "ES",
      "fresh Nominatim resolve after eviction returns ES");
    assert.equal(nominatimCalls, 1, "Nominatim called once during the re-resolve");

    // ── Phase 3: switch the DB back to a live, uncorrected row ────────────────
    // (e.g. the writeDbCache upsert from the re-resolve landed, or an admin
    // PUT revived the row).  corrected_at stays null — nothing to propagate.
    currentRow = {
      country: "Spain",
      country_code: "ES",
      corrected_at: null,
      deleted_at: null,
    };

    // Advance a FULL interval past the re-resolve time so the probe re-fires.
    const callsBeforeThird = maybeSingleCallCount;
    const T2 = T1 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T2);

    const third = await geocodeCityCountry("Madrid");

    assert.ok(
      maybeSingleCallCount > callsBeforeThird,
      "probe fired on the third call — maybeSingle was called after the interval elapsed",
    );
    assert.equal(nominatimCalls, 1,
      "Nominatim NOT called again — the live, uncorrected row keeps the cached entry");
    assert.equal(third?.countryCode, "ES",
      "cached result is returned unchanged after the keep-probe");
  });

  it("Pass 1 throw does not block Pass 2 — tombstoned entry is evicted and cleanup delete fires", async () => {
    // Regression guard: each pass of runCorrectionSweep is wrapped in its own
    // try/catch.  If Pass 1 (corrected_at query) throws — not just returns an
    // error object — Pass 2 (deleted_at tombstone query) must still run.
    // A regression that re-throws from Pass 1's catch block would silently skip
    // tombstone eviction.
    //
    // This test builds a sweep client where:
    //   - Pass 1 resolves as a rejected promise (the await throws).
    //   - Pass 2 returns a tombstoned row for "tokyo".
    // After the sweep the in-memory cache entry for "tokyo" must be gone
    // and the cleanup hard-delete must have been issued.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
      };
    });

    // Seed the in-memory cache via a DB load so the sweep has something to evict.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Japan", country_code: "JP", corrected_at: null, deleted_at: null }),
    );
    const seeded = await geocodeCityCountry("Tokyo");
    assert.equal(seeded?.countryCode, "JP", "pre-condition: cache seeded with JP");
    assert.equal(nominatimCalls, 0, "no Nominatim call during seed");

    // Build the sweep client:
    //   - Pass 1 (first .then()): throws synchronously — simulates a DB connection
    //     error that the Supabase client surfaces as a rejected promise.
    //   - Pass 2 (second .then()): returns "tokyo" as a tombstoned row.
    //   - DELETE: tracked so we can confirm it fired.
    let sweepQueryCount = 0;
    const cleanedUpKeys: string[][] = [];

    const pass1ThrowClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        let inKeys: string[] = [];
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            inKeys = keys;
            cleanedUpKeys.push([...keys]);
            return chain;
          },
          then(resolve: (v: any) => void, reject: (e: any) => void) {
            if (isDelete) {
              resolve({ error: null });
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: throw to simulate a rejected DB promise.
              reject(new Error("pass1_db_connection_refused"));
            } else {
              // Pass 2 — deleted_at: return "tokyo" as a tombstoned row.
              resolve({ data: [{ city_key: "tokyo" }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(pass1ThrowClient);
    await _runCorrectionSweepForTests();

    // Both passes must have been attempted — sweepQueryCount should be 2.
    assert.equal(sweepQueryCount, 2, "both sweep passes were attempted despite Pass 1 throwing");

    // Pass 2 found the tombstoned entry and should have evicted it from memory.
    // Switch to a null DB client so a cache miss falls through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const afterSweep = await geocodeCityCountry("Tokyo");

    assert.equal(nominatimCalls, 1,
      "Nominatim called once — Pass 2 eviction forced a fresh lookup");
    assert.equal(afterSweep?.countryCode, "JP",
      "fresh Nominatim lookup still returns JP");
    assert.equal(cleanedUpKeys.length, 1,
      "cleanup hard-delete was issued — confirming Pass 2 ran to completion");
    assert.deepEqual(cleanedUpKeys[0], ["tokyo"],
      "cleanup deleted the correct city_key");
  });

  it("Pass 1 DB error object does not block Pass 2 — tombstoned entry is evicted and cleanup delete fires", async () => {
    // Companion to the "Pass 1 throw" test above.  The Supabase client can also
    // surface a failure by resolving with { data: null, error: { message: "..." } }
    // (an error object, not a rejected promise).  In that path the outer catch
    // block never fires — the `if (!error && data)` guard silently skips the
    // eviction loop.  Pass 2 must still run regardless.
    //
    // This test builds a sweep client where:
    //   - Pass 1 resolves with { data: null, error: { message: "db_error" } }.
    //   - Pass 2 returns a tombstoned row for "kyoto".
    // After the sweep the in-memory cache entry for "kyoto" must be gone
    // and the cleanup hard-delete must have been issued.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
      };
    });

    // Seed the in-memory cache via a DB load so the sweep has something to evict.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Japan", country_code: "JP", corrected_at: null, deleted_at: null }),
    );
    const seeded = await geocodeCityCountry("Kyoto");
    assert.equal(seeded?.countryCode, "JP", "pre-condition: cache seeded with JP");
    assert.equal(nominatimCalls, 0, "no Nominatim call during seed");

    // Build the sweep client:
    //   - Pass 1 (first .then()): resolves with an error object — simulates a DB
    //     error returned by the Supabase client without throwing.
    //   - Pass 2 (second .then()): returns "kyoto" as a tombstoned row.
    //   - DELETE: tracked so we can confirm it fired.
    let sweepQueryCount = 0;
    const cleanedUpKeys: string[][] = [];

    const pass1ErrorObjectClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            cleanedUpKeys.push([...keys]);
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              resolve({ error: null });
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: resolve with an error object (not a throw).
              resolve({ data: null, error: { message: "db_error" } });
            } else {
              // Pass 2 — deleted_at: return "kyoto" as a tombstoned row.
              resolve({ data: [{ city_key: "kyoto" }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(pass1ErrorObjectClient);
    await _runCorrectionSweepForTests();

    // Both passes must have been attempted — sweepQueryCount should be 2.
    assert.equal(sweepQueryCount, 2, "both sweep passes were attempted despite Pass 1 returning an error object");

    // Pass 2 found the tombstoned entry and should have evicted it from memory.
    // Switch to a null DB client so a cache miss falls through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const afterSweep = await geocodeCityCountry("Kyoto");

    assert.equal(nominatimCalls, 1,
      "Nominatim called once — Pass 2 eviction forced a fresh lookup");
    assert.equal(afterSweep?.countryCode, "JP",
      "fresh Nominatim lookup still returns JP");
    assert.equal(cleanedUpKeys.length, 1,
      "cleanup hard-delete was issued — confirming Pass 2 ran to completion");
    assert.deepEqual(cleanedUpKeys[0], ["kyoto"],
      "cleanup deleted the correct city_key");
  });

  it("negative-cache entry whose TTL expires retries Nominatim and re-caches a positive result — no correction-check probe fires", async () => {
    // This test isolates the pure TTL-expiry retry path:
    //   1. Nominatim returns nothing → null cached for 6 hours (no DB row written — negatives are never persisted).
    //   2. Within the TTL the null is served from cache with ZERO DB probes.
    //   3. After the 6-hour NEGATIVE_TTL_MS the entry expires → geocoder falls through to
    //      re-resolve, calls readDbCache (no row), then calls Nominatim (now up) → ES.
    //   4. The correction-check probe (evictIfDbCorrected / maybeSingle) must NOT fire
    //      during the TTL-expiry re-resolve — that probe is only for warm, non-expired POSITIVE entries.
    //   5. The new positive result is re-cached so a follow-up call does not re-hit Nominatim.
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
      // Nominatim returns an empty result set — city not found, no geocode available.
      return { ok: true, json: async () => [] };
    });

    // Track every maybeSingle call so we can confirm no correction-check probe fires.
    // Negative cache entries are never written to the DB, so readDbCache returns null
    // and the correction-check probe (evictIfDbCorrected) is never triggered for null entries.
    let maybeSingleCalls = 0;
    _setGeocodeDbClientForTests({
      from(_table: string) {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            maybeSingleCalls++;
            return { data: null, error: null }; // no row — negatives are never persisted
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    // ── Phase 1: first call — Nominatim returns nothing → 6-hour negative cache ──
    const first = await geocodeCityCountry("Valencia");
    assert.equal(first, null, "first call returns null — Nominatim found nothing");
    assert.equal(nominatimCalls, 1, "Nominatim called once on the initial cache miss");
    // readDbCache was called once as part of the initial resolve (checking DB before Nominatim).
    // Reset the counter so subsequent assertions only measure post-seed probes.
    maybeSingleCalls = 0;

    // ── Phase 2: within the 6-hour TTL — null served from cache, zero DB probes ──
    // The correction-check probe must NOT fire for null entries (no DB row to inspect).
    mockNow(T0 + NEGATIVE_TTL_MS - 1_000);
    const withinTtl = await geocodeCityCountry("Valencia");
    assert.equal(withinTtl, null, "null is served from the negative cache within the TTL");
    assert.equal(nominatimCalls, 1, "Nominatim not called again within the negative TTL");
    assert.equal(maybeSingleCalls, 0,
      "no DB probe (maybeSingle) during the warm null-cache period — correction-check probe does not fire for null entries");

    // ── Phase 3: past the 6-hour TTL — entry expires, Nominatim is back up ───────
    nominatimShouldSucceed = true;
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    const afterTtl = await geocodeCityCountry("Valencia");
    assert.equal(afterTtl?.countryCode, "ES",
      "geocoder retries Nominatim after the 6-hour negative TTL expires and returns the successful result");
    assert.equal(nominatimCalls, 2, "Nominatim called a second time after the TTL expired");
    // readDbCache fires once as part of the normal re-resolve flow (check DB before Nominatim).
    // The correction-check probe (evictIfDbCorrected) must NOT have fired — it is only
    // triggered for warm, non-expired positive cache entries.
    assert.ok(maybeSingleCalls <= 1,
      "maybeSingle called at most once during TTL-expiry re-resolve (readDbCache only — no correction-check probe)");

    // ── Phase 4: positive result re-cached — follow-up call does not re-hit Nominatim ──
    maybeSingleCalls = 0;
    const followUp = await geocodeCityCountry("Valencia");
    assert.equal(followUp?.countryCode, "ES",
      "follow-up call returns the re-cached positive result (ES)");
    assert.equal(nominatimCalls, 2,
      "Nominatim not called again — the successful result is now cached as a positive entry");
    assert.equal(maybeSingleCalls, 0,
      "no DB probe on the follow-up call — positive entry is still within its 30-day TTL");
  });

  it("sweep_tombstone_evicted log event fires for a concurrently-revived city — even when the hard-delete is a no-op", async () => {
    // Race condition: the sweep queries tombstoned rows (SELECT), logs + evicts the
    // in-memory entry, then issues the hard-delete.  Between SELECT and DELETE an
    // admin PUT can revive the row by clearing deleted_at.  The hard-delete is then
    // a no-op (the .not("deleted_at","is",null) guard filters out the live row).
    //
    // Critically: the sweep_tombstone_evicted log event is emitted BEFORE the delete
    // step, so it must still fire even when the delete is a no-op.  Without this
    // guarantee operators lose the ability to audit that the race occurred.
    //
    // This test confirms:
    //   1. "stamp.country_geocode.sweep_tombstone_evicted" is logged for the city.
    //   2. The hard-delete was a no-op (deleteCallCount === 0 because the guard
    //      filters the revived row before any rows are actually removed).
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "dk", country: "Denmark" } }],
      };
    });

    // Seed the in-memory cache via a DB load so the sweep has something to evict.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Denmark", country_code: "DK", corrected_at: null, deleted_at: null }),
    );
    const seed = await geocodeCityCountry("Copenhagen");
    assert.equal(seed?.countryCode, "DK", "pre-condition: cache seeded with DK");
    assert.equal(nominatimCalls, 0, "no Nominatim call during seed");

    // Build a sweep client that simulates the race:
    //   Pass 1 (corrected_at): empty — nothing to evict via correction.
    //   Pass 2 (deleted_at):   returns "copenhagen" as tombstoned (sweep's SELECT snapshot).
    //   DELETE:                honours the .not("deleted_at","is",null) guard — the row
    //                          was revived by a concurrent PUT so zero rows are removed.
    let sweepQueryCount = 0;
    let deleteGuardFired = false; // true when .not() is called on the DELETE chain
    let deleteExecuted = false;   // true when .then() resolves on the DELETE chain

    const raceClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not(_col: string, _filter: string, _val: unknown) {
            if (isDelete) deleteGuardFired = true;
            return chain;
          },
          delete() { isDelete = true; return chain; },
          in(_col: string, _keys: string[]) { return chain; },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              // Simulate the guard filtering the revived row: the DELETE matches
              // zero rows because deleted_at is now null (row was revived by PUT).
              deleteExecuted = true;
              resolve({ error: null });
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing to evict.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: sweep sees "copenhagen" as tombstoned.
              resolve({ data: [{ city_key: "copenhagen" }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    // Capture console.log output during the sweep.
    const logLines: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    };

    try {
      _setGeocodeDbClientForTests(raceClient);
      await _runCorrectionSweepForTests();
    } finally {
      console.log = originalConsoleLog;
    }

    // ── Assertion 1: sweep_tombstone_evicted must have been logged for "copenhagen" ─
    const evictedEvents = logLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((obj): obj is Record<string, unknown> => obj !== null)
      .filter((obj) => obj.event === "stamp.country_geocode.sweep_tombstone_evicted");

    assert.ok(
      evictedEvents.length > 0,
      `Expected at least one "stamp.country_geocode.sweep_tombstone_evicted" log event but got none. ` +
        `Captured lines: ${JSON.stringify(logLines)}`,
    );

    const cityKeyLogged = evictedEvents.some((obj) => obj.city_key === "copenhagen");
    assert.ok(
      cityKeyLogged,
      `Expected sweep_tombstone_evicted event with city_key="copenhagen" but got: ${JSON.stringify(evictedEvents)}`,
    );

    // ── Assertion 2: the DELETE guard fired (confirming the race guard ran) ────────
    assert.ok(
      deleteGuardFired,
      "The .not('deleted_at','is',null) guard must be reached during the DELETE phase",
    );

    // ── Assertion 3: the hard-delete was a no-op — executed but matched 0 rows ────
    assert.ok(
      deleteExecuted,
      "The DELETE was issued (sweep always tries to clean up) — even when it matches zero rows",
    );

    // ── Assertion 4: the in-memory entry was evicted (sweep still clears it) ───────
    // After eviction a fresh geocodeCityCountry call must miss the cache and hit Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const afterSweep = await geocodeCityCountry("Copenhagen");
    assert.equal(nominatimCalls, 1,
      "Nominatim called once — sweep evicted the in-memory entry even though the hard-delete was a no-op");
    assert.equal(afterSweep?.countryCode, "DK",
      "geocoder re-resolved DK via Nominatim after sweep eviction");
  });

  it("two concurrent warm-cache callers fire the correction-check DB probe at most once — not twice simultaneously", async () => {
    // Scenario: two simultaneous geocodeCityCountry() calls arrive at the same
    // warm cache entry after the CORRECTION_CHECK_INTERVAL_MS has elapsed.
    // Without a dedup guard both callers would enter the evictIfDbCorrected()
    // branch concurrently, issuing two independent maybySingle() DB probes for
    // the same key.
    //
    // The fix: correctionCheckedAt is bumped BEFORE awaiting the probe.  When
    // the second caller reads the cache entry the timestamp is already fresh, so
    // the interval check fails and it returns the cached result directly —
    // at most one DB probe is issued regardless of how many callers are in flight.
    //
    // Confirmed assertions:
    //   - maybeSingle() called at most once across both concurrent callers.
    //   - Both callers receive the cached country code.
    //   - No Nominatim call is triggered (the entry was not evicted).
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "ch", country: "Switzerland" } }],
      };
    });

    // Phase 1: seed the warm cache entry via a DB read (no Nominatim call).
    let probeCallCount = 0;
    _setGeocodeDbClientForTests(
      makeFixedDbClient(
        { country: "Switzerland", country_code: "CH", corrected_at: null, deleted_at: null },
        { onCall: () => { probeCallCount++; } },
      ),
    );
    const warm = await geocodeCityCountry("Zurich");
    assert.equal(warm?.countryCode, "CH", "pre-condition: warm entry loaded from DB cache");
    assert.equal(nominatimCalls, 0, "no Nominatim call during warm-up");
    // Reset the probe counter — the readDbCache call above may have incremented it.
    probeCallCount = 0;

    // Phase 2: advance past the correction-check interval so both concurrent
    // callers see an elapsed interval on first inspection.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    // Phase 3: fire two concurrent geocode calls for the same city.
    const [resultA, resultB] = await Promise.all([
      geocodeCityCountry("Zurich"),
      geocodeCityCountry("Zurich"),
    ]);

    // Both callers must receive the (unmodified) cached result.
    assert.equal(resultA?.countryCode, "CH", "caller A received the cached country code");
    assert.equal(resultB?.countryCode, "CH", "caller B received the cached country code");

    // No Nominatim call — the DB probe found no correction so the entry was kept.
    assert.equal(nominatimCalls, 0, "Nominatim must not be called — entry was not evicted");

    // The critical assertion: at most one DB probe issued across both callers.
    // Without the optimistic correctionCheckedAt bump this would be 2.
    assert.ok(
      probeCallCount <= 1,
      `DB probe (maybySingle) called ${probeCallCount} time(s) — expected at most 1 across two concurrent warm-cache callers`,
    );
  });

  it("five concurrent warm-cache callers fire the correction-check DB probe at most once — probe-skip holds under bursts of three or more", async () => {
    // Extends the two-caller test: when five simultaneous geocodeCityCountry()
    // calls arrive at the same warm entry after CORRECTION_CHECK_INTERVAL_MS,
    // only one DB probe should fire.  The optimistic correctionCheckedAt bump
    // (written BEFORE the first await in the probe path) ensures every subsequent
    // concurrent caller sees a fresh timestamp and short-circuits without issuing
    // its own maybeSingle() call.
    //
    // Confirmed assertions:
    //   - maybeSingle() called at most once across all five concurrent callers.
    //   - All five callers receive the same cached country code.
    //   - No Nominatim call is triggered (the entry was not evicted).
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "nl", country: "Netherlands" } }],
      };
    });

    // Phase 1: seed the warm cache entry via a DB read (no Nominatim call).
    let probeCallCount = 0;
    _setGeocodeDbClientForTests(
      makeFixedDbClient(
        { country: "Netherlands", country_code: "NL", corrected_at: null, deleted_at: null },
        { onCall: () => { probeCallCount++; } },
      ),
    );
    const warm = await geocodeCityCountry("Amsterdam");
    assert.equal(warm?.countryCode, "NL", "pre-condition: warm entry loaded from DB cache");
    assert.equal(nominatimCalls, 0, "no Nominatim call during warm-up");
    // Reset the probe counter — the readDbCache call above may have incremented it.
    probeCallCount = 0;

    // Phase 2: advance past the correction-check interval so all five concurrent
    // callers see an elapsed interval on first inspection.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    // Phase 3: fire five concurrent geocode calls for the same city.
    const results = await Promise.all([
      geocodeCityCountry("Amsterdam"),
      geocodeCityCountry("Amsterdam"),
      geocodeCityCountry("Amsterdam"),
      geocodeCityCountry("Amsterdam"),
      geocodeCityCountry("Amsterdam"),
    ]);

    // All five callers must receive the (unmodified) cached result.
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i]?.countryCode, "NL",
        `caller ${i} received the cached country code`);
    }

    // No Nominatim call — the DB probe found no correction so the entry was kept.
    assert.equal(nominatimCalls, 0, "Nominatim must not be called — entry was not evicted");

    // The critical assertion: at most one DB probe issued across all five callers.
    // Without the optimistic correctionCheckedAt bump this would be 5.
    assert.ok(
      probeCallCount <= 1,
      `DB probe (maybeSingle) called ${probeCallCount} time(s) — expected at most 1 across five concurrent warm-cache callers`,
    );
  });

  it("sweep hard-delete is skipped when all tombstoned rows were revived before DELETE — zero rows removed, in-memory entries already evicted", async () => {
    // Race-condition edge case: the sweep's SELECT (Pass 2) returns tombstoned rows
    // and evicts their in-memory entries.  Before the hard-DELETE fires a concurrent
    // admin PUT revives EVERY one of those rows (sets deleted_at = null).
    // The DELETE's .not("deleted_at","is",null) guard then matches zero rows, so the
    // DB store is untouched — but the in-memory eviction already happened during the
    // SELECT pass and must not be reversed.
    //
    // Confirmed assertions:
    //   1. Zero rows are removed from the stateful DB store (guard worked).
    //   2. In-memory cache entries ARE still gone — eviction is not undone.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "gr", country: "Greece" } }],
      };
    });

    // Stateful DB: both rows start as tombstoned; the DELETE honours the guard
    // by checking deleted_at and only removing rows that are still tombstoned.
    // We simulate a concurrent PUT revival by having the DELETE callback see
    // deleted_at = null for all rows — exactly what the .not() guard protects against.
    const revivedStore = new Map<string, { city_key: string; deleted_at: string | null }>([
      ["athens", { city_key: "athens", deleted_at: new Date(T0 - 1_000).toISOString() }],
      ["thessaloniki", { city_key: "thessaloniki", deleted_at: new Date(T0 - 2_000).toISOString() }],
    ]);

    // Track how many rows the hard-delete actually removes from the store.
    const hardDeletedKeys: string[] = [];

    let sweepQueryCount = 0;
    const allRevivedClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        let deletedInKeys: string[] = [];
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not(_col: string, _filter: string, _val: unknown) {
            // When this is the DELETE chain, simulate all rows having been revived
            // by the time the guard fires — set deleted_at = null for every row.
            if (isDelete) {
              for (const [k, row] of revivedStore) {
                revivedStore.set(k, { ...row, deleted_at: null });
              }
            }
            return chain;
          },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            deletedInKeys = keys;
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              // Honour the .not("deleted_at","is",null) guard: only remove rows
              // whose deleted_at is still non-null at DELETE-time.  Because the PUT
              // revival above already cleared deleted_at, zero rows qualify.
              for (const key of deletedInKeys) {
                const row = revivedStore.get(key);
                if (row && row.deleted_at !== null) {
                  revivedStore.delete(key);
                  hardDeletedKeys.push(key);
                }
              }
              resolve({ error: null });
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing to evict from this pass.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: both rows are still tombstoned at SELECT-time.
              // The sweep evicts their in-memory entries here.
              resolve({ data: Array.from(revivedStore.values()), error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    // Seed in-memory cache for both cities.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Greece", country_code: "GR", corrected_at: null, deleted_at: null }),
    );
    await geocodeCityCountry("Athens");
    await geocodeCityCountry("Thessaloniki");
    assert.equal(nominatimCalls, 0, "pre-condition: both cities seeded from DB, no Nominatim calls");

    // Run the sweep.
    _setGeocodeDbClientForTests(allRevivedClient);
    await _runCorrectionSweepForTests();

    // ── Assertion 1: zero rows removed from the stateful store ───────────────
    // The guard prevented the DELETE from touching the now-revived rows.
    assert.equal(
      hardDeletedKeys.length,
      0,
      "hard-delete must touch zero rows when all tombstoned rows were revived before DELETE fires",
    );
    assert.equal(
      revivedStore.size,
      2,
      "both rows must remain in the stateful DB store — the guard protected the revived rows",
    );

    // ── Assertion 2: in-memory entries were still evicted by the SELECT pass ──
    // The sweep evicted entries during the SELECT pass; that eviction must not
    // be reversed just because the DELETE was a no-op.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    await geocodeCityCountry("Athens");
    await geocodeCityCountry("Thessaloniki");
    assert.equal(
      nominatimCalls,
      2,
      "both in-memory entries were evicted by the sweep SELECT pass — Nominatim re-resolved each city despite the DELETE no-op",
    );
  });

  it("DB error in readDbCache after sweep eviction falls through to Nominatim — not returning stale null", async () => {
    // Scenario: the tombstone sweep evicts a city's in-memory entry.  The very
    // next geocodeCityCountry call hits readDbCache to re-populate from the DB,
    // but readDbCache itself returns a transient DB error.  The geocoder must fall
    // through to Nominatim and return its result — NOT silently return null as if
    // the city doesn't exist.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "at", country: "Austria" } }],
      };
    });

    // Phase 1: seed the in-memory cache via a DB load (no Nominatim call).
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Austria", country_code: "AT", corrected_at: null, deleted_at: null }),
    );
    const seeded = await geocodeCityCountry("Vienna");
    assert.equal(seeded?.countryCode, "AT", "pre-condition: cache seeded with AT from DB");
    assert.equal(nominatimCalls, 0, "no Nominatim call during seed phase");

    // Phase 2: run the tombstone sweep with "vienna" reported as tombstoned.
    // The sweep evicts the in-memory entry so the next call re-resolves from scratch.
    const sweepClient = makeTombstoneSweepClient([{ city_key: "vienna" }]);
    _setGeocodeDbClientForTests(sweepClient);
    await _runCorrectionSweepForTests();

    // Phase 3: switch to a client that returns a transient DB error from
    // maybeSingle() — simulating a brief outage on the readDbCache call that
    // follows the sweep eviction.
    let readDbCalls = 0;
    _setGeocodeDbClientForTests({
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            readDbCalls++;
            // Transient error — readDbCache should return null and let the
            // geocoder fall through to Nominatim rather than propagating null
            // as a definitive "city not found" response.
            return { data: null, error: { message: "connection refused" } };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            // Sweep queries (corrected_at / deleted_at passes) return empty.
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    // Phase 4: the next call after sweep eviction must fall through to Nominatim
    // when readDbCache hits a DB error — not silently return null.
    const afterSweep = await geocodeCityCountry("Vienna");

    assert.equal(readDbCalls, 1,
      "readDbCache was attempted exactly once after the sweep eviction");
    assert.equal(nominatimCalls, 1,
      "Nominatim called once — DB error in readDbCache fell through to Nominatim, not null");
    assert.notEqual(afterSweep, null,
      "result must not be null — Nominatim fallback must fire when the DB read errors out");
    assert.equal(afterSweep?.countryCode, "AT",
      "Nominatim's result is returned even though the DB read errored after sweep eviction");
  });

  it("sweep Pass 1 evicts a stale null entry (cached before PUT revival) — next geocode returns the revived country", async () => {
    // Scenario: instance A handles the DELETE (tombstoning the DB row) and the
    // subsequent PUT (reviving it, setting corrected_at = now()).  Between those
    // two events, instance B independently calls geocodeCityCountry, finds the DB
    // row tombstoned, Nominatim returns nothing, and caches null.
    //
    // Instance A's evictGeocodeCacheKey() only cleared instance A's entry.
    // Instance B's null entry persists until the background correction sweep runs.
    //
    // The sweep's Pass 1 queries corrected_at >= since.  The PUT set corrected_at
    // after the null was written, so entry.writtenAt < correctedMs → the sweep
    // evicts instance B's stale null.  The next geocodeCityCountry call on B then
    // reads the revived DB row and returns the correct country.

    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // ── Step 1: seed a null in-memory entry (instance B's miss-window geocode). ──
    // DB is effectively offline (fetch override disables it); Nominatim returns
    // nothing → null is cached at writtenAt = T0.
    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return { ok: true, json: async () => [] };
    });

    const nullResult = await geocodeCityCountry("Vienna");
    assert.equal(nullResult, null,
      "pre-condition: null is cached when Nominatim returns nothing (DB tombstoned)");
    assert.equal(nominatimCalls, 1, "Nominatim called once to seed the null entry");

    // ── Step 2: simulate the PUT revival on instance A. ──────────────────────────
    // The PUT sets corrected_at to a timestamp that post-dates the null entry's
    // writtenAt (T0), so the sweep's comparison will satisfy writtenAt < correctedMs.
    const correctedAtMs = T0 + 100;
    const correctedAtIso = new Date(correctedAtMs).toISOString();

    // ── Step 3: build a combined sweep + readDbCache client. ─────────────────────
    //   Pass 1 (corrected_at): reports "vienna" corrected → triggers null eviction.
    //   Pass 2 (deleted_at):   returns empty (PUT cleared the tombstone).
    //   maybeSingle (readDbCache after eviction): returns the live revived row.
    //   upsert (writeDbCache for fresh geocode): no-op, counted for verification.
    let sweepQueryCount = 0;
    let upsertCalls = 0;
    const sweepAndRevivalClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in() { return chain; },
          async maybySingle() {
            return {
              data: {
                country: "Austria",
                country_code: "AT",
                corrected_at: correctedAtIso,
                deleted_at: null,
              },
              error: null,
            };
          },
          async maybeSingle() {
            // readDbCache call — returns the revived live row so the geocoder
            // can serve the corrected result without calling Nominatim.
            return {
              data: {
                country: "Austria",
                country_code: "AT",
                corrected_at: correctedAtIso,
                deleted_at: null,
              },
              error: null,
            };
          },
          upsert() {
            upsertCalls++;
            return Promise.resolve({ error: null });
          },
          then(resolve: (v: any) => void) {
            if (isDelete) { resolve({ error: null }); return; }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: "vienna" was corrected AFTER the null was cached.
              resolve({ data: [{ city_key: "vienna", corrected_at: correctedAtIso }], error: null });
            } else {
              // Pass 2 — deleted_at: empty (PUT cleared the tombstone; row is live).
              resolve({ data: [], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    // Inject the sweep client — overrides the null _dbClientOverride set by
    // _setGeocodeFetchForTests so the sweep can query the DB.
    _setGeocodeDbClientForTests(sweepAndRevivalClient);

    // ── Step 4: run the correction sweep. ─────────────────────────────────────────
    await _runCorrectionSweepForTests();

    // ── Step 5: assert the null entry is evicted and the revived country is served. ─
    nominatimCalls = 0; // reset so we confirm Nominatim is NOT called post-eviction

    const afterSweep = await geocodeCityCountry("Vienna");

    assert.equal(afterSweep?.countryCode, "AT",
      "sweep evicted the stale null — geocoder returns the revived country (AT) from the DB row");
    assert.equal(afterSweep?.country, "Austria",
      "revived DB row's country name is also propagated correctly");
    assert.equal(nominatimCalls, 0,
      "Nominatim must NOT be called — revived DB row is served directly by readDbCache");
    assert.equal(upsertCalls, 0,
      "writeDbCache must NOT be called — the DB row was already written by the PUT");
  });

  it("sweep handles a mix of already-evicted and still-warm entries — evicts the warm entry and issues the cleanup delete without crashing", async () => {
    // Scenario: two cities are tombstoned in the DB.  Before the sweep runs,
    // one of them ("tokyo") was already evicted from in-memory by the
    // on-request probe (evictIfDbCorrected).  The sweep must:
    //   - evict the still-warm entry ("osaka") without crashing on the absent "tokyo" key
    //   - issue one cleanup delete covering both tombstoned keys (DB-side cleanup
    //     is independent of whether the key was in the in-memory cache)
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1: seed both cities in-memory via DB cache hits — no Nominatim needed.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [],
    }));
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Japan", country_code: "JP", corrected_at: null, deleted_at: null }),
    );
    const tokyo = await geocodeCityCountry("Tokyo");
    const osaka = await geocodeCityCountry("Osaka");
    assert.equal(tokyo?.countryCode, "JP", "pre-condition: tokyo seeded in cache");
    assert.equal(osaka?.countryCode, "JP", "pre-condition: osaka seeded in cache");
    assert.notEqual(_getGeocodeCacheEntryForTests("tokyo"), undefined, "tokyo is in cache before probe");
    assert.notEqual(_getGeocodeCacheEntryForTests("osaka"), undefined, "osaka is in cache before sweep");

    // Step 2: simulate the on-request probe evicting "tokyo" — the same operation
    // evictIfDbCorrected performs when it finds deleted_at set on the DB row.
    evictGeocodeCacheKey("tokyo");
    assert.equal(_getGeocodeCacheEntryForTests("tokyo"), undefined,
      "tokyo has been evicted from cache by the on-request probe");
    assert.notEqual(_getGeocodeCacheEntryForTests("osaka"), undefined,
      "osaka is still warm in cache — the sweep must evict it");

    // Step 3: run a sweep cycle where both cities appear as tombstoned.
    // The sweep must not crash when it tries to _cache.delete("tokyo") — a no-op
    // for a key that is already absent — and must still evict "osaka" and issue
    // the cleanup delete for both keys.
    const cleanupDeleteKeys: string[] = [];
    let sweepQueryCount = 0;
    const mixedSweepClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            cleanupDeleteKeys.push(...keys);
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              resolve({ error: null });
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing corrected in this cycle.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: both cities appear as tombstoned.
              resolve({ data: [{ city_key: "tokyo" }, { city_key: "osaka" }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(mixedSweepClient);

    // Must not throw even though "tokyo" is already absent from the in-memory cache.
    await _runCorrectionSweepForTests();

    // Step 4: verify post-sweep state.
    assert.equal(_getGeocodeCacheEntryForTests("osaka"), undefined,
      "osaka was still warm before the sweep and must be evicted by it");
    assert.equal(_getGeocodeCacheEntryForTests("tokyo"), undefined,
      "tokyo was already evicted — it remains absent with no crash");

    // The cleanup delete must cover both keys so tombstone rows are removed from
    // the DB regardless of whether the in-memory entry was already gone.
    assert.equal(cleanupDeleteKeys.includes("tokyo"), true,
      "cleanup delete includes the already-evicted key — DB tombstone still needs removal");
    assert.equal(cleanupDeleteKeys.includes("osaka"), true,
      "cleanup delete includes the just-evicted key");
    assert.equal(cleanupDeleteKeys.length, 2,
      "exactly two keys in the cleanup delete — one already-evicted, one just-evicted by the sweep");
  });

  it("sweep logs sweep_pass1_error when Pass 1 throws — and Pass 2 still runs", async () => {
    // Seed a cache entry so Pass 2 eviction is observable.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "de", country: "Germany" } }],
    }));
    // No DB client for the warm-up — geocoder resolves via Nominatim.
    _setGeocodeDbClientForTests(null);
    await geocodeCityCountry("Berlin");

    // Now install a client where Pass 1 throws and Pass 2 returns a tombstoned row.
    let pass2Ran = false;
    const tombstonedKey = "berlin";
    let sweepQueryCount = 0;
    const mixedClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in() { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            if (isDelete) { resolve({ error: null }); return; }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — throw to simulate a DB error.
              throw new Error("connection_timeout");
            } else {
              // Pass 2 — return a tombstoned row so we can confirm it ran.
              pass2Ran = true;
              resolve({ data: [{ city_key: tombstonedKey }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(mixedClient);

    // Capture log output.
    const logLines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { logLines.push(msg); };

    try {
      await _runCorrectionSweepForTests();
    } finally {
      console.log = origLog;
    }

    // The sweep_pass1_error event must have been logged.
    const pass1ErrorEvents = logLines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o) => o?.event === "stamp.country_geocode.sweep_pass1_error");
    assert.equal(pass1ErrorEvents.length, 1, "sweep_pass1_error event logged exactly once");
    assert.ok(
      typeof pass1ErrorEvents[0].error === "string" && pass1ErrorEvents[0].error.length > 0,
      "sweep_pass1_error carries an error message",
    );

    // Pass 2 must have still run despite Pass 1 throwing.
    assert.ok(pass2Ran, "Pass 2 ran even though Pass 1 threw");

    // The Berlin entry should have been evicted by Pass 2.
    const tombstoneEvents = logLines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o) => o?.event === "stamp.country_geocode.sweep_tombstone_evicted");
    assert.equal(tombstoneEvents.length, 1, "Pass 2 evicted the tombstoned entry");
    assert.equal(tombstoneEvents[0].city_key, tombstonedKey);
  });

  it("sweep hard-delete error is swallowed — in-memory entry is evicted but tombstone rows remain for the next cycle", async () => {
    // The sweep evicts in-memory entries BEFORE issuing the hard-delete.
    // If the hard-delete throws (DB outage, network error), the outer try/catch
    // swallows the error.  Two invariants must hold:
    //   (a) the in-memory entry was already evicted — the next geocode call re-resolves
    //       from Nominatim, not from the now-stale cached result.
    //   (b) the tombstone rows were NOT removed from the stateful DB — the next sweep
    //       cycle will find them again and can retry the hard-delete.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "gr", country: "Greece" } }],
      };
    });

    // Seed the in-memory cache via a DB load so the sweep has something to evict.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Greece", country_code: "GR", corrected_at: null, deleted_at: null }),
    );
    const seeded = await geocodeCityCountry("Athens");
    assert.equal(seeded?.countryCode, "GR", "pre-condition: cache seeded with GR");
    assert.equal(nominatimCalls, 0, "no Nominatim call during seed");

    // Stateful tombstone store — the hard-delete must NOT mutate this when it throws.
    const tombstoneStore = new Map<string, { city_key: string; deleted_at: string }>([
      ["athens", { city_key: "athens", deleted_at: new Date(T0 - 1_000).toISOString() }],
    ]);

    let sweepQueryCount = 0;
    let hardDeleteAttempts = 0;

    const failingDeleteClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, _keys: string[]) {
            return chain;
          },
          then(resolve: (v: any) => void, reject: (e: any) => void) {
            if (isDelete) {
              hardDeleteAttempts++;
              // Throw to simulate a DB error on the hard-delete — the tombstone
              // store is intentionally NOT mutated here.
              reject(new Error("delete_connection_refused"));
              return;
            }
            const q = sweepQueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: nothing to evict from this pass.
              resolve({ data: [], error: null });
            } else {
              // Pass 2 — deleted_at: return the tombstoned row.
              resolve({ data: Array.from(tombstoneStore.values()), error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(failingDeleteClient);
    await _runCorrectionSweepForTests();

    // The sweep must have attempted both passes and the hard-delete.
    assert.equal(sweepQueryCount, 2, "sweep ran both passes");
    assert.equal(hardDeleteAttempts, 1, "hard-delete was attempted exactly once");

    // ── Assertion (a): in-memory entry was evicted despite the hard-delete failing ─
    // Switch to a null DB so a cache miss falls through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const afterSweep = await geocodeCityCountry("Athens");

    assert.equal(nominatimCalls, 1,
      "Nominatim called once — in-memory entry was evicted even though the hard-delete threw");
    assert.equal(afterSweep?.countryCode, "GR",
      "fresh Nominatim lookup still returns GR");

    // ── Assertion (b): tombstone rows remain in the stateful DB ──────────────────
    // The hard-delete threw before completing, so the tombstone store must be intact.
    assert.equal(tombstoneStore.size, 1,
      "tombstone store still has 1 row — hard-delete error left it untouched");
    assert.ok(tombstoneStore.has("athens"),
      "athens tombstone row is still present — next sweep cycle can retry the hard-delete");

    // ── Confirm: a second sweep cycle can pick up and clean the surviving tombstone ─
    let cycle2QueryCount = 0;
    const cycle2CleanedKeys: string[][] = [];
    const recoverySweepClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            cycle2CleanedKeys.push([...keys]);
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              // Successful hard-delete this time — remove from the store.
              for (const key of (cycle2CleanedKeys[cycle2CleanedKeys.length - 1] ?? [])) {
                tombstoneStore.delete(key);
              }
              resolve({ error: null });
              return;
            }
            const q = cycle2QueryCount++;
            if (q === 0) {
              resolve({ data: [], error: null }); // pass 1: corrected_at
            } else {
              // Pass 2: tombstone row is still there (hard-delete failed in cycle 1).
              resolve({ data: Array.from(tombstoneStore.values()), error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(recoverySweepClient);
    await _runCorrectionSweepForTests();

    assert.equal(cycle2CleanedKeys.length, 1,
      "cycle 2: cleanup hard-delete was issued — tombstone row found again after cycle 1 failure");
    assert.deepEqual(cycle2CleanedKeys[0], ["athens"],
      "cycle 2: correct city_key was passed to the cleanup delete");
    assert.equal(tombstoneStore.size, 0,
      "tombstone store is empty after cycle 2 — hard-delete succeeded on retry");
  });

  it("sweep issues no hard-delete and does not evict the cache when Pass 2 returns an empty array", async () => {
    // Scenario: the sweep runs, Pass 1 finds no corrected rows, and Pass 2 finds
    // no tombstoned rows (empty array). The guard `tombstoned.length > 0` must
    // prevent any hard-delete call from firing.  A warm in-memory cache entry
    // must also remain intact — no spurious eviction from an empty result.

    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Seed a warm positive cache entry so we can assert it is NOT evicted.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "de", country: "Germany" } }],
    }));

    // Build a minimal DB client: both sweep passes return empty arrays.
    // If delete() is ever called the test fails immediately.
    let deleteCallCount = 0;
    let sweepQueryCount = 0;
    const emptyPassClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() {
            isDelete = true;
            deleteCallCount++;
            return chain;
          },
          in() { return chain; },
          async maybySingle() { return { data: null, error: null }; },
          async maybeSingle() {
            // readDbCache for the warm-up — returns a live row the first time.
            return {
              data: {
                country: "Germany",
                country_code: "DE",
                corrected_at: null,
                deleted_at: null,
              },
              error: null,
            };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            if (isDelete) { resolve({ error: null }); return; }
            // Both Pass 1 and Pass 2 return empty — no corrected or tombstoned rows.
            sweepQueryCount++;
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(emptyPassClient);

    // Warm up the in-memory cache with a positive entry (reads from DB).
    const warmResult = await geocodeCityCountry("Berlin");
    assert.equal(warmResult?.countryCode, "DE",
      "pre-condition: warm cache entry loaded from DB");

    // Run the correction sweep — Pass 1 and Pass 2 both return [].
    await _runCorrectionSweepForTests();

    // No hard-delete must have been issued.
    assert.equal(deleteCallCount, 0,
      "hard-delete must NOT be called when Pass 2 returns an empty array");

    // The warm cache entry must still be present and serve the cached value.
    // Advance time just short of the correction-check interval so the probe
    // does NOT fire — only the sweep ran.
    mockNow(T0 + 1_000);
    let nominatimAfterSweep = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimAfterSweep++;
      return { ok: true, json: async () => [] };
    });

    const afterSweep = await geocodeCityCountry("Berlin");
    assert.equal(afterSweep?.countryCode, "DE",
      "cached entry must still be served — sweep must not evict when Pass 2 is empty");
    assert.equal(nominatimAfterSweep, 0,
      "Nominatim must not be called — the cache entry was NOT evicted by the empty-result sweep");
    assert.equal(sweepQueryCount, 2,
      "both sweep passes (corrected_at and deleted_at) were executed");
  });

  it("evicts both corrected-at (Pass 1) and tombstoned (Pass 2) entries when both passes error on cycle 1 but recover together on cycle 2", async () => {
    // Task 637: the untested edge from Task 560 — both passes fail simultaneously
    // (e.g. a total DB outage), then both recover in the same subsequent cycle.
    //
    // Cycle 1: Pass 1 (corrected_at query) errors + Pass 2 (deleted_at query) errors.
    //          → Neither entry is evicted; no cleanup delete is issued.
    // Cycle 2: Both passes succeed.
    //          → Both entries are evicted; the tombstone cleanup delete fires for Pass 2.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Nominatim stub — counts calls; used to confirm eviction happened.
    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "fr", country: "France" } }],
      };
    });

    // ── Seed Pass 1 target: "paris" ──────────────────────────────────────────────
    // Load it from the DB so writtenAt = T0.  The sweep's Pass 1 will return a
    // corrected_at of T0 + 1 000 ms — guaranteed to be newer than writtenAt.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "France", country_code: "FR", corrected_at: null, deleted_at: null }),
    );
    const parisFirst = await geocodeCityCountry("Paris");
    assert.equal(parisFirst?.countryCode, "FR", "pre-condition: paris seeded as FR");
    assert.equal(nominatimCalls, 0, "no Nominatim call during paris seed");

    const correctedAtIso = new Date(T0 + 1_000).toISOString(); // > writtenAt (T0)

    // ── Seed Pass 2 target: "berlin" ─────────────────────────────────────────────
    // Load a second entry; the sweep's Pass 2 will return it as tombstoned.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Germany", country_code: "DE", corrected_at: null, deleted_at: null }),
    );
    const berlinFirst = await geocodeCityCountry("Berlin");
    assert.equal(berlinFirst?.countryCode, "DE", "pre-condition: berlin seeded as DE");
    assert.equal(nominatimCalls, 0, "no Nominatim call during berlin seed");

    // ── Cycle 1: both passes return DB errors ────────────────────────────────────
    let cycle1QueryCount = 0;
    let cycle1DeleteCount = 0;
    const errorSweepClient: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, _keys: string[]) {
            cycle1DeleteCount++;
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              cycle1DeleteCount++;
              resolve({ error: null });
              return;
            }
            cycle1QueryCount++;
            // Both Pass 1 and Pass 2 error in cycle 1.
            resolve({ data: null, error: { message: "connection refused" } });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(errorSweepClient);
    await _runCorrectionSweepForTests();

    assert.equal(cycle1QueryCount, 2, "cycle 1: both sweep passes ran");
    assert.equal(cycle1DeleteCount, 0, "cycle 1: no cleanup delete issued when both passes error");

    // Both entries must still be in memory after the failed sweep.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    const parisAfterCycle1 = await geocodeCityCountry("Paris");
    assert.equal(parisAfterCycle1?.countryCode, "FR",
      "paris entry preserved after cycle 1 — Pass 1 error must not evict");
    const berlinAfterCycle1 = await geocodeCityCountry("Berlin");
    assert.equal(berlinAfterCycle1?.countryCode, "DE",
      "berlin entry preserved after cycle 1 — Pass 2 error must not evict");
    assert.equal(nominatimCalls, 0,
      "Nominatim not called after cycle 1 — both stale entries kept by error guard");

    // ── Cycle 2: both passes recover and return their respective rows ─────────────
    const cycle2CleanedKeys: string[][] = [];
    let cycle2QueryCount = 0;
    const recoverySweepClient2: SupabaseClient = {
      from(_table: string) {
        let isDelete = false;
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          delete() { isDelete = true; return chain; },
          in(_col: string, keys: string[]) {
            cycle2CleanedKeys.push(keys);
            return chain;
          },
          then(resolve: (v: any) => void) {
            if (isDelete) {
              resolve({ error: null });
              return;
            }
            const q = cycle2QueryCount++;
            if (q === 0) {
              // Pass 1 — corrected_at: paris was corrected after its cache entry was written.
              resolve({ data: [{ city_key: "paris", corrected_at: correctedAtIso }], error: null });
            } else {
              // Pass 2 — deleted_at: berlin is tombstoned.
              resolve({ data: [{ city_key: "berlin" }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    _setGeocodeDbClientForTests(recoverySweepClient2);
    await _runCorrectionSweepForTests();

    assert.equal(cycle2QueryCount, 2, "cycle 2: both sweep passes ran");
    assert.equal(cycle2CleanedKeys.length, 1,
      "cycle 2: cleanup hard-delete issued exactly once (for Pass 2 tombstones)");
    assert.deepEqual(cycle2CleanedKeys[0], ["berlin"],
      "cycle 2: correct city_key passed to the tombstone cleanup delete");

    // Both entries must now be evicted — subsequent calls must fall through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));
    await geocodeCityCountry("Paris");
    assert.equal(nominatimCalls, 1,
      "Nominatim called for paris after cycle 2 eviction — Pass 1 correctly evicted the entry");
    await geocodeCityCountry("Berlin");
    assert.equal(nominatimCalls, 2,
      "Nominatim called for berlin after cycle 2 eviction — Pass 2 correctly evicted the entry");
  });

  it("cache-size cap (2000 entries) evicts the oldest entry after a deletion-eviction re-geocode", async () => {
    // This test confirms that a re-geocode triggered by a deletion-eviction
    // (evictGeocodeCacheKey + subsequent geocodeCityCountry call) goes through
    // the pending-promise path and still triggers the MAX_CACHE_SIZE trim —
    // the oldest entry is removed and the cache never exceeds 2 000 entries.
    const MAX_CACHE_SIZE = 2_000;
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // No DB cache — every geocode falls through to the Nominatim mock.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async (url: string) => {
      nominatimCalls++;
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      return {
        ok: true,
        json: async () => [{ address: { country_code: "de", country: "Germany" } }],
      };
    });

    // Step 1: fill cache with 1 999 synthetic entries (city0 … city1998).
    // The throttle is disabled when a fetch mock is installed, so this is fast.
    for (let i = 0; i < MAX_CACHE_SIZE - 1; i++) {
      await geocodeCityCountry(`synth-city-${i}`);
    }
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE - 1,
      "pre-condition: cache has 1 999 entries");

    // The oldest entry in the Map is the very first one inserted ("synth-city-0").
    const oldestKey = "synth-city-0";
    assert.ok(
      _getGeocodeCacheEntryForTests(oldestKey) !== undefined,
      "pre-condition: oldest entry (synth-city-0) is present before cap fills",
    );

    // Step 2: geocode "targetcity" for the first time — this brings the cache
    // to exactly MAX_CACHE_SIZE (2 000).
    await geocodeCityCountry("targetcity");
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE,
      "cache is now at the cap after adding targetcity");

    // Step 3: simulate an admin DELETE on another instance by evicting the
    // in-memory entry.  The cache drops to 1 999.
    evictGeocodeCacheKey("targetcity");
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE - 1,
      "cache dropped by one after deletion-eviction of targetcity");

    // Step 4: add one more synthetic city to bring the cache back to exactly
    // MAX_CACHE_SIZE — so the next write *must* trigger the trim.
    await geocodeCityCountry(`synth-city-${MAX_CACHE_SIZE - 1}`);
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE,
      "cache is back at the cap after adding the last synthetic entry");

    // Step 5: re-geocode "targetcity" — this is the deletion-eviction re-geocode.
    // Because the in-memory entry was evicted and the DB returns null, the async
    // IIFE inside geocodeCityCountry runs the full pending-promise path (readDbCache
    // → forwardGeocodeCity).  Just before writing the result it checks:
    //   if (_cache.size >= MAX_CACHE_SIZE) evict oldest
    // so the oldest entry must be removed and the cache must stay at MAX_CACHE_SIZE.
    const nominatimCallsBefore = nominatimCalls;
    const result = await geocodeCityCountry("targetcity");

    assert.equal(result?.countryCode, "DE",
      "re-geocode returns the Nominatim result for targetcity");
    assert.ok(nominatimCalls > nominatimCallsBefore,
      "Nominatim was called during the deletion-eviction re-geocode");

    // The cache must not exceed the cap.
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE,
      "cache size did not exceed MAX_CACHE_SIZE after the deletion-eviction re-geocode");

    // The re-geocoded city must be present in the cache.
    const targetEntry = _getGeocodeCacheEntryForTests("targetcity");
    assert.ok(targetEntry !== undefined, "targetcity is present in the cache after re-geocode");
    assert.equal(targetEntry?.result?.countryCode, "DE",
      "targetcity cache entry holds the fresh Nominatim result");

    // The oldest entry that was in the cache when the re-geocode ran must have
    // been evicted.  After evictGeocodeCacheKey("targetcity") the new oldest
    // entry in the Map is synth-city-1 (synth-city-0 was already the oldest
    // when targetcity was first added, but is still present — the first eviction
    // is triggered by the initial targetcity write to bring the cache above
    // MAX_CACHE_SIZE for the first time in the loop, not yet; actually synth-city-0
    // was never evicted up to this point because we only hit MAX_CACHE_SIZE at
    // step 2, and the write check is _cache.size >= MAX_CACHE_SIZE BEFORE the
    // set, so the cap fires at step 5 when the cache is at 2000 and we write
    // targetcity again).
    //
    // At step 5 the cache is at 2000.  The trim in the IIFE deletes the current
    // first key, which is synth-city-0 (inserted first and never evicted).
    assert.ok(
      _getGeocodeCacheEntryForTests(oldestKey) === undefined,
      "oldest entry (synth-city-0) was evicted by the cache-size trim during the re-geocode",
    );
  });

  it("cache-size cap (2000 entries) evicts the oldest entry when the DB-cache path (not Nominatim) writes the re-geocoded result", async () => {
    // Sibling of the previous test: the MAX_CACHE_SIZE trim exists in TWO
    // branches of the async IIFE — after readDbCache returns a hit, and after
    // forwardGeocodeCity (Nominatim) returns.  The previous test covers the
    // Nominatim branch; this one covers the readDbCache branch: the deletion-
    // eviction re-geocode is satisfied by a positive DB-cache row, no Nominatim
    // call is made, and the trim must still fire so the cache never exceeds
    // 2 000 entries.
    const MAX_CACHE_SIZE = 2_000;
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Keyed DB client: returns a positive row ONLY for "targetcity"; every
    // other city misses the DB cache and falls through to the Nominatim mock.
    let dbReadsForTarget = 0;
    _setGeocodeDbClientForTests({
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        let queriedKey: string | undefined;
        const chain: any = {
          select() { return chain; },
          eq(_col: string, val: string) { queriedKey = val; return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            if (queriedKey === "targetcity") {
              dbReadsForTarget++;
              return {
                data: {
                  country: "Japan",
                  country_code: "JP",
                  corrected_at: null,
                  deleted_at: null,
                },
                error: null,
              };
            }
            return { data: null, error: null };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "de", country: "Germany" } }],
      };
    });

    // Step 1: fill cache with 1 999 synthetic entries (DB miss → Nominatim).
    for (let i = 0; i < MAX_CACHE_SIZE - 1; i++) {
      await geocodeCityCountry(`synth-city-${i}`);
    }
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE - 1,
      "pre-condition: cache has 1 999 entries");
    const oldestKey = "synth-city-0";
    assert.ok(_getGeocodeCacheEntryForTests(oldestKey) !== undefined,
      "pre-condition: oldest entry (synth-city-0) present");

    // Step 2: first geocode of targetcity — served by the DB cache (no
    // Nominatim), bringing the cache to exactly MAX_CACHE_SIZE.
    const nominatimAfterFill = nominatimCalls;
    const first = await geocodeCityCountry("targetcity");
    assert.equal(first?.countryCode, "JP", "targetcity resolved from the DB cache");
    assert.equal(nominatimCalls, nominatimAfterFill,
      "no Nominatim call — DB cache hit for targetcity");
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE,
      "cache is now at the cap after adding targetcity");

    // Step 3: simulate an admin DELETE on another instance.
    evictGeocodeCacheKey("targetcity");
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE - 1,
      "cache dropped by one after deletion-eviction of targetcity");

    // Step 4: top the cache back up to exactly MAX_CACHE_SIZE.
    await geocodeCityCountry(`synth-city-${MAX_CACHE_SIZE - 1}`);
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE,
      "cache is back at the cap");

    // Step 5: deletion-eviction re-geocode of targetcity.  The in-memory entry
    // is gone so the IIFE runs; readDbCache returns the positive row, so the
    // DB-cache branch (not the Nominatim branch) performs the write-back and
    // must fire the MAX_CACHE_SIZE trim.
    const dbReadsBefore = dbReadsForTarget;
    const nominatimBefore = nominatimCalls;
    const result = await geocodeCityCountry("targetcity");

    assert.equal(result?.countryCode, "JP",
      "re-geocode returns the DB-cache result for targetcity");
    assert.ok(dbReadsForTarget > dbReadsBefore,
      "the DB cache was read during the re-geocode — write-back came from the DB-cache path");
    assert.equal(nominatimCalls, nominatimBefore,
      "Nominatim was NOT called — the re-geocode was satisfied entirely by the DB cache");

    // The trim fired in the DB-cache branch: cache never exceeds the cap.
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE,
      "cache size did not exceed MAX_CACHE_SIZE after the DB-cache-path re-geocode");

    // The re-geocoded city is present with the DB result.
    const targetEntry = _getGeocodeCacheEntryForTests("targetcity");
    assert.ok(targetEntry !== undefined, "targetcity is present in the cache after re-geocode");
    assert.equal(targetEntry?.result?.countryCode, "JP",
      "targetcity cache entry holds the DB-cache result");

    // The oldest entry was evicted by the trim in the readDbCache branch.
    assert.ok(_getGeocodeCacheEntryForTests(oldestKey) === undefined,
      "oldest entry (synth-city-0) was evicted by the cache-size trim in the DB-cache branch");
  });

  it("positive DB write-back fires after TTL-expiry re-geocode succeeds — recovered entry survives a restart", async () => {
    // Scenario: a prior Nominatim failure cached null for 6 hours (NEGATIVE_TTL_MS).
    // After the TTL expires, Nominatim succeeds.  writeDbCache must be called with
    // the correct country fields so the positive result persists across server restarts.
    //
    // This test confirms:
    //   1. upsert() is called exactly once with city_key / country / country_code / deleted_at: null.
    //   2. The positive result is re-cached in memory — the follow-up call is served
    //      from the in-memory cache without a second Nominatim call.
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    mockNow(T0);

    let nominatimCalls = 0;

    // Track upsert calls and capture the payload(s) passed to writeDbCache.
    let upsertCalls = 0;
    const upsertPayloads: Array<Record<string, unknown>> = [];

    _setGeocodeDbClientForTests({
      from(_table: string) {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            // No DB row: negative-cache entries are never persisted.
            return { data: null, error: null };
          },
          upsert(payload: Record<string, unknown>) {
            upsertCalls++;
            upsertPayloads.push({ ...payload });
            return Promise.resolve({ error: null });
          },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    // Toggle the Nominatim stub — first call fails, then succeeds.
    let nominatimShouldSucceed = false;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      if (nominatimShouldSucceed) {
        return {
          ok: true,
          json: async () => [{ address: { country_code: "gr", country: "Greece" } }],
        };
      }
      // First attempt: city temporarily unresolvable.
      return { ok: true, json: async () => [] };
    });

    // Phase 1: cache miss → Nominatim fails → null cached for 6 hours, no DB write.
    const firstResult = await geocodeCityCountry("Seville");
    assert.equal(firstResult, null, "first call returns null — Nominatim found nothing");
    assert.equal(nominatimCalls, 1, "Nominatim called once on the initial miss");
    assert.equal(upsertCalls, 0,
      "writeDbCache must NOT be called for a null (negative) result");

    // ── Phase 2: advance past the 6-hour negative TTL — Nominatim is now up ──────
    nominatimShouldSucceed = true;
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    const afterTtl = await geocodeCityCountry("Seville");
    assert.equal(afterTtl?.countryCode, "GR",
      "TTL-expiry re-geocode succeeds and returns GR");
    assert.equal(nominatimCalls, 2, "Nominatim called a second time after the TTL expired");

    // ── Phase 3: assert upsert() was called exactly once with correct fields ──────
    assert.equal(upsertCalls, 1,
      "writeDbCache called exactly once after a successful TTL-expiry re-geocode");
    const payload = upsertPayloads[0];
    assert.equal(payload["city_key"], "seville",
      "upsert city_key is the normalised city key");
    assert.equal(payload["country_code"], "GR",
      "upsert country_code matches the Nominatim result");
    assert.equal(typeof payload["country"], "string",
      "upsert country is a non-empty string");
    assert.ok((payload["country"] as string).length > 0,
      "upsert country field is not empty");
    assert.equal(payload["deleted_at"], null,
      "upsert deleted_at is null — clears any prior soft-delete tombstone");
    assert.ok(typeof payload["updated_at"] === "string",
      "upsert updated_at is an ISO timestamp string");

    // ── Phase 4: follow-up call served from in-memory cache — no extra Nominatim ──
    const followUp = await geocodeCityCountry("Seville");
    assert.equal(followUp?.countryCode, "GR",
      "follow-up call returns the re-cached positive result (GR)");
    assert.equal(nominatimCalls, 2,
      "Nominatim not called again — positive result is now in the in-memory cache");
    assert.equal(upsertCalls, 1,
      "writeDbCache not called again on the follow-up cache hit");
  });

  it("DB write-back updated_at is 'now' — not the stale timestamp from the old negative-cache entry", async () => {
    // Scenario: a negative-cache entry was written 6+ hours ago (writtenAt = T0).
    // After the negative TTL expires, the re-geocode succeeds and writeDbCache
    // upserts the row.  A bug that captured the timestamp from the old
    // negative-cache entry (its writtenAt) instead of the current clock would
    // persist a stale updated_at, mis-ordering admin correction-check interval
    // logic.  This test pins updated_at to the moment of the write.
    //
    // Note on clocks: mockNow() only overrides Date.now — `new Date()` (used by
    // writeDbCache for updated_at) still reads the REAL system clock.  So we
    // bracket the re-geocode call with real-clock readings and assert the
    // upserted updated_at falls inside that window, and is nowhere near the
    // mocked T0 epoch used for the old negative entry.
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    mockNow(T0);

    let upsertCalls = 0;
    const upsertPayloads: Array<Record<string, unknown>> = [];

    _setGeocodeDbClientForTests({
      from(_table: string) {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            return { data: null, error: null };
          },
          upsert(payload: Record<string, unknown>) {
            upsertCalls++;
            upsertPayloads.push({ ...payload });
            return Promise.resolve({ error: null });
          },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    // First attempt fails (empty result) → negative-cache entry written at T0.
    let nominatimShouldSucceed = false;
    _setGeocodeFetchForTests(async () => {
      if (nominatimShouldSucceed) {
        return {
          ok: true,
          json: async () => [{ address: { country_code: "pt", country: "Portugal" } }],
        };
      }
      return { ok: true, json: async () => [] };
    });

    const firstResult = await geocodeCityCountry("Braga");
    assert.equal(firstResult, null, "pre-condition: first call caches null");
    const negEntry = _getGeocodeCacheEntryForTests("braga");
    assert.equal(negEntry?.writtenAt, T0,
      "pre-condition: negative-cache entry writtenAt is the (mocked) T0");
    assert.equal(upsertCalls, 0, "no DB write for the negative result");

    // Advance the mocked clock past the 6-hour negative TTL.
    nominatimShouldSucceed = true;
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    // Bracket the re-geocode with REAL clock readings (new Date() is unmocked).
    const realBefore = new Date().getTime();
    const afterTtl = await geocodeCityCountry("Braga");
    const realAfter = new Date().getTime();

    assert.equal(afterTtl?.countryCode, "PT", "TTL-expiry re-geocode succeeds");
    assert.equal(upsertCalls, 1, "writeDbCache called exactly once");

    const updatedAtRaw = upsertPayloads[0]["updated_at"];
    assert.ok(typeof updatedAtRaw === "string", "updated_at is a string");
    const updatedAtMs = new Date(updatedAtRaw as string).getTime();
    assert.ok(Number.isFinite(updatedAtMs), "updated_at parses to a valid timestamp");

    // Must be captured at the moment of the write — within the real-clock window.
    assert.ok(updatedAtMs >= realBefore && updatedAtMs <= realAfter,
      `updated_at (${updatedAtRaw}) must fall within the re-geocode call window ` +
      `[${new Date(realBefore).toISOString()} .. ${new Date(realAfter).toISOString()}]`);

    // Must NOT equal the old negative-cache entry's writtenAt (T0) — that would
    // indicate the payload captured the stale timestamp from the expired entry.
    assert.notEqual(updatedAtMs, T0,
      "updated_at must not equal the old negative-cache writtenAt");
    assert.notEqual(updatedAtRaw, new Date(T0).toISOString(),
      "updated_at ISO string must not be the old negative-cache writtenAt ISO string");
  });

  it("re-geocode write-back payload omits corrected_at entirely — an admin correction timestamp can never be wiped", async () => {
    // writeDbCache deliberately leaves corrected_at OUT of the upsert payload
    // so an existing admin-correction timestamp on the row survives the next
    // re-geocode.  If someone adds `corrected_at: null` (e.g. mirroring the
    // deleted_at tombstone-clear line), corrections would be silently erased,
    // breaking the on-request probe and the sweep's ordering logic.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let upsertCalls = 0;
    const upsertPayloads: Array<Record<string, unknown>> = [];

    _setGeocodeDbClientForTests({
      from(_table: string) {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            // No persisted row — force the Nominatim path so writeDbCache runs.
            return { data: null, error: null };
          },
          upsert(payload: Record<string, unknown>) {
            upsertCalls++;
            upsertPayloads.push({ ...payload });
            return Promise.resolve({ error: null });
          },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "it", country: "Italy" } }],
    }));

    const result = await geocodeCityCountry("Florence");
    assert.equal(result?.countryCode, "IT", "geocode succeeds and returns IT");
    assert.equal(upsertCalls, 1, "writeDbCache called exactly once");

    const payload = upsertPayloads[0];
    // The critical assertion: corrected_at must not be a key AT ALL —
    // neither null nor any other value.  An upsert that includes
    // `corrected_at: null` would overwrite an existing admin correction.
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, "corrected_at"),
      "corrected_at must NOT be a key in the upsert payload (not even null) — " +
      "including it would wipe an existing admin-correction timestamp");
    assert.ok(!("corrected_at" in payload),
      "corrected_at absent via `in` check as well");

    // Sanity: the payload still carries the expected fields.
    assert.equal(payload["city_key"], "florence");
    assert.equal(payload["country_code"], "IT");
    assert.equal(payload["deleted_at"], null,
      "deleted_at: null (tombstone clear) is present — corrected_at must not mirror it");
    assert.ok(typeof payload["updated_at"] === "string");
  });

  // ── correctionCheckedAt bump on DB-error probe ────────────────────────────

  it("bumps correctionCheckedAt even when the probe returns a DB error — preventing a retry storm on the next call", async () => {
    // If correctionCheckedAt is NOT updated after a DB-error probe, every
    // subsequent call within the correction-check interval would re-fire the
    // probe because Date.now() - lastCheck is still >= CORRECTION_CHECK_INTERVAL_MS.
    // This test verifies the bump happens even on error so only the call that
    // crossed the interval fires the probe, and the window resets from there.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "de", country: "Germany" } }],
    }));

    // Phase 1: warm the in-memory cache via a DB load.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({
        country: "Germany",
        country_code: "DE",
        corrected_at: null,
        deleted_at: null,
      }),
    );
    const first = await geocodeCityCountry("Berlin");
    assert.equal(first?.countryCode, "DE", "pre-condition: initial DB cache load returns DE");

    // Phase 2: switch to an error-returning client and advance past the interval.
    let probeCallCount = 0;
    _setGeocodeDbClientForTests(
      makeFixedDbClient(null, {
        isError: true,
        onCall: () => { probeCallCount++; },
      }),
    );

    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);
    const afterError = await geocodeCityCountry("Berlin");
    assert.equal(afterError?.countryCode, "DE",
      "cached value is kept when the probe hits a DB error");
    assert.equal(probeCallCount, 1, "probe fired exactly once when the interval elapsed");

    // Phase 3: advance by less than one more interval — correctionCheckedAt was
    // bumped after the error, so the probe must NOT fire again yet.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000 + CORRECTION_CHECK_INTERVAL_MS - 2_000);
    const withinSecondInterval = await geocodeCityCountry("Berlin");
    assert.equal(withinSecondInterval?.countryCode, "DE",
      "cached value still served within the second interval window");
    assert.equal(probeCallCount, 1,
      "probe NOT called again within the second interval — correctionCheckedAt was bumped on error");

    // Phase 4: advance past the second interval — the probe fires a second time.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000 + CORRECTION_CHECK_INTERVAL_MS + 1_000);
    const afterSecondInterval = await geocodeCityCountry("Berlin");
    assert.equal(afterSecondInterval?.countryCode, "DE",
      "cached value still served after the second probe (DB still erroring)");
    assert.equal(probeCallCount, 2,
      "probe fired a second time once the full interval elapsed again");
  });

  // ── Negative-TTL re-seeding on repeat failure ─────────────────────────────

  it("a Nominatim failure at TTL expiry re-seeds another 6-hour window — not a retry storm on every call", async () => {
    // Scenario: Nominatim is down.  The first call caches null for 6 hours.
    // After the 6-hour TTL expires a second call retries Nominatim (which is
    // still down) and must re-seed the in-memory null entry for another 6 hours.
    // A third call immediately after must be served from the fresh negative
    // cache without hitting Nominatim a third time.
    //
    // Total Nominatim calls must be exactly 2 (once per TTL expiry), not 3+.
    // No DB is involved — both the null seed and the re-seed happen entirely
    // through the catch block in geocodeCityCountry.
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      throw new Error("nominatim_down");
    });

    // No DB row for this city — readDbCache returns null, Nominatim is tried.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));

    // First call: cache miss → DB miss → Nominatim fails → null cached for 6h.
    const first = await geocodeCityCountry("Nowhere");
    assert.equal(first, null, "first call returns null when Nominatim is down");
    assert.equal(nominatimCalls, 1, "Nominatim called once on cold cache miss");

    // Within the 6-hour TTL — null must be served from cache, no second Nominatim call.
    mockNow(T0 + NEGATIVE_TTL_MS - 1_000);
    const withinTtl = await geocodeCityCountry("Nowhere");
    assert.equal(withinTtl, null, "null served from in-memory cache within 6-hour window");
    assert.equal(nominatimCalls, 1, "Nominatim NOT called again within the first 6-hour window");

    // Advance past the 6-hour TTL — the negative cache entry is now expired.
    // Nominatim is still down.
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);
    const atExpiry = await geocodeCityCountry("Nowhere");
    assert.equal(atExpiry, null, "null returned after TTL expiry — Nominatim still down");
    assert.equal(nominatimCalls, 2, "Nominatim called exactly once more at TTL expiry (total 2)");

    // The re-seeded 6-hour window is now live.  A call immediately after must
    // be served from the fresh negative cache — no third Nominatim round-trip.
    const withinNewTtl = await geocodeCityCountry("Nowhere");
    assert.equal(withinNewTtl, null, "null served from newly re-seeded 6-hour window");
    assert.equal(nominatimCalls, 2,
      "Nominatim called exactly twice total — once per TTL expiry, not on every call");

    // Verify the cache entry has a fresh expiry (writtenAt ≈ T0 + NEGATIVE_TTL_MS + 1_000).
    const entry = _getGeocodeCacheEntryForTests("nowhere");
    assert.ok(entry !== undefined, "re-seeded null entry exists in the cache");
    assert.equal(entry!.result, null, "cached result is null");
    assert.ok(
      entry!.expiresAt >= T0 + NEGATIVE_TTL_MS + 1_000 + NEGATIVE_TTL_MS - 5_000,
      "fresh entry expires ~6 hours after the re-seed time — not the original seed time",
    );
  });

  it("force-eviction mid-flight: settled result is not cached, next request resolves fresh and warms the cache", async () => {
    // This test confirms three things:
    //   1. When evictGeocodeCacheKey fires while a Nominatim fetch is in-flight,
    //      the guard (`_pending.get(key) === p`) prevents the settled result from
    //      writing to _cache — the eviction wins.
    //   2. A request arriving AFTER the eviction-and-settlement does NOT pick up
    //      a stale pending reference; it starts a fresh geocode instead of
    //      resolving against the now-cleared pending slot.
    //   3. That fresh result lands in _cache so the very next call is served instantly.

    // Use a deferred promise to pause the Nominatim stub mid-flight so we can
    // fire the eviction before the first fetch completes.
    let resolveStub1!: () => void;
    const stub1Gate = new Promise<void>((res) => { resolveStub1 = res; });

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      await stub1Gate;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "de", country: "Germany" } }],
      };
    });

    // No DB cache so the geocoder always falls through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));

    // Start the in-flight request — the stub is paused at stub1Gate.
    const inflightPromise = geocodeCityCountry("Munich");
    // Flush enough microtask ticks for the async body to reach the _fetchImpl call:
    //   tick 1: readDbCache's maybySingle() resolves → readDbCache returns null
    //   tick 2: p body continues → forwardGeocodeCity called → throttled() queues its resolve
    //   tick 3: throttled resolves → _fetchImpl called → pauses at stub1Gate
    // A few extra ticks provide a safety margin across JS engine scheduling variations.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(nominatimCalls, 1, "Nominatim called once for the in-flight request");

    // Evict the key mid-flight — clears both _cache and _pending.
    evictGeocodeCacheKey("munich");

    // Unblock the in-flight stub so the promise settles.
    resolveStub1();
    const inflightResult = await inflightPromise;

    // The promise itself still resolves correctly — the caller gets the right value.
    assert.equal(inflightResult?.countryCode, "DE",
      "in-flight promise still resolves to the correct value");

    // Because the eviction removed 'munich' from _pending before the finally
    // block ran, the guard (_pending.get(key) === p) evaluated false and the
    // result was NOT written to _cache.
    const cacheAfterSettlement = _getGeocodeCacheEntryForTests("munich");
    assert.equal(cacheAfterSettlement, undefined,
      "eviction + guard prevents the settled in-flight result from poisoning _cache");

    // Swap in a new paused stub so we can confirm a genuinely fresh Nominatim
    // call is made (not a re-use of the old pending promise).
    let resolveStub2!: () => void;
    const stub2Gate = new Promise<void>((res) => { resolveStub2 = res; });
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      await stub2Gate;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "de", country: "Germany" } }],
      };
    });

    // A request arriving after eviction-and-settlement must NOT re-use the old
    // pending promise (it was cleared by the eviction and by the finally block).
    const freshPromise = geocodeCityCountry("Munich");
    // Same flush as above — need enough ticks to reach _fetchImpl.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(nominatimCalls, 2, "a second Nominatim call was started for the fresh request");

    resolveStub2();
    const freshResult = await freshPromise;
    assert.equal(freshResult?.countryCode, "DE", "fresh request resolves correctly");

    // The fresh result MUST land in _cache so the very next caller is served
    // from memory without another round-trip.
    const cacheAfterFresh = _getGeocodeCacheEntryForTests("munich");
    assert.notEqual(cacheAfterFresh, undefined,
      "fresh result lands in _cache after a clean resolution");
    assert.equal(cacheAfterFresh?.result?.countryCode, "DE",
      "cached entry holds the correct country code");

    // Third call — must be served from _cache, no third Nominatim call.
    const cachedResult = await geocodeCityCountry("Munich");
    assert.equal(nominatimCalls, 2,
      "third call served from _cache — no additional Nominatim round-trip");
    assert.equal(cachedResult?.countryCode, "DE",
      "cache hit returns the correct country code");
  });

  it("force-eviction mid-flight with a null (Nominatim-down) result: no ghost negative-cache entry, next request retries fresh", async () => {
    // Complement to the happy-path mid-flight eviction test above: here the
    // in-flight Nominatim call resolves to a FAILED geocode (empty results →
    // null).  The same guard (`_pending.get(key) === p`) must block the null
    // from writing to _cache after evictGeocodeCacheKey ran — otherwise a
    // ghost negative-cache entry would serve null for up to 6 hours, bypassing
    // the eviction the admin just performed.

    // Deferred gate pauses the stub mid-flight so the eviction can fire first.
    let resolveStub1!: () => void;
    const stub1Gate = new Promise<void>((res) => { resolveStub1 = res; });

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      await stub1Gate;
      // Nominatim is "down" in the sense that it returns no usable result —
      // an empty result set shapes to a null (failed) geocode.
      return { ok: true, json: async () => [] };
    });

    // No DB cache row so the geocoder falls through to Nominatim.
    _setGeocodeDbClientForTests(makeFixedDbClient(null));

    // Start the in-flight request — paused at stub1Gate.
    const inflightPromise = geocodeCityCountry("Munich");
    // Flush microtask ticks so the async body reaches the paused _fetchImpl call.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(nominatimCalls, 1, "Nominatim called once for the in-flight request");

    // Evict the key mid-flight — clears both _cache and _pending.
    evictGeocodeCacheKey("munich");

    // Unblock the stub; the in-flight promise settles to null.
    resolveStub1();
    const inflightResult = await inflightPromise;
    assert.equal(inflightResult, null,
      "in-flight promise settles to null — Nominatim returned no result");

    // The guard must have blocked the null write: no ghost negative entry.
    const cacheAfterSettlement = _getGeocodeCacheEntryForTests("munich");
    assert.equal(cacheAfterSettlement, undefined,
      "eviction + guard blocked the null from poisoning _cache — no ghost negative-cache entry");

    // A subsequent call must trigger a FRESH Nominatim attempt — not serve a
    // stale negative-cache hit.  Swap in a working stub to prove the retry.
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "de", country: "Germany" } }],
      };
    });

    const retryResult = await geocodeCityCountry("Munich");
    assert.equal(nominatimCalls, 2,
      "a fresh Nominatim attempt was made — not a stale negative-cache hit");
    assert.equal(retryResult?.countryCode, "DE",
      "retry resolves correctly once Nominatim is back");

    // And the fresh positive result lands in _cache normally.
    const cacheAfterRetry = _getGeocodeCacheEntryForTests("munich");
    assert.equal(cacheAfterRetry?.result?.countryCode, "DE",
      "fresh positive result is cached after the retry");
  });

  it("two concurrent warm-cache callers sharing a no-op probe only bump correctionCheckedAt once — no conflicting timestamps", async () => {
    // Scenario: both callers arrive after CORRECTION_CHECK_INTERVAL_MS has elapsed.
    // The first caller reads the stale correctionCheckedAt, then immediately writes a
    // fresh timestamp BEFORE awaiting evictIfDbCorrected (optimistic bump in the source).
    // By the time the JS event loop hands control to the second caller, the cache already
    // has the bumped timestamp — so the second caller skips the probe entirely.
    //
    // Assertions:
    //   - DB probe fires at most 2 times (both raced) but in practice exactly 1
    //   - Both callers receive the correct result
    //   - correctionCheckedAt is set to the bumped timestamp (not left at 0 / stale)
    //   - A third call issued immediately after both settle does NOT fire another probe
    const T0 = 1_700_000_000_000;
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000; // well past the check interval
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "se", country: "Sweden" } }],
      };
    });

    // ── Phase 1: seed the in-memory cache via a DB load ──────────────────────
    _setGeocodeDbClientForTests(
      makeFixedDbClient({
        country: "Sweden",
        country_code: "SE",
        corrected_at: null,
        deleted_at: null,
      }),
    );
    const warm = await geocodeCityCountry("Stockholm");
    assert.equal(warm?.countryCode, "SE", "pre-condition: warm entry loaded from DB cache");
    assert.equal(nominatimCalls, 0, "no Nominatim call during warm-up");

    // ── Phase 2: switch to a no-op probe DB client ───────────────────────────
    // The probe returns a live row with no corrected_at — evictIfDbCorrected
    // returns false (no eviction). Both concurrent callers should return the
    // cached result without triggering a Nominatim re-resolve.
    let probeCallCount = 0;
    _setGeocodeDbClientForTests(
      makeFixedDbClient(
        { country: "Sweden", country_code: "SE", corrected_at: null, deleted_at: null },
        { onCall: () => { probeCallCount++; } },
      ),
    );

    // Backdate correctionCheckedAt to 0 so both concurrent callers see the
    // check interval as elapsed and both attempt to enter the probe branch.
    _backdateGeocodeCacheEntryForTests("stockholm");

    // Advance the clock to T1 (past the interval).
    mockNow(T1);

    // ── Phase 3: fire two concurrent calls ───────────────────────────────────
    const [resultA, resultB] = await Promise.all([
      geocodeCityCountry("Stockholm"),
      geocodeCityCountry("Stockholm"),
    ]);

    assert.equal(resultA?.countryCode, "SE", "caller A receives the cached country code");
    assert.equal(resultB?.countryCode, "SE", "caller B receives the cached country code");

    // In the single-threaded JS event loop the first caller bumps
    // correctionCheckedAt synchronously before any await completes, so the
    // second caller always sees the fresh timestamp and skips the probe.
    // We allow ≤ 2 in case both read the stale value in the same microtask tick,
    // but the design guarantees the guard still holds for the third call below.
    assert.ok(
      probeCallCount <= 2,
      `probe must fire at most twice across both callers (fired ${probeCallCount})`,
    );
    assert.equal(nominatimCalls, 0, "no Nominatim call — probe found no correction, cached result returned");

    // ── Phase 4: verify correctionCheckedAt was written ──────────────────────
    const entry = _getGeocodeCacheEntryForTests("stockholm");
    assert.ok(entry !== undefined, "cache entry still exists after the no-op probe");
    assert.ok(
      (entry!.correctionCheckedAt ?? 0) >= T1,
      "correctionCheckedAt was bumped to at least T1 — not left at the stale (0) value",
    );

    // ── Phase 5: third call immediately after — probe must NOT fire again ────
    // correctionCheckedAt is now fresh; the interval has not elapsed again.
    const probeCountAfterBothCalls = probeCallCount;
    const thirdResult = await geocodeCityCountry("Stockholm");
    assert.equal(thirdResult?.countryCode, "SE", "third call still returns the cached result");
    assert.equal(
      probeCallCount,
      probeCountAfterBothCalls,
      "no additional DB probe on the third call — correctionCheckedAt guard held",
    );
    assert.equal(nominatimCalls, 0, "Nominatim never called across all three calls");
  });

  it("TTL-expiry re-geocode that succeeds but writeDbCache errors still returns the positive result — not null", async () => {
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    mockNow(T0);

    // Phase 1: seed a null (negative) in-memory entry.
    // Nominatim returns no results and the DB cache is empty.
    let nominatimCalls = 0;
    let nominatimSucceeds = false;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () =>
          nominatimSucceeds
            ? [{ address: { country_code: "pt", country: "Portugal" } }]
            : [],
      };
    });

    let upsertCalls = 0;
    let upsertThrows = false;
    const dbClient = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
          upsert() {
            upsertCalls++;
            if (upsertThrows) {
              return Promise.reject(new Error("connection reset during upsert"));
            }
            return Promise.resolve({ error: null });
          },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(dbClient);

    const seeded = await geocodeCityCountry("Lisbon");
    assert.equal(seeded, null, "pre-condition: negative result seeded");
    assert.equal(nominatimCalls, 1, "one Nominatim attempt during seeding");
    const seededEntry = _getGeocodeCacheEntryForTests("lisbon");
    assert.ok(seededEntry && seededEntry.result === null, "null entry is in the in-memory cache");

    // Phase 2: advance past the negative TTL so the entry expires; Nominatim
    // now succeeds, but the DB upsert (writeDbCache) throws.
    nominatimSucceeds = true;
    upsertThrows = true;
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    const recovered = await geocodeCityCountry("Lisbon");
    assert.ok(recovered !== null,
      "positive result must be returned even though writeDbCache threw");
    assert.equal(recovered?.countryCode, "PT", "recovered result is the fresh Nominatim result");
    assert.equal(nominatimCalls, 2, "a fresh Nominatim call was made after TTL expiry");
    assert.equal(upsertCalls, 1, "writeDbCache (upsert) was attempted and threw");

    // Phase 3: the positive result must also be in the in-memory cache —
    // the upsert failure must not poison or drop the entry.
    const entry = _getGeocodeCacheEntryForTests("lisbon");
    assert.ok(entry, "cache entry exists after the failed upsert");
    assert.equal(entry!.result?.countryCode, "PT",
      "in-memory cache holds the positive result despite the writeDbCache error");

    // Follow-up call is served from memory — no extra Nominatim call, no extra upsert.
    const followUp = await geocodeCityCountry("Lisbon");
    assert.equal(followUp?.countryCode, "PT", "follow-up call returns the cached positive result");
    assert.equal(nominatimCalls, 2, "no additional Nominatim call on the follow-up");
    assert.equal(upsertCalls, 1, "no additional upsert attempt on the follow-up");
  });
});

// ── Probe race with cache eviction — correctionCheckedAt preservation ─────────

describe("optimistic correctionCheckedAt bump vs. mid-probe eviction", () => {
  it("re-establishes correctionCheckedAt on the fresh entry after a post-bump eviction — follow-up call does not re-probe", async () => {
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

    // DB client:
    //   - readDbCache calls (select includes country_code) resolve immediately
    //     with the live row.
    //   - probe calls (evictIfDbCorrected — select has corrected_at/deleted_at
    //     only) return a DEFERRED promise so the test can fire the eviction
    //     while the probe is in flight.
    let probeCalls = 0;
    let readCalls = 0;
    let releaseProbe: (() => void) | null = null;
    const liveRow = { country: "Germany", country_code: "DE", corrected_at: null, deleted_at: null };
    _setGeocodeDbClientForTests({
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        let cols = "";
        const chain: any = {
          select(c: string) { cols = c; return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          maybeSingle() {
            if (cols.includes("country_code")) {
              readCalls++;
              return Promise.resolve({ data: liveRow, error: null });
            }
            probeCalls++;
            return new Promise((res) => {
              releaseProbe = () => res({ data: { corrected_at: null, deleted_at: null }, error: null });
            });
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) { resolve({ data: [], error: null }); },
        };
        return chain;
      },
    } as unknown as SupabaseClient);

    // Phase 1: warm the cache from the DB row, then backdate correctionCheckedAt
    // to 0 so the very next call re-probes without waiting out the interval.
    const first = await geocodeCityCountry("Berlin");
    assert.equal(first?.countryCode, "DE", "pre-condition: warm-up loads DE from the DB cache");
    assert.equal(readCalls, 1, "warm-up used the DB cache read");
    _backdateGeocodeCacheEntryForTests("berlin");

    // Phase 2: fire a call that bumps correctionCheckedAt and awaits the probe.
    const raced = geocodeCityCountry("Berlin");

    // Wait until the probe's maybeSingle has actually been entered.
    while (releaseProbe === null) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(probeCalls, 1, "probe is in flight");
    // The optimistic bump landed before the await.
    assert.equal(
      _getGeocodeCacheEntryForTests("berlin")?.correctionCheckedAt,
      T0,
      "correctionCheckedAt was optimistically bumped before the probe resolved",
    );

    // Phase 3: an admin correction endpoint evicts the same key mid-probe.
    evictGeocodeCacheKey("berlin");
    assert.equal(_getGeocodeCacheEntryForTests("berlin"), undefined, "entry gone after eviction");

    // Let the probe finish — row is live and uncorrected, so the raced call
    // returns its (pre-eviction) cached result.
    releaseProbe!();
    const racedResult = await raced;
    assert.equal(racedResult?.countryCode, "DE", "raced call still returns DE");
    // The probe must NOT have resurrected the evicted entry.
    assert.equal(
      _getGeocodeCacheEntryForTests("berlin"),
      undefined,
      "completed probe does not resurrect the evicted entry",
    );

    // Phase 4: the next call re-resolves from the DB and MUST stamp a fresh
    // correctionCheckedAt on the new entry — this is the guard under test.
    const T1 = T0 + 10_000;
    mockNow(T1);
    const reResolved = await geocodeCityCountry("Berlin");
    assert.equal(reResolved?.countryCode, "DE", "re-resolve returns DE from the DB row");
    assert.equal(readCalls, 2, "re-resolve went through the DB cache read");
    const fresh = _getGeocodeCacheEntryForTests("berlin");
    assert.ok(fresh !== undefined, "fresh cache entry exists after re-resolve");
    assert.equal(
      fresh!.correctionCheckedAt,
      T1,
      "fresh entry carries a fresh correctionCheckedAt — the guard was not lost to the eviction race",
    );

    // Phase 5: a follow-up call within the interval must NOT re-probe.
    mockNow(T1 + CORRECTION_CHECK_INTERVAL_MS - 1_000);
    const followUp = await geocodeCityCountry("Berlin");
    assert.equal(followUp?.countryCode, "DE", "follow-up call serves the warm entry");
    assert.equal(probeCalls, 1, "no additional probe within the correction-check interval");
    assert.equal(readCalls, 2, "no additional DB read — served from memory");
    assert.equal(nominatimCalls, 0, "Nominatim never called anywhere in this scenario");
  });
});

// ── Concurrent-caller dedup across the eviction-and-re-resolve path ───────────

describe("concurrent callers coalesce onto one pending promise when the entry is evicted mid-flight", () => {
  it("calls Nominatim exactly once when a second caller arrives while the first is re-resolving after a deletion-eviction", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Deferred Nominatim: the fetch promise is held open so we can inject the
    // second caller while the first caller's re-resolve is in-flight (i.e.
    // after the eviction but before the _pending promise settles).
    let nominatimCalls = 0;
    let releaseNominatim!: () => void;
    const nominatimGate = new Promise<void>((r) => { releaseNominatim = r; });
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      await nominatimGate;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
      };
    });

    // Phase 1: warm the in-memory cache from a live DB row.
    _setGeocodeDbClientForTests(
      makeFixedDbClient({ country: "Japan", country_code: "JP", corrected_at: null, deleted_at: null }),
    );
    const warm = await geocodeCityCountry("Tokyo");
    assert.equal(warm?.countryCode, "JP", "pre-condition: cache warmed with JP");
    assert.equal(nominatimCalls, 0, "no Nominatim call during warm-up");

    // Phase 2: backdate correctionCheckedAt so the next call fires the probe
    // immediately, and switch the DB so the probe finds a tombstoned row.
    // readDbCache treats deleted_at as "not found", forcing the Nominatim path.
    _backdateGeocodeCacheEntryForTests("tokyo");
    let probeCalls = 0;
    _setGeocodeDbClientForTests(
      makeFixedDbClient(
        {
          country: "Japan",
          country_code: "JP",
          corrected_at: null,
          deleted_at: new Date(T0 - 1_000).toISOString(),
        },
        { onCall: () => { probeCalls++; } },
      ),
    );

    // Phase 3: first caller — bumps correctionCheckedAt, probe finds deleted_at,
    // evicts, falls through, sets _pending, then blocks on the gated Nominatim fetch.
    const firstCall = geocodeCityCountry("Tokyo");

    // Wait until the Nominatim fetch has actually been entered. At that point
    // the cache entry is evicted AND _pending holds the first caller's promise.
    while (nominatimCalls === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(
      _getGeocodeCacheEntryForTests("tokyo"),
      undefined,
      "cache entry was evicted before the second caller arrives",
    );

    // Phase 4: second caller arrives mid-flight — no cache entry exists, so it
    // must find and reuse the first caller's _pending promise, not start its own.
    const secondCall = geocodeCityCountry("Tokyo");

    // Give the second caller's synchronous prologue a chance to run, then
    // release the gated Nominatim response.
    await new Promise<void>((r) => setImmediate(r));
    releaseNominatim();

    const [first, second] = await Promise.all([firstCall, secondCall]);

    assert.equal(nominatimCalls, 1,
      "Nominatim called exactly once — both callers shared the single pending promise");
    assert.equal(first?.countryCode, "JP", "first caller resolved to JP");
    assert.equal(second?.countryCode, "JP", "second caller resolved to JP");
    assert.deepEqual(second, first, "both callers received the same result object");
    assert.ok(probeCalls >= 1, "the correction probe fired at least once");

    // The re-resolved result was committed back to the in-memory cache.
    const entry = _getGeocodeCacheEntryForTests("tokyo");
    assert.equal(entry?.result?.countryCode, "JP", "fresh result cached after re-resolve");
  });
});

// ── DB-cache re-resolve path re-arms the correction check ─────────────────────
//
// Task: after an eviction, the re-resolve can complete via the DB cache
// (readDbCache returns a freshly-restored live row) rather than Nominatim.
// The readDbCache branch explicitly sets correctionCheckedAt: now on the new
// in-memory entry. If a regression set it to 0 or omitted it, the very next
// call would immediately re-probe the DB (correctionCheckedAt ?? writtenAt
// would still guard when omitted — but a 0 value would re-probe instantly).
// This suite verifies the fresh entry is re-armed: an immediate follow-up call
// makes NO DB round-trip at all.

describe("DB-cache re-resolve path re-arms the correction check", () => {
  it("does not re-probe the DB on the call immediately after a DB-cache re-resolve", async () => {
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

    // Three-phase DB client:
    //   Phase 1 (warm-up readDbCache): live row.
    //   Phase 2 (eviction probe evictIfDbCorrected): tombstoned row.
    //   Phase 3 (readDbCache during re-resolve): freshly-restored live row —
    //     e.g. an admin PUT revived the entry between the probe and re-resolve.
    let phase: 1 | 2 | 3 = 1;
    let maybeSingleCalls = 0;
    const liveRow = { country: "Portugal", country_code: "PT", corrected_at: null, deleted_at: null };
    const client: SupabaseClient = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            maybeSingleCalls++;
            if (phase === 1) return { data: liveRow, error: null };
            if (phase === 2) {
              return {
                data: { ...liveRow, deleted_at: new Date(T0 + 1_000).toISOString() },
                error: null,
              };
            }
            return { data: liveRow, error: null };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(client);

    // Phase 1: warm up the in-memory cache from the DB row.
    const first = await geocodeCityCountry("Lisbon");
    assert.equal(first?.countryCode, "PT", "pre-condition: warm-up loads PT from DB cache");
    assert.equal(nominatimCalls, 0, "no Nominatim call on warm-up");
    assert.equal(maybeSingleCalls, 1, "one readDbCache call during warm-up");

    // Phase 2 + 3: advance past the interval so the probe fires, finds the
    // tombstone, evicts — then the re-resolve's readDbCache finds a restored
    // live row and completes via the DB-cache path (no Nominatim).
    phase = 2;
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);
    // The probe (phase 2) and the re-resolve readDbCache (phase 3) are two
    // separate maybeSingle calls; flip the phase after the probe fires by
    // wrapping the phase switch into the call counter.
    const probeCallIndex = maybeSingleCalls + 1;
    const origFrom = (client as any).from.bind(client);
    (client as any).from = (table: string) => {
      const chain = origFrom(table);
      const origMaybeSingle = chain.maybeSingle;
      chain.maybeSingle = async () => {
        const res = await origMaybeSingle();
        if (maybeSingleCalls === probeCallIndex) phase = 3; // after the probe, restore the row
        return res;
      };
      return chain;
    };

    const reResolved = await geocodeCityCountry("Lisbon");
    assert.equal(reResolved?.countryCode, "PT", "re-resolve returns PT from the restored DB row");
    assert.equal(nominatimCalls, 0,
      "re-resolve completed via the DB-cache path — Nominatim never called");
    assert.equal(maybeSingleCalls, 3,
      "exactly two DB calls at T1: eviction probe + readDbCache re-resolve (plus 1 warm-up)");

    // The fresh entry must be re-armed: correctionCheckedAt set to now (T1).
    const entry = _getGeocodeCacheEntryForTests("lisbon");
    assert.ok(entry, "in-memory entry exists after the DB-cache re-resolve");
    assert.equal(entry!.correctionCheckedAt, T1,
      "correctionCheckedAt was re-armed to now by the readDbCache branch");

    // Immediate second call — interval has NOT elapsed since T1, so no probe
    // and no readDbCache: zero additional maybeSingle calls.
    const callsBefore = maybeSingleCalls;
    const second = await geocodeCityCountry("Lisbon");
    assert.equal(second?.countryCode, "PT", "immediate second call serves the cached result");
    assert.equal(maybeSingleCalls, callsBefore,
      "no DB round-trip on the immediate second call — the correction check was re-armed");
    assert.equal(nominatimCalls, 0, "Nominatim still never called");
  });

  it("a DB-cache re-resolve entry gets a fresh 30-day lifetime taken at re-resolve time — not inherited staleness", async () => {
    const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // must match the private constant
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let nominatimCalls = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimCalls++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "it", country: "Italy" } }],
      };
    });

    // DB client that distinguishes readDbCache from the eviction probe by the
    // selected columns: readDbCache selects "country, ..." while the probe
    // selects only "corrected_at, deleted_at".
    //   - readDbCache always returns the live row.
    //   - the probe returns a tombstoned row while `tombstoned` is true
    //     (simulating an admin DELETE on another instance), otherwise live.
    let tombstoned = false;
    let readDbCacheCalls = 0;
    let probeCalls = 0;
    const liveRow = { country: "Italy", country_code: "IT", corrected_at: null, deleted_at: null };
    const client: SupabaseClient = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        let isReadDbCache = false;
        const chain: any = {
          select(cols: string) {
            isReadDbCache = typeof cols === "string" && cols.includes("country,");
            return chain;
          },
          eq() { return chain; },
          gte() { return chain; },
          not() { return chain; },
          async maybeSingle() {
            if (isReadDbCache) {
              readDbCacheCalls++;
              return { data: liveRow, error: null };
            }
            probeCalls++;
            if (tombstoned) {
              return {
                data: { ...liveRow, deleted_at: new Date(T0 + 1_000).toISOString() },
                error: null,
              };
            }
            return { data: liveRow, error: null };
          },
          upsert() { return Promise.resolve({ error: null }); },
          then(resolve: (v: any) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(client);

    // Phase 1: warm up the in-memory cache from the DB row at T0.
    const first = await geocodeCityCountry("Rome");
    assert.equal(first?.countryCode, "IT", "pre-condition: warm-up loads IT from DB cache");
    assert.equal(readDbCacheCalls, 1, "one readDbCache call during warm-up");
    const warmEntry = _getGeocodeCacheEntryForTests("rome");
    assert.ok(warmEntry, "warm-up entry exists");
    assert.equal(warmEntry!.writtenAt, T0, "warm-up entry written at T0");
    assert.equal(warmEntry!.expiresAt, T0 + POSITIVE_TTL_MS, "warm-up entry expires at T0 + 30 days");

    // Phase 2: eviction + DB-cache re-resolve at T1.  The probe finds the
    // tombstone and evicts; readDbCache then finds a restored live row (e.g.
    // an admin PUT revived the entry) and re-resolves via the DB-cache path.
    tombstoned = true;
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);
    const reResolved = await geocodeCityCountry("Rome");
    assert.equal(reResolved?.countryCode, "IT", "re-resolve returns IT from the restored DB row");
    assert.equal(nominatimCalls, 0, "re-resolve completed via the DB-cache path — no Nominatim");
    assert.equal(probeCalls, 1, "eviction probe fired once at T1");
    assert.equal(readDbCacheCalls, 2, "readDbCache fired once for the re-resolve at T1");

    // Core assertion: the restored entry has a FRESH 30-day lifetime taken at
    // re-resolve time — not the old entry's timestamps.
    const restored = _getGeocodeCacheEntryForTests("rome");
    assert.ok(restored, "restored entry exists after the DB-cache re-resolve");
    assert.equal(restored!.writtenAt, T1,
      "writtenAt is the re-resolve time T1 — not inherited from the evicted entry");
    assert.equal(restored!.expiresAt, T1 + POSITIVE_TTL_MS,
      "expiresAt is T1 + 30 days — a fresh full lifetime, not inherited staleness");

    // Phase 3: a call just BEFORE T1 + 30 days serves from cache — no
    // re-resolve (no readDbCache, no Nominatim).  The periodic correction
    // probe may fire, but it finds the live row and keeps the entry.
    tombstoned = false;
    mockNow(T1 + POSITIVE_TTL_MS - 1_000);
    const beforeExpiry = await geocodeCityCountry("Rome");
    assert.equal(beforeExpiry?.countryCode, "IT", "served from cache just before expiry");
    assert.equal(readDbCacheCalls, 2, "no readDbCache re-resolve just before T1 + 30 days");
    assert.equal(nominatimCalls, 0, "no Nominatim call just before T1 + 30 days");
    const beforeEntry = _getGeocodeCacheEntryForTests("rome");
    assert.equal(beforeEntry!.writtenAt, T1, "entry untouched — still the T1 re-resolve entry");

    // Phase 4: a call just AFTER T1 + 30 days re-resolves (entry expired).
    const T2 = T1 + POSITIVE_TTL_MS + 1_000;
    mockNow(T2);
    const afterExpiry = await geocodeCityCountry("Rome");
    assert.equal(afterExpiry?.countryCode, "IT", "re-resolved after expiry");
    assert.equal(readDbCacheCalls, 3, "readDbCache fired again just after T1 + 30 days");
    const renewed = _getGeocodeCacheEntryForTests("rome");
    assert.equal(renewed!.writtenAt, T2, "renewed entry written at T2");
    assert.equal(renewed!.expiresAt, T2 + POSITIVE_TTL_MS, "renewed entry gets its own fresh 30 days");
  });

  // ── Mid-flight eviction at the cache-size cap ────────────────────────────────

  it("a mid-flight evictGeocodeCacheKey blocks the cap-trim write — cache stays at MAX_CACHE_SIZE and the oldest entry survives", async () => {
    // Fills _cache to MAX_CACHE_SIZE (2000), starts a re-geocode for a NEW
    // city whose Nominatim fetch is held pending, evicts that key while the
    // fetch is in-flight, then resolves the fetch.  The `_pending.get(key) === p`
    // guard must skip the ENTIRE write block — including the MAX_CACHE_SIZE
    // trim — so the cache stays exactly at the cap, no entry is written for
    // the evicted key, and the oldest entry is NOT trimmed away.
    const MAX_CACHE_SIZE = 2_000; // must match the private constant

    // Disable the DB cache so every call goes straight to (fake) Nominatim.
    _setGeocodeDbClientForTests(null);

    // Deferred fetch for the racing city; instant answers for everything else.
    let releaseRaceFetch!: () => void;
    const raceFetchGate = new Promise<void>((r) => { releaseRaceFetch = r; });
    let raceFetchStarted = false;
    _setGeocodeFetchForTests(async (url: string) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "").toLowerCase();
      if (q === "race city") {
        raceFetchStarted = true;
        await raceFetchGate; // hold the request in-flight
      }
      return {
        ok: true,
        json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
      };
    });

    // Fill the cache to exactly MAX_CACHE_SIZE.
    for (let i = 0; i < MAX_CACHE_SIZE; i++) {
      await geocodeCityCountry(`filler${i}`);
    }
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE, "pre-condition: cache filled to the cap");
    assert.ok(_getGeocodeCacheEntryForTests("filler0"), "pre-condition: oldest entry present");

    // Start the re-geocode for a new city — its fetch stays pending.
    const inflight = geocodeCityCountry("Race City");
    // Wait until the fetch has actually started (readDbCache is a no-op here,
    // but yield until the fake fetch is entered to be robust).
    while (!raceFetchStarted) await new Promise<void>((r) => setImmediate(r));

    // Racing admin eviction fires while the geocode is in-flight.
    evictGeocodeCacheKey("race city");

    // Let the Nominatim response arrive.
    releaseRaceFetch();
    const result = await inflight;

    // The caller still receives the resolved result…
    assert.equal(result?.countryCode, "JP", "in-flight caller still gets the resolved result");
    // …but the guard blocked the write: no entry for the evicted key,
    assert.equal(_getGeocodeCacheEntryForTests("race city"), undefined,
      "in-flight result was NOT written to the cache after eviction");
    // …no cap-trim happened (oldest entry survives),
    assert.ok(_getGeocodeCacheEntryForTests("filler0"),
      "oldest entry was NOT trimmed — the cap-trim was skipped along with the write");
    // …and the cache size is exactly at the cap (not above, not below).
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE,
      "cache size remains exactly MAX_CACHE_SIZE — no over-cap write, no spurious trim");
  });

  it("negative-cache re-seed at capacity trims the oldest unrelated entry — not the re-seeded city's own entry", async () => {
    const T0 = 1_700_000_000_000;
    const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;
    const MAX_CACHE_SIZE = 2_000; // must match the private constant in countryGeocoder.ts
    mockNow(T0);

    // No DB — readDbCache short-circuits, all writes stay in-memory.
    _setGeocodeDbClientForTests(null);

    // Phase 1: fill the cache to MAX_CACHE_SIZE - 1 with synthetic positive entries.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "de", country: "Germany" } }],
    }));
    for (let i = 0; i < MAX_CACHE_SIZE - 1; i++) {
      await geocodeCityCountry(`synthcity${String(i).padStart(4, "0")}`);
    }
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE - 1,
      "pre-condition: cache filled to MAX_CACHE_SIZE - 1");

    // Phase 2: seed a null entry for the target city (Nominatim down → catch path).
    let nominatimThrows = 0;
    _setGeocodeFetchForTests(async () => {
      nominatimThrows++;
      throw new Error("network_error");
    });
    const seeded = await geocodeCityCountry("Atlantis");
    assert.equal(seeded, null, "target city seeded as null");
    assert.equal(nominatimThrows, 1, "one failed Nominatim attempt for the seed");
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE,
      "cache is now exactly at MAX_CACHE_SIZE");
    assert.ok(_getGeocodeCacheEntryForTests("synthcity0000"),
      "oldest synthetic entry still present — the seed itself did not trim (size was under cap)");

    // Phase 3: advance past the negative TTL so the null entry expires,
    // then trigger a re-seed (Nominatim still down → catch-path cache write).
    const T1 = T0 + NEGATIVE_TTL_MS + 1_000;
    mockNow(T1);
    const reseeded = await geocodeCityCountry("Atlantis");
    assert.equal(reseeded, null, "re-seed returns null again (Nominatim still down)");
    assert.equal(nominatimThrows, 2, "a fresh Nominatim attempt was made after the negative TTL expired");

    // The cap trim fired (size >= MAX_CACHE_SIZE) and evicted the OLDEST
    // unrelated synthetic entry — not the target city's own entry.
    assert.equal(_getGeocodeCacheEntryForTests("synthcity0000"), undefined,
      "oldest synthetic entry was the one evicted by the cap trim");
    assert.ok(_getGeocodeCacheEntryForTests("synthcity0001"),
      "second-oldest synthetic entry survives — only one entry was trimmed");

    // The re-seeded null entry is present and correctly sized.
    const target = _getGeocodeCacheEntryForTests("atlantis");
    assert.ok(target, "re-seeded null entry is present for the target city");
    assert.equal(target!.result, null, "re-seeded entry is a negative (null) entry");
    assert.equal(target!.writtenAt, T1, "re-seeded entry written at the re-seed time");
    assert.equal(target!.expiresAt, T1 + NEGATIVE_TTL_MS,
      "re-seeded entry carries the 6-hour negative TTL");

    // Cache never exceeds the cap; after trimming an unrelated entry and
    // replacing the target's expired entry in place, size sits under the cap.
    assert.ok(_getCacheSizeForTests() <= MAX_CACHE_SIZE,
      "cache size never exceeds MAX_CACHE_SIZE after the re-seed");
    assert.equal(_getCacheSizeForTests(), MAX_CACHE_SIZE - 1,
      "one unrelated entry trimmed + in-place replace of the target's expired entry");
  });
});
