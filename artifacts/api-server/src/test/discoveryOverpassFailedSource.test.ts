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
import discoveryRouter, { _clearTestCacheEntry, _clearTestCompassCache } from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { newWorld, worldClient, flag, communityRow, overpassBody, type WorldState } from "./helpers/fakeDiscoveryWorld.js";

type OverpassMode = "ok" | "empty" | "429" | "throws" | "badjson";
let overpass: OverpassMode = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de")) {
    if (overpass === "throws") throw new Error("socket hang up");
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
  overpass = "ok";
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
    assert.equal(body.refusal?.code, "feed_places_read_failed");
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
    assert.equal(body.refusal?.code, "category_counts_failed");
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
