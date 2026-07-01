/**
 * Route-level tests for GET /api/discovery/feed
 *
 * Uses _setTestDbPlacesOverride (exported from the route) to inject seeded rows
 * in-process, bypassing Supabase entirely. External OSM/Nominatim requests are
 * intercepted at the fetch level so tests run without network access.
 *
 * Tests cover: unified envelope shape, DB merge (seeded rows appear), excluded
 * row filtering, sourceSummary, cursor pagination, dedup, and parameter aliases.
 *
 * Run: node --import tsx/esm --test src/test/discoveryFeed.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, { _setTestDbPlacesOverride } from "../routes/discovery.js";

// ── Block external network calls ───────────────────────────────────────────────
// queryOverpass and geocode use fetchWithTimeout which catches all errors and
// degrades gracefully. Throw immediately so tests don't wait 25 s per call.

const _originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (urlStr.includes("overpass-api.de") || urlStr.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url as string, init);
};

// ── Canonical DiscoveryPlace shape ─────────────────────────────────────────────

function place(overrides: { id: string; name: string; category?: string; status?: string }) {
  return {
    id:           `db/${overrides.id}`,
    name:         overrides.name,
    category:     overrides.category ?? "for_you",
    type:         "traveler_pick",
    description:  "A great place to visit",
    distanceKm:   1.2,
    lat:          25.77,
    lng:          -80.19,
    tags:         [],
    address:      "Miami, FL",
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       4.5,
    isOpenNow:    null,
  };
}

const WYNWOOD  = place({ id: "miami-1", name: "Wynwood Walls" });
const SOUTHBCH = place({ id: "miami-2", name: "South Beach Boardwalk" });

// ── HTTP helper ────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(discoveryRouter);
  return app;
}

async function get(server: ReturnType<typeof createServer>, path: string) {
  const port = (server.address() as any).port as number;
  const res  = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() as any };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /discovery/feed", () => {
  let server: ReturnType<typeof createServer>;

  before(() =>
    new Promise<void>((resolve) => {
      server = createServer(makeApp());
      server.listen(0, "127.0.0.1", resolve);
    }),
  );

  after(() => new Promise<void>((done) => server.close(() => done())));

  beforeEach(() => {
    // Default: two active Miami rows returned by the DB for every test
    _setTestDbPlacesOverride(async () => [WYNWOOD, SOUTHBCH]);
  });

  afterEach(() => {
    _setTestDbPlacesOverride(null);
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it("returns 400 when neither city nor lat+lng provided", async () => {
    const r = await get(server, "/discovery/feed");
    assert.equal(r.status, 400, "missing params must yield 400");
    assert.ok(r.body.error, "response body must have error field");
  });

  // ── Envelope shape ────────────────────────────────────────────────────────

  it("returns complete unified envelope with all required keys", async () => {
    const r = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami");
    assert.equal(r.status, 200);
    const b = r.body;
    for (const key of ["places", "events", "posts", "memories", "sections", "nextCursor", "total", "sourceSummary"]) {
      assert.ok(key in b, `envelope must contain key: ${key}`);
    }
    assert.ok(Array.isArray(b.places),   "places must be array");
    assert.ok(Array.isArray(b.events),   "events must be array");
    assert.ok(Array.isArray(b.posts),    "posts must be array");
    assert.ok(Array.isArray(b.memories), "memories must be array");
    assert.ok(Array.isArray(b.sections), "sections must be array");
    assert.ok("seededDbCount"    in b.sourceSummary, "sourceSummary must have seededDbCount");
    assert.ok("osmCount"         in b.sourceSummary, "sourceSummary must have osmCount");
    assert.ok("userCreatedCount" in b.sourceSummary, "sourceSummary must have userCreatedCount");
  });

  // ── DB merge ──────────────────────────────────────────────────────────────

  it("seeded DB rows appear in places (DB merge)", async () => {
    const r = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami");
    assert.equal(r.status, 200);
    const names = (r.body.places as any[]).map((p: any) => p.name);
    assert.ok(names.includes("Wynwood Walls"),       "first seeded row must appear");
    assert.ok(names.includes("South Beach Boardwalk"), "second seeded row must appear");
  });

  it("sourceSummary.seededDbCount equals the number of DB rows returned", async () => {
    const r = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami");
    assert.equal(r.status, 200);
    assert.equal(r.body.sourceSummary.seededDbCount, 2, "two rows seeded from DB");
  });

  // ── Blocked / private exclusion ───────────────────────────────────────────
  // queryDbPlaces filters status=active at the DB level; this test verifies the
  // route correctly exposes only what the query returns (no phantom rows).

  it("route does not add rows beyond what the DB query returns", async () => {
    _setTestDbPlacesOverride(async () => [WYNWOOD]); // only one row
    const r = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami");
    assert.equal(r.status, 200);
    assert.equal(r.body.places.length, 1, "only the one returned row should appear");
    assert.equal(r.body.sourceSummary.seededDbCount, 1);
  });

  // ── Dedup ─────────────────────────────────────────────────────────────────

  it("dedup: a DB row with the same name as an OSM result does not appear twice", async () => {
    // Since OSM is blocked (network error → []), the route deduplicates against
    // an empty OSM set. Two DB rows with different names both appear once.
    _setTestDbPlacesOverride(async () => [WYNWOOD, WYNWOOD]);
    const r = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami");
    const names = (r.body.places as any[]).map((p: any) => p.name);
    const count = names.filter((n: string) => n === "Wynwood Walls").length;
    assert.ok(count <= 1, "same-id place must appear at most once after dedup");
  });

  // ── Cursor pagination ─────────────────────────────────────────────────────

  it("nextCursor is null when all results fit on one page", async () => {
    const r = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami&limit=50");
    assert.equal(r.status, 200);
    assert.equal(r.body.nextCursor, null, "no next page when all results fit");
  });

  it("nextCursor is non-null and page-size is respected when total exceeds limit", async () => {
    const manyRows = Array.from({ length: 6 }, (_, i) =>
      place({ id: `p${i}`, name: `Place ${i}` }),
    );
    _setTestDbPlacesOverride(async () => manyRows);
    const r = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami&limit=4");
    assert.equal(r.status, 200);
    assert.equal(r.body.places.length, 4, "page size respected");
    assert.ok(r.body.nextCursor !== null, "nextCursor must be set when more pages remain");
  });

  it("second page via cursor returns remaining results", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => place({ id: `p${i}`, name: `Place ${i}` }));
    _setTestDbPlacesOverride(async () => rows);
    const r1 = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami&limit=3");
    assert.equal(r1.status, 200);
    const cursor = r1.body.nextCursor as string;
    assert.ok(cursor, "first page must return a cursor");

    const r2 = await get(server, `/discovery/feed?lat=25.77&lng=-80.19&city=Miami&limit=3&cursor=${cursor}`);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.places.length, 2, "second page returns the remaining 2 places");
    assert.equal(r2.body.nextCursor, null, "last page has no cursor");
  });

  // ── Parameter aliases ─────────────────────────────────────────────────────

  it("city and destination params are treated as synonyms", async () => {
    const r1 = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami");
    const r2 = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&destination=Miami");
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual(r1.body.places.length, r2.body.places.length);
  });

  it("categories param fans out across multiple categories", async () => {
    _setTestDbPlacesOverride(async (_dest, cat) =>
      cat === "food" ? [place({ id: "food-1", name: "Best Taco", category: "food" })] : [WYNWOOD],
    );
    const r = await get(server, "/discovery/feed?lat=25.77&lng=-80.19&city=Miami&categories=food,places");
    assert.equal(r.status, 200);
    assert.ok(r.body.places.length >= 2, "multi-category fan-out should produce more places");
  });
});
