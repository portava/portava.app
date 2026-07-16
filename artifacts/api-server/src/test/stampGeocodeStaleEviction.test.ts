/**
 * Staleness-eviction guard for in-memory geocode cache.
 *
 * The corrected_at probe in evictIfDbCorrected is the only mechanism that
 * lets an instance whose in-memory cache is still warm pick up a geocode
 * correction written by the admin on a different instance.  These tests
 * verify the four essential behaviours of that guard:
 *
 *   1. Evicts + returns the corrected value when corrected_at > writtenAt.
 *   2. Keeps the cached value when corrected_at < writtenAt (old correction).
 *   3. Keeps the cached value when corrected_at is absent.
 *   4. Does NOT probe the DB at all before the check interval elapses.
 *
 * Run: node --import tsx/esm --test src/test/stampGeocodeStaleEviction.test.ts
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

function mockNow(t: number): void { _fakeNow = t; }

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

// ── DB client factory ─────────────────────────────────────────────────────────

/**
 * Build a fake Supabase client for city_country_geocode_cache that serves
 * responses from a queue.  The last element is repeated once the queue is
 * exhausted.  An optional `onCall` hook fires on each maybySingle() invocation
 * so tests can count DB hits.
 */
function makeQueuedDbClient(
  queue: Array<Record<string, unknown> | null>,
  onCall?: (callIndex: number) => void,
): SupabaseClient {
  let callIndex = 0;
  return {
    from(table: string) {
      assert.equal(table, "city_country_geocode_cache", "unexpected table");
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        async maybeSingle() {
          const idx = callIndex++;
          onCall?.(idx);
          const row = queue[Math.min(idx, queue.length - 1)];
          return { data: row ?? null, error: null };
        },
        upsert() { return Promise.resolve({ error: null }); },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

// Disable Nominatim for all tests in this file — the DB cache is the sole source.
function silentFetch(): void {
  _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("staleness-eviction: corrected_at probe", () => {
  it("evicts and returns the corrected DB value when corrected_at post-dates writtenAt", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    silentFetch();

    const correctedAtMs = T0 + 500; // 500 ms after the cache was written
    const correctedAtIso = new Date(correctedAtMs).toISOString();

    const db = makeQueuedDbClient([
      // call 0: readDbCache — initial warm-up, no correction yet
      { country: "France", country_code: "FR", corrected_at: null },
      // call 1: evictIfDbCorrected — probe returns corrected_at > T0 → evicts
      { corrected_at: correctedAtIso },
      // call 2: readDbCache — re-read after eviction returns corrected row
      { country: "Germany", country_code: "DE", corrected_at: correctedAtIso },
    ]);
    _setGeocodeDbClientForTests(db);

    const first = await geocodeCityCountry("Lyon");
    assert.equal(first?.countryCode, "FR", "pre-condition: initial load should return FR");

    // Advance past the correction-check interval so the probe fires.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const second = await geocodeCityCountry("Lyon");
    assert.equal(second?.countryCode, "DE",
      "after eviction + re-read, should return the corrected DE value");
    assert.equal(second?.country, "Germany");
  });

  it("keeps the cached value when corrected_at pre-dates writtenAt", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    silentFetch();

    // The DB row was corrected 1 second BEFORE this instance wrote the entry.
    const oldCorrectionIso = new Date(T0 - 1_000).toISOString();

    let dbCallCount = 0;
    const db = makeQueuedDbClient(
      [
        // call 0: readDbCache — initial load (no correction in response)
        { country: "France", country_code: "FR", corrected_at: null },
        // call 1: evictIfDbCorrected — probe returns an old corrected_at → no eviction
        { corrected_at: oldCorrectionIso },
        // Any further call would be a second probe — must not happen within the same interval.
        { corrected_at: oldCorrectionIso },
      ],
      (idx) => { dbCallCount = idx + 1; },
    );
    _setGeocodeDbClientForTests(db);

    const first = await geocodeCityCountry("Lyon");
    assert.equal(first?.countryCode, "FR");

    // Advance past the correction-check interval so the probe fires on the second call.
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);

    const second = await geocodeCityCountry("Lyon");
    assert.equal(second?.countryCode, "FR",
      "an old correction should not evict the in-memory entry");
    // Two DB calls: initial readDbCache + eviction probe — no third call for re-read.
    assert.equal(dbCallCount, 2,
      "should make exactly two DB calls: initial load + probe (no re-read on non-eviction)");

    // Advance by LESS than one full interval from T1 — the probe must NOT fire again.
    // This confirms correctionCheckedAt was bumped even on the "old correction" path.
    mockNow(T1 + CORRECTION_CHECK_INTERVAL_MS - 1_000);

    const third = await geocodeCityCountry("Lyon");
    assert.equal(third?.countryCode, "FR",
      "third call should still return the cached FR value");
    assert.equal(dbCallCount, 2,
      "correctionCheckedAt must have been reset after the old-correction probe — no second probe within the same interval");
  });

  it("keeps the cached value when the DB row has no corrected_at", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    silentFetch();

    let dbCallCount = 0;
    const db = makeQueuedDbClient(
      [
        // call 0: readDbCache — initial load
        { country: "France", country_code: "FR", corrected_at: null },
        // call 1: evictIfDbCorrected — row has no corrected_at → no eviction
        { corrected_at: null },
      ],
      (idx) => { dbCallCount = idx + 1; },
    );
    _setGeocodeDbClientForTests(db);

    const first = await geocodeCityCountry("Lyon");
    assert.equal(first?.countryCode, "FR");

    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const second = await geocodeCityCountry("Lyon");
    assert.equal(second?.countryCode, "FR",
      "absent corrected_at should leave the in-memory entry intact");
    assert.equal(dbCallCount, 2,
      "should make exactly two DB calls: initial load + probe (no re-read)");
  });

  it("does not probe the DB for a negative (null) cache entry even after the interval elapses", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Return empty Nominatim response so forwardGeocodeCity resolves to null.
    silentFetch();

    let probeCount = 0;
    const db = makeQueuedDbClient(
      [
        // call 0: readDbCache — no persisted row, so falls through to Nominatim
        null,
        // Any further call would be an unexpected correction probe — track it.
        { corrected_at: new Date(T0 + 500).toISOString() },
      ],
      (idx) => { if (idx >= 1) probeCount++; },
    );
    _setGeocodeDbClientForTests(db);

    // Seed the negative cache entry (result = null).
    const first = await geocodeCityCountry("UnknownCity");
    assert.equal(first, null, "pre-condition: unresolved city should return null");

    // Advance well past the correction-check interval.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    // Call again — the null entry must be returned immediately with no DB probe.
    const second = await geocodeCityCountry("UnknownCity");
    assert.equal(second, null, "should return the cached null without probing the DB");
    assert.equal(probeCount, 0,
      "correction probe must never fire for a negative (null) cache entry");
  });

  it("does not re-probe within the same interval after a clean (non-evicting) check", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    silentFetch();

    let dbCallCount = 0;
    const db = makeQueuedDbClient(
      [
        // call 0: readDbCache — initial load
        { country: "France", country_code: "FR", corrected_at: null },
        // call 1: evictIfDbCorrected — no corrected_at → no eviction, correctionCheckedAt bumped
        { corrected_at: null },
        // Any further call would be a second probe — must not happen
        { corrected_at: null },
      ],
      (idx) => { dbCallCount = idx + 1; },
    );
    _setGeocodeDbClientForTests(db);

    // First call: populates the in-memory cache from the DB.
    const first = await geocodeCityCountry("Lyon");
    assert.equal(first?.countryCode, "FR", "first call should return FR");

    // Advance past the correction-check interval so the probe fires on the second call.
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);

    // Second call: triggers the probe (corrected_at is null → no eviction, timer reset to T1).
    const second = await geocodeCityCountry("Lyon");
    assert.equal(second?.countryCode, "FR", "second call should still return FR");
    assert.equal(dbCallCount, 2, "exactly two DB calls after the second geocode");

    // Advance time by LESS than one full interval from T1 — probe must NOT fire again.
    mockNow(T1 + CORRECTION_CHECK_INTERVAL_MS - 1_000);

    // Third call: must return cached value without triggering a new DB probe.
    const third = await geocodeCityCountry("Lyon");
    assert.equal(third?.countryCode, "FR", "third call should still return FR");
    assert.equal(dbCallCount, 2,
      "correctionCheckedAt was bumped after the clean probe — no second probe within the same interval");
  });

});

