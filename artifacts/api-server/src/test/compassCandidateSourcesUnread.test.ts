/**
 * census-discovery §104 (DV-83, D-W11X2-54, D-W11X2-55): the Compass reads Discovery shows.
 *
 * GET /compass/feed/section (For You's picks) and GET /compass/recommendations (search's
 * Compass rail, For You's traveler row) when a Compass CANDIDATE read resolves a PostgREST
 * error (how supabase-js reports a DB failure: it RESOLVES { data: null, error }, never
 * rejects). DV-83 clause (a): a producer that could not read its sources refuses; clause
 * (b): nothing it built from them is cached as complete.
 *
 * The first describe is the §103.11 verifier's probe file, copied in unchanged as the
 * failing-first test (V7-S1, V7-S2, V7-R1, V7-R2 red at 67d900e55; V7-C1 the control).
 * The second pins every other arm this round changed, each with its healthy control.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "ab000000-0000-4000-a000-000000000001";
const TOKEN = "tok-compass-viewer";
const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };

const readsSeen: string[] = [];
const SOURCES = new Set(["posts", "rent_buddy_profiles", "events", "discovery_places", "hidden_gems"]);
function fakeClient(opts: { failSources: boolean; failTables?: string[] }) {
  function builder(table: string) {
    const named: Record<string, unknown> = {};
    const answer = (): { data: unknown; error: unknown } => {
      if (table === "feature_flags" && named.like !== undefined) {
        return { data: [{ flag: "COMPASS_ENABLED", enabled: true }, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }], error: null };
      }
      if (table === "feature_flags") return { data: null, error: null };
      if (table === "profiles" && named.select === "account_status") return { data: { account_status: "active" }, error: null };
      readsSeen.push(table);
      if (table === "user_location_state") return { data: { city: "Paris" }, error: null };
      if (table === "profiles") return { data: { id: VIEWER, account_status: "active" }, error: null };
      if (opts.failSources && SOURCES.has(table)) return { data: null, error: DB_ERR };
      if (opts.failTables?.includes(table)) return { data: null, error: DB_ERR };
      if (table === "discovery_places") return { data: [{ id: "11111111-1111-4111-a111-111111111111", city: "Paris", name: "Le Place", category: "food", status: "active", rating: 4, created_at: new Date().toISOString(), submitted_by: null, lat: 48.85, lng: 2.35 }], error: null };
      return { data: null, error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer()).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer());
        return (...args: unknown[]) => { named[prop] = args[0]; return b; };
      },
    });
    return b;
  }
  return {
    auth: { getUser: async (tok: string) => (tok === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

let base = "";
let server: Server;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); _resetRateLimit(); readsSeen.length = 0; });

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() };
}

describe("§103.11 verifier probes: Compass candidate sources unread", () => {
  it("V7-S2 section route: the empty section built from FAILED sources is cached and replayed after the sources recover", async () => {
    _setTestClient(fakeClient({ failSources: true }) as any, true);
    await get("/compass/feed/section/for_you?city=Paris");
    _setTestClient(fakeClient({ failSources: false }) as any, true);
    const { status, body } = await get("/compass/feed/section/for_you?city=Paris");
    const items = (body.sections ?? []).flatMap((s: any) => s.items ?? []);
    console.log("V7-S2", status, JSON.stringify(body).slice(0, 300), "reads:", [...new Set(readsSeen)].join(","));
    assert.ok(items.length > 0, "the failed read's empty section was cached as complete and replayed");
  });

  it("V7-S1 section route: every candidate read errors → must not be a 200 'complete' empty section", async () => {
    _setTestClient(fakeClient({ failSources: true }) as any, true);
    const { status, body } = await get("/compass/feed/section/for_you?city=Paris");
    console.log("V7-S1", status, JSON.stringify(body).slice(0, 400), "reads:", [...new Set(readsSeen)].join(","));
    const items = (body.sections ?? []).flatMap((s: any) => s.items ?? []);
    const saidFailed = body.refusal != null || body.fallbackReason != null;
    assert.ok(!(status === 200 && items.length === 0 && !saidFailed), "a section whose candidate reads all failed is served as a complete empty section");
  });

  it("V7-R1 recommendations surface=search: every candidate read errors → must not be a 200 [] with no refusal", async () => {
    _setTestClient(fakeClient({ failSources: true }) as any, true);
    const { status, body } = await get("/compass/recommendations?surface=search&q=zzqq&city=Paris&limit=6");
    console.log("V7-R1", status, JSON.stringify(body).slice(0, 400));
    assert.ok(!(status === 200 && Array.isArray(body.recommendations) && body.recommendations.length === 0 && body.refusal == null), "failed Compass read answered as an empty recommendation list");
  });

  it("V7-R2 recommendations surface=traveler (Discovery For You's CompassTravelerRow): block list unreadable → must not be a 200 [] with no refusal", async () => {
    _setTestClient(fakeClient({ failSources: false, failTables: ["blocks"] }) as any, true);
    const { status, body } = await get("/compass/recommendations?surface=traveler&city=Paris&limit=6");
    console.log("V7-R2", status, JSON.stringify(body).slice(0, 300));
    assert.ok(!(status === 200 && Array.isArray(body.recommendations) && body.recommendations.length === 0 && body.refusal == null), "failed traveler read answered as an empty list");
  });

  it("V7-C1 CONTROL: candidate reads succeed → section serves the place", async () => {
    _setTestClient(fakeClient({ failSources: false }) as any, true);
    const { status, body } = await get("/compass/feed/section/for_you?city=Paris");
    console.log("V7-C1", status, JSON.stringify(body).slice(0, 300), "reads:", [...new Set(readsSeen)].join(","));
    assert.equal(status, 200);
    const items = (body.sections ?? []).flatMap((s: any) => s.items ?? []);
    assert.ok(items.length > 0, "control serves the readable place");
  });
});


// ── Round 8 pins ────────────────────────────────────────────────────────────────
//
// A richer world than the probe's: every call records its arguments, so a flag read
// can be answered per flag, the traveler list is told from the viewer's own profile
// read, and every cache WRITE is captured.

const TRAVELER = "ab000000-0000-4000-a000-000000000002";
const PLACE_A = { id: "11111111-1111-4111-a111-111111111111", city: "Paris", name: "Le Place", category: "food", status: "active", rating: 4, created_at: new Date().toISOString(), submitted_by: null, lat: 48.85, lng: 2.35 };
const PLACE_B = { ...PLACE_A, id: "22222222-2222-4222-a222-222222222222", name: "Le Deux" };

interface World {
  failTables?: string[];          // resolve { data: null, error }
  flagsError?: boolean;           // the COMPASS_% read resolves an error
  compassOff?: boolean;           // COMPASS_ENABLED read, and false
  places?: unknown[];
  privacyError?: boolean;         // the person-card gate's reads fail
  travelerListError?: boolean;    // the traveler candidate read (profiles, .neq) fails
  throwTables?: string[];         // `from(table)` THROWS (a client fault, not a PostgREST error)
  projectionThrows?: boolean;     // the traveler's own profile row makes the person projection throw
  postsOnly?: "city" | "global";  // only the city-scoped (ilike) or only the global posts read fails
}
const writes: string[] = [];
function world(w: World) {
  function builder(table: string) {
    const calls: Record<string, unknown[]> = {};
    const answer = (single: boolean): { data: unknown; error: unknown } => {
      if (table === "feature_flags" && calls.like) {
        if (w.flagsError) return { data: null, error: DB_ERR };
        return { data: [{ flag: "COMPASS_ENABLED", enabled: !w.compassOff }, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }], error: null };
      }
      if (table === "feature_flags") return { data: single && calls.eq?.[1] === "COMPASS_FEED_ENABLED" ? { enabled: true } : null, error: null };
      if (w.failTables?.includes(table)) return { data: null, error: DB_ERR };
      if (table === "posts" && w.postsOnly && (w.postsOnly === "city") === (calls.ilike !== undefined)) return { data: null, error: DB_ERR };
      if ((table === "profile_privacy_settings" || table === "user_privacy_settings") && w.privacyError) return { data: null, error: DB_ERR };
      if (table === "profiles" && calls.select?.[0] === "account_status") return { data: { account_status: "active" }, error: null };
      if (table === "profiles" && single && w.projectionThrows && calls.eq?.[1] === TRAVELER) return { data: new Proxy({}, { get(_t, k) { if (k === "then") return undefined; throw new Error("projection fault"); } }), error: null };
      if (table === "profiles" && calls.neq && w.travelerListError) return { data: null, error: DB_ERR };
      if (table === "profiles" && calls.neq) return { data: [{ id: TRAVELER, home_city: "Paris", spoken_languages: [], interests: [], verified: false, account_status: "active", is_private: false, created_at: new Date().toISOString() }], error: null };
      if (table === "profiles") return { data: single ? { id: VIEWER, account_status: "active" } : [], error: null };
      if (table === "user_location_state") return { data: single ? { city: "Paris" } : [], error: null };
      if (table === "discovery_places") return { data: w.places ?? [PLACE_A], error: null };
      return { data: single ? null : [], error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer(true));
        if (prop === "upsert" || prop === "insert" || prop === "update" || prop === "delete") return (...args: unknown[]) => { writes.push(table); calls[prop] = args; return b; };
        return (...args: unknown[]) => { calls[prop] = args; return b; };
      },
    });
    return b;
  }
  return {
    auth: { getUser: async (tok: string) => (tok === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (table: string) => { if (w.throwTables?.includes(table)) throw new Error(`${table}: socket hang up`); return builder(table); },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}
const itemsOf = (body: any) => (body.sections ?? []).flatMap((s: any) => s.items ?? []);

describe("§104 round 8: every Compass arm a Discovery screen reads says a failed read", () => {
  beforeEach(() => { writes.length = 0; });

  it("S3 section: one source failed, one read → the read rows, marked partial, naming the failed table", async () => {
    _setTestClient(world({ failTables: ["posts"] }) as any, true);
    const { status, body } = await get("/compass/feed/section/for_you?city=Paris");
    assert.equal(status, 200);
    assert.ok(itemsOf(body).length > 0, "the rows that WERE read are served");
    assert.equal(body.fallbackReason, "compass_sources_unread");
    assert.equal(body.fallback, true);
    assert.equal(body.compassEnabled, true);
    assert.equal(body.refusal?.coverage, "partial");
    assert.deepEqual(body.refusal?.failedSources, ["posts"]);
  });

  it("S4 section: a partial section is written to no cache (not the DB cache, not L1)", async () => {
    _setTestClient(world({ failTables: ["posts"], places: [PLACE_A] }) as any, true);
    await get("/compass/feed/section/for_you?city=Paris");
    assert.ok(!writes.includes("compass_feed_cache"), "the partial section was written to the DB cache");
    _setTestClient(world({ places: [PLACE_A, PLACE_B] }) as any, true);
    const { body } = await get("/compass/feed/section/for_you?city=Paris");
    assert.equal(body.refusal, undefined);
    assert.equal(itemsOf(body).length, 2, "the partial section was replayed from L1");
  });

  it("S5 CONTROL section: every source read → no refusal, and the section IS cached", async () => {
    _setTestClient(world({}) as any, true);
    const { body } = await get("/compass/feed/section/compass_picks?city=Paris");
    assert.equal(body.refusal, undefined);
    assert.equal(body.fallback, false);
    assert.deepEqual(Object.keys(body), ["sections", "nextCursor", "fallback", "compassEnabled"]);
    assert.ok(writes.includes("compass_feed_cache"), "a healthy section is cached as before");
  });

  it("F1 full feed: a failed source is refused and not cached; F2 CONTROL a healthy feed carries no refusal", async () => {
    _setTestClient(world({ failTables: ["events"] }) as any, true);
    const failed = await get("/compass/feed");
    assert.equal(failed.body.refusal?.code, "compass_sources_unread");
    assert.deepEqual(failed.body.refusal?.failedSources, ["events"]);
    assert.ok(!writes.includes("compass_feed_cache"), "the feed built from a failed read was cached");
    writes.length = 0; clearL1Cache();
    _setTestClient(world({}) as any, true);
    const healthy = await get("/compass/feed");
    assert.equal(healthy.body.refusal, undefined);
    assert.ok(writes.includes("compass_feed_cache"));
  });

  it("R3 recommendations: an UNREAD flag table is refused, never the Compass-off empty list", async () => {
    _setTestClient(world({ flagsError: true }) as any, true);
    const { body } = await get("/compass/recommendations?surface=search&q=zzqq&city=Paris&limit=6");
    assert.deepEqual(body.recommendations, []);
    assert.equal(body.refusal?.code, "compass_flags_unreadable");
    assert.equal(body.refusal?.coverage, "nothing");
    assert.deepEqual(body.refusal?.failedSources, ["feature_flags"]);
  });

  it("R3c CONTROL: flags READ and Compass off → the old body, byte for byte", async () => {
    _setTestClient(world({ compassOff: true }) as any, true);
    const r = await fetch(`${base}/compass/recommendations?surface=search&q=zzqq&city=Paris&limit=6`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(await r.text(), JSON.stringify({ recommendations: [], surface: "search" }));
  });

  it("R4 surface=search: one source failed → the answer names it", async () => {
    // compass_picks keeps only finalScore >= 70, so this world's place does not reach it:
    // the rail is empty, and it is empty because of the failure as far as anyone can tell.
    _setTestClient(world({ failTables: ["posts"] }) as any, true);
    const { body } = await get("/compass/recommendations?surface=search&q=food&city=Paris&limit=6");
    assert.equal(body.refusal?.code, "compass_sources_unread");
    assert.deepEqual(body.refusal?.failedSources, ["posts"]);
  });

  it("R4b the same arm with rows (surface=for_you): the read rows, marked partial", async () => {
    _setTestClient(world({ failTables: ["posts"] }) as any, true);
    const { body } = await get("/compass/recommendations?surface=for_you&city=Paris&limit=6");
    assert.ok(body.recommendations.length > 0);
    assert.equal(body.refusal?.coverage, "partial");
    assert.deepEqual(body.refusal?.failedSources, ["posts"]);
  });

  it("R4c CONTROL: every source read → no refusal key at all (search and for_you)", async () => {
    _setTestClient(world({}) as any, true);
    const search = await get("/compass/recommendations?surface=search&q=food&city=Paris&limit=6");
    assert.ok(!("refusal" in search.body));
    const forYou = await get("/compass/recommendations?surface=for_you&city=Paris&limit=6");
    assert.ok(forYou.body.recommendations.length > 0);
    assert.ok(!("refusal" in forYou.body));
  });

  it("R5 surface=traveler: the candidate read fails → refused `nothing`, naming profiles", async () => {
    _setTestClient(world({ travelerListError: true }) as any, true);
    const { body } = await get("/compass/recommendations?surface=traveler&city=Paris&limit=6");
    assert.deepEqual(body.recommendations, []);
    assert.equal(body.refusal?.code, "traveler_read_failed");
    assert.deepEqual(body.refusal?.failedSources, ["profiles"]);
  });

  it("R6 surface=traveler: the person gate could not be read → the page names it", async () => {
    _setTestClient(world({ privacyError: true }) as any, true);
    const { body } = await get("/compass/recommendations?surface=traveler&city=Paris&limit=6");
    assert.ok(body.refusal, "a person withheld unchecked was answered as no match");
    assert.ok(body.refusal.failedSources.includes("profile_privacy_settings"));
  });

  it("R6c CONTROL surface=traveler: gate and list read → no refusal", async () => {
    _setTestClient(world({}) as any, true);
    const { body } = await get("/compass/recommendations?surface=traveler&city=Paris&limit=6");
    assert.ok(!("refusal" in body), JSON.stringify(body).slice(0, 300));
  });

  it("R7 surface=buddy: the block list or the buddy table unread → refused `nothing`", async () => {
    _setTestClient(world({ failTables: ["blocks"] }) as any, true);
    const blk = await get("/compass/recommendations?surface=buddy&city=Paris&limit=4");
    assert.equal(blk.body.refusal?.code, "block_check_failed");
    assert.equal(blk.body.error, "block_check_failed", "the old marker is kept for old clients");
    _setTestClient(world({ failTables: ["rent_buddy_profiles"] }) as any, true);
    const rows = await get("/compass/recommendations?surface=buddy&city=Paris&limit=4");
    assert.equal(rows.body.refusal?.code, "buddy_read_failed");
    assert.deepEqual(rows.body.refusal?.failedSources, ["rent_buddy_profiles"]);
  });

  it("R8 surface=passport: the block list unread → refused, never the empty list", async () => {
    _setTestClient(world({ failTables: ["blocks"] }) as any, true);
    const { body } = await get("/compass/recommendations?surface=passport&limit=8");
    assert.deepEqual(body.recommendations, []);
    assert.equal(body.refusal?.code, "block_check_failed");
    assert.equal(body.refusal?.coverage, "nothing");
  });

  it("R9 surface=trip: every source failed → the static tips are not a complete brief", async () => {
    _setTestClient(world({ failTables: ["posts", "rent_buddy_profiles", "discovery_places", "events", "hidden_gems"] }) as any, true);
    const { body } = await get("/compass/recommendations?surface=trip&city=Paris&limit=6");
    assert.ok(body.refusal, "a brief built from failed reads carried no refusal");
    assert.equal(body.refusal.failedSources.length, 5);
  });

  it("R10 a thrown build is refused, never `[]`", async () => {
    // The probe's single-object `profiles` answer makes the traveler list's `.filter` throw.
    _setTestClient(fakeClient({ failSources: false }) as any, true);
    const { body } = await get("/compass/recommendations?surface=traveler&city=Paris&limit=6");
    assert.deepEqual(body.recommendations, []);
    assert.equal(body.refusal?.code, "recommendations_build_failed");
  });
});

describe("§104 round 8: the other callers of the hydrator", () => {
  it("H1 hydrateCompassItems names each failed source by its table; H1c a healthy pool names none", async () => {
    const { hydrateCompassItems, compassHydrationFailedSources } = await import("../compass/CompassItemHydrator.js");
    const profile: any = { userId: VIEWER, currentCity: "Paris", blockedUserIds: [], blockerUserIds: [] };
    const failed = await hydrateCompassItems(world({ failTables: ["events", "discovery_places"] }) as any, profile);
    assert.deepEqual([...compassHydrationFailedSources(failed)].sort(), ["discovery_places", "events"]);
    const healthy = await hydrateCompassItems(world({}) as any, profile);
    assert.deepEqual(compassHydrationFailedSources(healthy), []);
    assert.ok(healthy.length > 0);
  });

  it("H2 the Compass home's best move: an empty pool from failed reads is `unavailable`, not `ok` + nothing", async () => {
    const { buildCompassHomeProjection } = await import("../routes/compassHome.js");
    const all = ["posts", "rent_buddy_profiles", "discovery_places", "events", "hidden_gems"];
    const failed = await buildCompassHomeProjection(world({ failTables: all }) as any, VIEWER, { localHour: 12 });
    assert.equal(failed.sources.bestNextMove, "unavailable");
    const empty = await buildCompassHomeProjection(world({ places: [] }) as any, VIEWER, { localHour: 12 });
    assert.equal(empty.sources.bestNextMove, "ok", "CONTROL: a pool that was READ and is empty stays Compass's answer");
  });

  it("H3 the front-load engine does not preload a first page built from a failed read; H3c a healthy one does", async () => {
    const { buildFrontLoadPayload } = await import("../compass/CompassFrontLoadEngine.js");
    const { getCompassProfile } = await import("../compass/CompassProfileService.js");
    clearL1Cache();
    const failedDb = world({ failTables: ["posts"] }) as any;
    const failed = await buildFrontLoadPayload(failedDb, VIEWER, await getCompassProfile(failedDb, VIEWER), { networkHint: "wifi" });
    assert.equal(failed.tier1.find((i) => i.type === "first_feed_page")?.data, null);
    clearL1Cache();
    const okDb = world({}) as any;
    const healthy = await buildFrontLoadPayload(okDb, VIEWER, await getCompassProfile(okDb, VIEWER), { networkHint: "wifi" });
    assert.notEqual(healthy.tier1.find((i) => i.type === "first_feed_page")?.data, null);
  });
});

describe("§104 round 8: the thrown arms (a client fault, not a PostgREST error)", () => {
  it("T1 buddy and traveler: the block list read THROWS → refused, never []", async () => {
    _setTestClient(world({ throwTables: ["blocks"] }) as any, true);
    for (const surface of ["buddy", "traveler"]) {
      const { body } = await get(`/compass/recommendations?surface=${surface}&city=Paris&limit=4`);
      assert.deepEqual(body.recommendations, [], surface);
      assert.equal(body.refusal?.code, "block_check_failed", surface);
    }
  });

  it("T2 passport: the block list read THROWS → refused, never []", async () => {
    _setTestClient(world({ throwTables: ["blocks"] }) as any, true);
    const { body } = await get("/compass/recommendations?surface=passport&limit=8");
    assert.equal(body.refusal?.code, "block_check_failed");
  });

  it("T3 a candidate source THROWS → it is named like a resolved error", async () => {
    const { hydrateCompassItems, compassHydrationFailedSources } = await import("../compass/CompassItemHydrator.js");
    const profile: any = { userId: VIEWER, currentCity: "Paris", blockedUserIds: [], blockerUserIds: [] };
    for (const t of ["posts", "rent_buddy_profiles", "discovery_places", "events", "hidden_gems"]) {
      const items = await hydrateCompassItems(world({ throwTables: [t] }) as any, profile);
      assert.deepEqual([...compassHydrationFailedSources(items)], [t], t);
    }
  });

  it("T4 with no city: the posts and events reads that still run are named when they fail", async () => {
    const { hydrateCompassItems, compassHydrationFailedSources } = await import("../compass/CompassItemHydrator.js");
    const profile: any = { userId: VIEWER, currentCity: null, blockedUserIds: [], blockerUserIds: [] };
    const items = await hydrateCompassItems(world({ failTables: ["posts", "events"] }) as any, profile);
    assert.deepEqual([...compassHydrationFailedSources(items)].sort(), ["events", "posts"]);
    const ok = await hydrateCompassItems(world({}) as any, profile);
    assert.deepEqual(compassHydrationFailedSources(ok), [], "CONTROL: with no city the city-scoped sources are not read, and nothing failed");
  });

  it("T5 each source alone: one failed read names exactly that table", async () => {
    const { hydrateCompassItems, compassHydrationFailedSources } = await import("../compass/CompassItemHydrator.js");
    const profile: any = { userId: VIEWER, currentCity: "Paris", blockedUserIds: [], blockerUserIds: [] };
    for (const t of ["posts", "rent_buddy_profiles", "discovery_places", "events", "hidden_gems"]) {
      const items = await hydrateCompassItems(world({ failTables: [t] }) as any, profile);
      assert.deepEqual([...compassHydrationFailedSources(items)], [t], t);
    }
  });

  it("T7 posts: the city-scoped read and the global read are each a read of the source", async () => {
    const { hydrateCompassItems, compassHydrationFailedSources } = await import("../compass/CompassItemHydrator.js");
    const profile: any = { userId: VIEWER, currentCity: "Paris", blockedUserIds: [], blockerUserIds: [] };
    for (const only of ["city", "global"] as const) {
      const items = await hydrateCompassItems(world({ postsOnly: only }) as any, profile);
      assert.deepEqual([...compassHydrationFailedSources(items)], ["posts"], only);
    }
  });

  it("T6 traveler: a person projection that throws makes the page name it", async () => {
    _setTestClient(world({ projectionThrows: true }) as any, true);
    const { body } = await get("/compass/recommendations?surface=traveler&city=Paris&limit=6");
    assert.ok(body.refusal, JSON.stringify(body).slice(0, 300));
    assert.ok(body.refusal.failedSources.includes("passport_projection"));
  });
});

describe("§104 round 8: GET /compass/why says a failed lookup (D-W11X2-58)", () => {
  async function tokenFor(userId: string) {
    const { encodeRecommendationToken } = await import("../compass/CompassExplanationEngine.js");
    return encodeRecommendationToken({ userId, itemId: "place:1", itemType: "place", sectionName: "for_you", explanationKey: "k" } as any);
  }

  it("W1 the served-recommendation lookup fails → refused, never \"not found\"", async () => {
    _setTestClient(world({ failTables: ["compass_served_recommendations"] }) as any, true);
    const { body } = await get(`/compass/why/${encodeURIComponent(await tokenFor(VIEWER))}`);
    assert.equal(body.refusal?.code, "why_unavailable");
    assert.deepEqual(body.refusal?.failedSources, ["compass_served_recommendations"]);
  });

  it("W2 the lookup THROWS → refused, never the generic reason as the explanation", async () => {
    _setTestClient(world({ throwTables: ["compass_served_recommendations"] }) as any, true);
    const { body } = await get(`/compass/why/${encodeURIComponent(await tokenFor(VIEWER))}`);
    assert.equal(body.refusal?.code, "why_unavailable");
    assert.deepEqual(body.refusal?.failedSources, ["compass_why"]);
  });

  it("W1c CONTROL a token for someone else, and a lookup that READ no row, are answers: no refusal", async () => {
    _setTestClient(world({}) as any, true);
    const other = await get(`/compass/why/${encodeURIComponent(await tokenFor(TRAVELER))}`);
    assert.ok(!("refusal" in other.body));
    const none = await get(`/compass/why/${encodeURIComponent(await tokenFor(VIEWER))}`);
    assert.ok(!("refusal" in none.body));
    assert.match(none.body.explanation, /not found/);
  });
});

// ── census-discovery §105 (DV-83 round 9, D-W11X2-64): the round-8 verifier's survivors ──
//
// SM14 forced `sendRecommendations`' coverage to "partial" with zero rows and survived:
// nothing pinned `nothing` on the feed-based surfaces. SM15 replaced the build catch's
// `compass_flags_unreadable` with `recommendations_build_failed` and survived: no test
// threw CompassFlagsUnreadableError into the build. Both are pinned here.

/** The route's own COMPASS_ENABLED read succeeds (and is cached); every later COMPASS_% read — the pipeline's uncached one — fails. */
function flagsFailAfterFirstRead(w: World) {
  const c = world(w);
  let likeReads = 0;
  const failing: any = new Proxy({}, {
    get(_t, p: string) {
      if (p === "then") return (f: any, r: any) => Promise.resolve({ data: null, error: DB_ERR }).then(f, r);
      return () => failing;
    },
  });
  return {
    ...c,
    from: (t: string) => {
      const target: any = c.from(t);
      if (t !== "feature_flags") return target;
      const wrap: any = new Proxy({}, {
        get(_x, p: string) {
          if (p === "then") return (f: any, r: any) => target.then(f, r);
          if (p === "maybeSingle" || p === "single") return () => target[p]();
          if (p === "like") return (...a: unknown[]) => { likeReads += 1; target.like(...a); return likeReads > 1 ? failing : wrap; };
          return (...a: unknown[]) => { target[p](...a); return wrap; };
        },
      });
      return wrap;
    },
  };
}

