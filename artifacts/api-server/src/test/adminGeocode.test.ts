/**
 * Admin geocode-cache management endpoint tests
 *
 * Verifies GET /admin/geocode-cache, DELETE /admin/geocode-cache/:city_key,
 * and PUT /admin/geocode-cache/:city_key, including:
 *   - admin-only enforcement (non-admin → 403)
 *   - list with optional ?q= filter
 *   - delete purges the DB row and evicts the in-memory cache
 *   - put upserts with correct country_code normalisation and validates input
 *   - in-memory cache eviction confirmed after correct/delete
 *
 * Run: node --import tsx/esm --test src/test/adminGeocode.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  _setGeocodeFetchForTests,
  _setGeocodeDbClientForTests,
  _clearCountryGeocodeCache,
  geocodeCityCountry,
} from "../lib/stamps/countryGeocoder.js";
import adminGeocodeRouter from "../routes/adminGeocode.js";
import type { RepairStats } from "../lib/stamps/xxCatalogRepair.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN = "fake.jwt.token";
const FAKE_USER_ID = "uid-admin-1";

function apiReq(
  method: string,
  path: string,
  body?: unknown,
  query?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const fullPath = query ? `${path}?${query}` : path;
    const url = new URL(fullPath, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "authorization": `Bearer ${FAKE_TOKEN}`,
    };
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client builder ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Build a minimal chainable Supabase-like query builder for a set of rows. */
function builder(rows: Row[]) {
  let _rows = [...rows];
  let _filtered: Row[] | null = null;
  let _limitN: number | null = null;

  const b: any = {
    select: () => b,
    order: () => b,
    ilike: (col: string, pattern: string) => {
      const needle = pattern.replace(/%/g, "").toLowerCase();
      _filtered = _rows.filter((r) => String(r[col] ?? "").toLowerCase().includes(needle));
      return b;
    },
    limit: (n: number) => { _limitN = n; return b; },
    eq: () => b,
    maybeSingle: async () => ({ data: _rows[0] ?? null, error: null }),
    then: (resolve: (v: any) => void) => {
      const result = _filtered ?? _rows;
      const final = _limitN != null ? result.slice(0, _limitN) : result;
      resolve({ data: final, error: null });
    },
  };
  return b;
}

function makeFakeClient(opts: {
  role?: string;
  cacheRows?: Row[];
  upsertError?: string;
  deleteError?: string;
  onUpsert?: (row: unknown) => void;
  onDelete?: (key: string) => void;
}) {
  const { role = "admin", cacheRows = [], upsertError, deleteError, onUpsert, onDelete } = opts;

  const client: any = {
    auth: {
      getUser: async () => ({ data: { user: { id: FAKE_USER_ID } }, error: null }),
    },
    from: (table: string) => {
      if (table === "profiles") {
        return builder([{ id: FAKE_USER_ID, role }]);
      }
      if (table === "city_country_geocode_cache") {
        return {
          select: (_cols: string) => builder(cacheRows),
          delete: () => ({
            eq: (_col: string, key: string) => {
              onDelete?.(key);
              return Promise.resolve({ data: null, error: deleteError ? { message: deleteError } : null });
            },
          }),
          upsert: (row: unknown, _opts?: unknown) => {
            onUpsert?.(row);
            return Promise.resolve({ data: null, error: upsertError ? { message: upsertError } : null });
          },
        };
      }
      return builder([]);
    },
  };
  return client;
}

function setClients(opts: Parameters<typeof makeFakeClient>[0]) {
  const c = makeFakeClient(opts);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminGeocodeRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  _setGeocodeFetchForTests(null);
  _setGeocodeDbClientForTests(undefined);
  _clearCountryGeocodeCache();
});

beforeEach(() => {
  _clearCountryGeocodeCache();
});

// ── GET /admin/geocode-cache ──────────────────────────────────────────────────

