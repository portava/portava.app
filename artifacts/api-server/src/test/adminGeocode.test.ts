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
          // DELETE handler now soft-deletes (update deleted_at) instead of hard-deleting.
          update: (_fields: Record<string, unknown>) => ({
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
  catalogUpdateError?: string,
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
      return {
        eq: () => Promise.resolve({
          data: null,
          error: catalogUpdateError ? { message: catalogUpdateError } : null,
        }),
      };
    },
  };
}

/** Build a fake Supabase client that also handles universal_stamp_catalog. */
function makeRepairClient(opts: {
  xxEntries?: Record<string, unknown>[];
  onCatalogUpdate?: (fields: Record<string, unknown>) => void;
  upsertError?: string;
  catalogUpdateError?: string;
}) {
  const { xxEntries = [], onCatalogUpdate, upsertError, catalogUpdateError } = opts;
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
        return makeCatalogFake(xxEntries, onCatalogUpdate, catalogUpdateError);
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
  catalogUpdateError?: string;
}) {
  const { xxEntries = [], onCatalogUpdate, deleteError, catalogUpdateError } = opts;
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
          // DELETE handler now soft-deletes via update(deleted_at).
          update: (_fields: Record<string, unknown>) => ({
            eq: (_col: string, _key: string) =>
              Promise.resolve({ data: null, error: deleteError ? { message: deleteError } : null }),
          }),
        };
      }
      if (table === "universal_stamp_catalog") {
        return makeCatalogFake(xxEntries, onCatalogUpdate, catalogUpdateError);
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

  it("re-keys the catalog entry to the freshly-resolved country B, not the deleted row's original country A", async () => {
    // Disambiguation scenario: the geocode cache row previously mapped the city to
    // country A (France / FR).  After the admin deletes that row, the geocoder
    // re-resolves via Nominatim and returns country B (Germany / DE).  The repair
    // stats must reflect country B (DE), not the stale country A (FR).
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-rekey-country-b",
          canonical_location_key: "city:XX:borderburg",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Borderburg",
          neighborhood: null,
          display_name: "Borderburg",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // After DELETE the in-memory cache is evicted. The geocoder will miss the
    // DB cache (row deleted) and fall through to Nominatim which returns DE —
    // the new country B, different from the deleted row's country A (FR).
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [{ address: { country_code: "de", country: "Germany" } }],
    }));
    // DB cache returns nothing (the row was just deleted).
    const emptyGeocodeDb: any = {
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
    _setGeocodeDbClientForTests(emptyGeocodeDb);

    const r = await apiReq("DELETE", "/admin/geocode-cache/borderburg", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;
    assert.equal(repair.catalogRekeyed, 1, "one catalog entry should have been re-keyed");
    assert.equal(catalogUpdates.length, 1, "catalog update should have been called once");
    // The re-key must use the freshly-resolved country B (DE), not the deleted row's
    // original country A (FR).
    assert.equal(
      catalogUpdates[0].country_code,
      "DE",
      "catalog entry should be re-keyed to country B (DE), not the deleted row's original country A (FR)",
    );
  });

  it("records unresolved cities in repair stats when the geocoder cannot re-resolve after DELETE", async () => {
    // After the geocode row is deleted and the cache evicted, if neither the
    // static lookup nor Nominatim can resolve the city, the entry must be left
    // as XX and reported in unresolvedCities — it must never be silently skipped.
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-unresolved-del-1",
          canonical_location_key: "city:XX:ghostown",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Ghostown",
          neighborhood: null,
          display_name: "Ghostown",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // Nominatim returns no results for this city.
    _setGeocodeFetchForTests(async () => ({
      ok: true,
      json: async () => [],
    }));
    // DB cache also has no entry (row was just deleted).
    const emptyGeocodeDb: any = {
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
    _setGeocodeDbClientForTests(emptyGeocodeDb);

    const r = await apiReq("DELETE", "/admin/geocode-cache/ghostown", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;
    assert.equal(repair.catalogRekeyed, 0, "unresolvable entry should not be re-keyed");
    assert.ok(
      repair.unresolvedCities.includes("Ghostown"),
      `unresolvedCities should list "Ghostown", got: ${JSON.stringify(repair.unresolvedCities)}`,
    );
    assert.equal(catalogUpdates.length, 0, "catalog should not have been updated for an unresolvable city");
  });

  it("re-keys all XX entries for the same city when the geocode resolves to a new country", async () => {
    // Seed two XX entries for the same city — a city stamp and a neighborhood
    // stamp.  The repair loop must iterate over both; seeding only one is not
    // enough to prove the loop doesn't stop after the first entry.
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-multi-1",
          canonical_location_key: "city:XX:twinburg",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Twinburg",
          neighborhood: null,
          display_name: "Twinburg",
        },
        {
          id: "cat-multi-2",
          canonical_location_key: "neighborhood:XX:twinburg:old-quarter",
          stamp_type: "neighborhood",
          country: "Unknown",
          country_code: "XX",
          city: "Twinburg",
          neighborhood: "Old Quarter",
          display_name: "Old Quarter",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Austria", "AT"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/twinburg", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // Both XX entries must have been re-keyed — not just the first one.
    assert.equal(repair.catalogRekeyed, 2,
      "all XX entries for the same city must be re-keyed, not just the first");

    // Every catalog update must use the freshly-resolved country code (AT), not a stale one.
    assert.equal(catalogUpdates.length, 2,
      "catalog update should have been called once for each XX entry");
    assert.ok(
      catalogUpdates.every((u) => u.country_code === "AT"),
      `all catalog updates must use the freshly-resolved country code AT, got: ${JSON.stringify(catalogUpdates.map((u) => u.country_code))}`,
    );
  });

  it("merges all XX entries for a city when every one of them has a surviving real-code entry", async () => {
    // Seed two XX entries for the same city with different stamp_types.  Each
    // already has a real-code survivor in the catalog under the resolved key.
    // The repair loop must merge both — catalogMerged must equal 2 and
    // catalogRekeyed must stay at 0.
    const XX_ID_1 = "cat-dual-xx-1";
    const XX_ID_2 = "cat-dual-xx-2";
    const SURVIVOR_ID_1 = "cat-dual-survivor-1";
    const SURVIVOR_ID_2 = "cat-dual-survivor-2";

    // Count how many times a merged XX entry is deleted from the catalog table.
    let catalogMergeDeleteCount = 0;

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
            // DELETE handler soft-deletes via update(deleted_at).
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "universal_stamp_catalog") {
          return {
            select: (cols: string) => {
              // Full XX scan — select with many columns including canonical_location_key.
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID_1,
                            canonical_location_key: "city:XX:mergedcity",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Mergedcity",
                            neighborhood: null,
                            display_name: "Mergedcity",
                          },
                          {
                            id: XX_ID_2,
                            canonical_location_key: "neighborhood:XX:mergedcity:old-quarter",
                            stamp_type: "neighborhood",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Mergedcity",
                            neighborhood: "Old Quarter",
                            display_name: "Old Quarter",
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
                    Promise.resolve({ data: [], error: null }),
                };
              }
              // Survivor check: select("id").eq("canonical_location_key", newKey)
              //   .eq("stamp_type", ...).neq("id", ...).maybeSingle()
              // Capture the canonical_location_key argument to return the right survivor.
              let resolvedSurvivorId: string = SURVIVOR_ID_1;
              const survivorChain: any = {
                eq: (col: string, val: unknown) => {
                  if (col === "canonical_location_key" && typeof val === "string") {
                    resolvedSurvivorId = val.startsWith("neighborhood:")
                      ? SURVIVOR_ID_2
                      : SURVIVOR_ID_1;
                  }
                  return survivorChain;
                },
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: resolvedSurvivorId }, error: null }),
              };
              return survivorChain;
            },
            update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID_1 || val === XX_ID_2) catalogMergeDeleteCount++;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps" || table === "passport_stamps" || table === "stamp_artwork_versions") {
          return {
            update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          };
        }

        if (table === "stamp_generation_queue") {
          return {
            delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/mergedcity", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // Both XX entries must have been merged — neither re-keyed.
    assert.equal(repair.catalogMerged, 2,
      "all XX entries for the same city must be merged when every one has a surviving real-code entry");
    assert.equal(repair.catalogRekeyed, 0,
      "catalogRekeyed must be 0 — both entries took the merge path, not the re-key path");

    // Each successful merge deletes the XX entry from the catalog table.
    assert.equal(catalogMergeDeleteCount, 2,
      "the XX catalog entry must be deleted once per successfully merged entry");
  });

  it("does not abort the merge loop when the first merge fails — the second XX entry is still attempted", async () => {
    // Two XX entries for the same city, each with a surviving real-code entry.
    // The first merge fails because user_stamps repoint returns an error
    // (mergeCatalogEntry returns false).  The second entry must still be
    // attempted and must succeed — catalogMerged must be 1, not 0.
    const XX_ID_1 = "cat-partial-fail-xx-1";
    const XX_ID_2 = "cat-partial-fail-xx-2";
    const SURVIVOR_ID_1 = "cat-partial-fail-survivor-1";
    const SURVIVOR_ID_2 = "cat-partial-fail-survivor-2";

    // Track which XX id the user_stamps repoint is called for so we can
    // selectively fail only the first merge.
    let catalogDeleteCount = 0;

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
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "universal_stamp_catalog") {
          return {
            select: (cols: string) => {
              // Full XX scan.
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID_1,
                            canonical_location_key: "city:XX:partialfailcity",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Partialfailcity",
                            neighborhood: null,
                            display_name: "Partialfailcity",
                          },
                          {
                            id: XX_ID_2,
                            canonical_location_key: "neighborhood:XX:partialfailcity:old-town",
                            stamp_type: "neighborhood",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Partialfailcity",
                            neighborhood: "Old Town",
                            display_name: "Old Town",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              // earn_count fetch during merge.
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({ data: [], error: null }),
                };
              }
              // Survivor check — return the right survivor based on stamp_type.
              let resolvedSurvivorId: string = SURVIVOR_ID_1;
              const survivorChain: any = {
                eq: (col: string, val: unknown) => {
                  if (col === "canonical_location_key" && typeof val === "string") {
                    resolvedSurvivorId = val.startsWith("neighborhood:")
                      ? SURVIVOR_ID_2
                      : SURVIVOR_ID_1;
                  }
                  return survivorChain;
                },
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: resolvedSurvivorId }, error: null }),
              };
              return survivorChain;
            },
            update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID_1 || val === XX_ID_2) catalogDeleteCount++;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: (_col: string, val: unknown) => {
                // Fail the repoint for the first XX entry only.
                if (val === XX_ID_1) {
                  return Promise.resolve({
                    data: null,
                    error: { message: "permission denied for table user_stamps" },
                  });
                }
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "passport_stamps" || table === "stamp_artwork_versions") {
          return {
            update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          };
        }

        if (table === "stamp_generation_queue") {
          return {
            delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("France", "FR"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/partialfailcity", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // First merge failed (user_stamps error) → catalogMerged must be 1, not 0 or 2.
    assert.equal(
      repair.catalogMerged,
      1,
      `catalogMerged must be 1 — first failed, second succeeded — got ${repair.catalogMerged}`,
    );

    // The second entry's XX row must have been deleted (evidence it was attempted).
    assert.equal(
      catalogDeleteCount,
      1,
      `catalog delete must be called once (for the successful second merge) — got ${catalogDeleteCount}`,
    );

    // unresolvedCities must be empty — the country resolved fine.
    assert.equal(
      repair.unresolvedCities.length,
      0,
      `unresolvedCities must be empty — got: ${JSON.stringify(repair.unresolvedCities)}`,
    );
  });

  // ── xx_entries_pending ──────────────────────────────────────────────────────

  it("includes xx_entries_pending when repair_catalog is not set and matching XX entries exist", async () => {
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-pend-1",
          canonical_location_key: "city:XX:pendville",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Pendville",
          neighborhood: null,
          display_name: "Pendville",
        },
        {
          id: "cat-pend-2",
          canonical_location_key: "city:XX:pendville:2",
          stamp_type: "neighborhood",
          country: "Unknown",
          country_code: "XX",
          city: "Pendville",
          neighborhood: "Old Quarter",
          display_name: "Old Quarter",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/pendville");

    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(!r.body.repair, "repair field must be absent — repair did not run");
    assert.equal(r.body.xx_entries_pending, 2,
      "should report both matching XX catalog entries as pending");
  });

  it("includes xx_entries_pending: 0 when repair_catalog is not set and no matching XX entries exist", async () => {
    const client = makeDeleteRepairClient({
      xxEntries: [], // no XX entries at all
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/cleantown");

    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(!r.body.repair, "repair field must be absent");
    assert.equal(r.body.xx_entries_pending, 0,
      "xx_entries_pending must be 0 when no matching XX entries exist");
  });

  it("omits xx_entries_pending when repair_catalog=true (repair already ran)", async () => {
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-rep-1",
          canonical_location_key: "city:XX:reptown",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Reptown",
          neighborhood: null,
          display_name: "Reptown",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Canada", "CA"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/reptown", undefined, "repair_catalog=true");

    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "repair stats must be present when repair_catalog=true");
    assert.equal(r.body.xx_entries_pending, undefined,
      "xx_entries_pending must be absent when repair_catalog=true — repair already ran");
  });

  it("counts only the matching city's XX entries — not other cities", async () => {
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-match",
          canonical_location_key: "city:XX:targetcity",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Targetcity",
          neighborhood: null,
          display_name: "Targetcity",
        },
        {
          id: "cat-other",
          canonical_location_key: "city:XX:othercity",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Othercity",    // different city — must not be counted
          neighborhood: null,
          display_name: "Othercity",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/targetcity");

    assert.equal(r.status, 200);
    assert.equal(r.body.xx_entries_pending, 1,
      "only the matching city's XX entry should be counted");
  });

  it("excludes definition-scoped (badge) entries from xx_entries_pending", async () => {
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-def",
          canonical_location_key: "definition:explorer-badge",
          stamp_type: "badge",
          country: "Global",
          country_code: "XX",
          city: "Badgeville",  // city matches the key
          neighborhood: null,
          display_name: "Explorer",
        },
        {
          id: "cat-real",
          canonical_location_key: "city:XX:badgeville",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Badgeville",
          neighborhood: null,
          display_name: "Badgeville",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/badgeville");

    assert.equal(r.status, 200);
    assert.equal(r.body.xx_entries_pending, 1,
      "definition-scoped entries must be excluded; only the real city entry counts");
  });

  it("counts a catalog entry as pending when the stored city has accent characters (São Paulo → sao paulo)", async () => {
    // normCityKey strips diacritics via NFD decomposition.  "São Paulo"
    // normalises to "sao paulo", so DELETE /admin/geocode-cache/sao paulo must
    // report xx_entries_pending: 1 even though the raw city value in the DB
    // contains accented characters.
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-accent-1",
          canonical_location_key: "city:XX:sao paulo",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "São Paulo",   // stored with accent
          neighborhood: null,
          display_name: "São Paulo",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/sao paulo");

    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(!r.body.repair, "repair field must be absent — repair_catalog was not passed");
    assert.equal(
      r.body.xx_entries_pending,
      1,
      "accent-normalised city 'São Paulo' must match the key 'sao paulo' and be counted as pending",
    );
  });

  it("counts a catalog entry as pending when the stored city is mixed-case with umlauts (MÜNCHEN → munchen)", async () => {
    // normCityKey lowercases and strips diacritics.  "MÜNCHEN" normalises to
    // "munchen", so DELETE /admin/geocode-cache/munchen must report
    // xx_entries_pending: 1 even though the raw city value is uppercased and
    // contains an umlaut.
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-umlaut-1",
          canonical_location_key: "city:XX:munchen",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "MÜNCHEN",   // stored uppercased with umlaut
          neighborhood: null,
          display_name: "MÜNCHEN",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/munchen");

    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(!r.body.repair, "repair field must be absent — repair_catalog was not passed");
    assert.equal(
      r.body.xx_entries_pending,
      1,
      "umlaut+uppercase city 'MÜNCHEN' must match the key 'munchen' and be counted as pending",
    );
  });

  it("counts only the exact city key — a city whose normalised form is a prefix of the key is not counted (port vs portland)", async () => {
    // normCityKey uses strict equality (===), not substring matching.
    // Deleting /admin/geocode-cache/portland must count only the "Portland"
    // entry; the "Port" entry normalises to "port" which does not equal
    // "portland", so it must be excluded.
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-exact-prefix-1",
          canonical_location_key: "city:XX:port",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Port",       // normalises to "port" — must not match "portland"
          neighborhood: null,
          display_name: "Port",
        },
        {
          id: "cat-exact-prefix-2",
          canonical_location_key: "city:XX:portland",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Portland",
          neighborhood: null,
          display_name: "Portland",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/portland");

    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(!r.body.repair, "repair field must be absent — repair_catalog was not passed");
    assert.equal(
      r.body.xx_entries_pending,
      1,
      "only 'Portland' must be counted — 'Port' normalises to 'port', which does not equal 'portland'",
    );
  });

  it("counts only the exact city key — a city whose normalised form is a superset of the key is not counted (portland vs port)", async () => {
    // Deleting /admin/geocode-cache/port must count only the "Port" entry;
    // the "Portland" entry normalises to "portland" which does not equal "port",
    // so it must be excluded even though "port" is a prefix of "portland".
    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-exact-suffix-1",
          canonical_location_key: "city:XX:port",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Port",
          neighborhood: null,
          display_name: "Port",
        },
        {
          id: "cat-exact-suffix-2",
          canonical_location_key: "city:XX:portland",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Portland",   // normalises to "portland" — must not match "port"
          neighborhood: null,
          display_name: "Portland",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("DELETE", "/admin/geocode-cache/port");

    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.ok(!r.body.repair, "repair field must be absent — repair_catalog was not passed");
    assert.equal(
      r.body.xx_entries_pending,
      1,
      "only 'Port' must be counted — 'Portland' normalises to 'portland', which does not equal 'port'",
    );
  });

  it("does not count a catalog re-key as successful when the DB update call fails", async () => {
    // The city resolves successfully (unresolvedCities must be empty), but the
    // DB write that re-keys the catalog entry returns an error.  The repair stats
    // must reflect the failure — catalogRekeyed must stay at 0.
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-del-update-fail",
          canonical_location_key: "city:XX:failburg",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Failburg",
          neighborhood: null,
          display_name: "Failburg",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
      catalogUpdateError: "permission denied for table universal_stamp_catalog",
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // Geocoder resolves successfully to Austria (AT) — so the city is NOT unresolved.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Austria", "AT"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/failburg", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // The DB update was attempted but returned an error — must NOT count as a success.
    assert.equal(
      repair.catalogRekeyed,
      0,
      "catalogRekeyed must be 0 when the catalog update call returns an error",
    );

    // The city geocoded successfully, so it must NOT appear in unresolvedCities.
    assert.equal(
      repair.unresolvedCities.length,
      0,
      `unresolvedCities must be empty when the city resolved — got: ${JSON.stringify(repair.unresolvedCities)}`,
    );
  });

  it("does not abort the loop when the first catalog update fails — the second entry is still attempted", async () => {
    // Seed two XX entries for the same city.  The first catalog update call
    // deliberately returns a DB error; the second must still be attempted and
    // must count as a success.  catalogRekeyed must therefore be 1 (not 0 or 2).
    const catalogUpdates: Record<string, unknown>[] = [];
    let updateCallCount = 0;

    // Build a custom catalog fake whose update only errors on the first call.
    const catalogFakeWithPartialError = {
      select: (cols: string) => {
        if (cols.includes("canonical_location_key")) {
          return {
            eq: (_col: string, _val: unknown) => ({
              then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                resolve({
                  data: [
                    {
                      id: "cat-loop-fail-1",
                      canonical_location_key: "city:XX:loopburg",
                      stamp_type: "city",
                      country: "Unknown",
                      country_code: "XX",
                      city: "Loopburg",
                      neighborhood: null,
                      display_name: "Loopburg",
                    },
                    {
                      id: "cat-loop-fail-2",
                      canonical_location_key: "neighborhood:XX:loopburg:old-quarter",
                      stamp_type: "neighborhood",
                      country: "Unknown",
                      country_code: "XX",
                      city: "Loopburg",
                      neighborhood: "Old Quarter",
                      display_name: "Old Quarter",
                    },
                  ],
                  error: null,
                }),
            }),
          };
        }
        // Survivor-check chain — no survivor for either entry.
        const chain: any = {
          eq: () => chain,
          neq: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
      update: (fields: Record<string, unknown>) => {
        updateCallCount += 1;
        const callIndex = updateCallCount;
        return {
          eq: () =>
            Promise.resolve({
              data: null,
              // Only the first call errors; subsequent calls succeed.
              error:
                callIndex === 1
                  ? { message: "permission denied for table universal_stamp_catalog" }
                  : null,
            }),
        };
        // Record updates that succeed (call index > 1).
      },
    };

    // Wrap in a full fake client so it can record successful updates.
    const successfulUpdates: Record<string, unknown>[] = [];
    const catalogFake = {
      select: catalogFakeWithPartialError.select,
      update: (fields: Record<string, unknown>) => {
        updateCallCount += 1;
        const callIndex = updateCallCount;
        if (callIndex > 1) {
          successfulUpdates.push(fields);
          catalogUpdates.push(fields);
        }
        return {
          eq: () =>
            Promise.resolve({
              data: null,
              error:
                callIndex === 1
                  ? { message: "permission denied for table universal_stamp_catalog" }
                  : null,
            }),
        };
      },
    };

    // Reset counter before building the client.
    updateCallCount = 0;

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
            update: (_fields: Record<string, unknown>) => ({
              eq: (_col: string, _key: string) =>
                Promise.resolve({ data: null, error: null }),
            }),
          };
        }
        if (table === "universal_stamp_catalog") {
          return catalogFake;
        }
        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);

    // Geocoder resolves successfully to Austria (AT) for both entries.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Austria", "AT"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/loopburg", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // Only the second entry succeeded — catalogRekeyed must be exactly 1.
    assert.equal(
      repair.catalogRekeyed,
      1,
      `catalogRekeyed must be 1 (first failed, second succeeded) — got ${repair.catalogRekeyed}`,
    );

    // The second update must have been attempted — the loop must not have aborted.
    assert.equal(
      updateCallCount,
      2,
      `catalog update must have been called twice (once per entry) — got ${updateCallCount}`,
    );

    // The city resolved successfully, so unresolvedCities must be empty.
    assert.equal(
      repair.unresolvedCities.length,
      0,
      `unresolvedCities must be empty — got: ${JSON.stringify(repair.unresolvedCities)}`,
    );
  });

  it("reports accurate xx_entries_pending on a second DELETE after the geocode row is re-added via PUT", async () => {
    // Scenario: admin deletes the geocode row, then immediately re-adds it via
    // PUT (no repair_catalog), then deletes again.  The XX catalog entries were
    // never repaired by either call, so both DELETEs must report the same
    // count — not a stale zero or a count from a previous state.

    const XX_ENTRIES = [
      {
        id: "cat-reset-1",
        canonical_location_key: "city:XX:resetville",
        stamp_type: "city",
        country: "Unknown",
        country_code: "XX",
        city: "Resetville",
        neighborhood: null,
        display_name: "Resetville",
      },
    ];

    let deleteCallCount = 0;
    let upsertCallCount = 0;

    // A single client object that handles DELETE, upsert (PUT path), and the
    // catalog count query.  The catalog table always returns the same XX entry
    // because repair_catalog is never passed — the entries are never fixed.
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
            // DELETE handler soft-deletes via update(deleted_at) — track that call.
            update: (_fields: Record<string, unknown>) => ({
              eq: (_col: string, _key: string) => {
                deleteCallCount += 1;
                return Promise.resolve({ data: null, error: null });
              },
            }),
            upsert: (_row: unknown, _opts?: unknown) => {
              upsertCallCount += 1;
              return Promise.resolve({ data: null, error: null });
            },
          };
        }

        if (table === "universal_stamp_catalog") {
          // countXXEntriesForCityKey selects "city, canonical_location_key"
          // filtered by country_code="XX" — always return the XX entry so
          // both DELETEs see the same unrepaired state.
          return {
            select: (cols: string) => {
              if (cols === "city, canonical_location_key") {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({ data: XX_ENTRIES, error: null }),
                  }),
                };
              }
              // Fallback for any other select shape
              const chain: any = {
                eq: () => chain,
                neq: () => chain,
                maybeSingle: async () => ({ data: null, error: null }),
              };
              return chain;
            },
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);

    // ── Step 1: first DELETE (no repair_catalog) ──────────────────────────────
    const r1 = await apiReq("DELETE", "/admin/geocode-cache/resetville");

    assert.equal(r1.status, 200, `first DELETE: expected 200, got ${r1.status}: ${JSON.stringify(r1.body)}`);
    assert.equal(r1.body.deleted, true, "first DELETE: deleted must be true");
    assert.ok(!r1.body.repair, "first DELETE: repair field must be absent — repair did not run");
    assert.equal(r1.body.xx_entries_pending, 1,
      "first DELETE: must report the single XX entry that exists");

    // ── Step 2: PUT re-adds the geocode row (no repair_catalog) ──────────────
    const r2 = await apiReq("PUT", "/admin/geocode-cache/resetville", {
      country_code: "DE",
      country: "Germany",
    });

    assert.equal(r2.status, 200, `PUT: expected 200, got ${r2.status}: ${JSON.stringify(r2.body)}`);
    assert.equal(r2.body.updated, true, "PUT: updated must be true");
    assert.ok(!r2.body.repair, "PUT: repair field must be absent — repair_catalog was not passed");

    // ── Step 3: second DELETE (no repair_catalog) ─────────────────────────────
    const r3 = await apiReq("DELETE", "/admin/geocode-cache/resetville");

    assert.equal(r3.status, 200, `second DELETE: expected 200, got ${r3.status}: ${JSON.stringify(r3.body)}`);
    assert.equal(r3.body.deleted, true, "second DELETE: deleted must be true");
    assert.ok(!r3.body.repair, "second DELETE: repair field must be absent — repair did not run");
    assert.equal(r3.body.xx_entries_pending, 1,
      "second DELETE after PUT must still report 1 — the XX entry was never repaired");

    // Sanity: both DELETEs and the PUT must have been exercised
    assert.equal(deleteCallCount, 2, "geocode delete must have been called exactly twice");
    assert.equal(upsertCallCount, 1, "geocode upsert must have been called exactly once (the PUT)");
  });

  it("repair loop re-keys a catalog entry whose city is accented (São Paulo → sao paulo)", async () => {
    // normCityKey in repairXXCatalogEntries must strip diacritics so an entry
    // stored with city "São Paulo" is matched by the cityKeyFilter "sao paulo"
    // and actually re-keyed.  catalogRekeyed must be 1 — not 0.
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-accent-repair-1",
          canonical_location_key: "city:XX:sao paulo",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "São Paulo",   // stored with diacritic
          neighborhood: null,
          display_name: "São Paulo",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Brazil", "BR"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/sao paulo", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response must include repair stats when repair_catalog=true");
    const repair = r.body.repair as RepairStats;
    assert.equal(
      repair.catalogRekeyed,
      1,
      "repair loop must re-key the accented-city entry — normCityKey must strip diacritics in the filter",
    );
    assert.equal(repair.catalogMerged, 0);
    assert.ok(catalogUpdates.length >= 1, "catalog update must have been called");
    assert.equal(
      catalogUpdates[0].country_code,
      "BR",
      "re-keyed entry must carry the resolved country_code",
    );
  });

  it("repair loop re-keys a catalog entry whose city is uppercased with umlauts (MÜNCHEN → munchen)", async () => {
    // normCityKey must lowercase and strip combining diacritics so "MÜNCHEN"
    // matches the cityKeyFilter "munchen".  catalogRekeyed must be 1 — not 0.
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeDeleteRepairClient({
      xxEntries: [
        {
          id: "cat-umlaut-repair-1",
          canonical_location_key: "city:XX:munchen",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "MÜNCHEN",   // uppercased with umlaut
          neighborhood: null,
          display_name: "MÜNCHEN",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const r = await apiReq("DELETE", "/admin/geocode-cache/munchen", undefined, "repair_catalog=true");

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.deleted, true);
    assert.ok(r.body.repair, "response must include repair stats when repair_catalog=true");
    const repair = r.body.repair as RepairStats;
    assert.equal(
      repair.catalogRekeyed,
      1,
      "repair loop must re-key the umlaut+uppercase entry — normCityKey must lowercase and strip umlauts in the filter",
    );
    assert.equal(repair.catalogMerged, 0);
    assert.ok(catalogUpdates.length >= 1, "catalog update must have been called");
    assert.equal(
      catalogUpdates[0].country_code,
      "DE",
      "re-keyed entry must carry the resolved country_code",
    );
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

    // Track artwork repointing
    let artworkRepointed: { newCatalogId: string; filteredOnXxId: string | null } | null = null;

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
            update: (fields: Record<string, unknown>) => ({
              eq: (_col: string, val: string) => {
                artworkRepointed = {
                  newCatalogId: fields.catalog_id as string,
                  filteredOnXxId: val,
                };
                return Promise.resolve({ data: null, error: null });
              },
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

    // Artwork rows were repointed to the survivor
    assert.ok(artworkRepointed !== null, "stamp_artwork_versions rows should have been repointed");
    assert.equal(artworkRepointed?.newCatalogId, SURVIVOR_ID,
      "artwork rows should be repointed to the survivor catalog id");
    assert.equal(artworkRepointed?.filteredOnXxId, XX_ID,
      "artwork repoint should filter on the XX catalog id so no orphaned rows remain");
  });

  it("repoints artwork rows to the survivor — not just ownership stamps", async () => {
    const XX_ID = "cat-xx-art-only";
    const SURVIVOR_ID = "cat-survivor-art";

    let artworkNewCatalogId: string | null = null;
    let artworkFilterId: string | null = null;
    let artworkRowsLeftOnXx = false;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:artville",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Artville",
                            neighborhood: null,
                            display_name: "Artville",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: 0 },
                        { id: SURVIVOR_ID, earn_count: 2 },
                      ],
                      error: null,
                    }),
                };
              }
              // Survivor check
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
            delete: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "user_stamps" || table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "stamp_artwork_versions") {
          return {
            update: (fields: Record<string, unknown>) => ({
              eq: (_col: string, val: string) => {
                // Record what catalog_id the artwork was pointed to
                artworkNewCatalogId = fields.catalog_id as string;
                artworkFilterId = val;
                // If the filter value equals XX_ID the repoint targets the right rows;
                // if it were ever called with SURVIVOR_ID as filter that would be a bug.
                if (val === XX_ID && fields.catalog_id === XX_ID) {
                  artworkRowsLeftOnXx = true;
                }
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "stamp_generation_queue") {
          return {
            delete: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("France", "FR"));

    const r = await apiReq("PUT", "/admin/geocode-cache/artville", {
      country_code: "FR",
      country: "France",
      repair_catalog: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.repair, "response should include repair stats");
    assert.equal((r.body.repair as RepairStats).catalogMerged, 1, "should have merged into the survivor");

    // Core assertion: artwork rows must be repointed to the survivor
    assert.ok(artworkNewCatalogId !== null,
      "stamp_artwork_versions.update() should have been called during merge");
    assert.equal(artworkNewCatalogId, SURVIVOR_ID,
      "artwork rows must point at the survivor after merge — not the deleted XX entry");
    assert.equal(artworkFilterId, XX_ID,
      "artwork repoint must filter on the XX catalog id to catch all orphaned rows");
    assert.equal(artworkRowsLeftOnXx, false,
      "no artwork update should leave rows still pointing at the XX catalog id");
  });

  it("does not issue an earn_count update and still completes when the earn_count select returns null", async () => {
    const XX_ID = "cat-xx-null-pair";
    const SURVIVOR_ID = "cat-survivor-null-pair";

    let earnCountUpdateCalled = false;
    let xxEntryDeleted = false;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:nullville",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Nullville",
                            neighborhood: null,
                            display_name: "Nullville",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              // earn_count select returns null data — simulates a DB miss / empty result
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({ data: null, error: null }),
                };
              }
              // Survivor check
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (fields: Record<string, unknown>) => {
              if (typeof fields.earn_count === "number") {
                earnCountUpdateCalled = true;
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
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "stamp_artwork_versions") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "stamp_generation_queue") {
          return {
            delete: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const r = await apiReq("PUT", "/admin/geocode-cache/nullville", {
      country_code: "DE",
      country: "Germany",
      repair_catalog: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // Merge still completes successfully
    assert.equal(repair.catalogMerged, 1, "merge should be counted even when earn_count select returns null");
    assert.equal(repair.catalogRekeyed, 0, "re-key count should be 0 when a merge occurred");

    // No earn_count update should be issued because xxCount falls back to 0
    assert.equal(earnCountUpdateCalled, false,
      "earn_count update must not be issued when the pair select returns null (xxCount=0 path skips it)");

    // XX entry must still be deleted to complete the merge
    assert.ok(xxEntryDeleted, "XX catalog entry should still be deleted after a null earn_count pair result");
  });

  it("does not issue an earn_count update and does not corrupt the survivor when only the survivor row is returned by the pair select", async () => {
    // Edge case: the earn_count select returns a partial result — only the survivor
    // row is present; the XX row is entirely absent (earn_count undefined on lookup).
    // The `?? 0` fallback must apply to xxCount only.  The survivor's own count must
    // not be written with a garbage value (e.g. survivorCount + phantom 0 write is
    // technically harmless, but the guard `xxCount > 0` must prevent the update
    // altogether so the survivor's count is never touched unnecessarily).
    const XX_ID = "cat-xx-partial-pair";
    const SURVIVOR_ID = "cat-survivor-partial-pair";
    const SURVIVOR_EARN_COUNT = 7;

    let earnCountUpdateCalled = false;
    let earnCountWrittenValue: number | null = null;
    let xxEntryDeleted = false;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:partialtown",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Partialtown",
                            neighborhood: null,
                            display_name: "Partialtown",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              // earn_count select returns only the survivor row — XX row is absent.
              // This simulates a partial DB result where the XX entry is missing.
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [{ id: SURVIVOR_ID, earn_count: SURVIVOR_EARN_COUNT }],
                      error: null,
                    }),
                };
              }
              // Survivor lookup
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (fields: Record<string, unknown>) => {
              if (typeof fields.earn_count === "number") {
                earnCountUpdateCalled = true;
                earnCountWrittenValue = fields.earn_count as number;
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
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "stamp_artwork_versions") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "stamp_generation_queue") {
          return {
            delete: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const r = await apiReq("PUT", "/admin/geocode-cache/partialtown", {
      country_code: "DE",
      country: "Germany",
      repair_catalog: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // Merge still completes
    assert.equal(repair.catalogMerged, 1,
      "merge should complete even when only the survivor row is returned by the pair select");
    assert.equal(repair.catalogRekeyed, 0, "re-key count must be 0 when a merge occurred");

    // xxCount falls back to 0 via ?? 0, so the guard (xxCount > 0) must prevent the update
    assert.equal(earnCountUpdateCalled, false,
      "earn_count update must not be issued when the XX row is absent from the pair result (xxCount ?? 0 === 0)");
    assert.equal(earnCountWrittenValue, null,
      "no earn_count value should have been written — survivor's count must stay untouched");

    // XX entry must still be deleted to complete the merge
    assert.ok(xxEntryDeleted, "XX catalog entry must still be deleted even when its earn_count row is absent");
  });

  it("skips the earn_count update when the survivor row is absent from the pair select — never zeroes the survivor", async () => {
    // Complementary edge case to the partial-pair test above.
    // Here the pair select returns ONLY the XX row; the survivor row is absent.
    // Writing survivorCount(0) + xxCount would silently discard whatever the
    // survivor held in the DB, so mergeCatalogEntry skips the earn_count
    // transfer entirely (with a warning) and still completes the merge.
    const XX_ID = "cat-xx-survivor-absent";
    const SURVIVOR_ID = "cat-survivor-survivor-absent";
    const XX_EARN_COUNT = 5;

    let earnCountUpdateCalled = false;
    let earnCountWrittenValue: number | null = null;
    let xxEntryDeleted = false;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:absenttown",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Absenttown",
                            neighborhood: null,
                            display_name: "Absenttown",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              // earn_count select returns ONLY the XX row — survivor row is absent.
              // survivorCount will fall back to 0 via ?? 0.
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [{ id: XX_ID, earn_count: XX_EARN_COUNT }],
                      error: null,
                    }),
                };
              }
              // Survivor lookup
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (fields: Record<string, unknown>) => {
              if (typeof fields.earn_count === "number") {
                earnCountUpdateCalled = true;
                earnCountWrittenValue = fields.earn_count as number;
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
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "stamp_artwork_versions") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "stamp_generation_queue") {
          return {
            delete: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const r = await apiReq("PUT", "/admin/geocode-cache/absenttown", {
      country_code: "DE",
      country: "Germany",
      repair_catalog: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // Merge still completes despite the missing survivor row in the pair result.
    assert.equal(repair.catalogMerged, 1,
      "merge should complete even when only the XX row is returned by the pair select");
    assert.equal(repair.catalogRekeyed, 0, "re-key count must be 0 when a merge occurred");

    // xxCount is 5 (present) but the survivor row is absent from the pair
    // result. Writing 0 + xxCount would silently zero the survivor's existing
    // DB earn_count, so the transfer is skipped entirely.
    assert.equal(earnCountUpdateCalled, false,
      "earn_count update must be skipped when the survivor row is absent from the pair result — writing 0 + xxCount would discard the survivor's existing count");
    assert.equal(earnCountWrittenValue, null,
      "no earn_count value should be written when the survivor row is absent");

    // XX entry must still be deleted to complete the merge.
    assert.ok(xxEntryDeleted, "XX catalog entry must still be deleted even when the survivor row is absent from the pair result");
  });

  it("prevents a success count when a user_stamps ownership repoint errors during merge", async () => {
    const XX_ID = "cat-xx-ownership-fail";
    const SURVIVOR_ID = "cat-survivor-ownership-fail";

    const warnMessages: string[] = [];
    let xxEntryDeleted = false;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:warnville",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Warnville",
                            neighborhood: null,
                            display_name: "Warnville",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: 1 },
                        { id: SURVIVOR_ID, earn_count: 4 },
                      ],
                      error: null,
                    }),
                };
              }
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID) xxEntryDeleted = true;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () =>
                // Simulate a transient DB error on the ownership repoint
                Promise.resolve({
                  data: null,
                  error: { message: "deadlock detected" },
                }),
            }),
          };
        }

        if (table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
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
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    // Intercept warn calls forwarded through mergeCatalogEntry
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    let r: { status: number; body: any };
    try {
      r = await apiReq("PUT", "/admin/geocode-cache/warnville", {
        country_code: "DE",
        country: "Germany",
        repair_catalog: true,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(r!.status, 200, `expected 200, got ${r!.status}: ${JSON.stringify(r!.body)}`);
    assert.ok(r!.body.repair, "response should include repair stats");
    const repair = r!.body.repair as RepairStats;

    // Ownership repoint failure is fatal — the merge must not be counted
    assert.equal(repair.catalogMerged, 0,
      "catalogMerged must be 0: a user_stamps repoint error must prevent the merge from being counted as successful");
    assert.equal(repair.catalogRekeyed, 0,
      "catalogRekeyed must be 0 — a merge path was attempted, not a re-key");

    // The XX entry must not be deleted when the repoint failed
    assert.equal(xxEntryDeleted, false,
      "the XX catalog entry must not be deleted when the ownership repoint errors — leaving it prevents data loss");

    // The error was logged — not silently swallowed
    const repointWarn = warnMessages.find((m) => m.includes("user_stamps") && m.includes("repoint"));
    assert.ok(repointWarn,
      "a warn should have been emitted for the failed user_stamps repoint so it is not silently swallowed");
  });

  it("prevents a success count when a passport_stamps ownership repoint errors during merge", async () => {
    const XX_ID = "cat-xx-passport-fail";
    const SURVIVOR_ID = "cat-survivor-passport-fail";

    const warnMessages: string[] = [];
    let xxEntryDeleted = false;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:passportville",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Passportville",
                            neighborhood: null,
                            display_name: "Passportville",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: 2 },
                        { id: SURVIVOR_ID, earn_count: 5 },
                      ],
                      error: null,
                    }),
                };
              }
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID) xxEntryDeleted = true;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () =>
                // Simulate a transient DB error on the passport_stamps repoint
                Promise.resolve({
                  data: null,
                  error: { message: "deadlock detected" },
                }),
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
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    // Intercept warn calls forwarded through mergeCatalogEntry
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    let r: { status: number; body: any };
    try {
      r = await apiReq("PUT", "/admin/geocode-cache/passportville", {
        country_code: "DE",
        country: "Germany",
        repair_catalog: true,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(r!.status, 200, `expected 200, got ${r!.status}: ${JSON.stringify(r!.body)}`);
    assert.ok(r!.body.repair, "response should include repair stats");
    const repair = r!.body.repair as RepairStats;

    // passport_stamps repoint failure is fatal — the merge must not be counted
    assert.equal(repair.catalogMerged, 0,
      "catalogMerged must be 0: a passport_stamps repoint error must prevent the merge from being counted as successful");
    assert.equal(repair.catalogRekeyed, 0,
      "catalogRekeyed must be 0 — a merge path was attempted, not a re-key");

    // The XX entry must not be deleted when the repoint failed
    assert.equal(xxEntryDeleted, false,
      "the XX catalog entry must not be deleted when the passport_stamps repoint errors — leaving it prevents data loss");

    // The error was logged — not silently swallowed
    const repointWarn = warnMessages.find((m) => m.includes("passport_stamps") && m.includes("repoint"));
    assert.ok(repointWarn,
      "a warn should have been emitted for the failed passport_stamps repoint so it is not silently swallowed");
  });

  it("silently swallows a 'table does not exist' error on user_stamps repoint and still counts the merge", async () => {
    const XX_ID = "cat-xx-no-table";
    const SURVIVOR_ID = "cat-survivor-no-table";

    const warnMessages: string[] = [];
    let xxEntryDeleted = false;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:silentville",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Silentville",
                            neighborhood: null,
                            display_name: "Silentville",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: 2 },
                        { id: SURVIVOR_ID, earn_count: 3 },
                      ],
                      error: null,
                    }),
                };
              }
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID) xxEntryDeleted = true;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () =>
                // Simulate the table not existing yet (e.g. pre-migration environment)
                Promise.resolve({
                  data: null,
                  error: { message: "relation user_stamps does not exist" },
                }),
            }),
          };
        }

        if (table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
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
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    let r: { status: number; body: any };
    try {
      r = await apiReq("PUT", "/admin/geocode-cache/silentville", {
        country_code: "DE",
        country: "Germany",
        repair_catalog: true,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(r!.status, 200, `expected 200, got ${r!.status}: ${JSON.stringify(r!.body)}`);
    assert.ok(r!.body.repair, "response should include repair stats");
    const repair = r!.body.repair as RepairStats;

    // The guard lets the merge continue — 'table does not exist' is non-fatal
    assert.equal(repair.catalogMerged, 1,
      "catalogMerged must be 1: a 'table does not exist' error on user_stamps must not block the merge");

    // The XX entry must have been cleaned up
    assert.equal(xxEntryDeleted, true,
      "the XX catalog entry must be deleted even when user_stamps does not exist yet");

    // warn must NOT have been called for the user_stamps repoint — the guard is silent
    const userStampsWarn = warnMessages.find(
      (m) => m.includes("user_stamps") && m.includes("repoint"),
    );
    assert.equal(userStampsWarn, undefined,
      `warn must NOT be called for a 'table does not exist' error on user_stamps — got: ${JSON.stringify(warnMessages)}`);
  });

  it("silently swallows a 'table does not exist' error on passport_stamps repoint and still counts the merge", async () => {
    const XX_ID = "cat-xx-no-table-passport";
    const SURVIVOR_ID = "cat-survivor-no-table-passport";
    const XX_EARN_COUNT = 4;
    const SURVIVOR_EARN_COUNT = 1;

    const warnMessages: string[] = [];
    let xxEntryDeleted = false;
    let earnCountUpdate: number | null = null;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:passporttown",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Passporttown",
                            neighborhood: null,
                            display_name: "Passporttown",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: 4 },
                        { id: SURVIVOR_ID, earn_count: 1 },
                      ],
                      error: null,
                    }),
                };
              }
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (fields: Record<string, unknown>) => ({
              eq: (_col: string, val: string) => {
                // Capture the earn_count written to the survivor row
                if (val === SURVIVOR_ID && typeof fields.earn_count === "number") {
                  earnCountUpdate = fields.earn_count as number;
                }
                return Promise.resolve({ data: null, error: null });
              },
            }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID) xxEntryDeleted = true;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () =>
                // Simulate the table not existing yet (e.g. pre-migration environment)
                Promise.resolve({
                  data: null,
                  error: { message: "relation passport_stamps does not exist" },
                }),
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
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    let r: { status: number; body: any };
    try {
      r = await apiReq("PUT", "/admin/geocode-cache/passporttown", {
        country_code: "DE",
        country: "Germany",
        repair_catalog: true,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(r!.status, 200, `expected 200, got ${r!.status}: ${JSON.stringify(r!.body)}`);
    assert.ok(r!.body.repair, "response should include repair stats");
    const repair = r!.body.repair as RepairStats;

    // The guard lets the merge continue — 'table does not exist' is non-fatal
    assert.equal(repair.catalogMerged, 1,
      "catalogMerged must be 1: a 'table does not exist' error on passport_stamps must not block the merge");

    // The XX entry must have been cleaned up
    assert.equal(xxEntryDeleted, true,
      "the XX catalog entry must be deleted even when passport_stamps does not exist yet");

    // warn must NOT have been called for the passport_stamps repoint — the guard is silent
    const passportStampsWarn = warnMessages.find(
      (m) => m.includes("passport_stamps") && m.includes("repoint"),
    );
    assert.equal(passportStampsWarn, undefined,
      `warn must NOT be called for a 'table does not exist' error on passport_stamps — got: ${JSON.stringify(warnMessages)}`);

    // earn_count must still be transferred to the survivor even though passport_stamps warned —
    // the non-fatal path must not short-circuit the earn_count block
    assert.ok(
      earnCountUpdate !== null,
      "earn_count UPDATE must be issued for the survivor even when passport_stamps repoint is non-fatal",
    );
    assert.equal(
      earnCountUpdate,
      XX_EARN_COUNT + SURVIVOR_EARN_COUNT,
      `survivor earn_count should be ${XX_EARN_COUNT} + ${SURVIVOR_EARN_COUNT} = ${XX_EARN_COUNT + SURVIVOR_EARN_COUNT}`,
    );
  });

  it("does not count a merge as successful when the XX entry DELETE fails", async () => {
    const XX_ID = "cat-xx-delete-fail";
    const SURVIVOR_ID = "cat-survivor-delete-fail";

    let xxEntryDeleteAttempted = false;

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
              // earn_count fetch during merge
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: 2 },
                        { id: SURVIVOR_ID, earn_count: 5 },
                      ],
                      error: null,
                    }),
                };
              }
              // Survivor check
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID) {
                  xxEntryDeleteAttempted = true;
                  // Simulate a DB error on the XX catalog entry delete
                  return Promise.resolve({
                    data: null,
                    error: { message: "permission denied for table universal_stamp_catalog" },
                  });
                }
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps" || table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
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
              eq: () => Promise.resolve({ data: null, error: null }),
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

    // The delete was attempted but failed — must not count as a successful merge
    assert.ok(xxEntryDeleteAttempted, "DELETE should have been attempted on the XX catalog entry");
    assert.equal(repair.catalogMerged, 0,
      "catalogMerged must be 0 when the XX entry DELETE returns an error");
    assert.equal(repair.catalogRekeyed, 0,
      "catalogRekeyed must also be 0 — no re-key path was taken");
  });

  it("warns when the artwork repoint fails but still attempts ownership repoints and completes the merge", async () => {
    const XX_ID = "cat-xx-art-fail";
    const SURVIVOR_ID = "cat-survivor-art-fail";

    // Spy on console.warn — the route hardcodes it as the warn sink for mergeCatalogEntry
    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnMessages.push(args.join(" ")); };

    const ownershipTablesAttempted: string[] = [];
    let xxEntryDeleted = false;

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
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: 1 },
                        { id: SURVIVOR_ID, earn_count: 4 },
                      ],
                      error: null,
                    }),
                };
              }
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
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
            update: (_fields: Record<string, unknown>) => ({
              eq: (_col: string, _val: string) => {
                ownershipTablesAttempted.push(table);
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "stamp_artwork_versions") {
          return {
            // Simulate a DB error on the artwork repoint
            update: (_fields: Record<string, unknown>) => ({
              eq: () =>
                Promise.resolve({
                  data: null,
                  error: { message: "artwork table locked" },
                }),
            }),
          };
        }

        if (table === "stamp_generation_queue") {
          return {
            delete: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
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

    let r: Awaited<ReturnType<typeof apiReq>>;
    try {
      r = await apiReq("PUT", "/admin/geocode-cache/fooville", {
        country_code: "ES",
        country: "Spain",
        repair_catalog: true,
      });
    } finally {
      // Always restore console.warn even if the request throws
      console.warn = originalWarn;
    }

    assert.equal(r!.status, 200, `expected 200, got ${r!.status}: ${JSON.stringify(r!.body)}`);
    assert.ok(r!.body.repair, "response should include repair stats");
    const repair = r!.body.repair as RepairStats;

    // The artwork error must have been warned about
    const artWarn = warnMessages.find((m) => m.includes("artwork repoint failed"));
    assert.ok(
      artWarn !== undefined,
      `expected a warn message about artwork repoint failure, got: ${JSON.stringify(warnMessages)}`,
    );
    assert.ok(
      artWarn!.includes("artwork table locked"),
      "warn message should include the DB error text",
    );

    // Ownership rows must still have been attempted despite the artwork failure
    assert.ok(
      ownershipTablesAttempted.includes("user_stamps"),
      "user_stamps repoint should still be attempted when artwork repoint fails",
    );
    assert.ok(
      ownershipTablesAttempted.includes("passport_stamps"),
      "passport_stamps repoint should still be attempted when artwork repoint fails",
    );

    // Overall merge should still succeed (artwork failure is non-fatal)
    assert.ok(xxEntryDeleted, "XX catalog entry should still be deleted after artwork error");
    assert.equal(repair.catalogMerged, 1,
      "catalogMerged must be 1 — artwork repoint failure is non-fatal to the merge");
    assert.equal(repair.catalogRekeyed, 0,
      "catalogRekeyed must be 0 — merge path was taken, not re-key");
  });

  it("prevents a success count when a passport_stamps ownership repoint errors during merge", async () => {
    // City name must normalise (lowercase, strip diacritics, collapse whitespace) to
    // exactly match the URL slug so that the cityKeyFilter in repairXxCatalog lets
    // this XX entry through.  "Stampburg" → normCityKey → "stampburg" === URL slug.
    const XX_ID = "cat-xx-passport-fail";
    const SURVIVOR_ID = "cat-survivor-passport-fail";

    const warnMessages: string[] = [];
    let xxEntryDeleted = false;

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
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID,
                            canonical_location_key: "city:XX:stampburg",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Stampburg",
                            neighborhood: null,
                            display_name: "Stampburg",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, _ids: string[]) =>
                    Promise.resolve({
                      data: [
                        { id: XX_ID, earn_count: 2 },
                        { id: SURVIVOR_ID, earn_count: 5 },
                      ],
                      error: null,
                    }),
                };
              }
              const survivorChain: any = {
                eq: () => survivorChain,
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: SURVIVOR_ID }, error: null }),
              };
              return survivorChain;
            },
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID) xxEntryDeleted = true;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        if (table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () =>
                // Simulate a transient DB error on the passport_stamps repoint
                Promise.resolve({
                  data: null,
                  error: { message: "connection timeout" },
                }),
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
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    // Intercept warn calls forwarded through mergeCatalogEntry
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    let r: { status: number; body: any };
    try {
      r = await apiReq("PUT", "/admin/geocode-cache/stampburg", {
        country_code: "DE",
        country: "Germany",
        repair_catalog: true,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(r!.status, 200, `expected 200, got ${r!.status}: ${JSON.stringify(r!.body)}`);
    assert.ok(r!.body.repair, "response should include repair stats");
    const repair = r!.body.repair as RepairStats;

    // passport_stamps repoint failure is fatal — the merge must not be counted
    assert.equal(repair.catalogMerged, 0,
      "catalogMerged must be 0: a passport_stamps repoint error must prevent the merge from being counted as successful");
    assert.equal(repair.catalogRekeyed, 0,
      "catalogRekeyed must be 0 — a merge path was attempted, not a re-key");

    // The XX entry must not be deleted when the passport_stamps repoint failed
    assert.equal(xxEntryDeleted, false,
      "the XX catalog entry must not be deleted when the passport_stamps repoint errors — leaving it prevents data loss");

    // The error was logged — not silently swallowed
    const repointWarn = warnMessages.find(
      (m) => m.includes("passport_stamps") && m.includes("repoint"),
    );
    assert.ok(repointWarn,
      "a warn should have been emitted for the failed passport_stamps repoint so it is not silently swallowed");
  });

  it("continues the repair loop after one merge fails — the second entry is still merged and counted", async () => {
    // Two XX catalog entries for the same city ("Loopburg").  Both have a
    // real-code survivor already in the catalog, so both take the merge path.
    // The first entry's user_stamps repoint returns an error, so mergeCatalogEntry
    // returns false and the first XX entry is NOT deleted.  The loop must
    // continue to the second entry: mergeCatalogEntry returns true, the entry
    // IS deleted, and catalogMerged ends up at 1 (not 0).
    const XX_ID_1 = "cat-loop-xx-1";
    const XX_ID_2 = "cat-loop-xx-2";
    const SURVIVOR_ID_1 = "cat-loop-survivor-1";
    const SURVIVOR_ID_2 = "cat-loop-survivor-2";

    const deletedIds: string[] = [];
    const warnMessages: string[] = [];

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
              // Full XX scan — many columns including canonical_location_key.
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID_1,
                            canonical_location_key: "city:XX:loopburg",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Loopburg",
                            neighborhood: null,
                            display_name: "Loopburg",
                          },
                          {
                            id: XX_ID_2,
                            canonical_location_key: "neighborhood:XX:loopburg:old-loop",
                            stamp_type: "neighborhood",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Loopburg",
                            neighborhood: "Old Loop",
                            display_name: "Old Loop",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              // earn_count fetch during merge
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, ids: string[]) =>
                    Promise.resolve({
                      data: ids.map((id) => ({ id, earn_count: 0 })),
                      error: null,
                    }),
                };
              }
              // Survivor lookup: return the right survivor per stamp_type
              let resolvedSurvivorId = SURVIVOR_ID_1;
              const survivorChain: any = {
                eq: (col: string, val: unknown) => {
                  if (col === "canonical_location_key" && typeof val === "string") {
                    resolvedSurvivorId = val.startsWith("neighborhood:")
                      ? SURVIVOR_ID_2
                      : SURVIVOR_ID_1;
                  }
                  return survivorChain;
                },
                neq: () => survivorChain,
                maybeSingle: async () => ({ data: { id: resolvedSurvivorId }, error: null }),
              };
              return survivorChain;
            },
            update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                deletedIds.push(val);
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps") {
          return {
            // Fail only for XX_ID_1; succeed for XX_ID_2.
            update: (_fields: Record<string, unknown>) => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID_1) {
                  return Promise.resolve({
                    data: null,
                    error: { message: "deadlock detected" },
                  });
                }
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
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
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    let r: { status: number; body: any };
    try {
      r = await apiReq("PUT", "/admin/geocode-cache/loopburg", {
        country_code: "DE",
        country: "Germany",
        repair_catalog: true,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(r!.status, 200, `expected 200, got ${r!.status}: ${JSON.stringify(r!.body)}`);
    assert.ok(r!.body.repair, "response should include repair stats");
    const repair = r!.body.repair as RepairStats;

    // The second merge succeeded — catalogMerged must be 1, not 0.
    assert.equal(repair.catalogMerged, 1,
      "catalogMerged must be 1: the loop must continue past the first failed merge and count the second");

    // The first XX entry must NOT be deleted (its merge returned false).
    assert.equal(deletedIds.includes(XX_ID_1), false,
      "the first XX entry must not be deleted when its user_stamps repoint errored");

    // The second XX entry MUST be deleted (its merge succeeded).
    assert.equal(deletedIds.includes(XX_ID_2), true,
      "the second XX entry must be deleted — its merge succeeded even though the first entry failed");

    // The repoint failure was logged.
    const repointWarn = warnMessages.find(
      (m) => m.includes("user_stamps") && m.includes("repoint"),
    );
    assert.ok(repointWarn,
      "a warn must be emitted for the failed user_stamps repoint on the first entry");
  });

  it("does not count a catalog re-key as successful when the DB update call fails", async () => {
    // The city resolves successfully (unresolvedCities must be empty), but the
    // DB write that re-keys the catalog entry returns an error.  The repair stats
    // must reflect the failure — catalogRekeyed must stay at 0.
    const catalogUpdates: Record<string, unknown>[] = [];

    const client = makeRepairClient({
      xxEntries: [
        {
          id: "cat-put-update-fail",
          canonical_location_key: "city:XX:failburg",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Failburg",
          neighborhood: null,
          display_name: "Failburg",
        },
      ],
      onCatalogUpdate: (f) => catalogUpdates.push(f),
      catalogUpdateError: "permission denied for table universal_stamp_catalog",
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // Geocoder resolves successfully to Austria (AT) — so the city is NOT unresolved.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Austria", "AT"));

    const r = await apiReq("PUT", "/admin/geocode-cache/failburg", {
      country_code: "AT",
      country: "Austria",
      repair_catalog: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // The DB update was attempted but returned an error — must NOT count as a success.
    assert.equal(
      repair.catalogRekeyed,
      0,
      "catalogRekeyed must be 0 when the catalog update call returns an error",
    );

    // The city geocoded successfully, so it must NOT appear in unresolvedCities.
    assert.equal(
      repair.unresolvedCities.length,
      0,
      `unresolvedCities must be empty when the city resolved — got: ${JSON.stringify(repair.unresolvedCities)}`,
    );
  });

  it("continues the repair loop after a merge failure — the second entry that takes the re-key path is still processed and counted", async () => {
    // Two XX catalog entries for the same city ("Mergethenrekey").
    // Entry 1 has a survivor in the catalog → takes the merge path; the
    // user_stamps repoint deliberately fails so mergeCatalogEntry returns false.
    // Entry 2 has no survivor → takes the re-key path; the update succeeds.
    // The loop must not abort after the first entry's merge fails:
    //   catalogRekeyed must be 1 (the second entry succeeded)
    //   catalogMerged  must be 0 (the first entry's merge did not complete)
    const XX_ID_MERGE = "cat-cross-xx-merge";
    const XX_ID_REKEY = "cat-cross-xx-rekey";
    const SURVIVOR_ID  = "cat-cross-survivor";

    const deletedIds: string[]   = [];
    const rekeyUpdates: unknown[] = [];
    const warnMessages: string[] = [];

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
              // Full XX scan — returns both entries.
              if (cols.includes("canonical_location_key")) {
                return {
                  eq: (_col: string, _val: unknown) => ({
                    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                      resolve({
                        data: [
                          {
                            id: XX_ID_MERGE,
                            canonical_location_key: "city:XX:mergethenrekey",
                            stamp_type: "city",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Mergethenrekey",
                            neighborhood: null,
                            display_name: "Mergethenrekey",
                          },
                          {
                            id: XX_ID_REKEY,
                            canonical_location_key: "neighborhood:XX:mergethenrekey:old-quarter",
                            stamp_type: "neighborhood",
                            country: "Unknown",
                            country_code: "XX",
                            city: "Mergethenrekey",
                            neighborhood: "Old Quarter",
                            display_name: "Old Quarter",
                          },
                        ],
                        error: null,
                      }),
                  }),
                };
              }
              // earn_count fetch during merge
              if (cols === "id, earn_count") {
                return {
                  in: (_col: string, ids: string[]) =>
                    Promise.resolve({
                      data: ids.map((id) => ({ id, earn_count: 0 })),
                      error: null,
                    }),
                };
              }
              // Survivor lookup: survivor exists for the city entry (XX_ID_MERGE),
              // but NOT for the neighborhood entry (XX_ID_REKEY).
              const chain: any = {
                _targetId: null as string | null,
                eq: function (col: string, val: unknown) {
                  if (col === "stamp_type" && val === "city") {
                    this._targetId = SURVIVOR_ID;
                  }
                  if (col === "stamp_type" && val === "neighborhood") {
                    this._targetId = null;
                  }
                  return this;
                },
                neq: function () { return this; },
                maybeSingle: async function () {
                  return {
                    data: this._targetId ? { id: this._targetId } : null,
                    error: null,
                  };
                },
              };
              return chain;
            },
            // Re-key update for the neighborhood entry (entry 2).
            update: (fields: Record<string, unknown>) => ({
              eq: () => {
                rekeyUpdates.push(fields);
                return Promise.resolve({ data: null, error: null });
              },
            }),
            delete: () => ({
              eq: (_col: string, val: string) => {
                deletedIds.push(val);
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "user_stamps") {
          return {
            // Fail for the XX_ID_MERGE entry so mergeCatalogEntry returns false.
            update: (_fields: Record<string, unknown>) => ({
              eq: (_col: string, val: string) => {
                if (val === XX_ID_MERGE) {
                  return Promise.resolve({
                    data: null,
                    error: { message: "deadlock on user_stamps" },
                  });
                }
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        }

        if (table === "passport_stamps") {
          return {
            update: (_fields: Record<string, unknown>) => ({
              eq: () => Promise.resolve({ data: null, error: null }),
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
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }

        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Germany", "DE"));

    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    let r: { status: number; body: any };
    try {
      r = await apiReq("PUT", "/admin/geocode-cache/mergethenrekey", {
        country_code: "DE",
        country: "Germany",
        repair_catalog: true,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(r!.status, 200, `expected 200, got ${r!.status}: ${JSON.stringify(r!.body)}`);
    assert.ok(r!.body.repair, "response should include repair stats");
    const repair = r!.body.repair as RepairStats;

    // The first entry's merge failed — must not be counted.
    assert.equal(repair.catalogMerged, 0,
      "catalogMerged must be 0: the first entry's merge failed due to a user_stamps error");

    // The second entry was re-keyed successfully — must be counted.
    assert.equal(repair.catalogRekeyed, 1,
      "catalogRekeyed must be 1: the loop must continue past the failed merge and re-key the second entry");

    // The first XX entry must NOT be deleted (its merge returned false).
    assert.equal(deletedIds.includes(XX_ID_MERGE), false,
      "the first XX entry must not be deleted when its merge failed");

    // The re-key update for the second entry must have been attempted.
    assert.ok(rekeyUpdates.length >= 1,
      "the re-key update for the second entry must have been called — the loop must not abort after the merge failure");

    // A warn must have been emitted for the failed merge.
    const mergeWarn = warnMessages.find(
      (m) => m.includes("user_stamps") && m.includes("repoint"),
    );
    assert.ok(mergeWarn,
      "a warn must be emitted for the failed user_stamps repoint so the error is not silently swallowed");
  });

  it("does not abort the loop when the first catalog re-key fails — the second entry for the same city is still processed", async () => {
    // Seed two XX entries for the same city.  The first catalog update call
    // deliberately returns a DB error; the second must still be attempted and
    // must count as a success.  catalogRekeyed must therefore be 1 (not 0 or 2).
    // unresolvedCities must be empty because the city geocoded successfully.
    let updateCallCount = 0;
    const successfulUpdates: Record<string, unknown>[] = [];

    const catalogFake = {
      select: (cols: string) => {
        if (cols.includes("canonical_location_key")) {
          return {
            eq: (_col: string, _val: unknown) => ({
              then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                resolve({
                  data: [
                    {
                      id: "cat-put-loop-fail-1",
                      canonical_location_key: "city:XX:rekeyfailburg",
                      stamp_type: "city",
                      country: "Unknown",
                      country_code: "XX",
                      city: "Rekeyfailburg",
                      neighborhood: null,
                      display_name: "Rekeyfailburg",
                    },
                    {
                      id: "cat-put-loop-fail-2",
                      canonical_location_key: "neighborhood:XX:rekeyfailburg:old-quarter",
                      stamp_type: "neighborhood",
                      country: "Unknown",
                      country_code: "XX",
                      city: "Rekeyfailburg",
                      neighborhood: "Old Quarter",
                      display_name: "Old Quarter",
                    },
                  ],
                  error: null,
                }),
            }),
          };
        }
        // Survivor-check chain — no survivor for either entry.
        const chain: any = {
          eq: () => chain,
          neq: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
      update: (fields: Record<string, unknown>) => {
        updateCallCount += 1;
        const callIndex = updateCallCount;
        if (callIndex > 1) {
          successfulUpdates.push(fields);
        }
        return {
          eq: () =>
            Promise.resolve({
              data: null,
              // Only the first call errors; subsequent calls succeed.
              error:
                callIndex === 1
                  ? { message: "permission denied for table universal_stamp_catalog" }
                  : null,
            }),
        };
      },
    };

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
          return catalogFake;
        }
        return builder([]);
      },
    };

    _setTestClient(client, true);
    _setTestServiceClient(client);

    // Geocoder resolves successfully to Austria (AT) for both entries.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Austria", "AT"));

    const r = await apiReq("PUT", "/admin/geocode-cache/rekeyfailburg", {
      country_code: "AT",
      country: "Austria",
      repair_catalog: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.repair, "response should include repair stats");
    const repair = r.body.repair as RepairStats;

    // Only the second entry succeeded — catalogRekeyed must be exactly 1.
    assert.equal(
      repair.catalogRekeyed,
      1,
      `catalogRekeyed must be 1 (first failed, second succeeded) — got ${repair.catalogRekeyed}`,
    );

    // The second update must have been attempted — the loop must not have aborted.
    assert.equal(
      updateCallCount,
      2,
      `catalog update must have been called twice (once per entry) — got ${updateCallCount}`,
    );

    // The city resolved successfully, so unresolvedCities must be empty.
    assert.equal(
      repair.unresolvedCities.length,
      0,
      `unresolvedCities must be empty — got: ${JSON.stringify(repair.unresolvedCities)}`,
    );
  });
});

// ── PUT /admin/geocode-cache/:city_key — xx_entries_pending ───────────────────

describe("PUT /admin/geocode-cache/:city_key — xx_entries_pending", () => {
  it("returns xx_entries_pending: N when repair_catalog is not set and N XX entries exist", async () => {
    const client = makeRepairClient({
      xxEntries: [
        {
          id: "cat-put-pend-1",
          canonical_location_key: "city:XX:putville",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Putville",
          neighborhood: null,
          display_name: "Putville",
        },
        {
          id: "cat-put-pend-2",
          canonical_location_key: "neighborhood:XX:putville:old-quarter",
          stamp_type: "neighborhood",
          country: "Unknown",
          country_code: "XX",
          city: "Putville",
          neighborhood: "Old Quarter",
          display_name: "Old Quarter",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("PUT", "/admin/geocode-cache/putville", {
      country_code: "DE",
      country: "Germany",
      // repair_catalog omitted
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.updated, true);
    assert.ok(!r.body.repair, "repair field must be absent when repair_catalog is not set");
    assert.equal(r.body.xx_entries_pending, 2,
      "PUT without repair_catalog must report both matching XX entries as pending");
  });

  it("returns xx_entries_pending: 0 when no matching XX entries exist", async () => {
    const client = makeRepairClient({
      xxEntries: [], // no XX entries
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("PUT", "/admin/geocode-cache/cleanville", {
      country_code: "AU",
      country: "Australia",
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.updated, true);
    assert.ok(!r.body.repair, "repair field must be absent");
    assert.equal(r.body.xx_entries_pending, 0,
      "xx_entries_pending must be 0 when no matching XX entries exist");
  });

  it("omits xx_entries_pending when repair_catalog is true (repair already ran)", async () => {
    const client = makeRepairClient({
      xxEntries: [
        {
          id: "cat-put-rep-1",
          canonical_location_key: "city:XX:repville",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Repville",
          neighborhood: null,
          display_name: "Repville",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("France", "FR"));

    const r = await apiReq("PUT", "/admin/geocode-cache/repville", {
      country_code: "FR",
      country: "France",
      repair_catalog: true,
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.updated, true);
    assert.ok(r.body.repair, "repair stats must be present when repair_catalog=true");
    assert.equal(r.body.xx_entries_pending, undefined,
      "xx_entries_pending must be absent when repair_catalog=true — repair already ran");
  });

  it("counts only the exact city key — a city whose normalised form is a prefix of the key is not counted (port vs portland)", async () => {
    // normCityKey uses strict equality (===), not substring matching.
    // PUT /admin/geocode-cache/portland must count only the "Portland" entry;
    // the "Port" entry normalises to "port" which does not equal "portland".
    const client = makeRepairClient({
      xxEntries: [
        {
          id: "cat-put-exact-prefix-1",
          canonical_location_key: "city:XX:port",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Port",       // normalises to "port" — must not match "portland"
          neighborhood: null,
          display_name: "Port",
        },
        {
          id: "cat-put-exact-prefix-2",
          canonical_location_key: "city:XX:portland",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Portland",
          neighborhood: null,
          display_name: "Portland",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("PUT", "/admin/geocode-cache/portland", {
      country_code: "US",
      country: "United States",
      // repair_catalog omitted
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.updated, true);
    assert.ok(!r.body.repair, "repair field must be absent when repair_catalog is not set");
    assert.equal(
      r.body.xx_entries_pending,
      1,
      "only 'Portland' must be counted — 'Port' normalises to 'port', which does not equal 'portland'",
    );
  });

  it("counts only the exact city key — a city whose normalised form is a superset of the key is not counted (portland vs port)", async () => {
    // PUT /admin/geocode-cache/port must count only the "Port" entry;
    // the "Portland" entry normalises to "portland" which does not equal "port",
    // so it must be excluded even though "port" is a prefix of "portland".
    const client = makeRepairClient({
      xxEntries: [
        {
          id: "cat-put-exact-suffix-1",
          canonical_location_key: "city:XX:port",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Port",
          neighborhood: null,
          display_name: "Port",
        },
        {
          id: "cat-put-exact-suffix-2",
          canonical_location_key: "city:XX:portland",
          stamp_type: "city",
          country: "Unknown",
          country_code: "XX",
          city: "Portland",   // normalises to "portland" — must not match "port"
          neighborhood: null,
          display_name: "Portland",
        },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await apiReq("PUT", "/admin/geocode-cache/port", {
      country_code: "GB",
      country: "United Kingdom",
      // repair_catalog omitted
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.updated, true);
    assert.ok(!r.body.repair, "repair field must be absent when repair_catalog is not set");
    assert.equal(
      r.body.xx_entries_pending,
      1,
      "only 'Port' must be counted — 'Portland' normalises to 'portland', which does not equal 'port'",
    );
  });

  it("repair_catalog failure mid-loop returns repair stats with catalogRekeyed=0 — not silent success — and a follow-up without repair_catalog reveals xx_entries_pending > 0", async () => {
    // Scenario: repair_catalog=true is requested, the geocoder resolves the city
    // successfully, but the catalog DB update call fails (e.g. permission error).
    // The PUT must still return 200 with repair stats so the caller can inspect
    // catalogRekeyed; silently returning success would hide the failure.
    // A subsequent PUT without repair_catalog must then report xx_entries_pending > 0
    // confirming the entries remain outstanding.
    const xxEntry = {
      id: "cat-put-failrepair-1",
      canonical_location_key: "city:XX:failrepairtown",
      stamp_type: "city",
      country: "Unknown",
      country_code: "XX",
      city: "Failrepairtown",
      neighborhood: null,
      display_name: "Failrepairtown",
    };

    // ── Pass 1: repair_catalog=true, catalog update deliberately fails ────────
    const clientWithError = makeRepairClient({
      xxEntries: [xxEntry],
      catalogUpdateError: "permission denied for table universal_stamp_catalog",
    });
    _setTestClient(clientWithError, true);
    _setTestServiceClient(clientWithError);

    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests(makeGeocodeDbClient("Norway", "NO"));

    const r1 = await apiReq("PUT", "/admin/geocode-cache/failrepairtown", {
      country_code: "NO",
      country: "Norway",
      repair_catalog: true,
    });

    assert.equal(r1.status, 200, `expected 200, got ${r1.status}: ${JSON.stringify(r1.body)}`);
    assert.equal(r1.body.updated, true, "updated must be true — the geocode row itself was written");

    // repair stats must be present — repair ran but failed.
    assert.ok(r1.body.repair, "repair stats must be present when repair_catalog=true, even on failure");
    const repair = r1.body.repair as RepairStats;

    // catalogRekeyed must be 0 — the update errored, so no entry was actually re-keyed.
    assert.equal(
      repair.catalogRekeyed,
      0,
      "catalogRekeyed must be 0 when the catalog update call fails mid-loop",
    );

    // xx_entries_pending must be absent — repair ran (even though it failed);
    // the handler only emits xx_entries_pending when repair_catalog is NOT set.
    assert.equal(
      r1.body.xx_entries_pending,
      undefined,
      "xx_entries_pending must be absent when repair_catalog=true, even if catalogRekeyed=0",
    );

    // ── Pass 2: follow-up without repair_catalog — entries still outstanding ──
    // The XX catalog entry was NOT repaired (the update failed), so a subsequent
    // GET/PUT without repair_catalog must still count it as pending.
    const clientForCount = makeRepairClient({
      xxEntries: [xxEntry], // same entry — still unrepaired
    });
    _setTestClient(clientForCount, true);
    _setTestServiceClient(clientForCount);

    const r2 = await apiReq("PUT", "/admin/geocode-cache/failrepairtown", {
      country_code: "NO",
      country: "Norway",
      // repair_catalog omitted
    });

    assert.equal(r2.status, 200, `expected 200, got ${r2.status}: ${JSON.stringify(r2.body)}`);
    assert.ok(!r2.body.repair, "repair field must be absent when repair_catalog is not set");
    assert.equal(
      r2.body.xx_entries_pending,
      1,
      "follow-up without repair_catalog must report xx_entries_pending=1 — entry is still unrepaired",
    );
  });
});

// ── DELETE then PUT — tombstone revival ───────────────────────────────────────

describe("DELETE then PUT for the same city_key — tombstone revival", () => {
  it("PUT clears deleted_at tombstone so readDbCache returns the new result", async () => {
    let upsertedRow: any = null;
    let softDeletedKey: string | null = null;

    // A single fake client that handles both the DELETE (soft-delete via update)
    // and the subsequent PUT (upsert that must clear deleted_at).
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
            // DELETE handler soft-deletes by calling update({ deleted_at: now }).eq(...)
            update: (_fields: Record<string, unknown>) => ({
              eq: (_col: string, key: string) => {
                softDeletedKey = key;
                return Promise.resolve({ data: null, error: null });
              },
            }),
            // PUT handler revives the row via upsert — must include deleted_at: null
            upsert: (row: unknown, _opts?: unknown) => {
              upsertedRow = row;
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        // universal_stamp_catalog: return empty (xx_entries_pending: 0)
        return builder([]);
      },
    };
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // Step 1: DELETE — writes the tombstone (deleted_at = now()).
    const deleteResp = await apiReq("DELETE", "/admin/geocode-cache/revivecity");
    assert.equal(deleteResp.status, 200);
    assert.equal(deleteResp.body.deleted, true);
    assert.equal(softDeletedKey, "revivecity", "soft-delete should have targeted 'revivecity'");

    // Step 2: PUT — re-adds the same city_key; the upsert must clear the tombstone.
    const putResp = await apiReq("PUT", "/admin/geocode-cache/revivecity", {
      country_code: "JP",
      country: "Japan",
    });
    assert.equal(putResp.status, 200);
    assert.equal(putResp.body.updated, true);
    assert.equal(putResp.body.country_code, "JP");

    // Step 3: Confirm the upserted payload included deleted_at: null.
    assert.ok(upsertedRow, "PUT must have called upsert");
    assert.equal(
      upsertedRow.deleted_at,
      null,
      "upsert payload must set deleted_at: null to clear the tombstone",
    );
    assert.equal(upsertedRow.city_key, "revivecity");
    assert.equal(upsertedRow.country_code, "JP");

    // Step 4: readDbCache must return the revived result — not null.
    // Point the geocoder at a DB that returns the row as live (deleted_at: null).
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests({
      from: (table: string) => {
        if (table === "city_country_geocode_cache") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  // Row is live — deleted_at is null so readDbCache must not skip it.
                  data: { country: "Japan", country_code: "JP", corrected_at: null, deleted_at: null },
                  error: null,
                }),
              }),
            }),
            upsert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        return {};
      },
    } as any);

    const geocoded = await geocodeCityCountry("revivecity");
    assert.ok(geocoded, "geocodeCityCountry must return a result after PUT revives the tombstoned row");
    assert.equal(geocoded.countryCode, "JP", "revived entry must have country_code JP, not null");
  });

  it("PUT evicts a null in-memory entry seeded between DELETE and PUT so next geocode returns the revived result", async () => {
    // Scenario: a geocodeCityCountry call races between DELETE and PUT.
    // At that moment the DB row is tombstoned, so readDbCache returns null and
    // forwardGeocodeCity fails → null is cached with a 6-hour negative TTL.
    // The subsequent PUT must call evictGeocodeCacheKey to clear that null entry
    // so the very next geocodeCityCountry call returns the correct revived result.

    const CITY = "betweencity";

    // Step 1: Seed a null in-memory entry by calling geocodeCityCountry while
    // the DB row is tombstoned (deleted_at set) and Nominatim returns nothing.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests({
      from: (table: string) => {
        if (table === "city_country_geocode_cache") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  // Tombstoned row — readDbCache must skip it (returns null).
                  data: { country: "Japan", country_code: "JP", corrected_at: null, deleted_at: "2026-01-01T00:00:00.000Z" },
                  error: null,
                }),
              }),
            }),
            upsert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        return {};
      },
    } as any);

    const nullResult = await geocodeCityCountry(CITY);
    assert.equal(nullResult, null, "pre-condition: null should be cached while row is tombstoned");

    // Step 2: Issue PUT via the admin endpoint — this must evict the null entry.
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
            upsert: (_row: unknown, _opts?: unknown) =>
              Promise.resolve({ data: null, error: null }),
          };
        }
        return builder([]);
      },
    };
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const putResp = await apiReq("PUT", `/admin/geocode-cache/${CITY}`, {
      country_code: "JP",
      country: "Japan",
    });
    assert.equal(putResp.status, 200);
    assert.equal(putResp.body.updated, true);

    // Step 3: After PUT, point the geocoder at a DB that returns the revived row
    // (deleted_at: null) and confirm the null in-memory entry is gone.
    let fetchCalled = false;
    _setGeocodeFetchForTests(async () => {
      fetchCalled = true;
      return { ok: true, json: async () => [] }; // Nominatim not needed — DB hit
    });
    _setGeocodeDbClientForTests({
      from: (table: string) => {
        if (table === "city_country_geocode_cache") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  // Row is live after PUT — deleted_at is null.
                  data: { country: "Japan", country_code: "JP", corrected_at: null, deleted_at: null },
                  error: null,
                }),
              }),
            }),
            upsert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        return {};
      },
    } as any);

    const revived = await geocodeCityCountry(CITY);
    assert.ok(revived, "geocodeCityCountry must return a result — null in-memory entry should have been evicted by PUT");
    assert.equal(revived.countryCode, "JP", "revived entry must reflect the PUT country_code, not the stale null");
    // Nominatim should NOT have been called — the revived DB row was hit instead.
    assert.equal(fetchCalled, false, "Nominatim must not be called when the DB cache has the revived row");
  });

  it("readDbCache returns null when deleted_at is still set — tombstone not yet cleared", async () => {
    // Confirm the inverse: if a row has deleted_at set, readDbCache skips it.
    // This validates the guard that makes the tombstone-clearing test meaningful.
    _setGeocodeFetchForTests(async () => ({ ok: true, json: async () => [] }));
    _setGeocodeDbClientForTests({
      from: (table: string) => {
        if (table === "city_country_geocode_cache") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  // Tombstoned row: deleted_at is set.
                  data: { country: "Japan", country_code: "JP", corrected_at: null, deleted_at: "2026-01-01T00:00:00.000Z" },
                  error: null,
                }),
              }),
            }),
            upsert: () => Promise.resolve({ data: null, error: null }),
          };
        }
        return {};
      },
    } as any);

    // geocodeCityCountry falls through readDbCache (returns null for tombstoned row)
    // and then hits forwardGeocodeCity — our fake fetch returns empty, so result is null.
    const result = await geocodeCityCountry("tombstonedcity");
    assert.equal(
      result,
      null,
      "readDbCache must return null for a tombstoned row (deleted_at set), forcing re-resolution",
    );
  });
});