describe("§105 round 9: the round-8 verifier's survivors on /compass/recommendations", () => {
  it("SM14 zero rows because a candidate source failed → coverage `nothing`, never `partial`", async () => {
    _setTestClient(world({ failTables: ["posts"] }) as any, true);
    const { body } = await get("/compass/recommendations?surface=search&q=food&city=Paris&limit=6");
    assert.deepEqual(body.recommendations, [], "the premise: the search rail read no rows");
    assert.equal(body.refusal?.code, "compass_sources_unread");
    assert.equal(body.refusal?.coverage, "nothing", "an empty list over a failed read carries nothing, so `partial` would claim rows that are not there");
  });

  it("SM14b the same failure with rows → `partial` (the other arm of the same line)", async () => {
    _setTestClient(world({ failTables: ["posts"] }) as any, true);
    const { body } = await get("/compass/recommendations?surface=for_you&city=Paris&limit=6");
    assert.ok(body.recommendations.length > 0);
    assert.equal(body.refusal?.coverage, "partial");
  });

  it("SM15 the build throws CompassFlagsUnreadableError (the pipeline's flag read failed) → `compass_flags_unreadable`, naming feature_flags", async () => {
    _setTestClient(flagsFailAfterFirstRead({}) as any, true);
    const { status, body } = await get("/compass/recommendations?surface=for_you&city=Paris&limit=6");
    assert.equal(status, 200);
    assert.deepEqual(body.recommendations, []);
    assert.equal(body.refusal?.code, "compass_flags_unreadable", JSON.stringify(body).slice(0, 300));
    assert.equal(body.refusal?.coverage, "nothing");
    assert.deepEqual(body.refusal?.failedSources, ["feature_flags"]);
  });
});
