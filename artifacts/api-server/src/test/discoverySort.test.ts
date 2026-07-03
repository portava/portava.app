/**
 * Tests for GET /api/discovery sort behaviour and the patchOsmSavedCount
 * in-memory cache update that keeps the popular sort current between
 * full Overpass fetches.
 *
 * Uses _setTestDbPlacesOverride to inject seeded rows in-process,
 * bypassing Supabase and OSM entirely. External Overpass/Nominatim
 * requests are blocked at the fetch level so tests run offline.
 *
 * Suites:
 *  1. sortBy=rating  — rated places before null, descending order
 *  2. sortBy=popular — higher savedCount ranks above lower savedCount,
 *                      savedCount wins over rating as the primary signal
 *  3. patchOsmSavedCount — cache entry is mutated to the incremented /
 *                          decremented count immediately after
 *                          trackOsmPlaceSave / trackOsmPlaceUnsave
 *
 * Run: node --import tsx/esm --test src/test/discoverySort.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { trackOsmPlaceSave, trackOsmPlaceUnsave } from "../routes/wishlist.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";

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

// ── Shared helpers ─────────────────────────────────────────────────────────────

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

function placeWithCount(overrides: {
  id: string;
  name: string;
  savedCount: number;
  rating?: number | null;
}): DiscoveryPlace {
  return {
    id:           `db/${overrides.id}`,
    name:         overrides.name,
    category:     "for_you",
    type:         "traveler_pick",
    description:  "A popular spot",
    distanceKm:   1.0,
    lat:          25.77,
    lng:          -80.19,
    tags:         [],
    address:      "Miami, FL",
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       overrides.rating ?? null,
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

// ── Fake DB client for cache-patch tests ───────────────────────────────────────

/**
 * Minimal fake service client used by trackOsmPlaceSave / trackOsmPlaceUnsave.
 * Drives only the tables those two functions touch: discovery_places,
 * discovery_place_saves, and wishlist_places.
 */
function makeCacheFakeClient(opts: {
  initialSavedCount: number;
  hasPriorSave: boolean;
}) {
  const DP_UUID = "dp-uuid-cache-patch";
  const dp: Record<string, unknown>[]  = [{ id: DP_UUID, osm_id: "node/111999", saved_count: opts.initialSavedCount }];
  const dps: Record<string, unknown>[] = opts.hasPriorSave
    ? [{ user_id: "user-cache-patch", place_id: DP_UUID }]
    : [];
  const wl: Record<string, unknown>[]  = [];

  function chain(rows: Record<string, unknown>[]) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let _op: string | null   = null;
    let _data: Record<string, unknown> | null = null;
    let _upsertOpts: Record<string, unknown>  = {};

    const obj: any = {
      select()                      { _op = "select"; return obj; },
      upsert(d: Record<string, unknown>, o?: Record<string, unknown>) {
        _op = "upsert"; _data = d; _upsertOpts = o ?? {}; return obj;
      },
      update(d: Record<string, unknown>) { _op = "update"; _data = d; return obj; },
      delete()                      { _op = "delete"; return obj; },
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return obj; },
      gt()                          { return obj; },
      order()                       { return obj; },
      limit()                       { return obj; },
      maybeSingle() {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown) {
        if (_op === "upsert" && _data) {
          const conflict = ((_upsertOpts["onConflict"] as string) ?? "id")
            .split(",").map((s) => s.trim());
          const idx = rows.findIndex((r) => conflict.every((c) => r[c] === _data![c]));
          if (idx >= 0) {
            if (!_upsertOpts["ignoreDuplicates"]) Object.assign(rows[idx], _data);
          } else {
            rows.push({ id: DP_UUID, ..._data });
          }
          return resolve({ data: null, error: null });
        }
        if (_op === "update" && _data) {
          rows.filter((r) => filters.every((f) => f(r))).forEach((r) => Object.assign(r, _data));
          return resolve({ data: null, error: null });
        }
        if (_op === "delete") {
          const toRemove = new Set(rows.filter((r) => filters.every((f) => f(r))));
          rows.splice(0, rows.length, ...rows.filter((r) => !toRemove.has(r)));
          return resolve({ data: null, error: null });
        }
        return resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
      },
    };
    return obj;
  }

  return {
    from(table: string) {
      if (table === "discovery_places")      return chain(dp);
      if (table === "discovery_place_saves") return chain(dps);
      if (table === "wishlist_places")       return chain(wl);
      return chain([]);
    },
    auth: {
      getUser: (_: string) =>
        Promise.resolve({ data: { user: { id: "user-cache-patch" } }, error: null }),
    },
  };
}

// ── Test data ─────────────────────────────────────────────────────────────────

const HIGH_RATED  = place({ id: "a", name: "High Rated Spot",   rating: 4.8 });
const LOW_RATED   = place({ id: "b", name: "Low Rated Spot",    rating: 3.1 });
const UNRATED     = place({ id: "c", name: "Unrated Spot",      rating: null });

