/**
 * Tests for GET /api/discovery/community — sortBy=popular ordering
 *
 * Verifies that when sortBy=popular is passed, results are ordered by
 * saved_count descending (highest saves first), and that without the param the
 * default created_at desc ordering is unaffected.
 *
 * The fake Supabase client tracks .order(col, opts) and applies real sorting
 * on resolution so removing or changing the .order() call in the route will
 * cause these tests to fail.
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunityPopularSort.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Seed rows ──────────────────────────────────────────────────────────────────

const BASE_ROW = {
  city:         "Testopolis",
  place_type:   "hidden_gem",
  category:     "food",
  neighborhood: null,
  blurb:        null,
  image_url:    null,
  submitted_by: null,
  tag:          null,
  note:         null,
  rating:       null,
  source:       "traveler",
  verified:     false,
  status:       "active",
  created_at:   "2025-07-01T00:00:00.000Z",
  lat:          null,
  lng:          null,
  profiles:     null,
};

const HIGH_SAVES = { ...BASE_ROW, id: "place-high",  name: "High Saves",  saved_count: 200 };
const MID_SAVES  = { ...BASE_ROW, id: "place-mid",   name: "Mid Saves",   saved_count: 50  };
const LOW_SAVES  = { ...BASE_ROW, id: "place-low",   name: "Low Saves",   saved_count: 1   };
const ZERO_SAVES = { ...BASE_ROW, id: "place-zero",  name: "Zero Saves",  saved_count: 0   };

// Rows for testing that default sort ignores save count
const POPULAR_OLD = { ...BASE_ROW, id: "place-popular-old", name: "Popular Old", saved_count: 999, created_at: "2024-01-01T00:00:00.000Z" };
const OBSCURE_NEW = { ...BASE_ROW, id: "place-obscure-new", name: "Obscure New", saved_count: 1,   created_at: "2025-06-01T00:00:00.000Z" };

// Rows for testing all-NULL / all-zero saved_count (different created_at for ordering check)
const NULL_A = { ...BASE_ROW, id: "place-null-a", name: "Null A", saved_count: null, created_at: "2025-03-01T00:00:00.000Z" };
const NULL_B = { ...BASE_ROW, id: "place-null-b", name: "Null B", saved_count: null, created_at: "2025-05-01T00:00:00.000Z" };
const NULL_C = { ...BASE_ROW, id: "place-null-c", name: "Null C", saved_count: null, created_at: "2025-01-01T00:00:00.000Z" };
const ZERO_A = { ...BASE_ROW, id: "place-zero-a", name: "Zero A", saved_count: 0,    created_at: "2025-02-01T00:00:00.000Z" };
const ZERO_B = { ...BASE_ROW, id: "place-zero-b", name: "Zero B", saved_count: 0,    created_at: "2025-06-01T00:00:00.000Z" };

// Rows for testing all-NULL rating (different created_at for tie-breaker ordering check)
// BASE_ROW already has rating: null; we only vary created_at and id/name.
const RATING_NULL_A = { ...BASE_ROW, id: "place-rating-null-a", name: "Rating Null A", created_at: "2025-03-01T00:00:00.000Z" };
const RATING_NULL_B = { ...BASE_ROW, id: "place-rating-null-b", name: "Rating Null B", created_at: "2025-05-01T00:00:00.000Z" };
const RATING_NULL_C = { ...BASE_ROW, id: "place-rating-null-c", name: "Rating Null C", created_at: "2025-01-01T00:00:00.000Z" };

// ── Fake client (tracks .order() and applies real sorting) ─────────────────────

function makeFakeClient(allRows: Record<string, unknown>[]) {
  function chain(table: string) {
    const eqFilters: Array<{ col: string; val: unknown }> = [];
    // Tracks multiple sort keys in declaration order (first = highest priority).
    const orderKeys: Array<{ col: string; asc: boolean }> = [];

    const obj: any = {
      select()         { return obj; },
      ilike()          { return obj; },
      or()             { return obj; },
      in()             { return obj; },
      limit()          { return obj; },
      maybeSingle()    { return obj; },
      single()         { return obj; },
      eq(col: string, val: unknown) {
        eqFilters.push({ col, val });
        return obj;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderKeys.push({ col, asc: opts?.ascending ?? true });
        return obj;
      },
      then(onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) {
        return resolve().then(onF, onR);
      },
    };

    async function resolve(): Promise<{ data: unknown[]; error: null }> {
      if (table === "discovery_places") {
        let rows = [...allRows];

        for (const { col, val } of eqFilters) {
          rows = rows.filter((r) => r[col] === val);
        }

        if (orderKeys.length > 0) {
          rows.sort((a, b) => {
            for (const { col, asc } of orderKeys) {
              const av = a[col] ?? null;
              const bv = b[col] ?? null;
              if (av === null && bv === null) continue;
              if (av === null) return asc ? 1 : -1;
              if (bv === null) return asc ? -1 : 1;
              if (av < bv) return asc ? -1 : 1;
              if (av > bv) return asc ? 1 : -1;
            }
            return 0;
          });
        }

        return { data: rows, error: null };
      }
      return { data: [], error: null };
    }

    return obj;
  }

  return {
    from(table: string) { return chain(table); },
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
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

type Item = { id: string; savedCount: number; name: string; rating: number | null };

async function getItems(url: string, qs = "") {
  const full = `${url}/api/discovery/community?city=Testopolis${qs ? `&${qs}` : ""}`;
  const res  = await fetch(full);
  const body = (await res.json()) as { items: Item[]; total: number };
  return { status: res.status, items: body.items ?? [], total: body.total ?? 0 };
}

// ── Tests — sortBy=popular ─────────────────────────────────────────────────────

describe("GET /api/discovery/community — sortBy=popular orders by saved_count desc", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([LOW_SAVES, MID_SAVES, HIGH_SAVES, ZERO_SAVES]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200 for sortBy=popular", async () => {
    const r = await getItems(url, "sortBy=popular");
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("all four active places are returned", async () => {
    const r = await getItems(url, "sortBy=popular");
    assert.equal(r.total, 4, `expected total=4, got ${r.total}`);
  });

  it("first item has the highest saved_count", async () => {
    const r = await getItems(url, "sortBy=popular");
    assert.ok(r.items.length > 0, "expected at least one item");
    assert.equal(
      r.items[0].id,
      HIGH_SAVES.id,
      `expected ${HIGH_SAVES.id} first (saved_count=200), got ${r.items[0].id} (savedCount=${r.items[0].savedCount})`,
    );
  });

  it("last item has the lowest saved_count (0)", async () => {
    const r = await getItems(url, "sortBy=popular");
    const last = r.items[r.items.length - 1];
    assert.equal(
      last.id,
      ZERO_SAVES.id,
      `expected ${ZERO_SAVES.id} last (saved_count=0), got ${last.id} (savedCount=${last.savedCount})`,
    );
  });

  it("items are in non-ascending savedCount order", async () => {
    const r = await getItems(url, "sortBy=popular");
    for (let i = 0; i < r.items.length - 1; i++) {
      assert.ok(
        r.items[i].savedCount >= r.items[i + 1].savedCount,
        `order violated at index ${i}: savedCount=${r.items[i].savedCount} < ${r.items[i + 1].savedCount}`,
      );
    }
  });
});

// ── Tests — default sort (no sortBy) uses created_at desc ─────────────────────

describe("GET /api/discovery/community — default sort uses created_at desc (not saved_count)", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([POPULAR_OLD, OBSCURE_NEW]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200 without sortBy", async () => {
    const r = await getItems(url);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("newer place appears first even though it has fewer saves", async () => {
    const r = await getItems(url);
    assert.ok(r.items.length > 0, "expected at least one item");
    assert.equal(
      r.items[0].id,
      OBSCURE_NEW.id,
      `expected newest place first (created_at=2025), got ${r.items[0].id}`,
    );
  });

  it("high saved_count alone does not override created_at ordering", async () => {
    const r = await getItems(url);
    const popularOldPos = r.items.findIndex((i) => i.id === POPULAR_OLD.id);
    const obscureNewPos = r.items.findIndex((i) => i.id === OBSCURE_NEW.id);
    assert.ok(
      obscureNewPos < popularOldPos,
      `newer but less-saved place (pos=${obscureNewPos}) should rank before older high-saved (pos=${popularOldPos})`,
    );
  });
});

// ── Tests — all saved_counts NULL (no saves on any row) ───────────────────────

describe("GET /api/discovery/community — sortBy=popular with all-NULL saved_count", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([NULL_A, NULL_B, NULL_C]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200 (no 500) when every row has saved_count=NULL", async () => {
    const r = await getItems(url, "sortBy=popular");
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("returns all three items even when saved_count is NULL on all rows", async () => {
    const r = await getItems(url, "sortBy=popular");
    assert.equal(r.total, 3, `expected total=3, got ${r.total}`);
    assert.equal(r.items.length, 3, `expected 3 items, got ${r.items.length}`);
  });

  it("maps NULL saved_count to savedCount=0 in the response", async () => {
    const r = await getItems(url, "sortBy=popular");
    for (const item of r.items) {
      assert.equal(
        item.savedCount,
        0,
        `expected savedCount=0 for ${item.id}, got ${item.savedCount}`,
      );
    }
  });

  it("response shape is valid — required fields present on each item", async () => {
    const r = await getItems(url, "sortBy=popular");
    assert.ok(r.items.length > 0, "expected at least one item");
    const item = r.items[0];
    assert.equal(typeof item.id,         "string",  "item.id must be a string");
    assert.equal(typeof item.name,       "string",  "item.name must be a string");
    assert.equal(typeof item.savedCount, "number",  "item.savedCount must be a number");
    assert.equal(typeof r.total,         "number",  "total must be a number");
  });

  it("ties broken by created_at desc — newest place comes first when saves are all NULL", async () => {
    // NULL_B is 2025-05-01 (newest), NULL_A is 2025-03-01, NULL_C is 2025-01-01 (oldest)
    const r = await getItems(url, "sortBy=popular");
    assert.equal(r.items.length, 3, "expected 3 items");
    assert.equal(
      r.items[0].id,
      NULL_B.id,
      `expected newest place (${NULL_B.id}) first, got ${r.items[0].id}`,
    );
    assert.equal(
      r.items[2].id,
      NULL_C.id,
      `expected oldest place (${NULL_C.id}) last, got ${r.items[2].id}`,
    );
  });
});

// ── Tests — all saved_counts zero ─────────────────────────────────────────────

describe("GET /api/discovery/community — sortBy=popular with all-zero saved_count", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([ZERO_A, ZERO_B]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200 (no 500) when every row has saved_count=0", async () => {
    const r = await getItems(url, "sortBy=popular");
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("returns both items when saved_count=0 on all rows", async () => {
    const r = await getItems(url, "sortBy=popular");
    assert.equal(r.total, 2, `expected total=2, got ${r.total}`);
    assert.equal(r.items.length, 2, `expected 2 items, got ${r.items.length}`);
  });

  it("response shape is valid — savedCount=0 on each item", async () => {
    const r = await getItems(url, "sortBy=popular");
    for (const item of r.items) {
      assert.equal(
        item.savedCount,
        0,
        `expected savedCount=0 for ${item.id}, got ${item.savedCount}`,
      );
    }
    assert.equal(typeof r.total, "number", "total must be a number");
  });

  it("ties broken by created_at desc — newest place comes first when saves are all zero", async () => {
    // ZERO_B is 2025-06-01 (newest), ZERO_A is 2025-02-01 (oldest)
    const r = await getItems(url, "sortBy=popular");
    assert.equal(r.items.length, 2, "expected 2 items");
    assert.equal(
      r.items[0].id,
      ZERO_B.id,
      `expected newest place (${ZERO_B.id}) first, got ${r.items[0].id}`,
    );
    assert.equal(
      r.items[1].id,
      ZERO_A.id,
      `expected oldest place (${ZERO_A.id}) last, got ${r.items[1].id}`,
    );
  });
});

// ── Tests — sortBy=rating with all-NULL ratings ────────────────────────────────

describe("GET /api/discovery/community — sortBy=rating with all-NULL rating", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient([RATING_NULL_A, RATING_NULL_B, RATING_NULL_C]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200 (no 500) when every row has rating=NULL", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("returns all three items even when rating is NULL on all rows", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.total, 3, `expected total=3, got ${r.total}`);
    assert.equal(r.items.length, 3, `expected 3 items, got ${r.items.length}`);
  });

  it("maps NULL rating to rating=null in the response (not NaN or undefined)", async () => {
    const r = await getItems(url, "sortBy=rating");
    for (const item of r.items) {
      assert.equal(
        item.rating,
        null,
        `expected rating=null for ${item.id}, got ${JSON.stringify(item.rating)}`,
      );
    }
  });

  it("response shape is valid — required fields present on each item", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.ok(r.items.length > 0, "expected at least one item");
    const item = r.items[0];
    assert.equal(typeof item.id,         "string", "item.id must be a string");
    assert.equal(typeof item.name,       "string", "item.name must be a string");
    assert.equal(typeof item.savedCount, "number", "item.savedCount must be a number");
    assert.equal(typeof r.total,         "number", "total must be a number");
    assert.ok(
      item.rating === null || typeof item.rating === "number",
      `item.rating must be null or a number, got ${JSON.stringify(item.rating)}`,
    );
  });

  it("ties broken by created_at desc — newest place comes first when ratings are all NULL", async () => {
    // RATING_NULL_B is 2025-05-01 (newest), RATING_NULL_A is 2025-03-01, RATING_NULL_C is 2025-01-01 (oldest)
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.items.length, 3, "expected 3 items");
    assert.equal(
      r.items[0].id,
      RATING_NULL_B.id,
      `expected newest place (${RATING_NULL_B.id}) first, got ${r.items[0].id}`,
    );
    assert.equal(
      r.items[2].id,
      RATING_NULL_C.id,
      `expected oldest place (${RATING_NULL_C.id}) last, got ${r.items[2].id}`,
    );
  });
});