// ── NEGATIVE_TTL expiry ───────────────────────────────────────────────────────

// Must match the private constant in countryGeocoder.ts.
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1_000;

describe("negative cache TTL expiry", () => {
  it("retries a fresh geocode after NEGATIVE_TTL_MS expires — not stuck null forever", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // First fetch returns empty → null geocode → negative cache entry.
    // _setGeocodeFetchForTests also sets _dbClientOverride = null (no DB).
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));

    const first = await geocodeCityCountry("RetryCity");
    assert.equal(first, null, "pre-condition: unresolved city should be cached as null");

    // Advance past the NEGATIVE_TTL_MS window so the entry is stale.
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    // Swap the fetch to return a valid geocode result on the retry.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
    }));

    const second = await geocodeCityCountry("RetryCity");
    assert.equal(
      second?.countryCode,
      "JP",
      "after TTL expiry the negative entry should be considered stale and a fresh geocode attempt must succeed",
    );
    assert.equal(second?.country, "Japan");
  });

  it("a network error during the TTL-retry re-caches with NEGATIVE_TTL_MS — not the 30-day positive TTL", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Seed the negative cache: first fetch returns empty → null geocode.
    let fetchCallCount = 0;
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return { ok: true, json: async () => [] };
    });

    const first = await geocodeCityCountry("ErrorCity");
    assert.equal(first, null, "pre-condition: city should cache as null");
    assert.equal(fetchCallCount, 1, "pre-condition: one fetch to seed negative entry");

    // Advance past the NEGATIVE_TTL_MS window so the first negative entry is stale.
    const T1 = T0 + NEGATIVE_TTL_MS + 1_000;
    mockNow(T1);

    // Swap fetch to throw a network error on the retry.
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      throw new Error("network_timeout");
    });

    // The stale entry triggers a retry; the retry throws → re-cached with NEGATIVE_TTL_MS from T1.
    const second = await geocodeCityCountry("ErrorCity");
    assert.equal(second, null, "network error during retry should return null");
    assert.equal(fetchCallCount, 2, "one fetch for the seed, one for the retry");

    // Advance by LESS than NEGATIVE_TTL_MS from T1 — the re-cached entry must still be live.
    mockNow(T1 + NEGATIVE_TTL_MS - 1_000);

    // Swap to a succeeding fetch — but it must NOT be called yet.
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return { ok: true, json: async () => [{ address: { country_code: "de", country: "Germany" } }] };
    });

    const third = await geocodeCityCountry("ErrorCity");
    assert.equal(third, null,
      "inside the short re-cached window the null must be served without a new fetch — proving NEGATIVE_TTL was used, not the 30-day TTL");
    assert.equal(fetchCallCount, 2,
      "no third fetch while the re-cached negative entry is still valid");

    // Now advance past the second NEGATIVE_TTL_MS window — a successful retry must proceed.
    mockNow(T1 + NEGATIVE_TTL_MS + 1_000);

    const fourth = await geocodeCityCountry("ErrorCity");
    assert.equal(fourth?.countryCode, "DE",
      "after the short TTL expires the retry should succeed and return the resolved country");
    assert.equal(fetchCallCount, 3, "one fetch for the successful retry after the short TTL");
  });

  it("keeps returning null while still inside the NEGATIVE_TTL_MS window", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    let fetchCallCount = 0;
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return { ok: true, json: async () => [] };
    });

    const first = await geocodeCityCountry("StuckCity");
    assert.equal(first, null, "pre-condition: should cache null on first call");
    assert.equal(fetchCallCount, 1, "pre-condition: one fetch call to seed the negative entry");

    // Advance time — but stay INSIDE the TTL window.
    mockNow(T0 + NEGATIVE_TTL_MS - 1_000);

    const second = await geocodeCityCountry("StuckCity");
    assert.equal(second, null, "null should be served from cache while inside the TTL window");
    assert.equal(
      fetchCallCount,
      1,
      "no second fetch call should be made while the negative entry is still valid",
    );
  });
});

