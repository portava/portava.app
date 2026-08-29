/**
 * Admin venue queue — limit-cap tests
 *
 * Route under test: GET /admin/venues/pending
 * Source:           artifacts/api-server/src/routes/admin.ts (~line 297)
 *
 * Invariants tested:
 *  1. limit=200 → at most 100 rows returned (Math.min(100, limit) cap)
 *  2. limit=10  → exactly 10 rows returned when more than 10 exist
 *
 * Run: node --import tsx/esm --test src/test/adminVenueQueue.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Constants ──────────────────────────────────────────────────────────────────
const ADMIN_USER_ID = "aaaaaaaa-0000-4000-0001-000000000001";

// ── Test server (shared for all tests) ────────────────────────────────────────
let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

// ── Request helper ─────────────────────────────────────────────────────────────
function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": "Bearer fake-admin-token",
        },
      },
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

// ── Fake client factory ────────────────────────────────────────────────────────
// Generates `count` provisional discovery_places rows and returns a fake Supabase
// client that correctly applies .limit() so the route's cap logic is exercised.

function makeQueueClient(opts: { venueCount: number } = { venueCount: 150 }) {
  const { venueCount } = opts;

  const provisionalVenues = Array.from({ length: venueCount }, (_, i) => ({
    id:           `venue-${String(i).padStart(4, "0")}`,
    name:         `Venue ${i}`,
    place_type:   "bar",
    category:     "nightlife",
    city:         "Testville",
    neighborhood: null,
    blurb:        null,
    source:       "community",
    submitted_by: ADMIN_USER_ID,
    created_at:   new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
    status:       "provisional",
  }));

  const db: Record<string, any[]> = {
    profiles: [{ id: ADMIN_USER_ID, role: "admin" }],
    discovery_places: provisionalVenues,
  };

  function chain(tableName: string, rows: any[]) {
    let filtered = [...rows];
    let appliedLimit: number | null = null;

    const b: any = {
      select: (_cols?: string) => b,
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r: any) => r[col] === val);
        return b;
      },
      order: (_col: string, _opts?: any) => b,
      limit: (n: number) => {
        appliedLimit = n;
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(
        filtered[0]
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: "No rows" } },
      ),
      then: (resolve: any, reject: any) => {
        const result = appliedLimit !== null ? filtered.slice(0, appliedLimit) : filtered;
        return Promise.resolve({ data: result, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName, [...(db[tableName] ?? [])]),
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: ADMIN_USER_ID } }, error: null }),
    },
    _db: db,
  };
}

function setClient(client: ReturnType<typeof makeQueueClient>) {
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Non-admin client factory ───────────────────────────────────────────────────
const NON_ADMIN_USER_ID = "bbbbbbbb-0000-4000-0001-000000000002";

function makeNonAdminClient() {
  const db: Record<string, any[]> = {
    profiles: [{ id: NON_ADMIN_USER_ID, role: "user" }],
    discovery_places: [],
  };

  function chain(tableName: string, rows: any[]) {
    let filtered = [...rows];
    const b: any = {
      select: (_cols?: string) => b,
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r: any) => r[col] === val);
        return b;
      },
      order: (_col: string, _opts?: any) => b,
      limit: (_n: number) => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(
        filtered[0]
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: "No rows" } },
      ),
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName, [...(db[tableName] ?? [])]),
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: NON_ADMIN_USER_ID } }, error: null }),
    },
    _db: db,
  };
}

// ── Request helper without an Authorization header ────────────────────────────
function reqNoAuth(
  method: string,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers: { "content-type": "application/json" },
      },
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
    r.end();
  });
}

// ── Test: unauthenticated caller receives 401 ─────────────────────────────────

describe("GET /admin/venues/pending — unauthenticated caller", () => {
  it("returns 401 with error code 'unauthenticated' when no Authorization header is supplied", async () => {
    // Even with a client that would grant admin access, the missing header
    // must short-circuit to 401 before any auth lookup happens.
    setClient(makeQueueClient({ venueCount: 3 }));

    const { status, body } = await reqNoAuth("GET", "/admin/venues/pending");

    assert.equal(
      status, 401,
      `Expected 401, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.equal(
      body.error, "unauthenticated",
      `Expected error code 'unauthenticated', got '${body.error}'`,
    );
  });
});

// ── Test 0: non-admin caller receives 403 ─────────────────────────────────────

describe("GET /admin/venues/pending — non-admin caller", () => {
  it("returns 403 with error code 'forbidden' when the caller has no admin role", async () => {
    const client = makeNonAdminClient();
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const { status, body } = await req("GET", "/admin/venues/pending");

    assert.equal(
      status, 403,
      `Expected 403, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.equal(
      body.error, "forbidden",
      `Expected error code 'forbidden', got '${body.error}'`,
    );
  });
});

// ── Test 1: limit=200 is capped at 100 ────────────────────────────────────────

describe("GET /admin/venues/pending — limit cap at 100", () => {
  it("returns at most 100 rows when limit=200 is requested and 150 venues exist", async () => {
    const client = makeQueueClient({ venueCount: 150 });
    setClient(client);

    const { status, body } = await req("GET", "/admin/venues/pending?limit=200");

    assert.equal(
      status, 200,
      `Expected 200, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.ok(Array.isArray(body.venues), "response must include a venues array");
    assert.ok(
      body.venues.length <= 100,
      `Expected at most 100 rows with limit=200, got ${body.venues.length}`,
    );
    assert.equal(
      body.venues.length, 100,
      `With 150 provisional venues and limit=200, the cap must produce exactly 100 rows (got ${body.venues.length})`,
    );
  });
});

// ── Test 3: no limit param defaults to 50 ────────────────────────────────────

describe("GET /admin/venues/pending — default limit of 50", () => {
  it("returns exactly 50 rows when no limit param is supplied and 150 venues exist", async () => {
    const client = makeQueueClient({ venueCount: 150 });
    setClient(client);

    const { status, body } = await req("GET", "/admin/venues/pending");

    assert.equal(
      status, 200,
      `Expected 200, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.ok(Array.isArray(body.venues), "response must include a venues array");
    assert.equal(
      body.venues.length, 50,
      `With 150 provisional venues and no limit param, the default must produce exactly 50 rows (got ${body.venues.length})`,
    );
  });
});

// ── Test 2: limit=10 returns exactly 10 rows when more exist ──────────────────

describe("GET /admin/venues/pending — exact limit when below cap", () => {
  it("returns exactly 10 rows when limit=10 is requested and 150 venues exist", async () => {
    const client = makeQueueClient({ venueCount: 150 });
    setClient(client);

    const { status, body } = await req("GET", "/admin/venues/pending?limit=10");

    assert.equal(
      status, 200,
      `Expected 200, got ${status}: ${JSON.stringify(body)}`,
    );
    assert.ok(Array.isArray(body.venues), "response must include a venues array");
    assert.equal(
      body.venues.length, 10,
      `With 150 provisional venues and limit=10, exactly 10 rows must be returned (got ${body.venues.length})`,
    );
  });
});
