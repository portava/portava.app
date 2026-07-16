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
  _clearCountryGeocodeCache,
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