// ── Correction-sweep eviction retry ──────────────────────────────────────────
//
// The correction sweep (_runCorrectionSweepForTests) can evict a null (negative)
// cache entry when the DB row has a corrected_at that post-dates writtenAt.
// After eviction the key is absent from the cache, so the next
// geocodeCityCountry call must re-geocode — not silently skip or stay null.

describe("correction-sweep eviction: negative entry retries after sweep removes it", () => {
  /**
   * Build a fake Supabase client suitable for the correction sweep.
   *
   * The sweep uses array-returning chains (.select().gte() — no .maybeSingle()),
   * so the chain must be thenable.  Each top-level `await sc.from(...)...` call
   * consumes one slot from `awaitedResponses`; maybeSingle() calls (from
   * geocodeCityCountry internals) are handled separately.
   */
  function makeSweepDbClient(
    pass1Rows: Array<{ city_key: string; corrected_at: string }>,
  ): SupabaseClient {
    let awaitIdx = 0;
    // Indexed by top-level await call order:
    //   0 → pass-1 query (corrected_at rows)
    //   1 → pass-2 query (tombstoned rows — empty in this test)
    const awaitedResponses: Array<{ data: any; error: null }> = [
      { data: pass1Rows, error: null },
      { data: [],        error: null },
    ];

    return {
      from(_table: string) {
        const chain: any = {
          select()  { return chain; },
          eq()      { return chain; },
          gte()     { return chain; },
          not()     { return chain; },
          in()      { return chain; },
          delete()  { return chain; },
          upsert()  { return Promise.resolve({ error: null }); },
          // Used by geocodeCityCountry → readDbCache after the sweep evicts the entry.
          // Returns null so the code falls through to Nominatim (the swapped fetch).
          async maybeSingle() {
            return { data: null, error: null };
          },
          // Thenable: consumed when the caller does `await chain` (sweep array queries).
          then(
            resolve: (v: any) => any,
            reject?: (e: any) => any,
          ): Promise<any> {
            const idx = awaitIdx++;
            const resp = awaitedResponses[Math.min(idx, awaitedResponses.length - 1)];
            return Promise.resolve(resp).then(resolve, reject);
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
  }

  it("retries and returns a valid result after the sweep evicts a null cache entry", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1 — seed a null (negative) cache entry.
    // _setGeocodeFetchForTests also sets _dbClientOverride = null (no DB),
    // so readDbCache returns null and the code falls through to Nominatim.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));

    const first = await geocodeCityCountry("SweepCity");
    assert.equal(first, null, "pre-condition: unresolved city should be cached as null");

    // Step 2 — install a sweep DB client whose pass-1 row has corrected_at > T0,
    // which will cause the sweep to evict the null entry.
    const correctedAtIso = new Date(T0 + 500).toISOString();
    // Normalized key produced by normCity("SweepCity"):
    const cityKey = "sweepcity";
    const sweepDb = makeSweepDbClient([{ city_key: cityKey, corrected_at: correctedAtIso }]);
    _setGeocodeDbClientForTests(sweepDb);

    await _runCorrectionSweepForTests();

    // Step 3 — swap fetch to return a valid geocode result.
    // _setGeocodeFetchForTests resets _dbClientOverride to null, so readDbCache
    // returns null and the code proceeds straight to forwardGeocodeCity.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
    }));

    // Step 4 — the sweep-evicted key must re-geocode, not stay absent/null.
    const second = await geocodeCityCountry("SweepCity");
    assert.equal(
      second?.countryCode,
      "JP",
      "after sweep eviction the null entry must be absent so the next call retries and returns a valid result",
    );
    assert.equal(second?.country, "Japan");
  });
});

describe("staleness-eviction: corrected_at probe (continued)", () => {
  it("does not probe the DB before the check interval has elapsed", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    silentFetch();

    let probeCount = 0;
    const db = makeQueuedDbClient(
      [
        // call 0: readDbCache — initial load
        { country: "France", country_code: "FR", corrected_at: null },
        // Any further call would be a probe — track it.
        { corrected_at: new Date(T0 + 500).toISOString() },
      ],
      (idx) => { if (idx >= 1) probeCount++; },
    );
    _setGeocodeDbClientForTests(db);

    const first = await geocodeCityCountry("Lyon");
    assert.equal(first?.countryCode, "FR");

    // Advance time by less than the interval — probe must NOT fire.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS - 1_000);

    const second = await geocodeCityCountry("Lyon");
    assert.equal(second?.countryCode, "FR",
      "should return the cached value without probing the DB");
    assert.equal(probeCount, 0,
      "correction probe must not run before the interval elapses");
  });
});
