/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the sweep beside the round-23 verifier's B42): no Discovery
 * serve path answers a viewer whose token could not be RESOLVED as though they were anonymous.
 *
 * B42 was GET /discovery/community. The same lookup shape stood on GET /discovery: `const { data } = await
 * auth.getUser(token)` inside a comment-only catch, so a lookup that threw, or that Supabase Auth did not answer, left
 * the viewer id null exactly as for a caller with no token. The signed-in viewer was then served the ANONYMOUS page: a
 * place submitted by someone they blocked, their dismissals not applied, the Layover gate not consulted, and (with no
 * `destination` parameter) a 400 "destination is required" over a context nobody read. GET /discovery/feed already knew
 * its viewer was unresolved (§98) and said so for the event posts, but its community places were still checked against
 * an EMPTY author set, and its Layover gate, like the community route's, answered "no traveller, no restriction".
 *
 * The classifier is D-W11X2-21's one (`authServiceUnreachable`): a token Auth REJECTED is an anonymous caller, as
 * before; a token nobody evaluated leaves the viewer unresolved.
 *
 *   GET /discovery — refused whole (its gates are the viewer's: author set, dismissals, Layover)
 *   DU0  CONTROL: the viewer resolves → the blocked submitter's pick is withheld, no refusal
 *   DU1  the lookup THROWS → `nothing`, upstream_unavailable / discovery_viewer_unresolved, ["viewer"], no places
 *   DU2  Auth answers 503 → the same
 *   DU3  an error with no status and no known name → the same (not a verdict on the token)
 *   DU4  CONTROL: Auth REJECTS the token (401 bad_jwt) → the anonymous page, no refusal
 *   DU5  CONTROL: no token → the anonymous page, no refusal
 *   DU6  unresolved and no `destination` → the same refusal, never 400 "destination is required"
 *   DU7  CONTROL: the refusal is not cached — once the viewer resolves, the next request serves their page
 *
 *   GET /discovery/feed — the places half
 *   FU0  CONTROL: the viewer resolves → the blocked submitter's pick is withheld
 *   FU1  the lookup THROWS → the blocked submitter's pick is NOT served; `viewer` named beside `event_posts`; partial
 *   FU2  the lookup THROWS and Layover mode is ON → `nothing`, layover_viewer_unresolved, ["viewer"]: nobody was looked at
 *   FU3  CONTROL: Auth REJECTS the token and Layover mode is ON → an anonymous caller: served, no refusal
 *
 *   GET /discovery/community — the Layover gate
 *   CU1  the lookup THROWS and Layover mode is ON → `nothing`, layover_viewer_unresolved, ["viewer"]
 *   CU2  CONTROL: Auth REJECTS the token and Layover mode is ON → an anonymous caller: served
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryViewerUnresolvedServe.test.ts
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
import { newWorld, worldClient, flag, communityRow, profileRow, overpassBody, type WorldState } from "./helpers/fakeDiscoveryWorld.js";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de")) {
    return new Response(JSON.stringify(overpassBody([{ id: 71, name: "OSM Taco", amenity: "fast_food" }])), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return realFetch(url, init);
}) as typeof globalThis.fetch;

const TOKEN = "tok-unresolved";
const VIEWER = "0b420000-0000-4000-8000-0000000000a1";
const BLOCKED = "0b420000-0000-4000-8000-0000000000b1";
const VENUE = communityRow("22222222-2222-4222-8222-0000000000a0", { name: "Legacy Row" });
const BLOCKED_PICK = communityRow("22222222-2222-4222-8222-0000000000a1", { name: "Blocked Pick", submitted_by: BLOCKED });
const COLD = "/discovery?destination=Miami&lat=25.77&lng=-80.19&radiusKm=10&category=food";
const COLD_NO_DESTINATION = "/discovery?lat=25.77&lng=-80.19&radiusKm=10&category=food";
const FEED = "/discovery/feed?city=Miami&lat=25.77&lng=-80.19&radiusKm=10&category=food";
const COMMUNITY = "/discovery/community?city=Miami";
const LAYOVER_MODE = "layover_discovery_mode_enabled";

