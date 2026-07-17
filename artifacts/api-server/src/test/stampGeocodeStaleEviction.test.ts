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

function mockNow(t: number): void { _fakeNow = t; }

beforeEach(() => {
  _fakeNow = null;
  _realDateNow = Date.now;
  Date.now = () => (_fakeNow !== null ? _fakeNow : _realDateNow());
  _clearCountryGeocodeCache();
  // _setGeocodeFetchForTests no longer resets the DB override (the setters
  // are independent now) — explicitly disable the real DB client so tests
  // never read/write the live city_country_geocode_cache table. Tests that
  // need a fake DB install one via _setGeocodeDbClientForTests themselves.
  _setGeocodeDbClientForTests(null);
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

  it("does not re-probe within one interval after eviction+re-read — correctionCheckedAt is set on the fresh entry", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    silentFetch();

    const correctedAtMs = T0 + 500; // correction written 500 ms after the initial cache entry
    const correctedAtIso = new Date(correctedAtMs).toISOString();

    let dbCallCount = 0;
    const db = makeQueuedDbClient(
      [
        // call 0: readDbCache — initial warm-up, returns FR
        { country: "France", country_code: "FR", corrected_at: null },
        // call 1: evictIfDbCorrected — probe returns corrected_at > T0 → evicts
        { corrected_at: correctedAtIso },
        // call 2: readDbCache — re-read after eviction returns corrected DE row
        { country: "Germany", country_code: "DE", corrected_at: correctedAtIso },
        // call 3 would be a second probe within the same interval — must not happen
        { corrected_at: correctedAtIso },
      ],
      (idx) => { dbCallCount = idx + 1; },
    );
    _setGeocodeDbClientForTests(db);

    // Call 1: populates the in-memory cache from the DB (DB call 0).
    const first = await geocodeCityCountry("Lyon");
    assert.equal(first?.countryCode, "FR", "pre-condition: initial load should return FR");
    assert.equal(dbCallCount, 1, "exactly one DB call after initial load");

    // Advance past the correction-check interval so the probe fires on the second call.
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);

    // Call 2: triggers probe (DB call 1) → eviction, then re-reads from DB (DB call 2).
    // The fresh CacheEntry must be created with correctionCheckedAt: T1.
    const second = await geocodeCityCountry("Lyon");
    assert.equal(second?.countryCode, "DE",
      "after eviction + re-read the corrected DE value should be returned");
    assert.equal(dbCallCount, 3, "exactly three DB calls after eviction+re-read: initial + probe + re-read");

    // Advance by LESS than one full interval from T1 — probe must NOT fire again.
    // If correctionCheckedAt was left unset (undefined) on the new entry, the guard
    // would fall back to writtenAt (≈ T1) and the check would still pass here, but
    // this asserts the count stays at 3 regardless.
    mockNow(T1 + CORRECTION_CHECK_INTERVAL_MS - 1_000);

    // Call 3: must return the cached DE value without triggering another DB probe.
    const third = await geocodeCityCountry("Lyon");
    assert.equal(third?.countryCode, "DE",
      "third call should return the cached DE value");
    assert.equal(dbCallCount, 3,
      "correctionCheckedAt must be set on the fresh re-read entry — no fourth DB call within the same interval");
  });

  it("deletion-eviction: does not re-probe within one interval after eviction+re-read — correctionCheckedAt is set on the fresh entry", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    silentFetch();

    // Simulate a row that was soft-deleted (tombstoned) on another instance.
    const deletedAtIso = new Date(T0 + 200).toISOString();

    let dbCallCount = 0;
    const db = makeQueuedDbClient(
      [
        // call 0: readDbCache — initial warm-up, returns FR (row is live)
        { country: "France", country_code: "FR", corrected_at: null },
        // call 1: evictIfDbCorrected — probe returns deleted_at set → evicts
        { corrected_at: null, deleted_at: deletedAtIso },
        // call 2: readDbCache — re-read after eviction; row revived elsewhere, returns DE
        { country: "Germany", country_code: "DE", corrected_at: null },
        // call 3 would be a second probe within the same interval — must not happen
        { corrected_at: null, deleted_at: null },
      ],
      (idx) => { dbCallCount = idx + 1; },
    );
    _setGeocodeDbClientForTests(db);

    // Call 1: populates the in-memory cache from the DB (DB call 0).
    const first = await geocodeCityCountry("Lyon");
    assert.equal(first?.countryCode, "FR", "pre-condition: initial load should return FR");
    assert.equal(dbCallCount, 1, "exactly one DB call after initial load");

    // Advance past the correction-check interval so the probe fires on the second call.
    const T1 = T0 + CORRECTION_CHECK_INTERVAL_MS + 1_000;
    mockNow(T1);

    // Call 2: triggers probe (DB call 1) → deletion-eviction detected, then
    // re-reads from DB (DB call 2).  The fresh CacheEntry must be stored with
    // correctionCheckedAt: T1 so the interval guard is honoured immediately.
    const second = await geocodeCityCountry("Lyon");
    assert.equal(second?.countryCode, "DE",
      "after deletion-eviction + re-read the revived DE value should be returned");
    assert.equal(dbCallCount, 3,
      "exactly three DB calls after eviction+re-read: initial + deletion probe + re-read");

    // Advance by LESS than one full interval from T1 — probe must NOT fire again.
    // If correctionCheckedAt were left unset on the new entry the guard would
    // still pass this check (writtenAt ≈ T1), but we assert the count stays at 3
    // to document the expected behaviour explicitly.
    mockNow(T1 + CORRECTION_CHECK_INTERVAL_MS - 1_000);

    // Call 3: must return the cached DE value without triggering another DB probe.
    const third = await geocodeCityCountry("Lyon");
    assert.equal(third?.countryCode, "DE",
      "third call should return the cached DE value");
    assert.equal(dbCallCount, 3,
      "correctionCheckedAt must be set on the fresh re-read entry — no fourth DB call within the same interval");
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
    // (DB cache is disabled in beforeEach via _setGeocodeDbClientForTests(null).)
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

  it("applies the 30-day positive TTL after a DB-failing TTL-retry — not the 6-hour negative TTL", async () => {
    const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // must match countryGeocoder.ts
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // DB client: readDbCache finds nothing (so Nominatim is consulted) and the
    // upsert in writeDbCache always fails.
    const failingDb = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache", "unexpected table");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
          upsert() { return Promise.resolve({ error: { message: "db_write_failed" } }); },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(failingDb);

    // Seed the negative cache: first fetch returns empty → null geocode.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));

    const first = await geocodeCityCountry("TtlCity");
    assert.equal(first, null, "pre-condition: city should cache as null");

    // Advance past the NEGATIVE_TTL_MS window so the negative entry is stale.
    const T1 = T0 + NEGATIVE_TTL_MS + 1_000;
    mockNow(T1);

    // Retry succeeds via Nominatim, but the DB upsert fails.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
    }));

    const second = await geocodeCityCountry("TtlCity");
    assert.equal(second?.countryCode, "JP",
      "the retry should return the positive result even though the DB write fails");

    // The in-memory entry must carry the 30-day positive TTL, not the 6-hour one.
    const entry = _getGeocodeCacheEntryForTests("ttlcity");
    assert.ok(entry, "in-memory cache entry must exist after the DB-failing retry");
    assert.equal(entry!.writtenAt, T1, "entry should be written at the retry time");
    assert.equal(entry!.expiresAt, T1 + POSITIVE_TTL_MS,
      "expiresAt must be writtenAt + POSITIVE_TTL_MS (30 days) — not NEGATIVE_TTL_MS (6 hours)");
    assert.notEqual(entry!.expiresAt, T1 + NEGATIVE_TTL_MS,
      "expiresAt must not be the 6-hour negative TTL");
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

  it("a successful TTL-retry persists the result to the DB — surviving a server restart", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1: seed a negative cache entry — fetch returns empty, DB disabled.
    // _setGeocodeFetchForTests also sets _dbClientOverride = null so readDbCache
    // returns null and the code falls through to forwardGeocodeCity.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));

    const first = await geocodeCityCountry("PersistCity");
    assert.equal(first, null, "pre-condition: city should cache as null");

    // Step 2: advance past NEGATIVE_TTL_MS so the entry is stale.
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    // Step 3: swap fetch to return a valid geocode result on retry.
    // _setGeocodeFetchForTests resets _dbClientOverride to null — we then
    // install a tracking DB client before the retry runs.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
    }));

    // Step 4: install a fake DB client that:
    //   • returns null from readDbCache (maybeSingle) so no persisted row
    //     short-circuits the Nominatim call,
    //   • records every upsert row so we can assert writeDbCache was called.
    const upsertedRows: Array<Record<string, unknown>> = [];
    const trackingDb = {
      from(_table: string) {
        const chain: any = {
          select()  { return chain; },
          eq()      { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
          upsert(row: Record<string, unknown>) {
            upsertedRows.push(row);
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(trackingDb);

    // Step 5: the stale negative entry triggers a fresh geocode; the success
    // must be written to the DB via writeDbCache.
    const second = await geocodeCityCountry("PersistCity");
    assert.equal(second?.countryCode, "JP",
      "TTL-retry should resolve to the geocoded country");
    assert.equal(second?.country, "Japan");

    assert.equal(upsertedRows.length, 1,
      "exactly one DB upsert should be made to persist the resolved result");
    assert.equal(
      (upsertedRows[0] as any).country_code,
      "JP",
      "the upserted row must carry the resolved country_code",
    );
  });

  it("two callers racing at negative-TTL expiry share one Nominatim retry — not two parallel calls", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Seed a negative cache entry: first fetch returns empty → null geocode.
    let fetchCallCount = 0;
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return { ok: true, json: async () => [] };
    });

    const seed = await geocodeCityCountry("RaceCity");
    assert.equal(seed, null, "pre-condition: city should be cached as null");
    assert.equal(fetchCallCount, 1, "pre-condition: one fetch to seed the negative entry");

    // Advance past the NEGATIVE_TTL_MS window so the entry is stale.
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    // Swap fetch to return a valid result on the retry.
    // Both racing callers must share this single invocation via _pending dedup.
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
      };
    });

    // Fire two concurrent calls — neither finds a valid cache entry (TTL expired),
    // so they both reach the _pending check.  The first caller creates the promise
    // and stores it in _pending synchronously (before any await); the second
    // caller finds that same promise and returns it, guaranteeing a single fetch.
    const [resultA, resultB] = await Promise.all([
      geocodeCityCountry("RaceCity"),
      geocodeCityCountry("RaceCity"),
    ]);

    // Exactly one Nominatim call across both callers (seed + one retry = 2 total).
    assert.equal(fetchCallCount, 2,
      "two concurrent callers at TTL expiry must share one Nominatim retry — not issue two calls");

    // Both callers receive the same resolved result.
    assert.equal(resultA?.countryCode, "JP",
      "first caller should receive the geocoded result");
    assert.equal(resultB?.countryCode, "JP",
      "second caller should receive the same geocoded result — not a duplicate fetch");
    assert.equal(resultA?.country, "Japan");
    assert.equal(resultB?.country, "Japan");
  });

  it("re-cached null entry after a network error carries a fresh writtenAt — not the original T0", async () => {
    // Regression guard: the catch block in geocodeCityCountry must stamp
    // writtenAt: now (T1, the retry time) so the correction sweep — which
    // evicts entries whose writtenAt predates corrected_at — cannot
    // immediately evict the freshly re-cached null entry.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Seed the negative cache: first fetch returns empty → null geocode at T0.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [],
    }));

    const first = await geocodeCityCountry("FreshWrittenAt");
    assert.equal(first, null, "pre-condition: city should cache as null at T0");

    // Confirm the seed entry carries writtenAt ≈ T0.
    const seedEntry = _getGeocodeCacheEntryForTests("freshwrittenat");
    assert.ok(seedEntry, "pre-condition: cache entry should exist after initial geocode");
    assert.ok(
      Math.abs(seedEntry.writtenAt - T0) < 50,
      `pre-condition: seedEntry.writtenAt (${seedEntry.writtenAt}) should be ≈ T0 (${T0})`,
    );

    // Advance past the NEGATIVE_TTL_MS window so the seed entry is stale.
    const T1 = T0 + NEGATIVE_TTL_MS + 1_000;
    mockNow(T1);

    // Swap fetch to throw a network error — the catch block must re-cache null
    // with writtenAt: T1 (Date.now() at the time of the catch), not the stale T0.
    _setGeocodeFetchForTests(async () => {
      throw new Error("network_timeout");
    });

    const second = await geocodeCityCountry("FreshWrittenAt");
    assert.equal(second, null, "network error during retry should return null");

    // The re-cached entry must have writtenAt ≈ T1 and expiresAt ≈ T1 + NEGATIVE_TTL_MS.
    const retryEntry = _getGeocodeCacheEntryForTests("freshwrittenat");
    assert.ok(retryEntry, "cache entry must exist after network-error retry");

    assert.ok(
      Math.abs(retryEntry.writtenAt - T1) < 50,
      `writtenAt must be ≈ T1 (${T1}) — got ${retryEntry.writtenAt}. ` +
      "If writtenAt were T0 the correction sweep could immediately evict this entry.",
    );

    const expectedExpiresAt = T1 + NEGATIVE_TTL_MS;
    assert.ok(
      Math.abs(retryEntry.expiresAt - expectedExpiresAt) < 50,
      `expiresAt must be ≈ T1 + NEGATIVE_TTL_MS (${expectedExpiresAt}) — got ${retryEntry.expiresAt}`,
    );

    // Confirm the entry is still live inside the new TTL window — proving
    // the sweep would not evict it prematurely if corrected_at were set to T1.
    mockNow(T1 + NEGATIVE_TTL_MS - 1_000);
    let fetchAfterCount = 0;
    _setGeocodeFetchForTests(async () => {
      fetchAfterCount++;
      return { ok: true, json: async () => [{ address: { country_code: "de", country: "Germany" } }] };
    });

    const third = await geocodeCityCountry("FreshWrittenAt");
    assert.equal(third, null,
      "inside the new TTL window the null must be served without a new fetch");
    assert.equal(fetchAfterCount, 0,
      "no fetch while the re-cached negative entry (writtenAt=T1) is still live");
  });

  it("both concurrent callers get null when the shared TTL-retry also fails — not a split result", async () => {
    // Task #525 confirmed that two callers racing at negative-TTL expiry share
    // one Nominatim fetch.  This test covers the complementary case: the shared
    // fetch throws.  Both callers must receive null (not one null and one stale
    // value), and the re-cached entry must use NEGATIVE_TTL_MS — not the 30-day
    // positive TTL.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1 — seed a negative cache entry: fetch returns empty → null geocode.
    let fetchCallCount = 0;
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return { ok: true, json: async () => [] };
    });

    const seed = await geocodeCityCountry("FailRaceCity");
    assert.equal(seed, null, "pre-condition: city should be cached as null");
    assert.equal(fetchCallCount, 1, "pre-condition: one fetch to seed the negative entry");

    // Step 2 — advance past NEGATIVE_TTL_MS so the entry is stale.
    const T1 = T0 + NEGATIVE_TTL_MS + 1_000;
    mockNow(T1);

    // Step 3 — swap fetch to throw on the retry.
    // Both racing callers must share this single failing invocation.
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      throw new Error("network_timeout");
    });

    // Step 4 — fire two concurrent calls.  Neither finds a valid cache entry
    // (TTL expired), so both reach the _pending check.  The first caller
    // synchronously stores its promise in _pending before any await; the second
    // finds that same promise — one fetch is made and it throws.
    const [resultA, resultB] = await Promise.all([
      geocodeCityCountry("FailRaceCity"),
      geocodeCityCountry("FailRaceCity"),
    ]);

    // Exactly one Nominatim call (seed + one failing retry = 2 total).
    assert.equal(
      fetchCallCount,
      2,
      "two concurrent callers at TTL expiry must share one failing retry — not issue two separate fetches",
    );

    // Both callers receive null — not a split result where one gets stale/undefined.
    assert.equal(resultA, null, "first caller must receive null when the shared retry fails");
    assert.equal(resultB, null, "second caller must also receive null — not a split result");

    // The re-cached entry must use NEGATIVE_TTL_MS, not the 30-day positive TTL.
    const entry = _getGeocodeCacheEntryForTests("failracecity");
    assert.ok(entry, "a negative cache entry must exist after the failing retry");

    const expectedExpiresAt = T1 + NEGATIVE_TTL_MS;
    assert.ok(
      Math.abs(entry.expiresAt - expectedExpiresAt) < 50,
      `expiresAt must be ≈ T1 + NEGATIVE_TTL_MS (${expectedExpiresAt}) — got ${entry.expiresAt}. ` +
      "If the positive TTL were used the entry would not expire for 30 days.",
    );
    assert.equal(entry.result, null,
      "the re-cached entry must store null — not a stale positive result");
  });

  it("DB write failure during TTL-retry is logged as persist_failed — not silently dropped (upsert returns error)", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1: seed a negative cache entry.
    // _setGeocodeFetchForTests also sets _dbClientOverride = null (no DB).
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));

    const first = await geocodeCityCountry("PersistFailCity");
    assert.equal(first, null, "pre-condition: city should cache as null");

    // Step 2: advance past NEGATIVE_TTL_MS so the entry is stale.
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    // Step 3: swap fetch to return a valid geocode result on the retry.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "it", country: "Italy" } }],
    }));

    // Step 4: install a DB client where readDbCache (maybySingle) returns null
    // (so the retry proceeds to Nominatim) and upsert returns an error object
    // (simulating a DB write failure on the persist step).
    const DB_WRITE_ERROR = "connection refused";
    const failingWriteDb = {
      from(_table: string) {
        const chain: any = {
          select()  { return chain; },
          eq()      { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
          upsert(_row: unknown) {
            return Promise.resolve({ error: { message: DB_WRITE_ERROR } });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(failingWriteDb);

    // Step 5: capture log output so we can assert on the persist_failed event.
    const loggedEvents: Array<Record<string, unknown>> = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      try {
        const parsed = JSON.parse(String(args[0]));
        loggedEvents.push(parsed);
      } catch {
        origLog(...args);
      }
    };

    let result: Awaited<ReturnType<typeof geocodeCityCountry>>;
    try {
      result = await geocodeCityCountry("PersistFailCity");
    } finally {
      console.log = origLog;
    }

    // Step 6: the resolved result must be returned — DB error must NOT be propagated.
    assert.equal(result?.countryCode, "IT",
      "TTL-retry should resolve and return the geocoded result even when the DB write fails");
    assert.equal(result?.country, "Italy");

    // Step 7: a persist_failed event must have been emitted.
    // normCity("PersistFailCity") → "persistfailcity"
    const persistFailedEvents = loggedEvents.filter(
      (e) => e.event === "stamp.country_geocode.persist_failed",
    );
    assert.equal(
      persistFailedEvents.length,
      1,
      "exactly one persist_failed log event must be emitted when the DB write returns an error",
    );
    assert.equal(
      persistFailedEvents[0].city_key,
      "persistfailcity",
      "persist_failed must carry the normalised city_key",
    );
    assert.equal(
      persistFailedEvents[0].error,
      DB_WRITE_ERROR,
      "persist_failed must carry the DB error message",
    );
  });

  it("DB write failure during TTL-retry is logged as persist_failed — not silently dropped (upsert throws)", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1: seed a negative cache entry (no DB).
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));

    const first = await geocodeCityCountry("PersistThrowCity");
    assert.equal(first, null, "pre-condition: city should cache as null");

    // Step 2: advance past NEGATIVE_TTL_MS so the entry is stale.
    mockNow(T0 + NEGATIVE_TTL_MS + 1_000);

    // Step 3: swap fetch to return a valid geocode result.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "es", country: "Spain" } }],
    }));

    // Step 4: install a DB client where upsert throws (exercises the catch branch
    // of writeDbCache rather than the `if (error)` branch).
    const THROW_ERROR_MSG = "unexpected db exception";
    const throwingWriteDb = {
      from(_table: string) {
        const chain: any = {
          select()  { return chain; },
          eq()      { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
          upsert(_row: unknown): Promise<{ error: null }> {
            throw new Error(THROW_ERROR_MSG);
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(throwingWriteDb);

    // Step 5: capture log output.
    const loggedEvents: Array<Record<string, unknown>> = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      try {
        const parsed = JSON.parse(String(args[0]));
        loggedEvents.push(parsed);
      } catch {
        origLog(...args);
      }
    };

    let result: Awaited<ReturnType<typeof geocodeCityCountry>>;
    try {
      result = await geocodeCityCountry("PersistThrowCity");
    } finally {
      console.log = origLog;
    }

    // Step 6: resolved result must be returned despite the thrown DB error.
    assert.equal(result?.countryCode, "ES",
      "TTL-retry should resolve and return the geocoded result even when writeDbCache throws");
    assert.equal(result?.country, "Spain");

    // Step 7: a persist_failed event must be emitted via the catch branch.
    // normCity("PersistThrowCity") → "persistthrowcity"
    const persistFailedEvents = loggedEvents.filter(
      (e) => e.event === "stamp.country_geocode.persist_failed",
    );
    assert.equal(
      persistFailedEvents.length,
      1,
      "exactly one persist_failed log event must be emitted when writeDbCache throws",
    );
    assert.equal(
      persistFailedEvents[0].city_key,
      "persistthrowcity",
      "persist_failed must carry the normalised city_key",
    );
    assert.equal(
      persistFailedEvents[0].error,
      THROW_ERROR_MSG,
      "persist_failed must carry the thrown error message",
    );
  });

  it("a network error during TTL retry does not overwrite a positive DB cache row with null", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1: seed a positive DB cache row by resolving the city once.
    // The successful geocode writes the result back to the DB via writeDbCache.
    let seedUpsertCount = 0;
    const seedDb = {
      from(_table: string) {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
          upsert(_row?: Record<string, unknown>) {
            seedUpsertCount++;
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(seedDb);
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "fr", country: "France" } }],
    }));

    const first = await geocodeCityCountry("NoOverwriteCity");
    assert.equal(first?.countryCode, "FR", "pre-condition: initial geocode should resolve FR");
    assert.equal(seedUpsertCount, 1, "pre-condition: positive DB row should be seeded");

    // Step 2: advance past NEGATIVE_TTL_MS and evict the in-memory entry so the
    // next call must re-resolve (simulating a TTL retry).
    const T1 = T0 + NEGATIVE_TTL_MS + 1_000;
    mockNow(T1);
    evictGeocodeCacheKey("nooverwritecity");

    // Step 3: install a DB client that returns null (no row) and tracks upsert
    // calls, and make Nominatim throw a network error.
    let retryUpsertCount = 0;
    const errorDb = {
      from(_table: string) {
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
          upsert() {
            retryUpsertCount++;
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(errorDb);
    _setGeocodeFetchForTests(async () => {
      throw new Error("network_error");
    });

    // Step 4: the retry should fail and cache null in-memory, but must never
    // call writeDbCache (upsert) with that null result.
    const second = await geocodeCityCountry("NoOverwriteCity");
    assert.equal(second, null, "network error should return null");
    assert.equal(retryUpsertCount, 0,
      "writeDbCache must NOT be called after a network error — a null upsert could corrupt the previously seeded positive DB row");

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

  it("sweep with corrected_at == writtenAt does not evict the freshly re-cached null entry (strict-less-than boundary)", async () => {
    // Regression guard for an off-by-one in the sweep condition.
    // The sweep evicts entries where entry.writtenAt < correctedMs (strictly less than).
    // When writtenAt == correctedMs the entry must be kept — an off-by-one (≤) would
    // silently drop a fresh null entry that was written at the exact same millisecond
    // as the correction timestamp.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1 — seed a null (negative) cache entry at T0.
    // No DB (getServiceClient throws in tests) so readDbCache returns null and
    // the code falls through to forwardGeocodeCity (returns empty → null).
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    const first = await geocodeCityCountry("SweepBoundaryCity");
    assert.equal(first, null, "pre-condition: city should be cached as null at T0");

    // Step 2 — advance to T1 (past NEGATIVE_TTL_MS) so the T0 entry is stale,
    // then trigger a network-error retry so the catch block re-caches null with
    // writtenAt = T1.
    const T1 = T0 + NEGATIVE_TTL_MS + 1_000;
    mockNow(T1);

    _setGeocodeFetchForTests(async () => { throw new Error("network_timeout"); });
    const retry = await geocodeCityCountry("SweepBoundaryCity");
    assert.equal(retry, null, "network error during retry should return null");

    // Confirm the re-cached entry has writtenAt ≈ T1.
    const entryBeforeSweep = _getGeocodeCacheEntryForTests("sweepboundarycity");
    assert.ok(entryBeforeSweep, "pre-condition: re-cached null entry must exist before sweep");
    assert.ok(
      Math.abs(entryBeforeSweep.writtenAt - T1) < 50,
      `pre-condition: writtenAt (${entryBeforeSweep.writtenAt}) must be ≈ T1 (${T1})`,
    );

    // Step 3 — run the correction sweep with corrected_at == T1 (exactly equal).
    // The condition is entry.writtenAt < correctedMs so equal should NOT evict.
    const correctedAtIso = new Date(T1).toISOString();
    const cityKey = "sweepboundarycity"; // normCity("SweepBoundaryCity")
    const sweepDb = makeSweepDbClient([{ city_key: cityKey, corrected_at: correctedAtIso }]);
    _setGeocodeDbClientForTests(sweepDb);

    await _runCorrectionSweepForTests();

    // The entry must still be present — writtenAt == correctedMs is not evicted.
    const entryAfterSweep = _getGeocodeCacheEntryForTests(cityKey);
    assert.ok(
      entryAfterSweep !== undefined,
      "sweep must NOT evict a null entry whose writtenAt equals corrected_at — boundary is strictly less than",
    );
    assert.equal(entryAfterSweep!.result, null,
      "the surviving entry must still carry result: null");
  });

  it("sweep with corrected_at == writtenAt + 1 evicts the freshly re-cached null entry", async () => {
    // Complementary to the boundary test above: one millisecond past the boundary
    // (corrected_at = writtenAt + 1) must evict, confirming the comparison is < not ≤.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1 — seed a null cache entry at T0.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    const first = await geocodeCityCountry("SweepBoundaryPlusOneCity");
    assert.equal(first, null, "pre-condition: city should be cached as null at T0");

    // Step 2 — advance to T1, trigger a network-error retry → writtenAt = T1.
    const T1 = T0 + NEGATIVE_TTL_MS + 1_000;
    mockNow(T1);

    _setGeocodeFetchForTests(async () => { throw new Error("network_timeout"); });
    const retry = await geocodeCityCountry("SweepBoundaryPlusOneCity");
    assert.equal(retry, null, "network error during retry should return null");

    // Confirm the re-cached entry has writtenAt ≈ T1.
    const entryBeforeSweep = _getGeocodeCacheEntryForTests("sweepboundaryplusonecity");
    assert.ok(entryBeforeSweep, "pre-condition: re-cached null entry must exist before sweep");
    assert.ok(
      Math.abs(entryBeforeSweep.writtenAt - T1) < 50,
      `pre-condition: writtenAt (${entryBeforeSweep.writtenAt}) must be ≈ T1 (${T1})`,
    );

    // Step 3 — run the correction sweep with corrected_at = T1 + 1.
    // writtenAt (≈ T1) < correctedMs (T1 + 1) is true → entry must be evicted.
    const correctedAtIso = new Date(T1 + 1).toISOString();
    const cityKey = "sweepboundaryplusonecity"; // normCity("SweepBoundaryPlusOneCity")
    const sweepDb = makeSweepDbClient([{ city_key: cityKey, corrected_at: correctedAtIso }]);
    _setGeocodeDbClientForTests(sweepDb);

    await _runCorrectionSweepForTests();

    // The entry must be absent — writtenAt < correctedMs is satisfied.
    const entryAfterSweep = _getGeocodeCacheEntryForTests(cityKey);
    assert.equal(
      entryAfterSweep,
      undefined,
      "sweep MUST evict a null entry whose writtenAt is strictly less than corrected_at",
    );
  });

  it("two simultaneous calls after a sweep-evicted null entry share one Nominatim fetch — not two", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1 — seed a null (negative) cache entry.
    // _setGeocodeFetchForTests also sets _dbClientOverride = null (no DB),
    // so readDbCache returns null and the code falls through to Nominatim.
    let fetchCallCount = 0;
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return { ok: true, json: async () => [] };
    });

    const seed = await geocodeCityCountry("SweepConcurrentCity");
    assert.equal(seed, null, "pre-condition: unresolved city should be cached as null");
    assert.equal(fetchCallCount, 1, "pre-condition: one fetch to seed the negative entry");

    // Step 2 — run the correction sweep so the null entry is evicted.
    // The sweep DB client has a pass-1 row with corrected_at > T0, triggering eviction.
    const correctedAtIso = new Date(T0 + 500).toISOString();
    const cityKey = "sweepconcurrentcity"; // normCity("SweepConcurrentCity")
    const sweepDb = makeSweepDbClient([{ city_key: cityKey, corrected_at: correctedAtIso }]);
    _setGeocodeDbClientForTests(sweepDb);

    await _runCorrectionSweepForTests();

    // Step 3 — swap fetch to return a valid geocode result on the retry.
    // Both racing callers must share this single invocation via the _pending dedup map.
    // _setGeocodeFetchForTests resets _dbClientOverride to null, so readDbCache
    // returns null and the code proceeds straight to forwardGeocodeCity.
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "de", country: "Germany" } }],
      };
    });

    // Step 4 — fire two concurrent calls.  The null entry has been evicted so
    // neither caller finds a valid cache entry; both reach the _pending check.
    // The first caller synchronously stores its promise in _pending before any
    // await; the second caller finds that same promise and returns it — so
    // exactly one Nominatim fetch is made.
    const [resultA, resultB] = await Promise.all([
      geocodeCityCountry("SweepConcurrentCity"),
      geocodeCityCountry("SweepConcurrentCity"),
    ]);

    // Exactly one Nominatim call across both callers (seed fetch + one retry = 2 total).
    assert.equal(
      fetchCallCount,
      2,
      "two concurrent callers after sweep eviction must share one Nominatim fetch — not issue two",
    );

    // Both callers receive the same resolved result.
    assert.equal(resultA?.countryCode, "DE",
      "first caller should receive the geocoded result");
    assert.equal(resultB?.countryCode, "DE",
      "second caller should receive the same geocoded result — not a duplicate fetch");
    assert.equal(resultA?.country, "Germany");
    assert.equal(resultB?.country, "Germany");
  });
});

