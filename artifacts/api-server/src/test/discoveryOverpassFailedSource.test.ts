/**
 * census-discovery §94.10 (lane W11-X2, round 2), DV-83 — the OSM half of
 * GET /discovery and GET /discovery/feed can say it failed.
 *
 * `queryOverpass` answered `[]` for a transport failure, a non-OK status (the
 * rate limit this deployment has hit) and an unparseable body, the same `[]` a
 * city with nothing tagged gets. `sendDiscoveryPlacesEnvelope` said so in its
 * own words ("Overpass cannot [report]"). So on every cold serve path the
 * places list lost its whole OSM half to an outage and the envelope named
 * nothing: a consumer cannot branch on a failure it is never sent (§80.1's
 * reasoning for the event posts, here for the places).
 *
 *   O1  Overpass 429: `partial`, failedSources ["overpass"], code
 *       `overpass_unavailable`, class `upstream_unavailable`; the DB rows kept and logged
 *   O2  Overpass unreachable (a throw): the same
 *   O3  Overpass 200 with an unparseable body: the same
 *   O4  all three retrievals failed and nothing served: `nothing`, the combined code, no exposure
 *   O5  the feed's places half names "overpass" beside its categories' failures
 *   O6  a failed Overpass read is never cached: the next healthy request serves OSM rows
 *   O7  GET /discovery/counts: a count over the DB half alone is a different number, so
 *       every category whose Overpass read failed is a failed category (D11's own rule)
 *   C1  CONTROL: Overpass ANSWERING empty is an empty half, not a failure — no refusal
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryOverpassFailedSource.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, { _clearTestCacheEntry, _clearTestCompassCache, _hasTestCacheEntry, _setTestDbPlacesOverride } from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { newWorld, worldClient, flag, communityRow, overpassBody, type WorldState } from "./helpers/fakeDiscoveryWorld.js";

type OverpassMode = "ok" | "empty" | "429" | "throws" | "badjson"; let overpassJson: ((query: string) => unknown) | null = null;  // §99: a 200 JSON body chosen per test from the decoded query (the remark cases); null = use `overpass`
let overpass: OverpassMode = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de")) {
    if (overpassJson) return new Response(JSON.stringify(overpassJson(decodeURIComponent(s))), { status: 200, headers: { "content-type": "application/json" } }); if (overpass === "throws") throw new Error("socket hang up");
    if (overpass === "429") return new Response("rate limited", { status: 429 });
    if (overpass === "badjson") return new Response("<html>gateway</html>", { status: 200 });
    if (overpass === "empty") return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(overpassBody([{ id: 71, name: "OSM Taco", amenity: "fast_food" }])), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return realFetch(url, init);
}) as typeof globalThis.fetch;

const TOKEN = "tok-osm-viewer";
const VIEWER = "0a5f0000-0000-4000-8000-000000000001";
const COLD = "/discovery?destination=Miami&lat=25.77&lng=-80.19&radiusKm=10&category=food";
const FEED = "/discovery/feed?city=Miami&lat=25.77&lng=-80.19&radiusKm=10&category=food";

function world(opts: { errorTables?: string[] } = {}): WorldState {
  const w = newWorld({
    users: { [TOKEN]: VIEWER },
    tables: {
      feature_flags: [flag("discovery_serve_log_enabled", true)],
      discovery_places: [communityRow("11111111-1111-4111-8111-000000000001")],
      places: [], profiles: [{ id: VIEWER, account_status: "active" }],
      blocks: [], user_mutes: [], rank_events: [], intel_coverage_snapshots: [],
    },
  });
  for (const t of opts.errorTables ?? []) w.errorTables.add(t);
  return w;
}

let w: WorldState;
function use(next: WorldState): void {
  w = next;
  const c = worldClient(w);
  _setTestServiceClient(c as any);
  _setTestClient(c as any, true);
}

let server: Server;
let base = "";
before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  overpass = "ok"; overpassJson = null;
  _clearTestCacheEntry("miami:food:10");
  _clearTestCompassCache();
  invalidateServeLogFlagCache(); invalidateFlagsCache(); invalidateDiscoveryEngineModeCache();
});

async function get(path: string): Promise<any> {
  const res = await realFetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  return res.json();
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const impressions = () => w.writes.filter((x) => x.table === "rank_events" && Array.isArray(x.payload)).flatMap((x) => x.payload as any[]);

describe("§94.10 — Overpass failing is a named source, not a smaller city", () => {
  for (const mode of ["429", "throws", "badjson"] as const) {
    it(`O1–O3 Overpass ${mode}: partial, ["overpass"], upstream_unavailable; the DB rows kept and logged`, async () => {
      use(world());
      overpass = mode;
      const body = await get(COLD);
      assert.ok(body.places.length >= 1, `the curated row is real and kept: ${JSON.stringify(body).slice(0, 300)}`);
      assert.ok(body.refusal, `an Overpass ${mode} must be on the envelope`);
      assert.deepEqual(body.refusal.failedSources, ["overpass"]);
      assert.equal(body.refusal.code, "overpass_unavailable");
      assert.equal(body.refusal.class, "upstream_unavailable");
      assert.equal(body.refusal.coverage, "partial");
      await settle();
      assert.ok(impressions().length >= 1, "a partial serve's rows really were served and are logged");
    });
  }

  it("O4 all three retrievals failed and nothing served: coverage nothing, the combined code, no exposure", async () => {
    use(world({ errorTables: ["discovery_places", "places"] }));
    overpass = "429";
    const body = await get(COLD);
    assert.deepEqual(body.places, []);
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body.refusal));
    assert.equal(body.refusal?.code, "discovery_place_sources_read_failed");
    assert.deepEqual([...body.refusal.failedSources].sort(), ["discovery_places", "overpass", "places"]);
    await settle();
    assert.equal(impressions().length, 0);
  });

  it("O5 the feed's places half names overpass", async () => {
    use(world());
    overpass = "throws";
    const body = await get(FEED);
    assert.ok(body.places.length >= 1);
    assert.equal(body.refusal?.coverage, "partial");
    assert.ok(body.refusal?.failedSources.includes("overpass"), JSON.stringify(body.refusal));
    assert.equal(body.refusal?.code, "overpass_unavailable"); assert.equal(body.refusal?.class, "upstream_unavailable");  // §100 (D-W11X2-25), RESTATED from "feed_places_read_failed": an Overpass-only failure is the upstream's on the feed too, as on GET /discovery (O1) and the counts (O7); O8 keeps a DB failure on the places code
  });

  it("O6 a failed Overpass read is never cached: the next healthy request serves the OSM rows", async () => {
    use(world());
    overpass = "429";
    const failed = await get(COLD);
    assert.equal(failed.refusal?.code, "overpass_unavailable");
    overpass = "ok";
    const healthy = await get(COLD);
    assert.ok(healthy.places.some((p: any) => p.name === "OSM Taco"), `served from Overpass, not a cached failure: ${healthy.places.map((p: any) => p.name)}`);
    assert.equal(healthy.refusal, undefined);
  });

  it("O7 counts: every category whose Overpass read failed is a failed category, never a smaller count", async () => {
    use(world());
    overpass = "429";
    const body = await get("/discovery/counts?destination=Miami&lat=25.77&lng=-80.19&radiusKm=10");
    assert.deepEqual(body.counts, {}, JSON.stringify(body));
    assert.equal(body.refusal?.coverage, "nothing");
    assert.equal(body.refusal?.code, "overpass_unavailable"); assert.equal(body.refusal?.class, "upstream_unavailable");  // §99 (D-W11X2-19), restated: an Overpass-only failure is the upstream's, not `transient_db` / `category_counts_failed`
    overpass = "empty";
    const ok = await get("/discovery/counts?destination=Lisbon&lat=38.72&lng=-9.14&radiusKm=10");
    assert.equal(ok.refusal, undefined, "CONTROL: an empty Overpass answer is counted, not refused");
  });

  it("C1 CONTROL: Overpass answering empty is an empty half, not a failure — no refusal", async () => {
    use(world());
    overpass = "empty";
    const body = await get(COLD);
    assert.ok(body.places.length >= 1);
    assert.equal(body.refusal, undefined);
    const feed = await get(FEED);
    assert.equal(feed.refusal, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// census-discovery §99 (lane W11-X2, round 3; DV-83, §98.1 finding 1) —
// Overpass reports a query it could not finish INSIDE an HTTP 200.
//
// The query sets `[timeout:20]`. When Overpass exceeds that, or its memory
// limit, it still answers 200, with `remark: "runtime error: …"` and the
// elements it had written so far: none, or a truncated set. `queryOverpass`
// never read `remark`, so a timed-out query served the smaller city with no
// refusal, wrote it to Cache A and L2 for 2 hours, and the counts answered with
// a five-minute public cache header.
//
//   X1  200, no elements, a timeout remark: `partial`, ["overpass"], upstream_unavailable; never cached (A, L2)
//   X2  200, TRUNCATED elements, an out-of-memory remark: the same; the truncated rows are not served; never cached
//   X3  the feed names "overpass" for both remark forms
//   X4  the counts refuse for both remark forms, with no public Cache-Control
//   X5  fail-closed forms: a remark in no Overpass form, a 200 JSON body with no `elements` array,
//       an informational remark followed by an error, a remark that is not a string, and a JSON null body
//   C2  CONTROL: a 200 with elements and no remark is served, cached in A and L2, and counted with the public header
//   C3  CONTROL: an informational `runtime remark:`, or an empty remark, is not a failure — served and cached
// ─────────────────────────────────────────────────────────────────────────────

const TIMEOUT_REMARK = 'runtime error: Query timed out in "query" at line 3 after 21 seconds.';
const MEMORY_REMARK = "runtime error: Query run out of memory using about 2048 MB of RAM.";
const TACO = overpassBody([{ id: 71, name: "OSM Taco", amenity: "fast_food" }]);
const REMARK_CASES = [
  { name: "empty + timeout remark", body: { elements: [], remark: TIMEOUT_REMARK } },
  { name: "truncated + out-of-memory remark", body: { ...TACO, remark: MEMORY_REMARK } },
] as const;
const l2Writes = () => w.writes.filter((x) => x.table === "discovery_cache");
async function getRaw(path: string): Promise<{ body: any; cacheControl: string | null }> {
  const res = await realFetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  return { body: await res.json(), cacheControl: res.headers.get("cache-control") };
}

describe("§99 — an Overpass 200 carrying a runtime-error remark is a failed read", () => {
  for (const [i, c] of REMARK_CASES.entries()) {
    it(`X${i + 1} GET /discovery, ${c.name}: partial, ["overpass"], upstream_unavailable; the truncated rows are not served; never cached`, async () => {
      use(world());
      overpassJson = () => c.body;
      const body = await get(COLD);
      assert.ok(body.places.length >= 1, "the curated row is real and kept");
      assert.ok(body.refusal, `an Overpass ${c.name} must be on the envelope: ${JSON.stringify(body).slice(0, 300)}`);
      assert.deepEqual(body.refusal.failedSources, ["overpass"]);
      assert.equal(body.refusal.code, "overpass_unavailable");
      assert.equal(body.refusal.class, "upstream_unavailable");
      assert.equal(body.refusal.coverage, "partial");
      assert.ok(!body.places.some((p: any) => p.name === "OSM Taco"), "a truncated set is not served as the nearest places");
      await settle();
      assert.equal(_hasTestCacheEntry("miami:food:10"), false, "Cache A holds no failed read");
      assert.equal(l2Writes().length, 0, "L2 holds no failed read");
      overpassJson = null;
      const healthy = await get(COLD);
      assert.ok(healthy.places.some((p: any) => p.name === "OSM Taco"), "the next healthy request reads Overpass again");
      assert.equal(healthy.refusal, undefined);
    });
  }

  for (const c of REMARK_CASES) {
    it(`X3 the feed, ${c.name}: "overpass" is a failed source`, async () => {
      use(world());
      overpassJson = () => c.body;
      const body = await get(FEED);
      assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body.refusal));
      assert.ok(body.refusal.failedSources.includes("overpass"));
      assert.ok(!body.places.some((p: any) => p.name === "OSM Taco"));
    });
  }

  for (const [i, c] of REMARK_CASES.entries()) {
    it(`X4 counts, ${c.name}: refused, and no public cache header`, async () => {
      use(world());
      overpassJson = () => c.body;
      const { body, cacheControl } = await getRaw(`/discovery/counts?destination=Porto${i}&lat=41.15&lng=-8.61&radiusKm=10`);
      assert.deepEqual(body.counts, {}, JSON.stringify(body));
      assert.equal(body.refusal?.coverage, "nothing");
      assert.ok(!(cacheControl ?? "").includes("public"), `a failed count set is not cacheable: ${cacheControl}`);
    });
  }

  for (const [name, data] of [
    ["a remark in no Overpass form", { elements: [], remark: "Dispatcher busy, try later" }],
    ["a 200 JSON body with no elements array", { error: "upstream proxy" }],
    ["an informational remark followed by an error", { ...TACO, remark: "runtime remark: Timeout is 20 and maxsize is 536870912.\nruntime error: Query timed out in \"query\" at line 3 after 21 seconds." }],
    ["a remark that is not a string", { elements: [], remark: { text: "runtime error" } }],
    ["a JSON null body", null],
  ] as const) {
    it(`X5 fail-closed, ${name}: a failed read`, async () => {
      use(world());
      overpassJson = () => data;
      const body = await get(COLD);
      assert.deepEqual(body.refusal?.failedSources, ["overpass"], JSON.stringify(body.refusal));
      await settle();
      assert.equal(_hasTestCacheEntry("miami:food:10"), false);
    });
  }

  for (const [name, data] of [
    ["no remark", TACO],
    ["an informational `runtime remark:`", { ...TACO, remark: "runtime remark: Timeout is 20 and maxsize is 536870912." }],
    ["an empty remark", { ...TACO, remark: "" }],
  ] as const) {
    it(`C2/C3 CONTROL: a 200 with elements and ${name} is served, cached in A and L2, and counted publicly`, async () => {
      use(world());
      overpassJson = () => data;
      const body = await get(COLD);
      assert.equal(body.refusal, undefined, JSON.stringify(body.refusal));
      assert.ok(body.places.some((p: any) => p.name === "OSM Taco"));
      await settle();
      assert.equal(_hasTestCacheEntry("miami:food:10"), true, "a complete answer is cached in A");
      assert.ok(l2Writes().length >= 1, "and in L2");
      const feed = await get(FEED);
      assert.equal(feed.refusal, undefined);
      const { body: counts, cacheControl } = await getRaw(`/discovery/counts?destination=Braga${name.length}&lat=41.55&lng=-8.42&radiusKm=10`);
      assert.equal(counts.refusal, undefined, JSON.stringify(counts));
      assert.equal(cacheControl, "public, max-age=300");
    });
  }
});

describe("§99 — the stale-L2 background revalidation does not write a truncated city", () => {
  function staleL2World(): WorldState {
    const s = world();
    const past = new Date(Date.now() - 60_000).toISOString();
    s.tables.discovery_cache = [{
      cache_key: "miami:food:10", destination: "Miami", category: "food", radius_km: 10,
      places: [{ id: "osm/node/5", name: "Old Cafe", category: "food", type: null, description: null, distanceKm: 1,
        lat: 25.77, lng: -80.19, tags: [], address: null, website: null, phone: null, openingHours: null, rating: null, isOpenNow: null }],
      cached_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), expires_at: past,
      geocode_lat: 25.77, geocode_lng: -80.19, geocode_display: "Miami",
    }];
    s.tables.discovery_geocode_cache = [{ location_key: "miami", lat: 25.77, lng: -80.19, display_name: "Miami", expires_at: new Date(Date.now() + 3_600_000).toISOString() }];
    return s;
  }

  it("X6 a stale L2 hit revalidated against a truncated, remarked answer writes nothing", async () => {
    use(staleL2World());
    overpassJson = () => ({ ...TACO, remark: MEMORY_REMARK });
    const body = await get(COLD);
    assert.ok(body.places.some((p: any) => p.name === "Old Cafe"), "the stale entry is served, as stale-while-revalidate does");
    await settle(); await settle();
    assert.equal(l2Writes().length, 0, "the truncated answer is not written to L2");
  });

  it("C4 CONTROL: the same stale hit revalidated against a whole answer is rewritten", async () => {
    use(staleL2World());
    overpassJson = () => TACO;
    await get(COLD);
    await settle(); await settle();
    assert.ok(l2Writes().some((x) => JSON.stringify(x.payload).includes("OSM Taco")), "the background refresh wrote the fresh city");
  });
});

describe("§99 — the counts name an Overpass-only failure as the upstream's (D-W11X2-19)", () => {
  it("X7 one category's Overpass read failed: partial, that category, upstream_unavailable / overpass_unavailable", async () => {
    use(world());
    overpassJson = (q) => (q.includes("fast_food") ? { elements: [], remark: TIMEOUT_REMARK } : TACO);
    const { body, cacheControl } = await getRaw("/discovery/counts?destination=Faro&lat=37.02&lng=-7.93&radiusKm=10");
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
    assert.deepEqual(body.refusal.failedSources, ["food"]);
    assert.equal(body.refusal.class, "upstream_unavailable");
    assert.equal(body.refusal.code, "overpass_unavailable");
    assert.ok(!("food" in body.counts));
    assert.ok(!(cacheControl ?? "").includes("public"));
  });

  it("C5 CONTROL: Overpass AND discovery_places failed — the DB failure keeps transient_db / category_counts_failed", async () => {
    use(world({ errorTables: ["discovery_places"] }));
    overpassJson = () => ({ elements: [], remark: TIMEOUT_REMARK });
    const { body } = await getRaw("/discovery/counts?destination=Evora&lat=38.57&lng=-7.91&radiusKm=10");
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body));
    assert.equal(body.refusal.class, "transient_db");
    assert.equal(body.refusal.code, "category_counts_failed");
  });

  it("C6 CONTROL: food failed on Overpass and nightlife on its DB half — a mixed set keeps transient_db / category_counts_partial", async () => {
    use(world());
    overpassJson = (q) => (q.includes("fast_food") ? { elements: [], remark: TIMEOUT_REMARK } : TACO);
    _setTestDbPlacesOverride(async (_d, cat) => { if (cat === "nightlife") throw new Error("read exploded"); return []; });
    try {
      const { body } = await getRaw("/discovery/counts?destination=Lagos&lat=37.10&lng=-8.67&radiusKm=10");
      assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
      assert.deepEqual([...body.refusal.failedSources].sort(), ["food", "nightlife"]);
      assert.equal(body.refusal.class, "transient_db");
      assert.equal(body.refusal.code, "category_counts_partial");
    } finally { _setTestDbPlacesOverride(null); }
  });
});

// census-discovery §100 (lane W11-X2 round 4; DV-83, §99.8 "also recorded"),
// register D-W11X2-25. Appended at the tail so every anchored line above keeps
// its place. O5 (restated in place) pins the Overpass-only feed failure to the
// class and code GET /discovery (O1) and the counts (O7) give the same failure.
//
//   O8  CONTROL: the feed, Overpass AND a category's DB half failed — a DB failure keeps transient_db / feed_places_read_failed
//   O9  the feed, Overpass failed AND the event posts failed — still the upstream's: both named, overpass_unavailable
describe("§100 (D-W11X2-25): the feed classes an Overpass-only failure as GET /discovery does", () => {
  it("O8 CONTROL: Overpass and a DB category both failed — the DB failure keeps transient_db / feed_places_read_failed", async () => {
    use(world({ errorTables: ["discovery_places", "places"] }));
    overpass = "throws";
    const body = await get(FEED);
    assert.ok(body.refusal, JSON.stringify(body));
    assert.ok(body.refusal.failedSources.includes("overpass"), JSON.stringify(body.refusal));
    assert.ok(body.refusal.failedSources.some((c: string) => c !== "overpass" && c !== "event_posts"), JSON.stringify(body.refusal));
    assert.equal(body.refusal.class, "transient_db");
    assert.equal(body.refusal.code, "feed_places_read_failed");
  });

  it("O9 Overpass-only among the PLACE sources, whatever the posts did: upstream_unavailable / overpass_unavailable", async () => {
    use(world());
    overpass = "429";
    const body = await get(FEED);
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body.refusal));
    assert.deepEqual(body.refusal.failedSources.filter((c: string) => c !== "event_posts"), ["overpass"]);
    assert.equal(body.refusal.class, "upstream_unavailable");
    assert.equal(body.refusal.code, "overpass_unavailable");
  });
});
