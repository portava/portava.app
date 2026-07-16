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