describe("GET /admin/geocode-cache", () => {
  it("returns 403 for non-admin users", async () => {
    setClients({ role: "user" });
    const r = await apiReq("GET", "/admin/geocode-cache");
    assert.equal(r.status, 403);
  });

  it("returns all rows for an admin", async () => {
    setClients({
      cacheRows: [
        { city_key: "paris", country: "France", country_code: "FR", resolved_at: "2024-01-01", updated_at: "2024-01-01" },
        { city_key: "banff", country: "Canada", country_code: "CA", resolved_at: "2024-01-02", updated_at: "2024-01-02" },
      ],
    });
    const r = await apiReq("GET", "/admin/geocode-cache");
    assert.equal(r.status, 200);
    assert.equal(r.body.rows.length, 2);
  });

  it("filters rows by ?q= substring", async () => {
    setClients({
      cacheRows: [
        { city_key: "paris", country: "France", country_code: "FR", resolved_at: "2024-01-01", updated_at: "2024-01-01" },
        { city_key: "banff", country: "Canada", country_code: "CA", resolved_at: "2024-01-02", updated_at: "2024-01-02" },
      ],
    });
    const r = await apiReq("GET", "/admin/geocode-cache", undefined, "q=par");
    assert.equal(r.status, 200);
    assert.equal(r.body.rows.length, 1);
    assert.equal(r.body.rows[0].city_key, "paris");
  });
});

// ── DELETE /admin/geocode-cache/:city_key ─────────────────────────────────────

describe("DELETE /admin/geocode-cache/:city_key", () => {
  it("returns 403 for non-admin users", async () => {
    setClients({ role: "user" });
    const r = await apiReq("DELETE", "/admin/geocode-cache/paris");
    assert.equal(r.status, 403);
  });

  it("deletes the specified row and returns confirmation", async () => {
    let deletedKey: string | null = null;
    setClients({ onDelete: (k) => { deletedKey = k; } });
    const r = await apiReq("DELETE", "/admin/geocode-cache/paris");
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.equal(r.body.city_key, "paris");
    assert.equal(deletedKey, "paris");
  });

  it("returns 500 when the DB delete fails", async () => {
    setClients({ deleteError: "constraint violation" });
    const r = await apiReq("DELETE", "/admin/geocode-cache/paris");
    assert.equal(r.status, 500);
  });

  it("evicts the in-memory cache so next geocode re-resolves", async () => {
    // Seed the in-memory geocode cache via the geocoder module directly.
    // Use a fake fetch that returns FR so "paris" gets cached as France.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "fr", country: "France" } }],
    }));
    const dbWithFrance: any = {
      from: (table: string) => {
        if (table === "city_country_geocode_cache") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            upsert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        return {};
      },
    };
    _setGeocodeDbClientForTests(dbWithFrance);
    const first = await geocodeCityCountry("paris");
    assert.equal(first?.countryCode, "FR", "pre-condition: paris is cached as FR");

    // Issue DELETE via the admin endpoint — this should evict "paris" from the in-memory cache.
    setClients({});
    const r = await apiReq("DELETE", "/admin/geocode-cache/paris");
    assert.equal(r.status, 200);

    // Next geocodeCityCountry call should re-resolve — point fetch at Italy now.
    let reFetchCalled = false;
    _setGeocodeFetchForTests(async () => {
      reFetchCalled = true;
      return { ok: true, json: async () => [{ address: { country_code: "it", country: "Italy" } }] };
    });
    const emptyDb: any = {
      from: (table: string) => {
        if (table === "city_country_geocode_cache") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            upsert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        return {};
      },
    };
    _setGeocodeDbClientForTests(emptyDb);
    const second = await geocodeCityCountry("paris");
    assert.ok(reFetchCalled, "expected geocoder to re-fetch from Nominatim after cache eviction");
    assert.equal(second?.countryCode, "IT");
  });
});

// ── PUT /admin/geocode-cache/:city_key ────────────────────────────────────────

