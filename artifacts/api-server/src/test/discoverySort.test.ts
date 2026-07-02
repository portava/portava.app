/**
 * Tests for GET /api/discovery?sortBy=rating
 *
 * Uses _setTestDbPlacesOverride to inject seeded rows in-process,
 * bypassing Supabase and OSM entirely. External Overpass/Nominatim
 * requests are blocked at the fetch level so tests run offline.
 *
 * Tests cover:
 *  - sortBy=rating returns rated places before null-rating places
 *  - sortBy=rating preserves descending order among rated places
 *  - omitting sortBy returns the original (insertion) order — no side-effects
 *
 * Run: node --import tsx/esm --test src/test/discoverySort.test.ts
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

function place(overrides: {
  id: string;
  name: string;
  rating?: number | null;
  category?: string;
}) {
  return {
    id:           `db/${overrides.id}`,
    name:         overrides.name,
    category:     overrides.category ?? "for_you",
    type:         "traveler_pick",
    description:  "A nice spot",
    distanceKm:   1.0,
    lat:          25.77,
    lng:          -80.19,
    tags:         [],
    address:      "Miami, FL",
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       overrides.rating !== undefined ? overrides.rating : null,
    isOpenNow:    null,
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

// ── Test data ─────────────────────────────────────────────────────────────────

// Three places: two rated, one with no rating
const HIGH_RATED  = place({ id: "a", name: "High Rated Spot",   rating: 4.8 });
const LOW_RATED   = place({ id: "b", name: "Low Rated Spot",    rating: 3.1 });
const UNRATED     = place({ id: "c", name: "Unrated Spot",      rating: null });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /discovery?sortBy=rating", () => {
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
    // Seed: unrated first, then low-rated, then high-rated (worst natural order)
    _setTestDbPlacesOverride(async () => [UNRATED, LOW_RATED, HIGH_RATED]);
  });

  afterEach(() => {
    _setTestDbPlacesOverride(null);
  });

  // ── sortBy=rating ──────────────────────────────────────────────────────────

  it("places with a rating appear before null-rating places when sortBy=rating", async () => {
    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating");
    assert.equal(r.status, 200, "should return 200");
    const places: any[] = r.body.places;
    assert.ok(places.length >= 3, "all three seeded places should be present");

    const unratedIdx  = places.findIndex((p: any) => p.name === UNRATED.name);
    const highRatedIdx = places.findIndex((p: any) => p.name === HIGH_RATED.name);
    const lowRatedIdx  = places.findIndex((p: any) => p.name === LOW_RATED.name);

    assert.ok(unratedIdx !== -1,   "unrated place must appear in results");
    assert.ok(highRatedIdx !== -1, "high-rated place must appear in results");
    assert.ok(lowRatedIdx !== -1,  "low-rated place must appear in results");

    assert.ok(
      highRatedIdx < unratedIdx,
      `rated place (idx ${highRatedIdx}) must appear before null-rating place (idx ${unratedIdx})`,
    );
    assert.ok(
      lowRatedIdx < unratedIdx,
      `rated place (idx ${lowRatedIdx}) must appear before null-rating place (idx ${unratedIdx})`,
    );
  });

  it("higher-rated places rank above lower-rated places when sortBy=rating", async () => {
    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating");
    assert.equal(r.status, 200);
    const places: any[] = r.body.places;

    const highRatedIdx = places.findIndex((p: any) => p.name === HIGH_RATED.name);
    const lowRatedIdx  = places.findIndex((p: any) => p.name === LOW_RATED.name);

    assert.ok(highRatedIdx !== -1 && lowRatedIdx !== -1, "both rated places must appear");
    assert.ok(
      highRatedIdx < lowRatedIdx,
      `higher-rated (idx ${highRatedIdx}) must rank above lower-rated (idx ${lowRatedIdx})`,
    );
  });

  // ── No sortBy — original order preserved ──────────────────────────────────

  it("omitting sortBy preserves the original insertion order", async () => {
    // Seed a deterministic named order
    const ALPHA = place({ id: "x1", name: "Alpha Place",   rating: 2.0 });
    const BETA  = place({ id: "x2", name: "Beta Place",    rating: 4.5 });
    const GAMMA = place({ id: "x3", name: "Gamma Place",   rating: null });
    _setTestDbPlacesOverride(async () => [ALPHA, BETA, GAMMA]);

    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19");
    assert.equal(r.status, 200);
    const names: string[] = (r.body.places as any[]).map((p: any) => p.name);

    const alphaIdx = names.indexOf("Alpha Place");
    const betaIdx  = names.indexOf("Beta Place");
    const gammaIdx = names.indexOf("Gamma Place");

    assert.ok(alphaIdx !== -1 && betaIdx !== -1 && gammaIdx !== -1, "all three places must appear");
    assert.ok(
      alphaIdx < betaIdx && betaIdx < gammaIdx,
      `without sortBy, insertion order must be preserved: alpha(${alphaIdx}) < beta(${betaIdx}) < gamma(${gammaIdx})`,
    );
  });

  it("sortBy=rating response has the same set of places as no sortBy", async () => {
    const withSort    = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating");
    const withoutSort = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19");

    assert.equal(withSort.status, 200);
    assert.equal(withoutSort.status, 200);

    const sortedNames   = (withSort.body.places    as any[]).map((p: any) => p.name).sort();
    const unsortedNames = (withoutSort.body.places as any[]).map((p: any) => p.name).sort();

    assert.deepEqual(
      sortedNames,
      unsortedNames,
      "sortBy=rating must not add or remove places, only reorder them",
    );
  });

  it("sortBy=rating produces a different ranking than the default when ratings differ", async () => {
    // Seed in ascending-rating order (worst first) so default and rated orderings are opposite.
    const WORST  = place({ id: "r1", name: "Worst Rated",  rating: 1.0 });
    const MIDDLE = place({ id: "r2", name: "Middle Rated", rating: 3.0 });
    const BEST   = place({ id: "r3", name: "Best Rated",   rating: 5.0 });

    _setTestDbPlacesOverride(async () => [WORST, MIDDLE, BEST]);
    const withSort = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=rating");
    assert.equal(withSort.status, 200);

    _setTestDbPlacesOverride(async () => [WORST, MIDDLE, BEST]);
    const withoutSort = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19");
    assert.equal(withoutSort.status, 200);

    const sortedNames   = (withSort.body.places    as any[]).map((p: any) => p.name);
    const unsortedNames = (withoutSort.body.places as any[]).map((p: any) => p.name);

    // With sortBy=rating: highest-rated must appear first.
    const bestSortedIdx  = sortedNames.indexOf(BEST.name);
    const worstSortedIdx = sortedNames.indexOf(WORST.name);
    assert.ok(bestSortedIdx < worstSortedIdx,
      `sortBy=rating: best (idx ${bestSortedIdx}) must rank above worst (idx ${worstSortedIdx})`);

    // Without sortBy: insertion order is preserved, so worst (seeded first) must appear first.
    const worstUnsortedIdx = unsortedNames.indexOf(WORST.name);
    const bestUnsortedIdx  = unsortedNames.indexOf(BEST.name);
    assert.ok(worstUnsortedIdx < bestUnsortedIdx,
      `default sort: insertion order kept — worst (idx ${worstUnsortedIdx}) before best (idx ${bestUnsortedIdx})`);

    // The two orderings must differ — the chip does something observable.
    assert.notDeepEqual(sortedNames, unsortedNames,
      "sortBy=rating must produce a different ordering than the default");
  });
});
