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
      ],
      (idx) => { dbCallCount = idx + 1; },
    );
    _setGeocodeDbClientForTests(db);

    const first = await geocodeCityCountry("Lyon");
    assert.equal(first?.countryCode, "FR");

    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000);

    const second = await geocodeCityCountry("Lyon");
    assert.equal(second?.countryCode, "FR",
      "an old correction should not evict the in-memory entry");
    // Two DB calls: initial readDbCache + eviction probe — no third call for re-read.
    assert.equal(dbCallCount, 2,
      "should make exactly two DB calls: initial load + probe (no re-read on non-eviction)");
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
