/**
 * Tests for applyFilters() in discovery.ts — sortBy=popular vs sortBy=rating divergence
 *
 * Exercises both sort paths with a mixed (OSM + community) dataset to confirm:
 *  - sortBy=popular ranks community places with savedCount > 0 above OSM-only places
 *  - sortBy=popular uses rating as tie-breaker when savedCounts are equal (OSM vs OSM)
 *  - sortBy=rating ranks purely by rating — a high-rated OSM place beats a
 *    lower-rated community place even when the community place has many saves
 *  - The two chips produce meaningfully different orderings on the same dataset
 *
 * Uses _setTestDbPlacesOverride to inject seeded rows in-process, bypassing
 * Supabase and OSM entirely.  External Overpass/Nominatim requests are blocked
 * at the fetch level so tests run offline.
 *
 * Run: node --import tsx/esm --test src/test/discoveryPopularVsRating.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, { _setTestDbPlacesOverride } from "../routes/discovery.js";

// ── Block external network calls ───────────────────────────────────────────────

const _originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (
    urlStr.includes("overpass-api.de") ||
    urlStr.includes("nominatim.openstreetmap.org")
  ) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url as string, init);
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function osmPlace(overrides: {
  id: string;
  name: string;
  rating?: number | null;
}) {
  return {
    id:           `osm/${overrides.id}`,
    name:         overrides.name,
    category:     "for_you",
    type:         "osm",
    description:  "An OSM venue",
    distanceKm:   1.0,
    lat:          25.77,
    lng:          -80.19,
    tags:         [] as string[],
    address:      "Miami, FL",
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       overrides.rating !== undefined ? overrides.rating : null,
    isOpenNow:    null,
    // No savedCount — OSM places without community enrichment
  };
}

function communityPlace(overrides: {
  id: string;
  name: string;
  rating?: number | null;
  savedCount: number;
}) {
  return {
    id:           `db/${overrides.id}`,
    name:         overrides.name,
    category:     "for_you",
    type:         "traveler_pick",
    description:  "A community pick",
    distanceKm:   1.0,
    lat:          25.77,
    lng:          -80.19,
    tags:         [] as string[],
    address:      "Miami, FL",
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       overrides.rating !== undefined ? overrides.rating : null,
    isOpenNow:    null,
    savedCount:   overrides.savedCount,
  };
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = pino({ level: "silent" });
    next();
  });
  app.use(discoveryRouter);
  return app;
}

async function get(server: ReturnType<typeof createServer>, path: string) {
  const port = (server.address() as any).port as number;
  const res  = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

// ── Mixed dataset ──────────────────────────────────────────────────────────────
//
// COMMUNITY_SAVES  — traveler_pick, savedCount=50, rating=3.5
//   → popular: ranks #1 (highest saves)
//   → rating:  ranks #2 (rating behind OSM_HIGH_RATED)
//
// OSM_HIGH_RATED   — osm, no savedCount, rating=4.8
//   → popular: ranks #2 (savedCount=0, highest rating tie-breaker)
//   → rating:  ranks #1 (highest rating)
//
// OSM_LOW_RATED    — osm, no savedCount, rating=2.1
//   → popular: ranks #3 (savedCount=0, lowest rating tie-breaker)
//   → rating:  ranks #3 (lowest rating)
//
// The two chips produce opposite orderings for the top two positions.

const COMMUNITY_SAVES = communityPlace({ id: "c1", name: "Community Saved Spot", rating: 3.5, savedCount: 50 });
const OSM_HIGH_RATED  = osmPlace({ id: "o1", name: "OSM High Rated Spot",   rating: 4.8 });
const OSM_LOW_RATED   = osmPlace({ id: "o2", name: "OSM Low Rated Spot",    rating: 2.1 });

// ── Tests — sortBy=popular ─────────────────────────────────────────────────────

describe("applyFilters() — sortBy=popular with mixed OSM + community dataset", () => {
  let server: ReturnType<typeof createServer>;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = createServer(makeApp());
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  after(() => new Promise<void>((done) => server.close(() => done())));

  beforeEach(() => {
    // Seed in unfavourable order so sort must do real work
    _setTestDbPlacesOverride(async () => [OSM_LOW_RATED, OSM_HIGH_RATED, COMMUNITY_SAVES]);
  });

  afterEach(() => {
    _setTestDbPlacesOverride(null);
  });

  it("returns HTTP 200 for sortBy=popular", async () => {
    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=popular");
    assert.equal(r.status, 200, "should return 200");
  });

  it("community place with savedCount > 0 ranks above all OSM places (savedCount=0)", async () => {
    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=popular");
    assert.equal(r.status, 200);
    const places: any[] = r.body.places;

    const communityIdx  = places.findIndex((p: any) => p.name === COMMUNITY_SAVES.name);
    const osmHighIdx    = places.findIndex((p: any) => p.name === OSM_HIGH_RATED.name);
    const osmLowIdx     = places.findIndex((p: any) => p.name === OSM_LOW_RATED.name);

    assert.ok(communityIdx !== -1, "community place must appear in results");
    assert.ok(osmHighIdx   !== -1, "OSM high-rated place must appear in results");
    assert.ok(osmLowIdx    !== -1, "OSM low-rated place must appear in results");

    assert.ok(
      communityIdx < osmHighIdx,
      `community (savedCount=50, idx ${communityIdx}) must rank above OSM high-rated (savedCount=0, idx ${osmHighIdx})`,
    );
    assert.ok(
      communityIdx < osmLowIdx,
      `community (savedCount=50, idx ${communityIdx}) must rank above OSM low-rated (savedCount=0, idx ${osmLowIdx})`,
    );
  });

  it("among OSM places with equal savedCount, higher-rated ranks first (tie-breaker)", async () => {
    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=popular");
    assert.equal(r.status, 200);
    const places: any[] = r.body.places;

    const osmHighIdx = places.findIndex((p: any) => p.name === OSM_HIGH_RATED.name);
    const osmLowIdx  = places.findIndex((p: any) => p.name === OSM_LOW_RATED.name);

    assert.ok(osmHighIdx !== -1 && osmLowIdx !== -1, "both OSM places must appear");
    assert.ok(
      osmHighIdx < osmLowIdx,
      `higher-rated OSM (rating=4.8, idx ${osmHighIdx}) must rank above lower-rated OSM (rating=2.1, idx ${osmLowIdx}) as tie-breaker`,
    );
  });
});

// ── Tests — sortBy=rating ──────────────────────────────────────────────────────

describe("applyFilters() — sortBy=rating with mixed OSM + community dataset", () => {
  let server: ReturnType<typeof createServer>;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = createServer(makeApp());
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  after(() => new Promise<void>((done) => server.close(() => done())));

  beforeEach(() => {
    _setTestDbPlacesOverride(async () => [OSM_LOW_RATED, OSM_HIGH_RATED, COMMUNITY_SAVES]);
  });

  afterEach(() => {
    _setTestDbPlacesOverride(null);
  });

  it("returns HTTP 200 for sortBy=rating", async () => {
    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating");
    assert.equal(r.status, 200, "should return 200");
  });

  it("OSM place with higher rating ranks above community place despite community having more saves", async () => {
    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating");
    assert.equal(r.status, 200);
    const places: any[] = r.body.places;

    const communityIdx = places.findIndex((p: any) => p.name === COMMUNITY_SAVES.name);
    const osmHighIdx   = places.findIndex((p: any) => p.name === OSM_HIGH_RATED.name);

    assert.ok(communityIdx !== -1, "community place must appear in results");
    assert.ok(osmHighIdx   !== -1, "OSM high-rated place must appear in results");

    assert.ok(
      osmHighIdx < communityIdx,
      `OSM high-rated (rating=4.8, idx ${osmHighIdx}) must rank above community (rating=3.5, savedCount=50, idx ${communityIdx}) when sortBy=rating`,
    );
  });

  it("places are in descending rating order", async () => {
    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating");
    assert.equal(r.status, 200);
    const places: any[] = r.body.places;

    const osmHighIdx   = places.findIndex((p: any) => p.name === OSM_HIGH_RATED.name);
    const communityIdx = places.findIndex((p: any) => p.name === COMMUNITY_SAVES.name);
    const osmLowIdx    = places.findIndex((p: any) => p.name === OSM_LOW_RATED.name);

    assert.ok(osmHighIdx   !== -1, "OSM high-rated must appear");
    assert.ok(communityIdx !== -1, "community must appear");
    assert.ok(osmLowIdx    !== -1, "OSM low-rated must appear");

    assert.ok(
      osmHighIdx < communityIdx,
      `rating=4.8 (idx ${osmHighIdx}) must rank above rating=3.5 (idx ${communityIdx})`,
    );
    assert.ok(
      communityIdx < osmLowIdx,
      `rating=3.5 (idx ${communityIdx}) must rank above rating=2.1 (idx ${osmLowIdx})`,
    );
  });
});

// ── Tests — divergence between popular and rating ──────────────────────────────

describe("applyFilters() — popular and rating chips produce different orderings", () => {
  let server: ReturnType<typeof createServer>;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = createServer(makeApp());
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  after(() => new Promise<void>((done) => server.close(() => done())));

  beforeEach(() => {
    _setTestDbPlacesOverride(async () => [OSM_LOW_RATED, OSM_HIGH_RATED, COMMUNITY_SAVES]);
  });

  afterEach(() => {
    _setTestDbPlacesOverride(null);
  });

  it("popular and rating produce different rankings on the mixed dataset", async () => {
    const [popularRes, ratingRes] = await Promise.all([
      get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=popular"),
      get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating"),
    ]);

    assert.equal(popularRes.status, 200, "popular should return 200");
    assert.equal(ratingRes.status,  200, "rating should return 200");

    const popularNames = (popularRes.body.places as any[]).map((p: any) => p.name);
    const ratingNames  = (ratingRes.body.places  as any[]).map((p: any) => p.name);

    // Both chips must return the same set of places
    assert.deepEqual(
      [...popularNames].sort(),
      [...ratingNames].sort(),
      "both chips must return the same set of places",
    );

    // But the orderings must differ — the chips must do something meaningfully different
    assert.notDeepEqual(
      popularNames,
      ratingNames,
      "sortBy=popular and sortBy=rating must produce different orderings on a mixed dataset with savedCount data",
    );
  });

  it("top place under popular is different from top place under rating", async () => {
    const [popularRes, ratingRes] = await Promise.all([
      get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=popular"),
      get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating"),
    ]);

    assert.equal(popularRes.status, 200);
    assert.equal(ratingRes.status,  200);

    const popularFirst = (popularRes.body.places as any[])[0]?.name;
    const ratingFirst  = (ratingRes.body.places  as any[])[0]?.name;

    // popular: community place (savedCount=50) is #1
    assert.equal(
      popularFirst,
      COMMUNITY_SAVES.name,
      `popular chip must surface community place (savedCount=50) first, got: ${popularFirst}`,
    );

    // rating: highest-rated OSM place is #1 (rating=4.8 > community rating=3.5)
    assert.equal(
      ratingFirst,
      OSM_HIGH_RATED.name,
      `rating chip must surface highest-rated place first (OSM, rating=4.8), got: ${ratingFirst}`,
    );

    assert.notEqual(
      popularFirst,
      ratingFirst,
      "the #1 result must differ between popular and rating chips",
    );
  });
});