// ── Suite 1: sortBy=rating ────────────────────────────────────────────────────

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
    _setTestDbPlacesOverride(async () => [UNRATED, LOW_RATED, HIGH_RATED]);
  });

  afterEach(() => {
    _setTestDbPlacesOverride(null);
  });

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

  it("omitting sortBy preserves the original insertion order", async () => {
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

    const bestSortedIdx  = sortedNames.indexOf(BEST.name);
    const worstSortedIdx = sortedNames.indexOf(WORST.name);
    assert.ok(bestSortedIdx < worstSortedIdx,
      `sortBy=rating: best (idx ${bestSortedIdx}) must rank above worst (idx ${worstSortedIdx})`);

    const worstUnsortedIdx = unsortedNames.indexOf(WORST.name);
    const bestUnsortedIdx  = unsortedNames.indexOf(BEST.name);
    assert.ok(worstUnsortedIdx < bestUnsortedIdx,
      `default sort: insertion order kept — worst (idx ${worstUnsortedIdx}) before best (idx ${bestUnsortedIdx})`);

    assert.notDeepEqual(sortedNames, unsortedNames,
      "sortBy=rating must produce a different ordering than the default");
  });
});

// ── Suite 2: sortBy=popular ───────────────────────────────────────────────────

describe("GET /discovery?sortBy=popular", () => {
  let server: ReturnType<typeof createServer>;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = createServer(makeApp());
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  after(() => new Promise<void>((done) => server.close(() => done())));

  afterEach(() => {
    _setTestDbPlacesOverride(null);
  });

  it("place with higher savedCount ranks above place with lower savedCount", async () => {
    const HIGH = placeWithCount({ id: "pop-h1", name: "Popular Spot", savedCount: 20, rating: 3.5 });
    const LOW  = placeWithCount({ id: "pop-l1", name: "Quiet Spot",   savedCount: 2,  rating: 4.5 });
    // Seed in reverse order (low-count first) so the default order is wrong —
    // sortBy=popular must reorder by savedCount, not insertion order.
    _setTestDbPlacesOverride(async () => [LOW, HIGH]);

    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=popular");
    assert.equal(r.status, 200, "should return 200");
    const places: any[] = r.body.places;

    const highIdx = places.findIndex((p: any) => p.name === HIGH.name);
    const lowIdx  = places.findIndex((p: any) => p.name === LOW.name);

    assert.ok(highIdx !== -1 && lowIdx !== -1, "both seeded places must appear");
    assert.ok(
      highIdx < lowIdx,
      `savedCount=${HIGH.savedCount} place (idx ${highIdx}) must rank above savedCount=${LOW.savedCount} place (idx ${lowIdx})`,
    );
  });

  it("savedCount takes priority over rating in the popular sort", async () => {
    // VIRAL has high savedCount but a low rating.
    // CRITIC has a perfect rating but only one save.
    // The popular sort must use savedCount as the primary signal.
    const VIRAL  = placeWithCount({ id: "pop-v1", name: "Viral Spot",  savedCount: 50, rating: 3.0 });
    const CRITIC = placeWithCount({ id: "pop-c1", name: "Critic Pick", savedCount: 1,  rating: 5.0 });
    _setTestDbPlacesOverride(async () => [CRITIC, VIRAL]);

    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=popular");
    assert.equal(r.status, 200);
    const places: any[] = r.body.places;

    const viralIdx  = places.findIndex((p: any) => p.name === VIRAL.name);
    const criticIdx = places.findIndex((p: any) => p.name === CRITIC.name);

    assert.ok(viralIdx !== -1 && criticIdx !== -1, "both places must appear");
    assert.ok(
      viralIdx < criticIdx,
      `savedCount=${VIRAL.savedCount} place (idx ${viralIdx}) must rank above 5-star savedCount=${CRITIC.savedCount} place (idx ${criticIdx})`,
    );
  });

  it("places with equal savedCount fall back to rating as a tiebreaker", async () => {
    const WELL_RATED = placeWithCount({ id: "pop-t1", name: "Tied Well Rated", savedCount: 5, rating: 4.8 });
    const POOR_RATED = placeWithCount({ id: "pop-t2", name: "Tied Poor Rated", savedCount: 5, rating: 2.0 });
    _setTestDbPlacesOverride(async () => [POOR_RATED, WELL_RATED]);

    const r = await get(server, "/discovery?destination=Miami&lat=25.77&lng=-80.19&sortBy=popular");
    assert.equal(r.status, 200);
    const places: any[] = r.body.places;

    const wellIdx = places.findIndex((p: any) => p.name === WELL_RATED.name);
    const poorIdx = places.findIndex((p: any) => p.name === POOR_RATED.name);

    assert.ok(wellIdx !== -1 && poorIdx !== -1, "both tied places must appear");
    assert.ok(
      wellIdx < poorIdx,
      `when savedCount is equal, higher-rated place (idx ${wellIdx}) must appear above lower-rated (idx ${poorIdx})`,
    );
  });

  it("OSM cached place with higher savedCount ranks above DB place with lower savedCount when merged", async () => {
    // This test exercises the production merge path:
    // OSM results come from the in-memory cache (simulating a warmed cache);
    // DB results come from _setTestDbPlacesOverride (simulating a DB query).
    // The popular sort must order by savedCount across BOTH sources.
    const OSM_PLACE_NAME = "OSM High Save Spot";
    const DB_PLACE_NAME  = "DB Low Save Spot";

    const osmPlace: DiscoveryPlace = {
      id:           "node/merge-osm-1",  // OSM-style ID, not db/... prefix
      name:         OSM_PLACE_NAME,
      category:     "for_you",
      type:         "traveler_pick",
      description:  "A popular OSM venue",
      distanceKm:   1.2,
      lat:          25.80,
      lng:          -80.20,
      tags:         [],
      address:      "Miami, FL",
      website:      null,
      phone:        null,
      openingHours: null,
      rating:       3.5,
      isOpenNow:    null,
      savedCount:   15,   // high — should rank first
    };

    const dbPlace: DiscoveryPlace = placeWithCount({
      id:        "merge-db-1",
      name:      DB_PLACE_NAME,
      savedCount: 3,      // low — should rank second
      rating:    4.9,     // rating is higher but savedCount wins
    });

    // Inject a fresh OSM cache entry for the destination used in the request.
    // Cache key: "${destination.toLowerCase()}:${category}:${radiusKm}"
    // Request uses destination=MergeCity, category=for_you (default), radiusKm=10
    const cacheKey = "mergecity:for_you:10";
    _injectTestCacheEntry(cacheKey, [osmPlace]);
    _setTestDbPlacesOverride(async () => [dbPlace]);

    const r = await get(
      server,
      "/discovery?destination=MergeCity&lat=25.77&lng=-80.19&sortBy=popular&radiusKm=10",
    );
    assert.equal(r.status, 200, "should return 200");
    const places: any[] = r.body.places;

    const osmIdx = places.findIndex((p: any) => p.name === OSM_PLACE_NAME);
    const dbIdx  = places.findIndex((p: any) => p.name === DB_PLACE_NAME);

    assert.ok(osmIdx !== -1, "OSM cached place must appear in merged results");
    assert.ok(dbIdx  !== -1, "DB place must appear in merged results");
    assert.ok(
      osmIdx < dbIdx,
      `OSM place with savedCount=15 (idx ${osmIdx}) must rank above DB place with savedCount=3 (idx ${dbIdx}) in the popular sort`,
    );

    _clearTestCacheEntry(cacheKey);
  });
});