type Auth = "resolves" | "throws" | "503" | "statusless" | "rejected";
function world(opts: { layoverMode?: boolean } = {}): WorldState {
  return newWorld({
    users: { [TOKEN]: VIEWER },
    tables: {
      feature_flags: opts.layoverMode ? [flag(LAYOVER_MODE, true)] : [],
      discovery_places: [VENUE, BLOCKED_PICK],
      places: [],
      profiles: [profileRow(VIEWER), profileRow(BLOCKED)],
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
      user_mutes: [], user_follows: [], rank_events: [], intel_coverage_snapshots: [], collections: [], collection_items: [],
      profile_privacy_settings: [], identity_verifications: [], layover_sessions: [],
    },
  });
}
function use(w: WorldState, auth: Auth): void {
  const c: any = worldClient(w);
  const getUser = async (token: string) => {
    if (auth === "throws") throw new Error("socket hang up");
    if (auth === "503") return { data: { user: null }, error: { name: "AuthApiError", status: 503, message: "upstream unavailable" } };
    if (auth === "statusless") return { data: { user: null }, error: { message: "something went wrong" } };
    if (auth === "rejected") return { data: { user: null }, error: { name: "AuthApiError", status: 401, code: "bad_jwt", message: "invalid JWT" } };
    return c.auth.getUser(token);
  };
  const client = { ...c, auth: { getUser } };
  _setTestServiceClient(client as any);
  _setTestClient(client as any, true);
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
  _setTestServiceClient(null); _setTestClient(null as any, false);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  _clearTestCacheEntry("miami:food:10");
  _clearTestCompassCache();
  invalidateServeLogFlagCache(); invalidateFlagsCache(); invalidateDiscoveryEngineModeCache();
});

async function get(path: string, token = true): Promise<{ status: number; body: any }> {
  const res = await realFetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${TOKEN}` } } : undefined);
  return { status: res.status, body: await res.json() as any };
}
const names = (rows: any[] | undefined) => (rows ?? []).map((i) => i.name as string).sort();
const refusalOf = (body: any) => (body?.refusal ? { class: body.refusal.class, code: body.refusal.code, coverage: body.refusal.coverage, failedSources: body.refusal.failedSources ?? null } : null);
const DISCOVERY_UNRESOLVED = { class: "upstream_unavailable", code: "discovery_viewer_unresolved", coverage: "nothing", failedSources: ["viewer"] };
const LAYOVER_UNRESOLVED = { class: "upstream_unavailable", code: "layover_viewer_unresolved", coverage: "nothing", failedSources: ["viewer"] };

describe("census-discovery §123: GET /discovery never serves an unresolved viewer the anonymous page", () => {
  it("DU0 CONTROL: the viewer resolves → the blocked submitter's pick is withheld, no refusal", async () => {
    use(world(), "resolves");
    const r = await get(COLD);
    assert.equal(r.status, 200);
    assert.equal(refusalOf(r.body), null, JSON.stringify(r.body.refusal));
    assert.ok(names(r.body.places).includes("Legacy Row"), JSON.stringify(names(r.body.places)));
    assert.equal(names(r.body.places).includes("Blocked Pick"), false);
  });
  for (const [id, auth, what] of [
    ["DU1", "throws", "the lookup THROWS"],
    ["DU2", "503", "Auth answers 503"],
    ["DU3", "statusless", "an error with no status and no known name"],
  ] as const) {
    it(`${id} ${what} → refused whole, \`viewer\` named, no places`, async () => {
      use(world(), auth);
      const r = await get(COLD);
      assert.equal(r.status, 200);
      assert.deepEqual(refusalOf(r.body), DISCOVERY_UNRESOLVED, JSON.stringify(r.body).slice(0, 400));
      assert.deepEqual(r.body.places, []);
      assert.equal(JSON.stringify(r.body).includes(BLOCKED_PICK.id), false, "the blocked submitter's pick reached a viewer nobody resolved");
    });
  }
  it("DU4 CONTROL: Auth REJECTS the token (401 bad_jwt) → the anonymous page, no refusal", async () => {
    use(world(), "rejected");
    const r = await get(COLD);
    assert.equal(refusalOf(r.body), null, JSON.stringify(r.body.refusal));
    assert.ok(names(r.body.places).includes("Blocked Pick"), "an anonymous caller has no block relationship");
  });
  it("DU5 CONTROL: no token → the anonymous page, no refusal", async () => {
    use(world(), "throws");
    const r = await get(COLD, false);
    assert.equal(refusalOf(r.body), null, JSON.stringify(r.body.refusal));
    assert.ok(names(r.body.places).includes("Blocked Pick"));
  });
  it("DU6 unresolved and no `destination` → the same refusal, never 400 'destination is required'", async () => {
    use(world(), "throws");
    const r = await get(COLD_NO_DESTINATION);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(refusalOf(r.body), DISCOVERY_UNRESOLVED);
  });
  it("DU7 CONTROL: the refusal is not cached — once the viewer resolves, the next request serves their page", async () => {
    use(world(), "throws");
    assert.deepEqual(refusalOf((await get(COLD)).body), DISCOVERY_UNRESOLVED);
    use(world(), "resolves");
    const r = await get(COLD);
    assert.equal(refusalOf(r.body), null);
    assert.ok(names(r.body.places).includes("Legacy Row"));
    assert.equal(names(r.body.places).includes("Blocked Pick"), false);
  });
});