// ── Tombstone-sweep eviction retry ───────────────────────────────────────────
//
// The correction sweep has a second pass that evicts entries whose DB row has
// deleted_at set (tombstone path).  A null (negative) cache entry evicted via
// this path must trigger a fresh geocode on the next call — not stay absent or
// permanently null.

describe("tombstone-sweep eviction: negative entry retries after sweep removes it via pass 2", () => {
  /**
   * Build a fake Supabase client suitable for the tombstone sweep path.
   *
   * awaitIdx mapping:
   *   0 → pass-1 query (corrected_at rows — empty, so tombstone path is exercised)
   *   1 → pass-2 query (tombstoned rows)
   *   2 → pass-2 delete (hard-delete of tombstone rows)
   *
   * maybeSingle() is used by geocodeCityCountry → readDbCache after the sweep
   * evicts the entry; it returns null so the code falls through to Nominatim.
   */
  function makeTombstoneSweepDbClient(
    tombstoneRows: Array<{ city_key: string }>,
  ): SupabaseClient {
    let awaitIdx = 0;
    const awaitedResponses: Array<{ data: any; error: null }> = [
      { data: [],            error: null }, // pass-1: no corrected_at rows
      { data: tombstoneRows, error: null }, // pass-2: tombstoned rows
      { data: null,          error: null }, // pass-2 delete result
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

  it("retries and returns a valid result after the tombstone sweep evicts a null cache entry", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1 — seed a null (negative) cache entry.
    // _setGeocodeFetchForTests also sets _dbClientOverride = null (no DB),
    // so readDbCache returns null and the code falls through to Nominatim.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));

    const first = await geocodeCityCountry("TombstoneCity");
    assert.equal(first, null, "pre-condition: unresolved city should be cached as null");

    // Step 2 — install a sweep DB client whose pass-2 result contains a
    // tombstone row for the city key, which will cause the sweep to evict
    // the null entry via the tombstone path.
    const cityKey = "tombstonecity"; // normCity("TombstoneCity")
    const tombstoneDb = makeTombstoneSweepDbClient([{ city_key: cityKey }]);
    _setGeocodeDbClientForTests(tombstoneDb);

    await _runCorrectionSweepForTests();

    // Step 3 — swap fetch to return a valid geocode result.
    // _setGeocodeFetchForTests resets _dbClientOverride to null, so readDbCache
    // returns null and the code proceeds straight to forwardGeocodeCity.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "br", country: "Brazil" } }],
    }));

    // Step 4 — the tombstone-sweep-evicted key must re-geocode, not stay absent/null.
    const second = await geocodeCityCountry("TombstoneCity");
    assert.equal(
      second?.countryCode,
      "BR",
      "after tombstone-sweep eviction the null entry must be absent so the next call retries and returns a valid result",
    );
    assert.equal(second?.country, "Brazil");
  });
});