// ── Suite 3: patchOsmSavedCount — in-memory cache update ─────────────────────

describe("patchOsmSavedCount — in-memory cache update after wishlist changes", () => {
  const OSM_ID    = "node/111999";
  const CACHE_KEY = "testpatch:for_you:10";
  const USER_ID   = "user-cache-patch";
  const PLACE_DATA = { name: "Patched Place", category: "for_you" };

  function makeCachePlace(savedCount: number): DiscoveryPlace {
    return {
      id:           OSM_ID,
      name:         "Patched Place",
      category:     "for_you",
      type:         "traveler_pick",
      description:  "",
      distanceKm:   1.0,
      lat:          10.0,
      lng:          10.0,
      tags:         [],
      address:      null,
      website:      null,
      phone:        null,
      openingHours: null,
      rating:       4.0,
      isOpenNow:    null,
      savedCount,
    };
  }

  afterEach(() => {
    _clearTestClient();
    _clearTestCacheEntry(CACHE_KEY);
  });

  it("trackOsmPlaceSave patches the cache entry to saved_count + 1", async () => {
    const fake = makeCacheFakeClient({ initialSavedCount: 5, hasPriorSave: false });
    _setTestClient(fake, true);

    // Inject a live cache entry; patchOsmSavedCount will mutate the object
    // in-place so we can observe the change on the same reference.
    const cachePlace = makeCachePlace(5);
    _injectTestCacheEntry(CACHE_KEY, [cachePlace]);

    await trackOsmPlaceSave(USER_ID, OSM_ID, PLACE_DATA);

    assert.equal(
      cachePlace.savedCount,
      6,
      "patchOsmSavedCount must update the cached place's savedCount from 5 → 6",
    );
  });

  it("trackOsmPlaceUnsave patches the cache entry to saved_count - 1", async () => {
    const fake = makeCacheFakeClient({ initialSavedCount: 5, hasPriorSave: true });
    _setTestClient(fake, true);

    const cachePlace = makeCachePlace(5);
    _injectTestCacheEntry(CACHE_KEY, [cachePlace]);

    await trackOsmPlaceUnsave(USER_ID, OSM_ID);

    assert.equal(
      cachePlace.savedCount,
      4,
      "patchOsmSavedCount must update the cached place's savedCount from 5 → 4",
    );
  });
});