describe("PUT /admin/geocode-cache/:city_key", () => {
  it("returns 403 for non-admin users", async () => {
    setClients({ role: "user" });
    const r = await apiReq("PUT", "/admin/geocode-cache/paris", { country_code: "ES", country: "Spain" });
    assert.equal(r.status, 403);
  });

  it("rejects a missing country_code", async () => {
    setClients({});
    const r = await apiReq("PUT", "/admin/geocode-cache/paris", { country: "Spain" });
    assert.equal(r.status, 400);
  });

  it("rejects an invalid country_code (not two letters)", async () => {
    setClients({});
    const r = await apiReq("PUT", "/admin/geocode-cache/paris", { country_code: "ESP", country: "Spain" });
    assert.equal(r.status, 400);
  });

  it("rejects a missing country name", async () => {
    setClients({});
    const r = await apiReq("PUT", "/admin/geocode-cache/paris", { country_code: "ES" });
    assert.equal(r.status, 400);
  });

  it("normalises lowercase country_code to uppercase and upserts", async () => {
    let upsertRow: any = null;
    setClients({ onUpsert: (row) => { upsertRow = row; } });
    const r = await apiReq("PUT", "/admin/geocode-cache/paris", { country_code: "es", country: "Spain" });
    assert.equal(r.status, 200);
    assert.equal(r.body.country_code, "ES");
    assert.equal(r.body.country, "Spain");
    assert.equal(upsertRow?.country_code, "ES");
    assert.equal(upsertRow?.city_key, "paris");
  });

  it("evicts the in-memory cache so next geocode re-resolves", async () => {
    // Seed "lyon" in the in-memory cache as France.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "fr", country: "France" } }],
    }));
    const seedDb: any = {
      from: (table: string) => {
        if (table === "city_country_geocode_cache") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            upsert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        return {};
      },
    };
    _setGeocodeDbClientForTests(seedDb);
    const first = await geocodeCityCountry("lyon");
    assert.equal(first?.countryCode, "FR", "pre-condition: lyon cached as FR");

    // Correct it via PUT — should evict "lyon" from in-memory cache.
    setClients({});
    const r = await apiReq("PUT", "/admin/geocode-cache/lyon", { country_code: "CH", country: "Switzerland" });
    assert.equal(r.status, 200);
    assert.equal(r.body.updated, true);

    // Next geocodeCityCountry should re-fetch, not return the stale FR entry.
    let reFetchCalled = false;
    _setGeocodeFetchForTests(async () => {
      reFetchCalled = true;
      return { ok: true, json: async () => [{ address: { country_code: "ch", country: "Switzerland" } }] };
    });
    const emptyDb: any = {
      from: (table: string) => {
        if (table === "city_country_geocode_cache") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            upsert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        return {};
      },
    };
    _setGeocodeDbClientForTests(emptyDb);
    const second = await geocodeCityCountry("lyon");
    assert.ok(reFetchCalled, "expected re-fetch after PUT cache eviction");
    assert.equal(second?.countryCode, "CH");
  });

  it("returns 500 when the DB upsert fails", async () => {
    setClients({ upsertError: "db write failed" });
    const r = await apiReq("PUT", "/admin/geocode-cache/paris", { country_code: "ES", country: "Spain" });
    assert.equal(r.status, 500);
  });
});

// ── PUT /admin/geocode-cache/:city_key with repair_catalog: true ──────────────

/**
 * Minimal chainable fake for universal_stamp_catalog.
 * Distinguishes the XX scan (select with many columns) from the survivor
 * check (select "id" only → ends with maybeSingle).
 */
function makeCatalogFake(
  xxEntries: Record<string, unknown>[],
  onUpdate?: (fields: Record<string, unknown>) => void,
) {
  return {
    select: (cols: string) => {
      if (cols.includes("canonical_location_key")) {
        // Full scan for XX entries — awaited directly (thenable).
        return {
          eq: (_col: string, _val: unknown) => ({
            then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
              resolve({ data: xxEntries, error: null }),
          }),
        };
      }
      // Survivor-check chain: select("id").eq(...).eq(...).neq(...).maybeSingle()
      const chain: any = {
        eq: () => chain,
        neq: () => chain,
        maybeSingle: async () => ({ data: null, error: null }), // no survivor
      };
      return chain;
    },
    update: (fields: Record<string, unknown>) => {
      onUpdate?.(fields);
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    },
  };
}

