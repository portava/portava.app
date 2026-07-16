/**
 * Geocoding-backed country resolution for stamps.
 *
 * Guards Task "recognize any city's country automatically": cities missing
 * from the static lookup resolve via geocoding (cached, deduplicated), and
 * failures still leave "XX" — never guessed. Also covers the XX-catalog
 * repair (re-key / merge) with a geocoding resolver.
 *
 * Run: node --import tsx/esm --test src/test/stampCountryGeocoder.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  geocodeCityCountry,
  resolveCountryWithGeocoding,
  _setGeocodeFetchForTests,
  _setGeocodeDbClientForTests,
  _clearCountryGeocodeCache,
  _runCorrectionSweepForTests,
  _backdateGeocodeCacheEntryForTests,
  startCorrectionSweep,
} from "../lib/stamps/countryGeocoder.js";
import {
  repairXXCatalogEntries,
  makeGeocodingResolver,
  staticResolver,
} from "../lib/stamps/xxCatalogRepair.js";

// ── Fake fetch helpers ────────────────────────────────────────────────────────

let fetchCalls: string[] = [];

function fakeNominatim(results: Record<string, { country_code: string; country: string } | null>) {
  return async (url: string) => {
    fetchCalls.push(url);
    const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "").toLowerCase();
    const hit = results[q];
    return {
      ok: true,
      json: async () => (hit ? [{ address: { country_code: hit.country_code, country: hit.country } }] : []),
    };
  };
}

beforeEach(() => {
  fetchCalls = [];
  _clearCountryGeocodeCache();
  _setGeocodeFetchForTests(null);
});

// ── geocodeCityCountry ────────────────────────────────────────────────────────

describe("geocodeCityCountry", () => {
  it("resolves an unknown city's country via forward geocoding", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "banff": { country_code: "ca", country: "Canada" },
    }));
    const r = await geocodeCityCountry("Banff");
    assert.deepEqual(r, { country: "Canada", countryCode: "CA" });
  });

  it("prefers the canonical English country name from the static table", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "köln": { country_code: "de", country: "Deutschland" },
    }));
    const r = await geocodeCityCountry("Köln");
    assert.equal(r?.country, "Germany"); // not "Deutschland"
    assert.equal(r?.countryCode, "DE");
  });

  it("caches positive results — one fetch for repeated calls", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "banff": { country_code: "ca", country: "Canada" },
    }));
    await geocodeCityCountry("Banff");
    await geocodeCityCountry("banff ");
    await geocodeCityCountry("BANFF");
    assert.equal(fetchCalls.length, 1);
  });

  it("returns null (never guesses) when geocoding finds nothing", async () => {
    _setGeocodeFetchForTests(fakeNominatim({}));
    assert.equal(await geocodeCityCountry("Nowhereville"), null);
  });

  it("returns null and caches negatively when the provider errors", async () => {
    _setGeocodeFetchForTests(async (url: string) => {
      fetchCalls.push(url);
      return { ok: false, status: 503, json: async () => ({}) };
    });
    assert.equal(await geocodeCityCountry("Banff"), null);
    assert.equal(await geocodeCityCountry("Banff"), null); // negative-cached
    assert.equal(fetchCalls.length, 1);
  });

  it("rejects invalid country codes from the provider", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "weird": { country_code: "canada", country: "Canada" },
    }));
    assert.equal(await geocodeCityCountry("Weird"), null);
  });
});

// ── Persistent DB cache ───────────────────────────────────────────────────────

interface GeoCacheRow { city_key: string; country: string; country_code: string; updated_at?: string }

function makeFakeGeoCacheDb(rows: GeoCacheRow[]) {
  const calls = { reads: 0, upserts: 0 };
  const client = {
    from(table: string) {
      assert.equal(table, "city_country_geocode_cache");
      let _key: string | null = null;
      const chain: any = {
        select() { return chain; },
        eq(_col: string, val: string) { _key = val; return chain; },
        async maybeSingle() {
          calls.reads += 1;
          return { data: rows.find((r) => r.city_key === _key) ?? null, error: null };
        },
        async upsert(row: GeoCacheRow) {
          calls.upserts += 1;
          const i = rows.findIndex((r) => r.city_key === row.city_key);
          if (i >= 0) rows[i] = row; else rows.push(row);
          return { error: null };
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, rows, calls };
}

describe("geocodeCityCountry persistent cache", () => {
  it("serves a persisted positive result without hitting the geocoder", async () => {
    _setGeocodeFetchForTests(async (url: string) => {
      fetchCalls.push(url);
      throw new Error("should not be called");
    });
    const db = makeFakeGeoCacheDb([{ city_key: "banff", country: "Canada", country_code: "CA" }]);
    _setGeocodeDbClientForTests(db.client);
    const r = await geocodeCityCountry("Banff");
    assert.deepEqual(r, { country: "Canada", countryCode: "CA" });
    assert.equal(fetchCalls.length, 0);

    // Now in the in-memory (L1) cache — repeat calls don't re-read the DB.
    await geocodeCityCountry("BANFF");
    assert.equal(db.calls.reads, 1);
  });

  it("persists positive geocode results to the DB", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "tromso": { country_code: "no", country: "Norway" },
    }));
    const db = makeFakeGeoCacheDb([]);
    _setGeocodeDbClientForTests(db.client);
    await geocodeCityCountry("Tromso");
    assert.equal(db.calls.upserts, 1);
    assert.deepEqual(db.rows[0].city_key, "tromso");
    assert.equal(db.rows[0].country_code, "NO");
    assert.equal(db.rows[0].country, "Norway");
  });

  it("does NOT persist negative results — failures stay retryable", async () => {
    _setGeocodeFetchForTests(fakeNominatim({}));
    const db = makeFakeGeoCacheDb([]);
    _setGeocodeDbClientForTests(db.client);
    assert.equal(await geocodeCityCountry("Nowhereville"), null);
    assert.equal(db.calls.upserts, 0);
  });

  it("falls through to geocoding when the DB cache errors", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "banff": { country_code: "ca", country: "Canada" },
    }));
    _setGeocodeDbClientForTests({
      from() { throw new Error("db down"); },
    } as unknown as SupabaseClient);
    const r = await geocodeCityCountry("Banff");
    assert.deepEqual(r, { country: "Canada", countryCode: "CA" });
  });

  it("ignores corrupt persisted rows and re-geocodes", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "banff": { country_code: "ca", country: "Canada" },
    }));
    const db = makeFakeGeoCacheDb([{ city_key: "banff", country: "Canada", country_code: "CANADA" }]);
    _setGeocodeDbClientForTests(db.client);
    const r = await geocodeCityCountry("Banff");
    assert.deepEqual(r, { country: "Canada", countryCode: "CA" });
    assert.equal(fetchCalls.length, 1);
  });
});

// ── resolveCountryWithGeocoding ───────────────────────────────────────────────

describe("resolveCountryWithGeocoding", () => {
  it("uses the static lookup without any network call when possible", async () => {
    _setGeocodeFetchForTests(async (url: string) => {
      fetchCalls.push(url);
      throw new Error("should not be called");
    });
    const r = await resolveCountryWithGeocoding({ city: "London" });
    assert.equal(r.countryCode, "GB");
    assert.equal(fetchCalls.length, 0);
  });

  it("falls back to forward geocoding for cities the static lookup misses", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "tromso": { country_code: "no", country: "Norway" },
    }));
    const r = await resolveCountryWithGeocoding({ city: "Tromso" });
    assert.equal(r.countryCode, "NO");
    assert.equal(r.country, "Norway");
  });

  it("leaves XX when geocoding fails — never guesses", async () => {
    _setGeocodeFetchForTests(fakeNominatim({}));
    const r = await resolveCountryWithGeocoding({ city: "Nowhereville" });
    assert.equal(r.countryCode, "XX");
  });
});

// ── XX catalog repair with geocoding ──────────────────────────────────────────

type DB = Record<string, any[]>;

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

function makeFakeClient(db: DB): SupabaseClient {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _update: any = null;
    let _delete = false;
    let _maybeSingle = false;

    const rows = () => (db[table] ?? []);

    const chain: any = {
      select() { return chain; },
      update(data: any) { _update = data; return chain; },
      delete() { _delete = true; return chain; },
      eq(col: string, val: any) { _filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any) { _filters.push((r) => r[col] !== val); return chain; },
      in(col: string, vals: any[]) { _filters.push((r) => vals.includes(r[col])); return chain; },
      is() { return chain; },
      not() { return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      then(resolve: any) {
        return Promise.resolve().then(() => {
          if (!db[table]) db[table] = [];
          const matched = rows().filter((r) => _filters.every((f) => f(r)));
          if (_update) {
            for (const r of matched) Object.assign(r, _update);
            return resolve({ data: matched, error: null });
          }
          if (_delete) {
            db[table] = rows().filter((r) => !matched.includes(r));
            return resolve({ data: null, error: null });
          }
          if (_maybeSingle) return resolve({ data: matched[0] ?? null, error: null });
          return resolve({ data: matched, error: null });
        });
      },
    };
    return chain;
  }
  return { from: (table: string) => buildChain(table) } as unknown as SupabaseClient;
}

const quietLog = { info: () => {}, warn: () => {} };

function freshDb(): DB {
  return {
    universal_stamp_catalog: [],
    user_stamps: [],
    passport_stamps: [],
    stamp_artwork_versions: [],
    stamp_generation_queue: [],
  };
}

describe("repairXXCatalogEntries", () => {
  it("re-keys an XX entry in place when the city geocodes and no survivor exists", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "tromso": { country_code: "no", country: "Norway" },
    }));
    const db = freshDb();
    db.universal_stamp_catalog.push({
      id: nextId(),
      canonical_location_key: "trip:xx:tromso",
      stamp_type: "trip",
      country: "Unknown",
      country_code: "XX",
      city: "Tromso",
      neighborhood: null,
      display_name: "Tromso",
      earn_count: 3,
    });
    const stats = await repairXXCatalogEntries(makeFakeClient(db), makeGeocodingResolver(), quietLog);
    assert.equal(stats.catalogRekeyed, 1);
    assert.equal(stats.geocodeResolved, 1);
    const entry = db.universal_stamp_catalog[0];
    assert.equal(entry.canonical_location_key, "trip:no:tromso");
    assert.equal(entry.country_code, "NO");
    assert.equal(entry.country, "Norway");
  });

  it("merges into an existing real-code entry: repoints ownership, transfers earn_count, deletes XX entry", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "tromso": { country_code: "no", country: "Norway" },
    }));
    const db = freshDb();
    const xxId = nextId();
    const realId = nextId();
    db.universal_stamp_catalog.push(
      {
        id: xxId, canonical_location_key: "trip:xx:tromso", stamp_type: "trip",
        country: "Unknown", country_code: "XX", city: "Tromso",
        neighborhood: null, display_name: "Tromso", earn_count: 2,
      },
      {
        id: realId, canonical_location_key: "trip:no:tromso", stamp_type: "trip",
        country: "Norway", country_code: "NO", city: "Tromso",
        neighborhood: null, display_name: "Tromso", earn_count: 5,
      },
    );
    db.user_stamps.push({ id: nextId(), catalog_id: xxId });
    db.stamp_artwork_versions.push({ id: nextId(), catalog_id: xxId });
    db.stamp_generation_queue.push({ id: nextId(), catalog_id: xxId, status: "queued" });

    const stats = await repairXXCatalogEntries(makeFakeClient(db), makeGeocodingResolver(), quietLog);
    assert.equal(stats.catalogMerged, 1);
    assert.equal(db.universal_stamp_catalog.length, 1);
    assert.equal(db.universal_stamp_catalog[0].id, realId);
    assert.equal(db.universal_stamp_catalog[0].earn_count, 7);
    assert.equal(db.user_stamps[0].catalog_id, realId);
    assert.equal(db.stamp_artwork_versions[0].catalog_id, realId);
    assert.equal(db.stamp_generation_queue.length, 0);
  });

  it("leaves genuinely unresolvable cities as XX and reports them", async () => {
    _setGeocodeFetchForTests(fakeNominatim({}));
    const db = freshDb();
    db.universal_stamp_catalog.push({
      id: nextId(),
      canonical_location_key: "trip:xx:nowhereville",
      stamp_type: "trip",
      country: "Unknown",
      country_code: "XX",
      city: "Nowhereville",
      neighborhood: null,
      display_name: "Nowhereville",
      earn_count: 1,
    });
    const stats = await repairXXCatalogEntries(makeFakeClient(db), makeGeocodingResolver(), quietLog);
    assert.equal(stats.catalogRekeyed, 0);
    assert.equal(stats.catalogMerged, 0);
    assert.deepEqual(stats.unresolvedCities, ["Nowhereville"]);
    assert.equal(db.universal_stamp_catalog[0].country_code, "XX");
  });

  it("skips definition-scoped (badge) entries which are intentionally XX", async () => {
    const db = freshDb();
    db.universal_stamp_catalog.push({
      id: nextId(),
      canonical_location_key: "definition:helpful-buddy",
      stamp_type: "social",
      country: "Global",
      country_code: "XX",
      city: null,
      neighborhood: null,
      display_name: "Helpful Buddy",
      earn_count: 4,
    });
    const stats = await repairXXCatalogEntries(makeFakeClient(db), staticResolver, quietLog);
    assert.equal(stats.scanned, 0);
    assert.equal(db.universal_stamp_catalog[0].canonical_location_key, "definition:helpful-buddy");
  });

  it("respects the geocode budget (maxGeocodes)", async () => {
    _setGeocodeFetchForTests(fakeNominatim({
      "cityone": { country_code: "fr", country: "France" },
      "citytwo": { country_code: "de", country: "Germany" },
    }));
    const db = freshDb();
    for (const city of ["CityOne", "CityTwo"]) {
      db.universal_stamp_catalog.push({
        id: nextId(),
        canonical_location_key: `trip:xx:${city.toLowerCase()}`,
        stamp_type: "trip",
        country: "Unknown",
        country_code: "XX",
        city,
        neighborhood: null,
        display_name: city,
        earn_count: 0,
      });
    }
    const stats = await repairXXCatalogEntries(
      makeFakeClient(db),
      makeGeocodingResolver({ maxGeocodes: 1 }),
      quietLog,
    );
    assert.equal(fetchCalls.length, 1);
    assert.equal(stats.catalogRekeyed, 1);
    assert.equal(stats.unresolvedCities.length, 1);
  });
});

// ── Background correction sweep ───────────────────────────────────────────────

/**
 * Build a minimal fake DB client whose city_country_geocode_cache table
 * returns a fixed list of rows for .select().gte() queries (the sweep pattern).
 */
