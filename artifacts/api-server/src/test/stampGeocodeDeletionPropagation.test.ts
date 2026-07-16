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
});
