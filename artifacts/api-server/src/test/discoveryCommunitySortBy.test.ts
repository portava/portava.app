/**
 * Tests for GET /api/discovery/community?sortBy=rating
 *
 * Uses _setTestClient to inject a fake Supabase service client, bypassing the
 * real DB entirely. No network calls are made.
 *
 * Tests cover:
 *  - sortBy=rating returns rated places before null-rating places
 *  - sortBy=rating preserves descending order among rated places
 *  - default (no sortBy) returns created_at DESC order
 *  - missing city param returns 400 invalid_payload
 *
 * Run: node --import tsx/esm --test src/test/discoveryCommunitySortBy.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Fake client ────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

function makeFakeClient(rows: Row[]) {
  function chain(tableRows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    let _orderCol: string | null = null;
    let _orderAsc = true;
    let _orderNullsFirst = true;
    let _limitN: number | null = null;

    const obj: any = {
      select()    { return obj; },
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return obj;
      },
      ilike(col: string, val: any) {
        const pattern = String(val).toLowerCase();
        filters.push((r) => String(r[col] ?? "").toLowerCase() === pattern);
        return obj;
      },
      or()        { return obj; },
      order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
        _orderCol = col;
        _orderAsc = opts?.ascending !== false;
        _orderNullsFirst = opts?.nullsFirst !== false;
        return obj;
      },
      limit(n: number) { _limitN = n; return obj; },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    async function resolve(): Promise<{ data: Row[]; error: null }> {
      let result = tableRows.filter((r) => filters.every((f) => f(r)));

      if (_orderCol) {
        const col = _orderCol;
        const asc = _orderAsc;
        const nullsFirst = _orderNullsFirst;

        result = [...result].sort((a, b) => {
          const av = a[col] ?? null;
          const bv = b[col] ?? null;

          if (av === null && bv === null) return 0;
          if (av === null) return nullsFirst ? -1 : 1;
          if (bv === null) return nullsFirst ? 1 : -1;

          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
          return 0;
        });
      }

      if (_limitN !== null) result = result.slice(0, _limitN);
      return { data: result, error: null };
    }

    return obj;
  }

  return {
    from(table: string) {
      if (table === "discovery_places") return chain(rows);
      return chain([]);
    },
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: "no auth" } }),
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

async function get(url: string, path: string) {
  const res  = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

// ── Seed data ──────────────────────────────────────────────────────────────────

function communityRow(overrides: {
  id: string;
  name: string;
  rating?: number | null;
  created_at?: string;
}) {
  return {
    id:          overrides.id,
    city:        "Bangkok",
    name:        overrides.name,
    place_type:  "hidden_gem",
    category:    "food",
    neighborhood: null,
    blurb:       "A nice spot",
    image_url:   null,
    submitted_by: null,
    profiles:    null,
    saved_count: 0,
    tag:         null,
    note:        null,
    rating:      overrides.rating !== undefined ? overrides.rating : null,
    source:      "traveler",
    status:      "active",
    verified:    false,
    created_at:  overrides.created_at ?? "2025-01-01T00:00:00.000Z",
    lat:         13.75,
    lng:         100.5,
  };
}

const HIGH_RATED = communityRow({ id: "place-a", name: "High Rated Place",   rating: 4.9 });
const MID_RATED  = communityRow({ id: "place-b", name: "Mid Rated Place",    rating: 3.2 });
const UNRATED    = communityRow({ id: "place-c", name: "Unrated Place",      rating: null });

// Three places with distinct created_at values (newest → oldest: NEW, MID, OLD)
const NEW_PLACE  = communityRow({ id: "place-d", name: "Newest Place",  rating: null, created_at: "2025-06-01T00:00:00.000Z" });
const MID_PLACE  = communityRow({ id: "place-e", name: "Middle Place",  rating: null, created_at: "2025-03-01T00:00:00.000Z" });
const OLD_PLACE  = communityRow({ id: "place-f", name: "Oldest Place",  rating: null, created_at: "2025-01-01T00:00:00.000Z" });

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /api/discovery/community — sortBy=rating", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
  });

  afterEach(async () => {
    _setTestClient(null, false);
    await closeServer(server);
  });

  it("returns 400 when city param is missing", async () => {
    _setTestClient(makeFakeClient([]), true);
    const r = await get(url, "/api/discovery/community");
    assert.equal(r.status, 400, "missing city should return 400");
    assert.equal(r.body.error, "invalid_payload");
  });

  it("sortBy=rating — rated places appear before null-rating places", async () => {
    // Seed: unrated first, then mid, then high (worst natural order)
    _setTestClient(makeFakeClient([UNRATED, MID_RATED, HIGH_RATED]), true);

    const r = await get(url, "/api/discovery/community?city=Bangkok&sortBy=rating");
    assert.equal(r.status, 200);

    const items: any[] = r.body.items;
    assert.ok(items.length >= 3, "all three seeded places should be present");

    const unratedIdx   = items.findIndex((p: any) => p.name === UNRATED.name);
    const highRatedIdx = items.findIndex((p: any) => p.name === HIGH_RATED.name);
    const midRatedIdx  = items.findIndex((p: any) => p.name === MID_RATED.name);

    assert.ok(unratedIdx !== -1,   "unrated place must appear");
    assert.ok(highRatedIdx !== -1, "high-rated place must appear");
    assert.ok(midRatedIdx !== -1,  "mid-rated place must appear");

    assert.ok(
      highRatedIdx < unratedIdx,
      `high-rated (idx ${highRatedIdx}) must appear before unrated (idx ${unratedIdx})`,
    );
    assert.ok(
      midRatedIdx < unratedIdx,
      `mid-rated (idx ${midRatedIdx}) must appear before unrated (idx ${unratedIdx})`,
    );
  });

  it("sortBy=rating — higher-rated place ranks above lower-rated place", async () => {
    _setTestClient(makeFakeClient([MID_RATED, HIGH_RATED, UNRATED]), true);

    const r = await get(url, "/api/discovery/community?city=Bangkok&sortBy=rating");
    assert.equal(r.status, 200);

    const items: any[] = r.body.items;
    const highRatedIdx = items.findIndex((p: any) => p.name === HIGH_RATED.name);
    const midRatedIdx  = items.findIndex((p: any) => p.name === MID_RATED.name);

    assert.ok(highRatedIdx !== -1 && midRatedIdx !== -1, "both rated places must appear");
    assert.ok(
      highRatedIdx < midRatedIdx,
      `higher-rated (idx ${highRatedIdx}) must rank above lower-rated (idx ${midRatedIdx})`,
    );
  });

  it("default (no sortBy) — returns places in created_at DESC order", async () => {
    // Seed: old first, then mid, then newest (reverse of expected output)
    _setTestClient(makeFakeClient([OLD_PLACE, MID_PLACE, NEW_PLACE]), true);

    const r = await get(url, "/api/discovery/community?city=Bangkok");
    assert.equal(r.status, 200);

    const items: any[] = r.body.items;
    const newIdx = items.findIndex((p: any) => p.name === NEW_PLACE.name);
    const midIdx = items.findIndex((p: any) => p.name === MID_PLACE.name);
    const oldIdx = items.findIndex((p: any) => p.name === OLD_PLACE.name);

    assert.ok(newIdx !== -1 && midIdx !== -1 && oldIdx !== -1, "all three places must appear");
    assert.ok(
      newIdx < midIdx && midIdx < oldIdx,
      `default sort must be created_at DESC: newest(${newIdx}) < middle(${midIdx}) < oldest(${oldIdx})`,
    );
  });

  it("sortBy=rating does not add or remove items compared to default sort", async () => {
    _setTestClient(makeFakeClient([UNRATED, MID_RATED, HIGH_RATED]), true);
    const withSort    = await get(url, "/api/discovery/community?city=Bangkok&sortBy=rating");

    _setTestClient(makeFakeClient([UNRATED, MID_RATED, HIGH_RATED]), true);
    const withoutSort = await get(url, "/api/discovery/community?city=Bangkok");

    assert.equal(withSort.status, 200);
    assert.equal(withoutSort.status, 200);

    const sortedNames   = (withSort.body.items    as any[]).map((p: any) => p.name).sort();
    const unsortedNames = (withoutSort.body.items as any[]).map((p: any) => p.name).sort();

    assert.deepEqual(
      sortedNames,
      unsortedNames,
      "sortBy=rating must not add or remove places, only reorder them",
    );
  });

  it("sortBy=rating produces a demonstrably different ordering than default (created_at DESC)", async () => {
    // Seed two places where created_at-DESC and rating-DESC orderings are opposite:
    // RECENT_LOW is newer (appears first without sortBy) but has a low rating.
    // OLD_HIGH is older (appears second without sortBy) but has a high rating.
    const RECENT_LOW = communityRow({ id: "rl", name: "Recent Low Rated", rating: 1.0, created_at: "2025-05-01T00:00:00.000Z" });
    const OLD_HIGH   = communityRow({ id: "oh", name: "Old High Rated",   rating: 4.9, created_at: "2025-01-01T00:00:00.000Z" });

    _setTestClient(makeFakeClient([RECENT_LOW, OLD_HIGH]), true);
    const withSort = await get(url, "/api/discovery/community?city=Bangkok&sortBy=rating");
    assert.equal(withSort.status, 200);

    _setTestClient(makeFakeClient([RECENT_LOW, OLD_HIGH]), true);
    const withoutSort = await get(url, "/api/discovery/community?city=Bangkok");
    assert.equal(withoutSort.status, 200);

    const sortedNames   = (withSort.body.items    as any[]).map((p: any) => p.name);
    const unsortedNames = (withoutSort.body.items as any[]).map((p: any) => p.name);

    // sortBy=rating: OLD_HIGH (4.9) must appear before RECENT_LOW (1.0).
    const sortedHighIdx = sortedNames.indexOf(OLD_HIGH.name);
    const sortedLowIdx  = sortedNames.indexOf(RECENT_LOW.name);
    assert.ok(sortedHighIdx < sortedLowIdx,
      `sortBy=rating: high-rated (idx ${sortedHighIdx}) must rank above low-rated (idx ${sortedLowIdx})`);

    // Default (created_at DESC): RECENT_LOW (2025-05) must appear before OLD_HIGH (2025-01).
    const unsortedRecentIdx = unsortedNames.indexOf(RECENT_LOW.name);
    const unsortedOldIdx    = unsortedNames.indexOf(OLD_HIGH.name);
    assert.ok(unsortedRecentIdx < unsortedOldIdx,
      `default sort: more recent (idx ${unsortedRecentIdx}) must appear before older (idx ${unsortedOldIdx})`);

    // The two orderings must differ — the chip changes the result order.
    assert.notDeepEqual(sortedNames, unsortedNames,
      "sortBy=rating must produce a different order than default (created_at) sort");
  });
});