describe("census-discovery §123: GET /discovery/feed checks no authored place against a viewer it could not resolve", () => {
  it("FU0 CONTROL: the viewer resolves → the blocked submitter's pick is withheld", async () => {
    use(world(), "resolves");
    const r = await get(FEED);
    assert.ok(names(r.body.places).includes("Legacy Row"), JSON.stringify(names(r.body.places)));
    assert.equal(names(r.body.places).includes("Blocked Pick"), false);
  });
  it("FU1 the lookup THROWS → the blocked submitter's pick is not served; `viewer` named beside `event_posts`; partial", async () => {
    use(world(), "throws");
    const r = await get(FEED);
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(r.body.places ?? []).includes(BLOCKED_PICK.id), false, "the blocked submitter's pick reached a viewer nobody resolved");
    assert.ok(names(r.body.places).includes("Legacy Row"), "a venue fact needs no author check and is kept");
    assert.deepEqual(refusalOf(r.body), { class: "upstream_unavailable", code: "feed_viewer_unresolved", coverage: "partial", failedSources: ["viewer", "event_posts"] });
  });
  it("FU2 the lookup THROWS and Layover mode is ON → refused whole: nobody was looked at", async () => {
    use(world({ layoverMode: true }), "throws");
    const r = await get(FEED);
    assert.deepEqual(refusalOf(r.body), LAYOVER_UNRESOLVED, JSON.stringify(r.body).slice(0, 400));
    assert.deepEqual(r.body.places, []);
  });
  it("FU3 CONTROL: Auth REJECTS the token and Layover mode is ON → an anonymous caller: served, no refusal", async () => {
    use(world({ layoverMode: true }), "rejected");
    const r = await get(FEED);
    assert.equal(refusalOf(r.body), null, JSON.stringify(r.body.refusal));
    assert.ok(names(r.body.places).includes("Legacy Row"));
  });
});

describe("census-discovery §123: GET /discovery/community's Layover gate is owed to a viewer it could not resolve", () => {
  it("CU1 the lookup THROWS and Layover mode is ON → refused whole, `viewer` named", async () => {
    use(world({ layoverMode: true }), "throws");
    const r = await get(COMMUNITY);
    assert.deepEqual(refusalOf(r.body), LAYOVER_UNRESOLVED, JSON.stringify(r.body).slice(0, 400));
    assert.deepEqual(r.body.items, []);
  });
  it("CU2 CONTROL: Auth REJECTS the token and Layover mode is ON → an anonymous caller: served", async () => {
    use(world({ layoverMode: true }), "rejected");
    const r = await get(COMMUNITY);
    assert.equal(refusalOf(r.body), null, JSON.stringify(r.body.refusal));
    assert.deepEqual(names(r.body.items), ["Blocked Pick", "Legacy Row"]);
  });
});
