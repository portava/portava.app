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

// Rows for testing numeric rating values
const RATING_HIGH = { ...BASE_ROW, id: "place-rating-high", name: "Rating High", rating: 4.5, created_at: "2025-01-01T00:00:00.000Z" };
const RATING_MID  = { ...BASE_ROW, id: "place-rating-mid",  name: "Rating Mid",  rating: 3.0, created_at: "2025-02-01T00:00:00.000Z" };
const RATING_LOW  = { ...BASE_ROW, id: "place-rating-low",  name: "Rating Low",  rating: 1.2, created_at: "2025-03-01T00:00:00.000Z" };

// Rows for testing mixed NULL + numeric rating (nullsFirst: false → NULLs appear after numeric values)
const RATING_MIX_NUM  = { ...BASE_ROW, id: "place-mix-num",  name: "Mix Numeric", rating: 4.5, created_at: "2025-06-01T00:00:00.000Z" };
const RATING_MIX_NULL = { ...BASE_ROW, id: "place-mix-null", name: "Mix Null",    rating: null, created_at: "2025-07-01T00:00:00.000Z" };

// ── Fake client (tracks .order() and applies real sorting) ─────────────────────

function makeFakeClient(allRows: Record<string, unknown>[]) {
  function chain(table: string) {
    const eqFilters: Array<{ col: string; val: unknown }> = [];
    // Tracks multiple sort keys in declaration order (first = highest priority).
    const orderKeys: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];

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
      order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
        const asc = opts?.ascending ?? true;
        orderKeys.push({ col, asc, nullsFirst: opts?.nullsFirst ?? asc });
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
            for (const { col, asc, nullsFirst } of orderKeys) {
              const av = a[col] as number | null ?? null;
              const bv = b[col] as number | null ?? null;
              if (av === null && bv === null) continue;
              if (av === null) return nullsFirst ? -1 : 1;
              if (bv === null) return nullsFirst ? 1 : -1;
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

// ── Tests — sortBy=rating with real numeric values ─────────────────────────────

describe("GET /api/discovery/community — sortBy=rating with numeric values sorts highest-rated first", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    // Seed in low→high order so we confirm the sort is applied (not just seed order preserved)
    _setTestClient(makeFakeClient([RATING_LOW, RATING_MID, RATING_HIGH]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200 for sortBy=rating with numeric values", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("returns all three places", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.total, 3, `expected total=3, got ${r.total}`);
    assert.equal(r.items.length, 3, `expected 3 items, got ${r.items.length}`);
  });

  it("first item has the highest rating (4.5)", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.ok(r.items.length > 0, "expected at least one item");
    assert.equal(
      r.items[0].id,
      RATING_HIGH.id,
      `expected ${RATING_HIGH.id} first (rating=4.5), got ${r.items[0].id} (rating=${r.items[0].rating})`,
    );
    assert.equal(r.items[0].rating, 4.5, `expected first item rating=4.5, got ${r.items[0].rating}`);
  });

  it("last item has the lowest rating (1.2)", async () => {
    const r = await getItems(url, "sortBy=rating");
    const last = r.items[r.items.length - 1];
    assert.equal(
      last.id,
      RATING_LOW.id,
      `expected ${RATING_LOW.id} last (rating=1.2), got ${last.id} (rating=${last.rating})`,
    );
    assert.equal(last.rating, 1.2, `expected last item rating=1.2, got ${last.rating}`);
  });

  it("items are in non-ascending rating order", async () => {
    const r = await getItems(url, "sortBy=rating");
    for (let i = 0; i < r.items.length - 1; i++) {
      const curr = r.items[i].rating as number;
      const next = r.items[i + 1].rating as number;
      assert.ok(
        curr >= next,
        `order violated at index ${i}: rating=${curr} < ${next}`,
      );
    }
  });

  it("middle item has rating=3.0", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.items.length, 3, "expected 3 items");
    assert.equal(
      r.items[1].id,
      RATING_MID.id,
      `expected ${RATING_MID.id} in the middle (rating=3.0), got ${r.items[1].id}`,
    );
    assert.equal(r.items[1].rating, 3.0, `expected middle item rating=3.0, got ${r.items[1].rating}`);
  });
});

// ── Tests — sortBy=rating with mixed NULL + numeric (nullsFirst: false) ─────────

describe("GET /api/discovery/community — sortBy=rating mixed NULL + numeric puts NULLs last", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    // RATING_MIX_NULL has a newer created_at (2025-07-01) but rating=null;
    // RATING_MIX_NUM has rating=4.5. The numeric row must still appear first
    // because nullsFirst: false pushes NULLs to the end regardless of created_at.
    _setTestClient(makeFakeClient([RATING_MIX_NULL, RATING_MIX_NUM]), true);
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns HTTP 200 for sortBy=rating with mixed NULL and numeric ratings", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("returns both places", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.total, 2, `expected total=2, got ${r.total}`);
    assert.equal(r.items.length, 2, `expected 2 items, got ${r.items.length}`);
  });

  it("numeric-rated place appears before the NULL-rated place", async () => {
    const r = await getItems(url, "sortBy=rating");
    assert.equal(r.items.length, 2, "expected 2 items");
    assert.equal(
      r.items[0].id,
      RATING_MIX_NUM.id,
      `expected numeric-rated place (${RATING_MIX_NUM.id}, rating=4.5) first, got ${r.items[0].id} (rating=${r.items[0].rating})`,
    );
  });

  it("NULL-rated place appears last (nullsFirst: false)", async () => {
    const r = await getItems(url, "sortBy=rating");
    const last = r.items[r.items.length - 1];
    assert.equal(
      last.id,
      RATING_MIX_NULL.id,
      `expected null-rated place (${RATING_MIX_NULL.id}) last, got ${last.id} (rating=${last.rating})`,
    );
    assert.equal(
      last.rating,
      null,
      `expected last item rating=null, got ${JSON.stringify(last.rating)}`,
    );
  });

  it("NULL-rated place is last even though its created_at is newer", async () => {
    // RATING_MIX_NULL has created_at=2025-07-01, RATING_MIX_NUM has 2025-06-01.
    // Without nullsFirst:false enforcement, the NULL row could incorrectly float
    // to the top via the created_at tie-breaker. The numeric row must still win.
    const r = await getItems(url, "sortBy=rating");
    const numericPos  = r.items.findIndex((i) => i.id === RATING_MIX_NUM.id);
    const nullRatedPos = r.items.findIndex((i) => i.id === RATING_MIX_NULL.id);
    assert.ok(numericPos !== -1, "numeric-rated place not found in results");
    assert.ok(nullRatedPos !== -1, "null-rated place not found in results");
    assert.ok(
      numericPos < nullRatedPos,
      `numeric-rated place (pos=${numericPos}) must rank before null-rated place (pos=${nullRatedPos}), even though null place has a newer created_at`,
    );
  });
});