/** Build a fake Supabase client that also handles universal_stamp_catalog. */
function makeRepairClient(opts: {
  xxEntries?: Record<string, unknown>[];
  onCatalogUpdate?: (fields: Record<string, unknown>) => void;
  upsertError?: string;
}) {
  const { xxEntries = [], onCatalogUpdate, upsertError } = opts;
  const client: any = {
    auth: {
      getUser: async () => ({ data: { user: { id: FAKE_USER_ID } }, error: null }),
    },
    from: (table: string) => {
      if (table === "profiles") {
        return builder([{ id: FAKE_USER_ID, role: "admin" }]);
      }
      if (table === "city_country_geocode_cache") {
        return {
          select: (_cols: string) => builder([]),
          upsert: (_row: unknown, _o?: unknown) =>
            Promise.resolve({
              data: null,
              error: upsertError ? { message: upsertError } : null,
            }),
        };
      }
      if (table === "universal_stamp_catalog") {
        return makeCatalogFake(xxEntries, onCatalogUpdate);
      }
      return builder([]);
    },
  };
  return client;
}

/** Geocode DB client that returns a pre-set country for any city key. */
function makeGeocodeDbClient(country: string, countryCode: string): any {
  return {
    from: (table: string) => {
      if (table === "city_country_geocode_cache") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { country, country_code: countryCode },
                error: null,
              }),
            }),
          }),
          upsert: () => Promise.resolve({ data: null, error: null }),
        };
      }
      return {};
    },
  };
}

// ── DELETE /admin/geocode-cache/:city_key with repair_catalog ─────────────────

/** Fake client for delete-with-repair: handles profiles, geocode cache delete, and catalog. */
function makeDeleteRepairClient(opts: {
  xxEntries?: Record<string, unknown>[];
  onCatalogUpdate?: (fields: Record<string, unknown>) => void;
  deleteError?: string;
}) {
  const { xxEntries = [], onCatalogUpdate, deleteError } = opts;
  const client: any = {
    auth: {
      getUser: async () => ({ data: { user: { id: FAKE_USER_ID } }, error: null }),
    },
    from: (table: string) => {
      if (table === "profiles") {
        return builder([{ id: FAKE_USER_ID, role: "admin" }]);
      }
      if (table === "city_country_geocode_cache") {
        return {
          select: (_cols: string) => builder([]),
          delete: () => ({
            eq: (_col: string, _key: string) =>
              Promise.resolve({ data: null, error: deleteError ? { message: deleteError } : null }),
          }),
        };
      }
      if (table === "universal_stamp_catalog") {
        return makeCatalogFake(xxEntries, onCatalogUpdate);
      }
      return builder([]);
    },
  };
  return client;
}

