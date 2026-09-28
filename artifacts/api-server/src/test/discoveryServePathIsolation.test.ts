/**
 * census-discovery §47 — the serve paths that DO NOT rank, and the modes that
 * must not change what they serve.
 *
 * Three claims, each of which a weaker test would pass vacuously:
 *
 *   1. LEGACY IS BYTE-IDENTICAL TO THE TREE BEFORE §47. Proved against a golden
 *      captured from `709b7b800` (see helpers/discoveryLegacyScenarios.ts for
 *      how, and for what is normalised away and why that is not a loophole).
 *
 *   2. EVERY PER-VIEWER RULE HOLDS ON THE UNRANKED CACHE-A PATH (DV-03's leg).
 *      Cache A is user-INDEPENDENT and serves its cached order unranked in the
 *      shipping mode. What it serves must still be filtered per viewer — blocks
 *      both ways, mutes, submitter standing, "Not interested", the age gate — and
 *      nothing one viewer's request does may reach the shared entry (L1) or the
 *      persisted row (L2, `discovery_cache`).
 *
 *   3. SHADOW NEVER CHANGES WHAT IS SERVED, AND `pde` WITH ITS COHORT CLOSED IS
 *      LEGACY. With a control that `pde` with the cohort OPEN does change the
 *      order, so "identical" is not the trivial answer of a mode that never runs.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryServePathIsolation.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _injectTestCacheEntry, _clearTestCacheEntry, _clearTestCompassCache,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { invalidateCandidateProjectionFlagCache } from "../lib/discoveryCandidate.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { worldClient, flag, overpassBody, type WorldState } from "./helpers/fakeDiscoveryWorld.js";
import {
  runLegacyScenarios, legacyWorld, osmCached, normalise,
  LEGACY_VIEWER as A, LEGACY_SUBMITTER_S as S, LEGACY_SUBMITTER_T as T, LEGACY_TOKEN as TOK_A,
  CACHE_A_FOR_YOU,
} from "./helpers/discoveryLegacyScenarios.js";

const B = "bbbb0000-0000-4000-8000-00000000000b";
const TOK_B = "tok-b";
const Q = "destination=Miami&lat=25.77&lng=-80.19&radiusKm=10";
const CACHE_A_FOOD = "miami:food:10";

const realFetch = globalThis.fetch;
let overpassCalls = 0;
function useNetwork(overpass: boolean): void {
  globalThis.fetch = (async (url: any, init?: any) => {
    const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
    if (s.includes("overpass-api.de")) {
      overpassCalls++;
      if (!overpass) return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "content-type": "application/json" } });  // census-discovery §94.10: "off" means Overpass answered empty; a throw is now an outage the route names
      return new Response(JSON.stringify(overpassBody([
        { id: 11, name: "Taco Stand", amenity: "fast_food" },
        { id: 12, name: "Bistro Doce", amenity: "restaurant", lat: 25.775 },
        { id: 13, name: "Corner Bar", amenity: "bar", lat: 25.78 },
      ])), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
    return realFetch(url, init);
  }) as typeof globalThis.fetch;
}

function resetCaches(): void {
  _clearTestCompassCache();
  _clearTestCacheEntry(CACHE_A_FOR_YOU);
  _clearTestCacheEntry(CACHE_A_FOOD);
  invalidateDiscoveryEngineModeCache();
  invalidateFlagsCache();
  invalidateServeLogFlagCache();
  invalidateCandidateProjectionFlagCache();
  invalidateLiveRankFlagCache();
  invalidateDiscoveryModifiersFlagCache();
  _resetStopConditionsForTest();
}

let server: Server;
let base = "";
let w: WorldState;

function use(next: WorldState): WorldState {
  w = next;
  w.users[TOK_B] = B;
  w.tables.profiles!.push({ id: B, name: "b", username: "hb", avatar_url: null, account_status: "active", date_of_birth: "1985-01-01" });
  const c = worldClient(w);
  _setTestServiceClient(c as any);
  _setTestClient(c as any, true);
  return w;
}

async function get(path: string, token: string | null): Promise<{ status: number; body: any; ids: string[] }> {
  const res = await realFetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await res.json() as any;
  return { status: res.status, body, ids: ((body.places ?? body.items ?? []) as any[]).map((p) => p.id) };
}

function engineMode(mode: string, cohort: unknown): any[] {
  return [
    flag("DISCOVERY_ENGINE_MODE", true, { mode, cohort }),
    flag("disable_discovery_pde", false),
  ];
}

async function waitFor(pred: () => boolean, ms = 3_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

const writesTo = (table: string) => w.writes.filter((x) => x.table === table);

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

describe("legacy is byte-identical to the tree before §47", () => {
  it("L0 eleven fixed requests, every serve path and all three routes, replay the 709b7b800 golden exactly", async () => {
    const golden = JSON.parse(readFileSync(new URL("./fixtures/discoveryLegacyGolden.json", import.meta.url), "utf8"));
    const now = await runLegacyScenarios();
    assert.deepEqual(Object.keys(now), Object.keys(golden), "the scenario list changed — regenerate the golden AT THE BASE COMMIT, never at HEAD");
    for (const k of Object.keys(golden)) {
      assert.deepEqual(now[k], golden[k], `legacy output moved for "${k}"`);
    }
  });
});

describe("DV-03's leg: every per-viewer rule holds on the unranked cache-A path", () => {
  beforeEach(() => { resetCaches(); useNetwork(false); use(legacyWorld()); _injectTestCacheEntry(CACHE_A_FOR_YOU, osmCached()); });
  afterEach(() => { resetCaches(); globalThis.fetch = realFetch; });

  it("I1 mutes and blocks (both ways) filter the viewer's page and no one else's; the shared entry is untouched", async () => {
    w.tables.user_mutes!.push({ muter_id: A, muted_id: S });
    w.tables.blocks!.push({ blocker_id: T, blocked_id: A });   // T blocked the VIEWER
    const a = await get(`/discovery?${Q}&category=for_you`, TOK_A);
    assert.equal(a.body.meta?.cacheLevel, "L1", "precondition: this is the cache-A serve");
    assert.ok(!a.ids.includes("db/p2"), `a muted submitter's row reached the unranked path: ${JSON.stringify(a.ids)}`);
    assert.ok(!a.ids.includes("db/p3"), `a row by someone who blocked the viewer was served: ${JSON.stringify(a.ids)}`);
    const b = await get(`/discovery?${Q}&category=for_you`, TOK_B);
    assert.ok(b.ids.includes("db/p2") && b.ids.includes("db/p3"), `A's exclusions leaked to B: ${JSON.stringify(b.ids)}`);
    const anon = await get(`/discovery?${Q}&category=for_you`, null);
    assert.deepEqual(anon.ids.filter((id) => id.startsWith("node/")), ["node/1", "node/2", "node/3", "node/4"],
      "the cached OSM order must be exactly what was cached — a viewer's request wrote nothing into it");
  });

  it("I2 submitter standing holds for EVERY caller, anonymous included", async () => {
    w.tables.profiles!.find((r) => r.id === S)!.account_status = "deactivated";
    for (const tok of [TOK_A, TOK_B, null]) {
      const r = await get(`/discovery?${Q}&category=for_you`, tok);
      assert.ok(!r.ids.includes("db/p2"), `${tok ?? "anonymous"} was served a deactivated account's submission`);
      assert.ok(r.ids.includes("db/p3"), "an active submitter is unaffected");
    }
  });

  it("I3 'Not interested' is the viewer's own: A's dismissal never reaches B", async () => {
    w.tables.rank_events!.push({ user_id: A, surface: "discovery", outcome: "dismiss", item_id: "node/3", served_at: "2026-09-01T00:00:00Z" });
    const a = await get(`/discovery?${Q}&category=for_you`, TOK_A);
    const b = await get(`/discovery?${Q}&category=for_you`, TOK_B);
    assert.ok(!a.ids.includes("node/3"));
    assert.ok(b.ids.includes("node/3"), "a dismissal is a per-viewer rule and must not touch another viewer's page");
  });

  it("I4 DEFECT: the age gate withholds a REAL Overpass bar (category = the tab, type = 'bar') from a minor", async () => {
    w.tables.profiles!.find((r) => r.id === A)!.date_of_birth = "2012-01-01";
    const minor = await get(`/discovery?${Q}&category=for_you&ageFilter=open_to_me`, TOK_A);
    assert.ok(!minor.ids.includes("node/3"),
      `a bar shaped exactly as mapOsmElementToPlace shapes it was served to a minor: ${JSON.stringify(minor.ids)}`);
    const adult = await get(`/discovery?${Q}&category=for_you&ageFilter=open_to_me`, TOK_B);
    assert.ok(adult.ids.includes("node/3"), "control: an adult is still served the bar");
  });

  it("I5 a policy read that FAILS closes the authored rows, and only them", async () => {
    w.errorTables.add("user_mutes");
    const a = await get(`/discovery?${Q}&category=for_you`, TOK_A);
    assert.deepEqual(a.ids.filter((id) => id.startsWith("db/")), ["db/p1"], "authored rows must be withheld while mutes are unknown");
    assert.equal(a.ids.filter((id) => id.startsWith("node/")).length, 4, "venue facts are not the policy's subject and stay");
  });
});

describe("the shared caches hold no per-viewer data (L1 and the persisted L2 row)", () => {
  beforeEach(() => { resetCaches(); overpassCalls = 0; useNetwork(true); use(legacyWorld()); });
  afterEach(() => { resetCaches(); globalThis.fetch = realFetch; });

  it("I6 a signed-in cold fetch with a device position, mutes and a dismissal writes the SAME L2 row an anonymous fetch writes", async () => {
    w.tables.user_mutes!.push({ muter_id: A, muted_id: S });
    w.tables.rank_events!.push({ user_id: A, surface: "discovery", outcome: "dismiss", item_id: "node/12", served_at: "2026-09-01T00:00:00Z" });
    const a = await get(`/discovery?${Q}&category=food&userLat=40.7&userLng=-74.0&sortBy=nearest`, TOK_A);
    assert.ok(!a.ids.includes("node/12") && !a.ids.includes("db/p2"), "precondition: A's own page is filtered");
    const rowA = writesTo("discovery_cache").at(-1)?.payload as any;
    assert.ok(rowA, "precondition: the cold fetch persisted an L2 row");

    _clearTestCacheEntry(CACHE_A_FOOD);
    await get(`/discovery?${Q}&category=food`, null);
    const rowAnon = writesTo("discovery_cache").at(-1)?.payload as any;
    assert.notEqual(rowAnon, rowA, "precondition: the anonymous fetch wrote its own row");

    assert.deepEqual(rowA.places, rowAnon.places, "the persisted candidate set must not depend on who fetched it");
    assert.deepEqual(rowA.places.map((p: any) => p.id), ["node/11", "node/12", "node/13"],
      "L2 holds OSM rows only — the dismissed node/12 is there (policy is per request) and no community row is");
    const forbidden = /recommendation|newToMe|candidate|isSaved|submitted|userLat|userLng/i;
    for (const p of rowA.places) {
      for (const k of Object.keys(p)) assert.ok(!forbidden.test(k), `a viewer-scoped key "${k}" was persisted on ${p.id}`);
      assert.ok(p.distanceKm < 5, `${p.id} distance was measured from the viewer's device (${p.distanceKm} km), not the destination`);
    }
    assert.equal(rowA.geocode_lat, 25.77, "the persisted centre is the request's lat/lng param — the destination contract, never userLat");
  });

  it("I7 B, served from the L1 entry A's fetch wrote, sees what A's policies removed from A", async () => {
    w.tables.user_mutes!.push({ muter_id: A, muted_id: S });
    w.tables.rank_events!.push({ user_id: A, surface: "discovery", outcome: "dismiss", item_id: "node/12", served_at: "2026-09-01T00:00:00Z" });
    await get(`/discovery?${Q}&category=food`, TOK_A);
    const b = await get(`/discovery?${Q}&category=food`, TOK_B);
    assert.equal(b.body.meta?.cacheLevel, "L1", "precondition: B is served from the entry A's request wrote");
    assert.ok(b.ids.includes("node/12") && b.ids.includes("db/p2"), `A's per-viewer rules leaked into the shared entry: ${JSON.stringify(b.ids)}`);
  });

  it("I8 the shared entry holds OSM rows only — a community row that becomes ineligible cannot ride the cached half", async () => {
    await get(`/discovery?${Q}&category=food`, TOK_A);          // writes L1
    w.tables.profiles!.find((r) => r.id === S)!.account_status = "deactivated";
    const b = await get(`/discovery?${Q}&category=food`, TOK_B);
    assert.equal(b.body.meta?.cacheLevel, "L1");
    assert.ok(!b.ids.includes("db/p2"), `a deactivated account's row was served out of the SHARED entry: ${JSON.stringify(b.ids)}`);
    w.tables.discovery_places = [];
    const anon = await get(`/discovery?${Q}&category=food`, null);
    assert.deepEqual(anon.ids, ["node/11", "node/12", "node/13"], "with the community table empty, the cached half must be OSM and nothing else");
  });
});

describe("modes: shadow observes, pde-with-a-closed-cohort is legacy", () => {
  beforeEach(() => { resetCaches(); useNetwork(false); });
  afterEach(() => { resetCaches(); globalThis.fetch = realFetch; });

  async function servedUnder(flags: any[], path: string, token: string | null) {
    resetCaches();
    const wd = use(legacyWorld());
    wd.tables.feature_flags!.push(flag("discovery_serve_log_enabled", true), ...flags);
    wd.tables.rank_events!.push({ user_id: A, surface: "discovery", outcome: "dismiss", item_id: "node/3", served_at: "2026-09-01T00:00:00Z" });
    if (path.includes("for_you")) _injectTestCacheEntry(CACHE_A_FOR_YOU, osmCached());
    const r = await get(path, token);
    return { ...r, norm: normalise(r.body), world: wd };
  }

  for (const [label, path] of [["cache-A serve", `/discovery?${Q}&category=for_you`], ["cold fetch", `/discovery?${Q}&category=food`]] as const) {
    it(`M1 ${label}: pde with the cohort CLOSED serves exactly what legacy serves`, async () => {
      const legacy = await servedUnder([], path, TOK_A);
      const none   = await servedUnder(engineMode("pde", { kind: "none" }), path, TOK_A);
      const other  = await servedUnder(engineMode("pde", { kind: "users", userIds: [B] }), path, TOK_A);
      const absent = await servedUnder(engineMode("pde", undefined), path, TOK_A);
      assert.deepEqual(none.norm, legacy.norm, "cohort kind=none must be legacy");
      assert.deepEqual(other.norm, legacy.norm, "a viewer outside a users cohort must be legacy");
      assert.deepEqual(absent.norm, legacy.norm, "an absent cohort includes nobody");
    });
  }

  it("M2 CONTROL: pde with the cohort OPEN does re-rank the cache-A serve (M1 is not the trivial answer)", async () => {
    const legacy = await servedUnder([], `/discovery?${Q}&category=for_you`, TOK_A);
    const all    = await servedUnder(engineMode("pde", { kind: "all" }), `/discovery?${Q}&category=for_you`, TOK_A);
    assert.equal(all.ids.length, legacy.ids.length);
    assert.notDeepEqual(all.ids, legacy.ids, "an in-cohort pde serve must differ from the unranked cached order");
  });

  it("M3 shadow serves exactly what legacy serves and writes ONLY discovery_shadow_serves beyond it", async () => {
    const path = `/discovery?${Q}&category=for_you`;
    const legacy = await servedUnder([], path, TOK_A);
    await waitFor(() => false, 150);                       // let legacy's fire-and-forget writes land
    const legacyTables = legacy.world.writes.map((x) => x.table).sort();
    assert.ok(legacyTables.includes("rank_events"),
      "precondition: the legacy serve logged its exposure — without it 'no extra rank_events writes' would be vacuous");
    assert.ok(!legacyTables.includes("discovery_shadow_serves"), "legacy must not run the shadow observation at all");

    const shadow = await servedUnder(engineMode("shadow", { kind: "all" }), path, TOK_A);
    assert.deepEqual(shadow.norm, legacy.norm, "shadow changed what the viewer was served");
    const landed = await waitFor(() => shadow.world.writes.some((x) => x.table === "discovery_shadow_serves"));
    assert.ok(landed, "precondition: the shadow observation ran and wrote its row");
    await waitFor(() => false, 150);
    const shadowTables = shadow.world.writes.map((x) => x.table).sort();
    const extra = [...shadowTables].filter((t) => t !== "rpc:discovery_stop_measurements"); // census-discovery §54 H1: 3391's STABLE stop-condition measurement is a READ the shadow/pde resolver now makes; a STABLE function cannot write, and every other rpc or table still fails here
    for (const t of legacyTables) { const i = extra.indexOf(t); if (i > -1) extra.splice(i, 1); }
    assert.deepEqual(extra, ["discovery_shadow_serves"], `the shadow run wrote beyond its own table: ${JSON.stringify(extra)}`);
  });

  it("M4 DEFECT (DC-14): the shadow's PDE page passes the same post-rank layers as the served page", async () => {
    const shadow = await servedUnder(engineMode("shadow", { kind: "all" }), `/discovery?${Q}&category=for_you`, TOK_A);
    assert.ok(!shadow.ids.includes("node/3"), "precondition: A dismissed node/3 and the served page honours it");
    assert.ok(await waitFor(() => shadow.world.writes.some((x) => x.table === "discovery_shadow_serves")));
    const row = shadow.world.writes.find((x) => x.table === "discovery_shadow_serves")!.payload as any;
    assert.ok(!row.pde_ids.includes("node/3"),
      `the shadow recorded a DISMISSED place as a page PDE would serve — divergence caused by filtering, not ranking: ${JSON.stringify(row.pde_ids)}`);
    assert.deepEqual([...row.pde_ids].sort(), [...row.legacy_ids].sort(), "one page, the same eligible set — only the ORDER may differ");
    assert.equal(row.pde_total, row.legacy_total, "both totals count what the page would serve");
  });
});

describe("GET /discovery/community — the byline surface", () => {
  beforeEach(() => { resetCaches(); useNetwork(false); use(legacyWorld()); });
  afterEach(() => { resetCaches(); globalThis.fetch = realFetch; });

  it("C1 a non-active submitter loses the pick AND the byline, for every caller", async () => {
    w.tables.profiles!.find((r) => r.id === S)!.account_status = "pending_deletion";
    for (const tok of [TOK_A, null]) {
      const r = await get("/discovery/community?city=Miami", tok);
      assert.ok(!r.ids.includes("p2"), `${tok ?? "anonymous"} was shown a pending-deletion account's pick`);
      assert.ok(!JSON.stringify(r.body).includes(S), "the submitter's id must not appear anywhere in the body");
      assert.equal(r.body.total, r.ids.length, "total counts what was served");
    }
  });

  it("C2 a mute hides the pick for the viewer who muted, and fails closed when unreadable", async () => {
    w.tables.user_mutes!.push({ muter_id: A, muted_id: T });
    assert.ok(!(await get("/discovery/community?city=Miami", TOK_A)).ids.includes("p3"));
    assert.ok((await get("/discovery/community?city=Miami", null)).ids.includes("p3"), "an anonymous caller muted nobody");
    w.errorTables.add("user_mutes");
    assert.deepEqual((await get("/discovery/community?city=Miami", TOK_A)).ids, ["p1"], "unknown mutes withhold every authored pick");
  });
});
