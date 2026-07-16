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

  it("completes the merge and counts it when a passport_stamps ownership repoint errors", async () => {
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

    // passport_stamps repoint failure is non-fatal — the merge must still be counted
    assert.equal(repair.catalogMerged, 1,
      "catalogMerged must be 1: a passport_stamps repoint error must not prevent the merge from being counted");
    assert.equal(repair.catalogRekeyed, 0,
      "catalogRekeyed must be 0 — a merge path was taken, not a re-key");

    // The XX entry must still be deleted even though passport_stamps repoint failed
    assert.ok(xxEntryDeleted,
      "the XX catalog entry must still be deleted when only the passport_stamps repoint errors");

    // The error was logged — not silently swallowed
    const repointWarn = warnMessages.find(
      (m) => m.includes("passport_stamps") && m.includes("repoint"),
    );
    assert.ok(repointWarn,
      "a warn should have been emitted for the failed passport_stamps repoint so it is not silently swallowed");
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
});
