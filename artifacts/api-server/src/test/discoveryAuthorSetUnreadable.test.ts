/**
 * census-discovery §102 (DV-83 round 6, lane W11-X2; D-W11X2-37): a signed-in
 * viewer whose author-exclusion set (blocks both ways + mutes) cannot be READ
 * is served only the rows that need no such check — venue facts with no
 * submitter — and the answer SAYS so. Authored rows that could not be
 * block-checked are withheld (fail-closed, lib/blocks.ts) and are never served
 * as though checked, nor counted as though the city had no more.
 *
 * Before: GET /discovery/community answered `200 { items: [<venue facts>],
 * total: n }` with no refusal (the verifier's V5-B1 at 0db25c816), and
 * useCommunityDiscovery cached that list as complete for five minutes.
 *
 *   B1  the verifier's probe: blocks unreadable, authored + unauthored rows →
 *       refusal `partial`, failedSources ["blocks"], only the venue fact served
 *   B2  every row authored → refusal `nothing`, no items
 *   B3  the mute read fails (blocks readable) → the same refusal
 *   F1  GET /discovery/feed with the same failure names "blocks" (the feed's side)
 *   D1  GET /discovery with the same failure names "blocks"
 *   C1  control: readable sets → a plain 200, no refusal
 *   C2  control: blocks unreadable but no authored row exists → nothing was
 *       withheld, a plain 200
 *   C3  control: anonymous caller → no viewer, nothing to check, a plain 200
 *   C4  control: GET /discovery, blocks unreadable but no authored row → no refusal
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryAuthorSetUnreadable.test.ts
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

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de")) {
    return new Response(JSON.stringify(overpassBody([{ id: 71, name: "OSM Taco", amenity: "fast_food" }])), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return realFetch(url, init);
}) as typeof globalThis.fetch;

const TOKEN = "tok-author-set";
const VIEWER = "0a5f0000-0000-4000-8000-0000000000a1";
const AUTHOR_A = "0a5f0000-0000-4000-8000-0000000000b1";
const AUTHOR_B = "0a5f0000-0000-4000-8000-0000000000b2";
const AUTHOR_C = "0a5f0000-0000-4000-8000-0000000000b3";
const COMMUNITY = "/discovery/community?city=Miami";
const FEED = "/discovery/feed?city=Miami&lat=25.77&lng=-80.19&radiusKm=10&category=food";
const COLD = "/discovery?destination=Miami&lat=25.77&lng=-80.19&radiusKm=10&category=food";

const VENUE = communityRow("11111111-1111-4111-8111-0000000000a0", { name: "Legacy Row" });
const AUTHORED = [
  communityRow("11111111-1111-4111-8111-0000000000a1", { name: "Pick A", submitted_by: AUTHOR_A }),
  communityRow("11111111-1111-4111-8111-0000000000a2", { name: "Pick B", submitted_by: AUTHOR_B }),
  communityRow("11111111-1111-4111-8111-0000000000a3", { name: "Pick C", submitted_by: AUTHOR_C }),
];

function world(opts: { rows?: any[]; errorTables?: string[] } = {}): WorldState {
  const w = newWorld({
    users: { [TOKEN]: VIEWER },
    tables: {
      feature_flags: [],
      discovery_places: opts.rows ?? [VENUE, ...AUTHORED],
      places: [],
      profiles: [VIEWER, AUTHOR_A, AUTHOR_B, AUTHOR_C].map((id) => ({ id, account_status: "active" })),
      blocks: [], user_mutes: [], rank_events: [], intel_coverage_snapshots: [],
    },
  });
  for (const t of opts.errorTables ?? []) w.errorTables.add(t);
  return w;
}

function use(next: WorldState): void {
  const c = worldClient(next);
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
  _clearTestCacheEntry("miami:food:10");
  _clearTestCompassCache();
  invalidateServeLogFlagCache(); invalidateFlagsCache(); invalidateDiscoveryEngineModeCache();
});

async function get(path: string, authed = true): Promise<any> {
  const res = await realFetch(`${base}${path}`, authed ? { headers: { authorization: `Bearer ${TOKEN}` } } : undefined);
  assert.equal(res.status, 200);
  return res.json();
}
const names = (items: any[] | undefined) => (items ?? []).map((i) => i.name as string).sort();

describe("§102 — an unreadable author-exclusion set is stated, never served as a checked list", () => {
  it("B1 (the verifier's V5-B1) community: blocks unreadable → partial, [\"blocks\"], only the venue fact", async () => {
    use(world({ errorTables: ["blocks"] }));
    const body = await get(COMMUNITY);
    assert.deepEqual(names(body.items), ["Legacy Row"]);
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body.refusal));
    assert.deepEqual(body.refusal?.failedSources, ["blocks"]);
    assert.equal(body.refusal?.route, "GET /discovery/community");
    assert.equal(body.refusal?.code, "community_blocks_unreadable");
    for (const p of AUTHORED) assert.equal(JSON.stringify(body).includes(p.id), false, "an unchecked authored row leaked");
  });

  it("B2 community: every row authored → refusal nothing, no items", async () => {
    use(world({ rows: AUTHORED, errorTables: ["blocks"] }));
    const body = await get(COMMUNITY);
    assert.deepEqual(body.items, []);
    assert.equal(body.total, 0);
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body.refusal));
    assert.deepEqual(body.refusal?.failedSources, ["blocks"]);
  });

  it("B3 community: the MUTE read fails (blocks readable) → the same refusal", async () => {
    use(world({ errorTables: ["user_mutes"] }));
    const body = await get(COMMUNITY);
    assert.deepEqual(names(body.items), ["Legacy Row"]);
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body.refusal));
    assert.deepEqual(body.refusal?.failedSources, ["blocks"]);
  });

  it("F1 feed: blocks unreadable → the refusal names \"blocks\"", async () => {
    use(world({ errorTables: ["blocks"] }));
    const body = await get(FEED);
    const served = JSON.stringify(body.places ?? []);
    for (const p of AUTHORED) assert.equal(served.includes(p.id), false, "an unchecked authored row leaked");
    assert.ok((body.refusal?.failedSources ?? []).includes("blocks"), JSON.stringify(body.refusal));
    assert.equal(body.refusal?.coverage, "partial");
    assert.equal(body.refusal?.code, "author_set_unreadable");
  });

  it("D1 GET /discovery: blocks unreadable → the refusal names \"blocks\"", async () => {
    use(world({ errorTables: ["blocks"] }));
    const body = await get(COLD);
    const served = JSON.stringify(body.places ?? []);
    for (const p of AUTHORED) assert.equal(served.includes(p.id), false, "an unchecked authored row leaked");
    assert.ok((body.refusal?.failedSources ?? []).includes("blocks"), JSON.stringify(body.refusal));
    assert.equal(body.refusal?.coverage, "partial");
    assert.equal(body.refusal?.code, "author_set_unreadable");
  });

  it("C1 control: readable sets → community, feed and GET /discovery carry no refusal", async () => {
    use(world());
    const c = await get(COMMUNITY);
    assert.deepEqual(names(c.items), ["Legacy Row", "Pick A", "Pick B", "Pick C"]);
    assert.equal(c.refusal, undefined);
    assert.equal((await get(FEED)).refusal, undefined);
    _clearTestCacheEntry("miami:food:10");
    assert.equal((await get(COLD)).refusal, undefined);
  });

  it("C2 control: blocks unreadable but no authored row → nothing withheld, no refusal", async () => {
    use(world({ rows: [VENUE], errorTables: ["blocks"] }));
    const body = await get(COMMUNITY);
    assert.deepEqual(names(body.items), ["Legacy Row"]);
    assert.equal(body.refusal, undefined);
  });

  it("C3 control: anonymous caller → nothing to check, every row, no refusal", async () => {
    use(world({ errorTables: ["blocks"] }));
    const body = await get(COMMUNITY, false);
    assert.deepEqual(names(body.items), ["Legacy Row", "Pick A", "Pick B", "Pick C"]);
    assert.equal(body.refusal, undefined);
  });

  it("C4 control: GET /discovery, blocks unreadable but no authored row → nothing withheld, no refusal", async () => {
    use(world({ rows: [VENUE], errorTables: ["blocks"] }));
    const body = await get(COLD);
    assert.equal(body.refusal, undefined, JSON.stringify(body.refusal));
  });
});