describe("DELETE /admin/geocode-cache/:city_key with repair_catalog", () => {
  it("triggers catalog repair and returns repair stats when repair_catalog=true (query param)", async () => {
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-del-1",
          canonical_location_key: "city:XX:bazburg",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Bazburg",
          neighborhood: null,
          display_name: "Bazburg",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // After DELETE the in-memory cache is evicted; geocoder will re-resolve via DB.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/bazburg", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.equal(r.body.city_key, "bazburg");
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;
    assert.equal(repair.catalogRekeyed, 1, "one catalog entry should have been re-keyed");
    assert.equal(repair.catalogMerged, 0);
    assert.ok(catalogUpdates.length >= 1, "catalog update should have been called");
    assert.equal(catalogUpdates[0].country_code, "DE");
  });

  it("triggers catalog repair when repair_catalog is passed as a query param", async () => {
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-del-2",
          canonical_location_key: "city:XX:quxton",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Quxton",
          neighborhood: null,
          display_name: "Quxton",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Portugal", "PT"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/quxton", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response should include repair stats when passed as query param");
    assert.equal((r.body.repair as RepairStats).catalogRekeyed, 1);
    assert.ok(catalogUpdates.length >= 1);
    assert.equal(catalogUpdates[0].country_code, "PT");
  });

  it("skips repair and returns no repair field when repair_catalog is not set", async () => {
    let updateCalled = false;
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-del-3",
          canonical_location_key: "city:XX:nopeville",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Nopeville",
          neighborhood: null,
          display_name: "Nopeville",
        },
      ],
      onCatalogUpdate: () => { updateCalled = true; },
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/nopeville");

    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(!r.body.repair, "repair field should be absent when repair_catalog is not set");
    assert.equal(updateCalled, false, "catalog update should not have been called");
  });

  it("skips entries for other cities even when repair_catalog is true", async () => {
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-del-other",
          canonical_location_key: "city:XX:otherville",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Otherville",  // different city from deleted "mytown"
          neighborhood: null,
          display_name: "Otherville",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Italy", "IT"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/mytown", undefined, "repair_catalog=true");

    assert.equal(r.status, 200);
    assert.ok(r.body.repair, "repair stats should still be returned");
    assert.equal((r.body.repair as RepairStats).catalogRekeyed, 0, "other-city entry should be skipped");
    assert.equal(catalogUpdates.length, 0, "no catalog update for a different city");
  });
});

