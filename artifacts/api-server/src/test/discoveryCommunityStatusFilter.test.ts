/**
 * Tests for GET /api/discovery/community — status filter enforcement
 *
 * Verifies that only rows with status='active' appear in results even when the
 * underlying DB returns a mix of active, pending, and rejected rows.
 *
 * Uses _setTestClient to inject a fake Supabase service client that respects
 * .eq("status", ...) calls so the real route's .eq("status", "active") filter
 * is exercised against seeded data.  No network calls are made.
 *
 * Tests cover:
 *  - active row appears in the response
 *  - pending row is absent from the response
 *  - rejected row is absent from the response
 *  - response total matches only active rows
 *  - response is 200 even when no active rows exist
 *  - only active rows are returned when every status is mixed
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunityStatusFilter.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Seed rows ──────────────────────────────────────────────────────────────────

const BASE_ROW = {
  city:         "TestCity",
  place_type:   "hidden_gem",
  category:     "food",
  neighborhood: null,
  blurb:        null,
  image_url:    null,
  submitted_by: null,
  saved_count:  0,
  tag:          null,
  note:         null,
  rating:       null,
  source:       "traveler",
  verified:     false,
  created_at:   "2025-07-01T00:00:00.000Z",
  lat:          null,
  lng:          null,
  profiles:     null,
};

const ACTIVE_ROW  = { ...BASE_ROW, id: "place-active-1",  name: "Active Place",   status: "active"   };
const PENDING_ROW = { ...BASE_ROW, id: "place-pending-1", name: "Pending Place",  status: "pending"  };
const REJECTED_ROW= { ...BASE_ROW, id: "place-rejected-1",name: "Rejected Place", status: "rejected" };

// ── Fake client ────────────────────────────────────────────────────────────────
//
// The chain tracks every .eq(column, value) call and applies those constraints
// when resolving, so the real route's .eq("status", "active") genuinely filters
// the seeded rows rather than being silently ignored.

function makeFakeClient(allRows: typeof ACTIVE_ROW[]) {
  function chain(table: string) {
    const eqFilters: Array<{ col: string; val: unknown }> = [];

    const obj: any = {
      select()               { return obj; },
      ilike()                { return obj; },
      eq(col: string, val: unknown) { eqFilters.push({ col, val }); return obj; },
      order()                { return obj; },
      limit()                { return obj; },
      or()                   { return obj; },
      in()                   { return obj; },
      maybeSingle()          { return obj; },
      single()               { return obj; },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    async function resolve(): Promise<{ data: any; error: null }> {
      if (table === "discovery_places") {
        let rows = [...allRows];
        for (const { col, val } of eqFilters) {
          rows = rows.filter((r) => (r as any)[col] === val);
        }
        return { data: rows, error: null };
      }
      // collections / collection_items — not needed for unauthenticated GET
      return { data: [], error: null };
    }

    return obj;
  }

  return {
    from(table: string) { return chain(table); },
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function getItems(url: string, city = "TestCity") {
  const res = await fetch(`${url}/api/discovery/community?city=${encodeURIComponent(city)}`);
  const body = (await res.json()) as { items: Array<{ id: string; status: string; name: string }>; total: number };
  return { status: res.status, items: body.items ?? [], total: body.total ?? 0 };
}

// ── Tests — mixed statuses ─────────────────────────────────────────────────────

describe("GET /api/discovery/community — status=active filter (mixed rows)", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([ACTIVE_ROW, PENDING_ROW, REJECTED_ROW]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200", async () => {
    const r = await getItems(url);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("includes the active place in the response", async () => {
    const r = await getItems(url);
    const ids = r.items.map((i) => i.id);
    assert.ok(ids.includes(ACTIVE_ROW.id), `expected active place id in response, got ${JSON.stringify(ids)}`);
  });

  it("excludes the pending place from the response", async () => {
    const r = await getItems(url);
    const ids = r.items.map((i) => i.id);
    assert.ok(!ids.includes(PENDING_ROW.id), `pending place must not appear, got ${JSON.stringify(ids)}`);
  });

  it("excludes the rejected place from the response", async () => {
    const r = await getItems(url);
    const ids = r.items.map((i) => i.id);
    assert.ok(!ids.includes(REJECTED_ROW.id), `rejected place must not appear, got ${JSON.stringify(ids)}`);
  });

  it("reports total equal to the number of active rows only", async () => {
    const r = await getItems(url);
    assert.equal(r.total, 1, `expected total=1 (active rows only), got ${r.total}`);
  });

  it("every returned item carries status=active", async () => {
    const r = await getItems(url);
    for (const item of r.items) {
      assert.equal(
        item.status,
        "active",
        `item ${item.id} has status=${item.status}, expected active`,
      );
    }
  });
});

// ── Tests — no active rows ─────────────────────────────────────────────────────

describe("GET /api/discovery/community — status=active filter (no active rows)", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([PENDING_ROW, REJECTED_ROW]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200 even when no active rows exist", async () => {
    const r = await getItems(url);
    assert.equal(r.status, 200, `expected 200 when no active rows, got ${r.status}`);
  });

  it("returns an empty items array when no active rows exist", async () => {
    const r = await getItems(url);
    assert.equal(r.items.length, 0, `expected 0 items, got ${r.items.length}`);
  });

  it("returns total=0 when no active rows exist", async () => {
    const r = await getItems(url);
    assert.equal(r.total, 0, `expected total=0, got ${r.total}`);
  });
});

// ── Tests — only active rows ───────────────────────────────────────────────────

describe("GET /api/discovery/community — status=active filter (all rows are active)", () => {
  let server: Server;
  let url: string;

  const ACTIVE_ROW_2 = { ...BASE_ROW, id: "place-active-2", name: "Second Active", status: "active" };

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([ACTIVE_ROW, ACTIVE_ROW_2]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns all rows when every row is active", async () => {
    const r = await getItems(url);
    assert.equal(r.items.length, 2, `expected 2 active items, got ${r.items.length}`);
  });

  it("reports total equal to the number of active rows", async () => {
    const r = await getItems(url);
    assert.equal(r.total, 2, `expected total=2, got ${r.total}`);
  });
});