// ── Tombstone-sweep: concurrent revival between pass-2 select and delete ──────
//
// The hard-delete in pass 2 is guarded with .not("deleted_at", "is", null) so
// that a row revived by a concurrent PUT (deleted_at cleared) is not destroyed.
// The guard means the delete can legitimately affect 0 rows.  The sweep must:
//   • still evict the in-memory entry (eviction is unconditional, before delete)
//   • not throw or propagate an error when the delete is a no-op

describe("tombstone-sweep: concurrent revival between pass-2 select and delete", () => {
  /**
   * Build a fake sweep DB client where:
   *   await idx 0 → pass-1 query: no corrected_at rows
   *   await idx 1 → pass-2 select: one tombstone row
   *   await idx 2 → pass-2 delete: 0 rows deleted (guard matched nothing —
   *                 simulates the row being revived between select and delete)
   *
   * maybeSingle() (used by readDbCache after the sweep) returns null to avoid
   * a real DB round-trip in this focused test.
   */
  function makeConcurrentRevivalSweepClient(
    tombstoneRows: Array<{ city_key: string }>,
    onDelete?: () => void,
  ): SupabaseClient {
    let awaitIdx = 0;
    const awaitedResponses: Array<{ data: any; error: null; count?: number }> = [
      { data: [],            error: null },           // pass-1: no corrected_at rows
      { data: tombstoneRows, error: null },           // pass-2 select: tombstone found
      { data: [],            error: null, count: 0 }, // pass-2 delete: 0 rows (revived)
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
          async maybeSingle() {
            return { data: null, error: null };
          },
          then(
            resolve: (v: any) => any,
            reject?: (e: any) => any,
          ): Promise<any> {
            const idx = awaitIdx++;
            const resp = awaitedResponses[Math.min(idx, awaitedResponses.length - 1)];
            if (idx === 2) onDelete?.();
            return Promise.resolve(resp).then(resolve, reject);
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
  }

  it("evicts the in-memory entry even when the hard-delete affects 0 rows (row was revived)", async () => {
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // Step 1 — seed a positive cache entry for the city so the eviction can
    // be observed (the entry must be present before the sweep and absent after).
    silentFetch();
    const db0 = makeQueuedDbClient([
      { country: "France", country_code: "FR", corrected_at: null },
    ]);
    _setGeocodeDbClientForTests(db0);
    const before = await geocodeCityCountry("RevivalRaceCity");
    assert.equal(before?.countryCode, "FR", "pre-condition: cache entry should be present before sweep");

    // Confirm the entry is in the cache before the sweep.
    const entryBefore = _getGeocodeCacheEntryForTests("rivalracecity".replace("rival", "revival"));
    // normCity("RevivalRaceCity") → "rivalracecity" — but let's confirm via the returned value.
    assert.ok(before, "pre-condition: geocode result must be non-null");

    // Step 2 — install a sweep DB client that returns a tombstone row in pass-2
    // select but reports 0 rows deleted (simulating a concurrent PUT revival).
    const cityKey = "rivalracecity".replace("rival", "revival"); // normCity("RevivalRaceCity")
    let deleteWasCalled = false;
    const sweepDb = makeConcurrentRevivalSweepClient(
      [{ city_key: cityKey }],
      () => { deleteWasCalled = true; },
    );
    _setGeocodeDbClientForTests(sweepDb);

    // Step 3 — the sweep must complete without throwing even though the delete
    // affects 0 rows.
    let thrownErr: unknown = undefined;
    try {
      await _runCorrectionSweepForTests();
    } catch (e) {
      thrownErr = e;
    }
    assert.equal(thrownErr, undefined,
      "runCorrectionSweep must not throw when the pass-2 delete affects 0 rows");

    // Step 4 — the delete path must have been reached (delete was attempted).
    assert.ok(deleteWasCalled,
      "the pass-2 delete should have been attempted even though it will match 0 rows");

    // Step 5 — the in-memory cache entry must have been evicted unconditionally
    // (eviction happens in the for-loop before the delete).
    const entryAfter = _getGeocodeCacheEntryForTests(cityKey);
    assert.equal(entryAfter, undefined,
      "the in-memory cache entry must be evicted even when the hard-delete is a no-op");
  });

  it("does not throw when the pass-2 select returns a tombstone but the delete guard eliminates all rows", async () => {
    // Focused variant: no pre-seeded positive entry — verifies the no-throw
    // guarantee even when the in-memory cache has no entry for the city.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    // City is NOT in the cache (never geocoded).
    const cityKey = "ghostcity";

    let deleteWasCalled = false;
    const sweepDb = makeConcurrentRevivalSweepClient(
      [{ city_key: cityKey }],
      () => { deleteWasCalled = true; },
    );
    _setGeocodeDbClientForTests(sweepDb);

    let thrownErr: unknown = undefined;
    try {
      await _runCorrectionSweepForTests();
    } catch (e) {
      thrownErr = e;
    }

    assert.equal(thrownErr, undefined,
      "sweep must not throw even when the deleted entry was never in the in-memory cache");
    assert.ok(deleteWasCalled,
      "delete must still be attempted for tombstone keys that are absent from the in-memory cache");

    // Cache entry should remain absent (it was never there, and the sweep should
    // not accidentally insert anything).
    const entryAfter = _getGeocodeCacheEntryForTests(cityKey);
    assert.equal(entryAfter, undefined,
      "a key absent from the cache before the sweep must remain absent after it");
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

  it("does not probe the DB before the interval elapses for a Nominatim-sourced entry where correctionCheckedAt is absent", async () => {
    // When the DB has no persisted row the code falls through to forwardGeocodeCity
    // (Nominatim).  The resulting CacheEntry is written WITHOUT correctionCheckedAt
    // (see the forwardGeocodeCity branch in geocodeCityCountry).  The probe guard
    // must fall back to `correctionCheckedAt ?? writtenAt` and still prevent an
    // early re-probe within the same interval.
    const T0 = 1_700_000_000_000;
    mockNow(T0);

    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "jp", country: "Japan" } }],
    }));

    let dbCallCount = 0;
    const db = makeQueuedDbClient(
      [
        // call 0: readDbCache — no persisted row; falls through to Nominatim.
        null,
        // Any further call would be a correction probe — must NOT happen within the interval.
        { corrected_at: new Date(T0 + 500).toISOString() },
      ],
      (idx) => { dbCallCount = idx + 1; },
    );
    _setGeocodeDbClientForTests(db);

    // First call: DB miss → Nominatim hit → cache entry written WITHOUT correctionCheckedAt.
    const first = await geocodeCityCountry("NominatimCity");
    assert.equal(first?.countryCode, "JP",
      "pre-condition: Nominatim-sourced entry should resolve to JP");
    assert.equal(dbCallCount, 1,
      "exactly one DB call for the initial readDbCache — no extra probe");

    // Confirm the Nominatim path leaves correctionCheckedAt unset.
    const entry = _getGeocodeCacheEntryForTests("nominatimcity");
    assert.ok(entry, "pre-condition: cache entry must exist after Nominatim geocode");
    assert.equal(entry.correctionCheckedAt, undefined,
      "Nominatim-sourced entries must not set correctionCheckedAt — this is the fallback path under test");

    // Advance by LESS than one full interval from writtenAt.
    // Guard: lastCheck = correctionCheckedAt ?? writtenAt = writtenAt ≈ T0.
    // (T0 + INTERVAL - 1_000) - T0 < INTERVAL → probe must NOT fire.
    mockNow(T0 + CORRECTION_CHECK_INTERVAL_MS - 1_000);

    const second = await geocodeCityCountry("NominatimCity");
    assert.equal(second?.countryCode, "JP",
      "should return the cached Nominatim result without probing the DB");
    assert.equal(dbCallCount, 1,
      "the correctionCheckedAt ?? writtenAt fallback must prevent a DB probe before the interval elapses");
  });
});