describe("PUT /admin/geocode-cache/:city_key with repair_catalog: true", () => {
  it("re-keys a matching XX catalog entry and returns repair stats", async () => {
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeRepairClient({
      xxEntries: [
        {
          id: "cat-1",
          canonical_location_key: "city:XX:fooville",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Fooville",
          neighborhood: null,
          display_name: "Fooville",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // Fake fetch must be set BEFORE the geocode DB client because
    // _setGeocodeFetchForTests resets _dbClientOverride to null internally.
    // We set a no-op fetch (Nominatim is not needed — the DB cache hit suffices).
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    // Now inject the geocode DB client so readDbCache returns the corrected Spain.
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Spain", "ES"));

    const r = await apiReq("PUT", "/admin/geocode-cache/fooville", {
      country_code: "ES",
      country: "Spain",
      repair_catalog: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;
    assert.equal(repair.catalogRekeyed, 1, "one catalog entry should have been re-keyed");
    assert.equal(repair.catalogMerged, 0);
    assert.ok(catalogUpdates.length >= 1, "catalog update should have been called");
    assert.equal(catalogUpdates[0].country_code, "ES");
  });

  it("skips catalog entries for other cities when using cityKeyFilter", async () => {
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeRepairClient({
      xxEntries: [
        {
          id: "cat-other",
          canonical_location_key: "city:XX:bartown",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Bartown",  // different city from the corrected "fooville"
          neighborhood: null,
          display_name: "Bartown",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Spain", "ES"));

    const r = await apiReq("PUT", "/admin/geocode-cache/fooville", {
      country_code: "ES",
      country: "Spain",
      repair_catalog: true,
    });

    assert.equal(r.status, 200);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;
    assert.equal(repair.catalogRekeyed, 0, "Bartown entry should be skipped (different city)");
    assert.equal(catalogUpdates.length, 0, "no catalog update should have been issued");
  });

  it("omitting repair_catalog skips repair and returns no repair field", async () => {
    let updateCalled = false;
    const client = makeRepairClient({
      xxEntries: [
        {
          id: "cat-1",
          canonical_location_key: "city:XX:fooville",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Fooville",
          neighborhood: null,
          display_name: "Fooville",
        },
      ],
      onCatalogUpdate: () => { updateCalled = true; },
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("PUT", "/admin/geocode-cache/fooville", {
      country_code: "ES",
      country: "Spain",
      // repair_catalog omitted
    });

    assert.equal(r.status, 200);
    assert.ok(!r.body.repair, "repair field should be absent when repair_catalog is not set");
    assert.equal(updateCalled, false, "catalog update should not have been called");
  });

  it("merges ownership rows and earn_count into the surviving real-code entry when one already exists", async () => {
    const XX_ID = "cat-xx-merge";
    const SURVIVOR_ID = "cat-survivor-1";
    const XX_EARN_COUNT = 3;
    const SURVIVOR_EARN_COUNT = 7;

    const ownershipUpdates: { table: string; newCatalogId: string }[] = [];
    let earnCountUpdate: number | null = null;
    let xxEntryDeleted = false;
    let queueEntryDeleted = false;

    const client: any = {
      auth: {
        getUser: async () => ({ data: { user: { id: FAKE_USER_ID } }, error: null }),
      },
      from: (table: string) => {
        if (table === "profiles") {
          return builder([{ id: FAKE_USER_ID, role: "admin" }]);
        }

        if (table === "city_country_geocode_cache") {
          return {
            select: (_cols: string) => builder([]),
            upsert: (_row: unknown, _o?: unknown) =>
              Promise.resolve({ data: null, error: null }),
          };
        }

        if (table === "universal_stamp_catalog") {
          return {
            select: (cols: string) => {
              // Full XX scan
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:fooville",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Fooville",
                            neighborhood: null,
                            display_name: "Fooville",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              // earn_count fetch during merge: select("id, earn_count").in(...)
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: XX_EARN_COUNT },
                        { id: SURVIVOR_ID, earn_count: SURVIVOR_EARN_COUNT },
                      ],
                      error: null,
                    }),
                };
              }
              // Survivor check: select("id").eq().eq().neq().maybeSingle()
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (fields: Record<string, unknown>) => {
              if (typeof fields.earn_count === "number") {
                earnCountUpdate = fields.earn_count as number;
              }
              return { eq: () => Promise.resolve({ data: null, error: null }) };
            },
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID) xxEntryDeleted = true;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps" || table === "passport_stamps") {
          return {
            update: (fields: Record<string, unknown>) => ({
              eq: (_col: string, _val: string) => {
                ownershipUpdates.push({ table, newCatalogId: fields.catalog_id as string });
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "stamp_artwork_versions") {
          return {
            update: (_fields: unknown) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "stamp_generation_queue") {
          return {
            delete: () => ({
              eq: () => {
                queueEntryDeleted = true;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Spain", "ES"));

    const r = await apiReq("PUT", "/admin/geocode-cache/fooville", {
      country_code: "ES",
      country: "Spain",
      repair_catalog: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // Merge was chosen over re-key
    assert.equal(repair.catalogMerged, 1, "one catalog entry should have been merged");
    assert.equal(repair.catalogRekeyed, 0, "re-key count should be 0 when a merge occurred");

    // Ownership rows were repointed to the survivor
    const userUpdate = ownershipUpdates.find((u) => u.table === "user_stamps");
    assert.ok(userUpdate, "user_stamps rows should have been repointed");
    assert.equal(userUpdate?.newCatalogId, SURVIVOR_ID);

    const passportUpdate = ownershipUpdates.find((u) => u.table === "passport_stamps");
    assert.ok(passportUpdate, "passport_stamps rows should have been repointed");
    assert.equal(passportUpdate?.newCatalogId, SURVIVOR_ID);

    // earn_count was summed onto the survivor
    assert.ok(earnCountUpdate !== null, "earn_count should have been updated on the survivor");
    assert.equal(earnCountUpdate, XX_EARN_COUNT + SURVIVOR_EARN_COUNT,
      `survivor earn_count should be ${XX_EARN_COUNT} + ${SURVIVOR_EARN_COUNT}`);

    // XX entry was deleted
    assert.ok(xxEntryDeleted, "the XX catalog entry should have been deleted after merge");
    assert.ok(queueEntryDeleted, "stamp_generation_queue rows for the XX entry should have been deleted");
  });
});