function makeSweepDb(recentlyCorrectRows: Array<{ city_key: string; corrected_at: string }>) {
  const client = {
    from(table: string) {
      assert.equal(table, "city_country_geocode_cache");
      const chain: any = {
        select() { return chain; },
        gte() { return chain; },
        then(resolve: (v: any) => void) {
          resolve({ data: recentlyCorrectRows, error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return client;
}

describe("background correction sweep", () => {
  it("evicts an in-memory entry whose writtenAt predates the DB corrected_at", async () => {
    // Seed the in-memory cache with a stale entry (writtenAt in the past).
    _setGeocodeFetchForTests(fakeNominatim({ "banff": { country_code: "ca", country: "Canada" } }));
    await geocodeCityCountry("Banff");                   // populates in-memory cache
    assert.equal(fetchCalls.length, 1);

    // DB reports that "banff" was corrected one second after the entry was written.
    const correctedAt = new Date(Date.now() + 1_000).toISOString(); // future = definitely after writtenAt
    _setGeocodeDbClientForTests(makeSweepDb([{ city_key: "banff", corrected_at: correctedAt }]));

    await _runCorrectionSweepForTests();

    // Cache entry should have been evicted; the next call re-resolves.
    await geocodeCityCountry("Banff");
    assert.equal(fetchCalls.length, 2, "should have re-geocoded after sweep eviction");
  });

  it("leaves an in-memory entry alone when writtenAt is newer than corrected_at", async () => {
    // Seed the in-memory cache.
    _setGeocodeFetchForTests(fakeNominatim({ "banff": { country_code: "ca", country: "Canada" } }));
    await geocodeCityCountry("Banff");
    assert.equal(fetchCalls.length, 1);

    // DB reports a correction that happened BEFORE the cache entry was written.
    const correctedAt = new Date(Date.now() - 10_000).toISOString(); // 10 s in the past
    _setGeocodeDbClientForTests(makeSweepDb([{ city_key: "banff", corrected_at: correctedAt }]));

    await _runCorrectionSweepForTests();

    // Cache should still be valid; no new fetch.
    await geocodeCityCountry("Banff");
    assert.equal(fetchCalls.length, 1, "cache entry should still be valid — no re-fetch expected");
  });

  it("is a no-op when the DB reports no recently-corrected rows", async () => {
    _setGeocodeFetchForTests(fakeNominatim({ "banff": { country_code: "ca", country: "Canada" } }));
    await geocodeCityCountry("Banff");
    assert.equal(fetchCalls.length, 1);

    _setGeocodeDbClientForTests(makeSweepDb([])); // nothing corrected recently

    await _runCorrectionSweepForTests();

    await geocodeCityCountry("Banff");
    assert.equal(fetchCalls.length, 1, "empty sweep result should leave the cache untouched");
  });

  it("only evicts keys that are actually present in the in-memory cache", async () => {
    // DB reports a correction for "tromso", but it was never cached in memory.
    _setGeocodeDbClientForTests(
      makeSweepDb([{ city_key: "tromso", corrected_at: new Date().toISOString() }]),
    );
    // Should not throw or cause any issues.
    await _runCorrectionSweepForTests();
  });

  it("survives a DB error without throwing", async () => {
    const errorClient = {
      from() { throw new Error("db exploded"); },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(errorClient);
    // Must not throw.
    await _runCorrectionSweepForTests();
  });

  it("startCorrectionSweep returns a stop function that clears the interval", () => {
    const stop = startCorrectionSweep(60_000);
    assert.equal(typeof stop, "function");
    // Calling stop must not throw.
    stop();
    // Calling stop a second time must also be safe.
    stop();
  });

  it("does not evict an in-memory entry when the DB row has corrected_at: null (sweep path)", async () => {
    // Seed in-memory cache with a valid entry.
    _setGeocodeFetchForTests(fakeNominatim({ "kyoto": { country_code: "jp", country: "Japan" } }));
    await geocodeCityCountry("Kyoto");
    assert.equal(fetchCalls.length, 1, "initial geocode should hit Nominatim once");

    // DB sweep returns the row for "kyoto" but with corrected_at: null.
    // SQL WHERE corrected_at >= since filters nulls, but if a null somehow
    // slips through the sweep must not treat it as an eviction signal.
    const nullCorrectedClient = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache");
        const chain: any = {
          select() { return chain; },
          gte()    { return chain; },
          then(resolve: (v: any) => void) {
            resolve({ data: [{ city_key: "kyoto", corrected_at: null }], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(nullCorrectedClient);

    await _runCorrectionSweepForTests();

    // Entry must still be cached — no Nominatim re-fetch.
    fetchCalls = [];
    _setGeocodeFetchForTests(async (url: string) => {
      fetchCalls.push(url);
      throw new Error("Nominatim must not be called — entry should still be cached");
    });
    _setGeocodeDbClientForTests(nullCorrectedClient);

    const r = await geocodeCityCountry("Kyoto");
    assert.equal(fetchCalls.length, 0, "null corrected_at must not evict the cache entry");
    assert.ok(r !== null, "cached result must still be returned");
    assert.equal(r!.countryCode, "JP");
  });

  it("does not evict an in-memory entry when the DB row has corrected_at: null (per-request probe path)", async () => {
    // Seed in-memory cache with a valid entry.
    _setGeocodeFetchForTests(fakeNominatim({ "oslo": { country_code: "no", country: "Norway" } }));
    await geocodeCityCountry("Oslo");
    assert.equal(fetchCalls.length, 1, "initial geocode should hit Nominatim once");

    // Backdate the cache entry so the next geocodeCityCountry call immediately
    // re-probes the DB for corrected_at (skips the 5-minute cooldown).
    _backdateGeocodeCacheEntryForTests("oslo");

    // DB per-request probe returns a row with corrected_at: null.
    const nullCorrectedMaybeSingleClient = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache");
        let _isMaybeSingle = false;
        const chain: any = {
          select()      { return chain; },
          eq()          { return chain; },
          gte()         { return chain; },
          maybeSingle() { _isMaybeSingle = true; return chain; },
          then(resolve: (v: any) => void) {
            if (_isMaybeSingle) {
              // evictIfDbCorrected path — null corrected_at must not evict.
              resolve({ data: { corrected_at: null }, error: null });
            } else {
              resolve({ data: [], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    _setGeocodeDbClientForTests(nullCorrectedMaybeSingleClient);

    // Replace Nominatim with a failing stub — must never be called.
    fetchCalls = [];
    _setGeocodeFetchForTests(async (url: string) => {
      fetchCalls.push(url);
      throw new Error("Nominatim must not be called — null corrected_at is not an eviction signal");
    });
    _setGeocodeDbClientForTests(nullCorrectedMaybeSingleClient);

    const r = await geocodeCityCountry("Oslo");
    assert.equal(fetchCalls.length, 0, "null corrected_at must not trigger a re-geocode");
    assert.ok(r !== null, "cached result must still be returned");
    assert.equal(r!.countryCode, "NO");
  });

  it("after sweep eviction re-resolves from the corrected DB row — zero Nominatim fetches", async () => {
    // Step 1: populate the in-memory cache with a stale entry (CA for Banff).
    _setGeocodeFetchForTests(fakeNominatim({
      "banff": { country_code: "ca", country: "Canada" },
    }));
    await geocodeCityCountry("Banff");
    assert.equal(fetchCalls.length, 1, "first resolve should hit Nominatim");

    // Step 2: an admin has since corrected the DB row to FR (a hypothetical admin override).
    // corrected_at is in the future relative to now so it definitely post-dates writtenAt.
    const correctedAt = new Date(Date.now() + 1_000).toISOString();

    // Build a combined fake DB client that serves:
    //   • the sweep query  (.select("city_key, corrected_at").gte("corrected_at", since))
    //   • the readDbCache  (.select("country, country_code, corrected_at").eq("city_key", key).maybeSingle())
    const correctedRow = {
      city_key: "banff",
      country: "France",
      country_code: "FR",
      corrected_at: correctedAt,
    };
    let dbReads = 0;
    const combinedDb = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache");
        let _isMaybeSingle = false;
        const chain: any = {
          select() { return chain; },
          eq()     { return chain; },
          gte()    { return chain; },
          maybeSingle() { _isMaybeSingle = true; return chain; },
          then(resolve: (v: any) => void) {
            dbReads += 1;
            if (_isMaybeSingle) {
              // readDbCache path: return the corrected row
              resolve({ data: correctedRow, error: null });
            } else {
              // sweep path: return the sweep list
              resolve({ data: [{ city_key: "banff", corrected_at: correctedAt }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    // Step 3: run the sweep — it should evict the stale CA entry.
    _setGeocodeDbClientForTests(combinedDb);
    await _runCorrectionSweepForTests();

    // Step 4: now disable Nominatim entirely so any forward geocode call would fail.
    fetchCalls = [];
    _setGeocodeFetchForTests(async (url: string) => {
      fetchCalls.push(url);
      throw new Error("Nominatim must not be called after sweep eviction");
    });

    // Re-inject the same combined DB client (setGeocodeFetch resets it).
    _setGeocodeDbClientForTests(combinedDb);

    // Step 5: geocodeCityCountry should re-resolve from the DB row only.
    const r = await geocodeCityCountry("Banff");

    assert.equal(fetchCalls.length, 0, "no Nominatim call should be made — DB row must be used");
    assert.ok(r !== null, "should return a resolved result");
    assert.equal(r!.countryCode, "FR", "should return the admin-corrected country code from the DB");
    assert.equal(r!.country, "France", "should return the admin-corrected country name from the DB");
    assert.ok(dbReads >= 2, "should have read the DB at least twice (sweep + readDbCache)");
  });

  it("after sweep eviction falls back to Nominatim when the DB row was deleted — not null", async () => {
    // Step 1: populate the in-memory cache with a stale entry (CA for Banff).
    _setGeocodeFetchForTests(fakeNominatim({
      "banff": { country_code: "ca", country: "Canada" },
    }));
    await geocodeCityCountry("Banff");
    assert.equal(fetchCalls.length, 1, "first resolve should hit Nominatim");

    // Step 2: the sweep DB returns a corrected_at that post-dates writtenAt,
    // but readDbCache returns null — the admin DELETE removed the row entirely.
    const correctedAt = new Date(Date.now() + 1_000).toISOString();
    const deletedDb = {
      from(table: string) {
        assert.equal(table, "city_country_geocode_cache");
        let _isMaybeSingle = false;
        const chain: any = {
          select() { return chain; },
          eq()     { return chain; },
          gte()    { return chain; },
          maybeSingle() { _isMaybeSingle = true; return chain; },
          then(resolve: (v: any) => void) {
            if (_isMaybeSingle) {
              // readDbCache path: row was deleted — return null
              resolve({ data: null, error: null });
            } else {
              // sweep path: report the corrected_at so the entry is evicted
              resolve({ data: [{ city_key: "banff", corrected_at: correctedAt }], error: null });
            }
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    // Step 3: run the sweep — it should evict the stale CA entry.
    _setGeocodeDbClientForTests(deletedDb);
    await _runCorrectionSweepForTests();

    // Step 4: set up Nominatim to return a fresh result (GB for illustration).
    fetchCalls = [];
    _setGeocodeFetchForTests(fakeNominatim({
      "banff": { country_code: "gb", country: "United Kingdom" },
    }));

    // Re-inject the deleted DB client (setGeocodeFetch resets it).
    _setGeocodeDbClientForTests(deletedDb);

    // Step 5: geocodeCityCountry should fall through to Nominatim because
    // the DB row is gone — not return null.
    const r = await geocodeCityCountry("Banff");

    assert.equal(fetchCalls.length, 1, "exactly one Nominatim call should be made after deletion eviction");
    assert.ok(r !== null, "should return a resolved result — not stuck returning null");
    assert.equal(r!.countryCode, "GB", "should return the fresh Nominatim country code");
    assert.equal(r!.country, "United Kingdom", "should return the fresh Nominatim country name");
  });
});