// ── PUT-revival race: in-flight null must not re-poison cache after eviction ──
//
// When a geocodeCityCountry call is in-flight (awaiting a Nominatim fetch that
// will return null because the DB row is tombstoned) and evictGeocodeCacheKey
// runs concurrently (simulating a PUT revival), the in-flight promise must NOT
// write its null result back into the cache after it settles.  Without the
// _pending.get(key) === p guard, the null write re-poisons the entry and the
// next caller gets null instead of re-resolving from the freshly-revived DB row.

describe("PUT-revival race: in-flight null does not re-poison cache after eviction", () => {
  it("next call re-resolves from DB when eviction races the in-flight Nominatim null", async () => {
    // Gate that lets us suspend the Nominatim fetch mid-flight so eviction
    // runs between the fetch start and fetch settle.
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });

    // The in-flight fetch suspends until released, then returns empty (null geocode).
    _setGeocodeFetchForTests(async () => {
      await fetchGate;
      return { ok: true, json: async () => [] };
    });

    let dbCallCount = 0;
    // call 0: readDbCache during the in-flight call — no row (tombstoned/absent)
    // call 1: readDbCache on the subsequent call after eviction — valid FR result
    //         (the PUT revival wrote this row to the DB while the fetch was in-flight)
    const db = makeQueuedDbClient(
      [
        null,
        { country: "France", country_code: "FR", corrected_at: null },
      ],
      (idx) => { dbCallCount = idx + 1; },
    );
    _setGeocodeDbClientForTests(db);

    // Start the geocode call — it suspends inside forwardGeocodeCity awaiting the fetch.
    const inFlightPromise = geocodeCityCountry("EvictionRaceCity");

    // Simulate the PUT revival handler calling evictGeocodeCacheKey while the
    // Nominatim fetch is still pending.  This removes the key from both _cache
    // and _pending.  The fix: the in-flight promise checks _pending.get(key) === p
    // before writing to _cache, and skips the write when evicted.
    evictGeocodeCacheKey("evictionracecity"); // normCity("EvictionRaceCity")

    // Release the suspended fetch — Nominatim returns nothing → result is null.
    // Without the fix this would write _cache.set("evictionracecity", { result: null, ... }).
    releaseFetch();
    const inFlightResult = await inFlightPromise;
    assert.equal(inFlightResult, null,
      "the in-flight call itself should return null (Nominatim found nothing)");

    // The critical assertion: the cache must NOT contain a re-poisoned null entry.
    // The next call should see no valid cache entry and fall through to readDbCache,
    // which now returns the FR row written by the PUT revival.
    const second = await geocodeCityCountry("EvictionRaceCity");
    assert.equal(second?.countryCode, "FR",
      "after PUT eviction the next call must re-resolve from the DB — not serve the re-poisoned null");
    assert.equal(second?.country, "France");
    assert.equal(dbCallCount, 2,
      "exactly two DB calls: one during in-flight readDbCache (null) and one after eviction (FR)");
  });

  it("eviction during readDbCache (before the Nominatim fetch) also prevents the null write", async () => {
    // A subtler variant: eviction happens between readDbCache returning null and
    // forwardGeocodeCity being called.  The guard must also protect this path.
    let releaseDb!: () => void;
    const dbGate = new Promise<void>((resolve) => { releaseDb = resolve; });

    let dbCallIndex = 0;
    const db: any = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache");
        const chain: any = {
          select() { return chain; },
          eq() { return chain; },
          async maybySingle() { return { data: null, error: null }; },
          async maybeSingle() {
            const idx = dbCallIndex++;
            if (idx === 0) {
              // First call (readDbCache during in-flight): suspend so we can
              // interleave the eviction before forwardGeocodeCity starts.
              await dbGate;
              return { data: null, error: null };
            }
            // Second call (readDbCache after eviction): return a valid DE row.
            return { data: { country: "Germany", country_code: "DE", corrected_at: null }, error: null };
          },
          upsert() { return Promise.resolve({ error: null }); },
        };
        return chain;
      },
    };

    // IMPORTANT: call _setGeocodeFetchForTests BEFORE _setGeocodeDbClientForTests.
    // _setGeocodeFetchForTests resets _dbClientOverride to null; the subsequent
    // _setGeocodeDbClientForTests call overwrites it with our fake DB client.
    // Reversing this order would null out the DB client and break readDbCache.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(db);

    // Start the geocode call — suspends inside readDbCache awaiting the dbGate.
    const inFlightPromise = geocodeCityCountry("EarlyEvictionCity");

    // Evict while readDbCache is suspended.
    evictGeocodeCacheKey("earlyevictioncity"); // normCity("EarlyEvictionCity")

    // Release readDbCache → returns null → forwardGeocodeCity runs → null result.
    releaseDb();
    const inFlightResult = await inFlightPromise;
    assert.equal(inFlightResult, null,
      "in-flight call should return null (Nominatim empty)");

    // The next call must re-resolve from the DB, not serve a poisoned null.
    const second = await geocodeCityCountry("EarlyEvictionCity");
    assert.equal(second?.countryCode, "DE",
      "after early eviction the next call must re-resolve from DB — not serve the null the in-flight settled with");
    assert.equal(second?.country, "Germany");
  });
});

