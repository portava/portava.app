/**
 * discoveryVerifyExplain.db.test.ts — census-discovery §59 (verification lane
 * P12), DV-52: `05` §9 *"Graph Engine is useful when: … it remains explainable
 * enough for debugging"* (docs/specs/discovery-v1/05_Graph_Engine.md:125).
 *
 * Every debug / explain surface the tree has for the graph and for Discovery's
 * ranking, driven through its REAL route on a real PostgreSQL 16 with
 * CONTROLLED rows, and each asked the two questions the verification brief
 * sets: does it explain, and does it ever hand another viewer's data or a raw
 * score to a non-admin?
 *
 *   X1  FLIPPED at §62 (was: DEFECT, pinned — every debug sample omitted the NOT
 *       NULL content_type/content_id of production's `ranking_debug_samples`,
 *       was refused 23502, and was swallowed). The writer now supplies the type
 *       always and a uuid content_id where the item has one, and 3421 lets a
 *       Discovery sample carry none: every sample LANDS, and the admin reads it.
 *   X2  GET /admin/ranking/debug-samples, on controlled rows: an admin reads
 *       the breakdowns (raw scores included); a signed-in non-admin gets 403
 *       and not one byte of either viewer's sample; no token is 401.
 *   X3  GET /compass/graph/status (the graph's debug read): admin-only, counts
 *       equal to the tables', each city's depth; the non-admin is refused.
 *   X4  GET /compass/city-confidence (the graph read any signed-in user has):
 *       exactly five aggregate keys — never `signals`, never a person node key.
 *   X5  GET /discovery to a signed-in non-admin, on the legacy-ranked cold
 *       fetch: no score, component or feature vector on the response, and no
 *       other viewer's id anywhere in it. With the ranking experiment flag on
 *       (in memory) the same serve exercises X1 on the LIVE path: one debug
 *       sample per candidate, every one landed (§62; was: every one refused).
 *   X0  the flag rows were never written; every request was modelled; the
 *       database refused nothing (§62; was: exactly the five samples above).
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import pino from "pino";
import { HAVE_DB, exec, scalar, seedUser } from "./localDb.js";
import { bridge, lit, type Bridge } from "./discoveryVerifyBridge.js";
import { _setTestClient } from "../../lib/http.js";
import { _setTestServiceClient } from "../../lib/supabase.js";
import discoveryRouter, {
  _setTestDbPlacesOverride, _clearTestCacheEntry, _clearTestCompassCache, type DiscoveryPlace,
} from "../../routes/discovery.js";
import adminRankingConfigRouter from "../../routes/adminRankingConfig.js";
import compassGraphRouter from "../../routes/compassGraph.js";
import { invalidateServeLogFlagCache, _resetServeRequestTableLatch } from "../../lib/discoveryServeLog.js";
import { invalidateDiscoveryEngineModeCache } from "../../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../../compass/flags.js";
import { rankItems, type RankingInput, type RankingViewerContext } from "../../services/ranking/DiscoveryRankingService.js";

const CITY = "p12explaincity";
const KEY = `${CITY}:for_you:10`;
let viewerA = "", viewerB = "", admin = "";
const users: string[] = [];
const sampleIds: string[] = [];
let server: Server | null = null;
let base = "";
let b: Bridge;

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("network blocked");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

async function call(path: string, token: string | null): Promise<{ status: number; body: any; text: string }> {
  const res = await _originalFetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

function drsInput(itemId: string): RankingInput {
  return {
    itemId, itemType: "place", creatorId: null, createdAt: null, city: CITY, country: null, tags: ["food"],
    category: "for_you", languageCode: null, hasMedia: false, completeness: 0.5, positiveReviewRate: null,
    flagCount: 0, saveCount: 3, shareCount: 0, commentCount: 0, impressionCount: 3, uniqueViewerCount: 3,
    lat: null, lng: null, distanceKm: 1,
    isDeleted: false, isExpired: false, isSuspended: false, isModerated: false, isPrivate: false,
    isAgeRestricted: false, minAgeRequired: null, isGeoRestricted: false, geoRestrictionCountries: null,
    authorIsBlockedByViewer: false, authorBlocksViewer: false, authorIsMutedByViewer: false,
    viewerHasReportedItem: false, viewerHasHiddenItem: false, viewerHasHiddenCreator: false,
    repeatCount: null, expiresAt: null, accountAgeDays: null, isUnfamiliarCategory: false, isFirstImpression: false,
  } as unknown as RankingInput;
}

describe("DV-52 — the graph and Discovery's debug surfaces explain, and only to an admin (census-discovery §59)", { skip: !HAVE_DB }, () => {
  let flagRowsBefore = "";
  const seeded = { nodes: [] as string[], edges: [] as string[] };

  before(async () => {
    viewerA = seedUser("p12xA"); viewerB = seedUser("p12xB"); admin = seedUser("p12xAdmin");
    users.push(viewerA, viewerB, admin);
    exec(`UPDATE public.profiles SET role = 'admin' WHERE id = '${admin}';`);
    flagRowsBefore = scalar(`SELECT COALESCE(json_agg(t ORDER BY flag), '[]'::json)::text FROM (SELECT flag, enabled FROM public.feature_flags WHERE flag IN ('RANKING_EXPERIMENT_ENABLED','discovery_serve_log_enabled','DISCOVERY_ENGINE_MODE')) t`) ?? "";
    b = bridge({
      flags: { discovery_serve_log_enabled: { enabled: true }, RANKING_EXPERIMENT_ENABLED: { enabled: true } },
      tokens: { "a-token": viewerA, "b-token": viewerB, "admin-token": admin },
    });
    _setTestClient(b.client, true);
    _setTestServiceClient(b.client);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
    app.use("/api", discoveryRouter);
    app.use("/api", adminRankingConfigRouter);
    app.use("/api", compassGraphRouter);
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server!.address() as any).port}`;
  });

  after(async () => {
    globalThis.fetch = _originalFetch;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
    const u = users.map(lit).join(",");
    exec(
      `DELETE FROM public.ranking_debug_samples WHERE viewer_id IN (${u});\n` +
      `DELETE FROM public.compass_graph_edges WHERE src_key LIKE 'p12x-%' OR dst_key LIKE 'p12x-%' OR src_key IN (${u}) OR dst_key IN (${u});\n` +
      `DELETE FROM public.compass_graph_nodes WHERE node_key LIKE 'p12x-%' OR node_key IN (${u});\n` +
      `DELETE FROM public.compass_city_confidence WHERE city = ${lit(CITY)};\n` +
      `DELETE FROM public.rank_events WHERE user_id IN (${u});\n` +
      `DELETE FROM public.recommendations WHERE user_id IN (${u});\n` +
      `DELETE FROM public.profiles WHERE id IN (${u});\n` +
      `DELETE FROM auth.users WHERE id IN (${u});`,
    );
  });

  // §59 pinned DV-52 here as test("X1. DEFECT, pinned: the DRS debug sample omits production's NOT NULL content_type/content_id — every sample is refused and swallowed"). §62 flipped it:
  test("X1. FLIPPED (§62): the DRS debug sample carries content_type, a content_id only for a uuid item, and LANDS — the admin read returns it", async () => {
    const x1Session = randomUUID(), dbItem = "db/" + randomUUID(), uuidItem = randomUUID();   // uuidItem: a post-shaped item whose id IS a uuid
    const viewer = {
      viewerId: viewerA, travelStyles: ["food"], preferredLanguages: [], preferredCities: [CITY], currentCity: CITY,
      currentCountry: null, lat: null, lng: null, viewerAge: null, followedCreatorIds: new Set<string>(),
      mutedCreatorIds: new Set<string>(), blockedCreatorIds: new Set<string>(), seenItemIds: new Set<string>(),
      sessionId: x1Session, lastActiveAt: null,
    } as RankingViewerContext;
    const realRandom = Math.random;
    Math.random = () => 0;   // sample EVERY item (the writer samples 1-in-10)
    let out: unknown[] = [];
    try {
      out = await rankItems([drsInput(dbItem), drsInput("node/9912001"), { ...drsInput(uuidItem), itemType: "post" } as RankingInput], "discovery", viewer, b.client,
        { flags: { RANKING_EXPERIMENT_ENABLED: true } } as any, { emitPerCandidateAnalytics: false });
    } finally { Math.random = realRandom; }
    assert.equal(out.length, 3, "precondition: the ranker ran and scored all three items");
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(b.failed.filter((f) => f.includes("/rest/v1/ranking_debug_samples")), [], `no sample was refused (was: each refused 23502):\n${b.failed.join("\n")}`);
    const landed = (scalar(`SELECT string_agg(item_id || '|' || content_type || '|' || coalesce(content_id::text, '-'), ',') FROM public.ranking_debug_samples WHERE viewer_id = '${viewerA}' AND session_id = '${x1Session}'`) ?? "").split(",").sort();
    assert.deepEqual(landed, [`${dbItem}|place|-`, `node/9912001|place|-`, `${uuidItem}|post|${uuidItem}`].sort(), "every sample lands: a type always, a uuid content_id only where the item id is one");
    const asAdmin = await call("/api/admin/ranking/debug-samples?surface=discovery&limit=200", "admin-token");
    assert.deepEqual([asAdmin.status, (asAdmin.body.samples as any[]).filter((s) => s.session_id === x1Session && s.components && typeof s.explanation_key === "string").length], [200, 3], "the admin read returns the sampler's OWN rows now");
  });

  test("X2. the admin debug read explains with raw scores — to an admin only; a non-admin reads nothing of either viewer", async () => {
    for (const [viewer, score] of [[viewerA, 12.3456], [viewerB, 65.4321]] as const) {
      sampleIds.push(scalar(
        `INSERT INTO public.ranking_debug_samples (viewer_id, content_type, content_id, final_score, surface, item_id, session_id, components, explanation_key) ` +
        `VALUES ('${viewer}', 'place', gen_random_uuid(), ${score}, 'discovery', 'db/p12x-${viewer.slice(0, 8)}', 'p12x', '{"freshness": ${score}, "geographicRelevance": 1.5}'::jsonb, 'discovery:place:local') RETURNING id`)!);
    }
    const asAdmin = await call("/api/admin/ranking/debug-samples?surface=discovery&limit=200", "admin-token");
    assert.equal(asAdmin.status, 200, asAdmin.text.slice(0, 300));
    const mine = (asAdmin.body.samples as any[]).filter((s) => sampleIds.includes(String(s.id)));
    assert.equal(mine.length, 2, "the admin sees both viewers' breakdowns");
    assert.deepEqual(mine.map((s) => Number(s.final_score)).sort(), [12.3456, 65.4321]);
    assert.ok(mine.every((s) => s.components && typeof s.explanation_key === "string"), "each sample says HOW it was scored and which reason it was served under");

    const asA = await call("/api/admin/ranking/debug-samples?surface=discovery", "a-token");
    assert.equal(asA.status, 403, asA.text.slice(0, 300));
    for (const leak of [viewerA, viewerB, "65.4321", "12.3456", "components", "final_score"]) {
      assert.ok(!asA.text.includes(leak), `the non-admin's 403 carries no ${leak}`);
    }
    const anon = await call("/api/admin/ranking/debug-samples?surface=discovery", null);
    assert.equal(anon.status, 401);
    assert.ok(!anon.text.includes("65.4321"));
  });

  test("X3. the graph's debug read is admin-only and its counts are the tables' own", async () => {
    const node = (type: string, key: string) => {
      const id = scalar(`INSERT INTO public.compass_graph_nodes (node_type, node_key, city, attrs) VALUES ('${type}', ${lit(key)}, ${lit(CITY)}, '{}'::jsonb) RETURNING id`)!;
      seeded.nodes.push(id);
    };
    node("person", viewerB);           // a person node's key IS a user id
    node("place", "p12x-place-1");
    node("city", `p12x-${CITY}`);
    seeded.edges.push(scalar(
      `INSERT INTO public.compass_graph_edges (src_type, src_key, dst_type, dst_key, edge_type, weight, observed_count, first_seen, last_seen, attrs) ` +
      `VALUES ('person', '${viewerB}', 'place', 'p12x-place-1', 'visited', 1, 3, now() - interval '9 days', now() - interval '1 day', '{}'::jsonb) RETURNING id`)!);
    exec(`INSERT INTO public.compass_city_confidence (city, depth_score, tier, signals, computed_at) VALUES (${lit(CITY)}, 41, 'moderate', '{"visitors": 3, "p12x_marker": 7}'::jsonb, now());`);

    const status = await call("/api/compass/graph/status", "admin-token");
    assert.equal(status.status, 200, status.text.slice(0, 300));
    assert.equal(status.body.nodes, Number(scalar(`SELECT count(1) FROM public.compass_graph_nodes`)));
    assert.equal(status.body.edges, Number(scalar(`SELECT count(1) FROM public.compass_graph_edges`)));
    const city = (status.body.cities as any[]).find((c) => c.city === CITY);
    assert.deepEqual([Number(city?.depth_score), city?.tier], [41, "moderate"], "each city's depth, as stored");
    assert.ok("lastRebuildAt" in status.body && "lastOutcome" in status.body, "and the last rebuild's time and outcome");

    const asA = await call("/api/compass/graph/status", "a-token");
    assert.equal(asA.status, 403);
    assert.ok(!asA.text.includes(CITY) && !asA.text.includes(viewerB));
  });

  test("X4. the graph read any signed-in user has returns five aggregate keys — never signals, never a person node key", async () => {
    const r = await call(`/api/compass/city-confidence?city=${CITY}`, "a-token");
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual(Object.keys(r.body).sort(), ["city", "computedAt", "depthScore", "note", "tier"]);
    assert.equal(r.body.depthScore, 41);
    for (const leak of [viewerB, "signals", "p12x_marker", "visitors", "p12x-place-1"]) {
      assert.ok(!r.text.includes(leak), `no ${leak} reaches a non-admin`);
    }
  });

  test("X5. a Discovery serve to a signed-in non-admin carries no score, component or feature vector, and no other viewer's id", async () => {
    invalidateServeLogFlagCache(); invalidateDiscoveryEngineModeCache(); invalidateFlagsCache();
    _resetServeRequestTableLatch(); _clearTestCompassCache(); _clearTestCacheEntry(KEY);
    const places: DiscoveryPlace[] = [0, 1, 2].map((i) => ({
      id: `db/${randomUUID()}`, name: `p12x-${i}`, category: "for_you", type: "traveler_pick", description: null,
      distanceKm: 1 + i, lat: 38.7, lng: -9.1, tags: [], address: CITY, website: null, phone: null, openingHours: null,
      rating: null, isOpenNow: null, savedCount: 5 + i,
    }) as DiscoveryPlace);
    _setTestDbPlacesOverride(async () => places);
    const realRandom = Math.random;
    Math.random = () => 0;   // the in-request ranker's debug sample fires for EVERY candidate (X1, on the live path)
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call(`/api/discovery?destination=${CITY}&lat=38.7&lng=-9.1`, "a-token");
      await new Promise((res) => setTimeout(res, 500));
    } finally {
      Math.random = realRandom;
    }
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const refused = b.failed.filter((f) => f.includes("/rest/v1/ranking_debug_samples") && /23502/.test(f));
    assert.equal(refused.length, 0, `the cold fetch's ranker sampled every candidate and none was refused (was: 2 + 3 refused 23502):\n${b.failed.join("\n")}`);
    assert.equal(Number(scalar(`SELECT count(1) FROM public.ranking_debug_samples WHERE viewer_id = '${viewerA}' AND session_id IS NULL AND surface = 'discovery' AND content_type = 'place' AND content_id IS NULL`)), 3,
      "one landed per candidate (the PDE's DRS pass has no session id; X1's and X2's rows carry theirs)");
    assert.equal(r.body?.meta?.cacheLevel, "miss", "precondition: the cold fetch, which ranks in-request");
    const items = r.body.places as any[];
    assert.equal(items.length, 3);
    const forbidden = ["score", "finalScore", "final_score", "components", "features", "scoreBreakdown", "rankScore"];
    for (const it of items) for (const k of forbidden) assert.ok(!(k in it), `no ${k} on a served item`);
    assert.ok(!r.text.includes(viewerB) && !r.text.includes(admin), "no other viewer's id anywhere in the response");
  });

  test("X0. the flag rows were never written, and every request was modelled", () => {
    const after = scalar(`SELECT COALESCE(json_agg(t ORDER BY flag), '[]'::json)::text FROM (SELECT flag, enabled FROM public.feature_flags WHERE flag IN ('RANKING_EXPERIMENT_ENABLED','discovery_serve_log_enabled','DISCOVERY_ENGINE_MODE')) t`) ?? "";
    assert.equal(after, flagRowsBefore);
    assert.deepEqual(b.unmodelled, [], b.unmodelled.join("\n"));
    // §62: the database refused NOTHING on any path this suite drove. Before the
    // fix it refused exactly the five debug samples X1 (2) and X5 (3) provoked.
    assert.equal(b.failed.length, 0, b.failed.join("\n"));
    assert.ok(b.failed.every((f) => f.startsWith("POST /rest/v1/ranking_debug_samples :: 23502 ")), b.failed.join("\n"));
  });
});