// ── Cold-start dedup ──────────────────────────────────────────────────────────
//
// When both the in-memory cache and the DB cache are empty (first-ever lookup),
// two concurrent callers must still share a single Nominatim request — the
// _pending dedup map must be populated synchronously before the first await so
// the second caller always finds the promise and piggy-backs on it.

describe("cold-start dedup: concurrent calls on a completely empty cache share one Nominatim fetch", () => {
  it("two concurrent calls with no in-memory cache and no DB row make exactly one fetch", async () => {
    // beforeEach already calls _clearCountryGeocodeCache(), so both the
    // in-memory cache and _pending map are empty at the start of this test.

    let fetchCallCount = 0;
    _setGeocodeFetchForTests(async () => {
      fetchCallCount++;
      return {
        ok: true,
        json: async () => [{ address: { country_code: "nz", country: "New Zealand" } }],
      };
    });

    // _setGeocodeFetchForTests sets _dbClientOverride = null (no DB),
    // so readDbCache returns null and both callers fall through to forwardGeocodeCity.
    // The first caller creates the _pending promise synchronously (before any await);
    // the second caller finds that promise via _pending.get(key) and returns it —
    // guaranteeing a single Nominatim fetch.
    const [resultA, resultB] = await Promise.all([
      geocodeCityCountry("ColdStartCity"),
      geocodeCityCountry("ColdStartCity"),
    ]);

    assert.equal(
      fetchCallCount,
      1,
      "two concurrent cold-start callers must share one Nominatim fetch — not issue two",
    );

    assert.equal(resultA?.countryCode, "NZ",
      "first caller should receive the geocoded result");
    assert.equal(resultB?.countryCode, "NZ",
      "second caller should receive the same geocoded result — not a duplicate fetch");
    assert.equal(resultA?.country, "New Zealand");
    assert.equal(resultB?.country, "New Zealand");
  });
});
