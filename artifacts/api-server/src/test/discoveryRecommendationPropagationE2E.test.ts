/**
 * census-discovery §48 — DV-40 / DV-46 / DV-37, END TO END through the real routes:
 *
 *     GET /api/discovery  →  the id on the RESPONSE
 *                         →  the id on the stored rank_events row (or the
 *                            per-request row, for an anonymous serve)
 *     POST /api/rank-events/outcome { recommendation_id }
 *                         →  the SAME row moves, and nobody else's does.
 *
 * Every case runs the real `routes/discovery.ts` and `routes/rankEvents.ts`
 * against src/test/helpers/fakeDiscoveryTelemetryDb.ts, which ENFORCES 2891's
 * UNIQUE (recommendation_id, outcome), executes the compare-and-set update as
 * one statement, and reads served_at back in PostgREST's `+00:00` spelling.
 *
 * WHY IT EXISTS. Before §48 two serve points — the cold fetch (serve point 6)
 * and the PDE-cohort cache-A serve — logged through `lib/rankLog.logImpression`
 * with a session and clock of their own, so the `recommendationId` the route
 * put on its RESPONSE joined to no row at all (S6-1, S1-PDE below were RED on
 * the unfixed tree for exactly that). An anonymous serve got no id and left no
 * record (A1). An outcome carried no id, so an engagement could not be bound to
 * the exposure that caused it, and a replayed or concurrent outcome moved the
 * negative-signal counter twice (O7, O8).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryRecommendationPropagationE2E.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter, {
  _setTestDbPlacesOverride, _injectTestCacheEntry, _clearTestCacheEntry, _clearTestCompassCache,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import rankEventsRouter, { _resetRecommendationIdSchemaLatch } from "../routes/rankEvents.js";
import { invalidateServeLogFlagCache, DiscoveryServePoint, _resetServeRequestTableLatch } from "../lib/discoveryServeLog.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import {
  recommendationRecordsFromServeRequest, recommendationRecordFromRankEventsRow, ANONYMOUS_VIEWER_KEY,
} from "../lib/discoveryRecommendationRecord.js";
import { DISCOVERY_PDE_MODEL_VERSION } from "../lib/discoveryRankProvenance.js";
import { NEGATIVE_SIGNAL_RPC } from "../services/ranking/DiscoveryRankingService.js";
import { makeTelemetryDb } from "./helpers/fakeDiscoveryTelemetryDb.js";

// No network: Overpass and Nominatim fail at once, so the OSM half is empty
// unless a case seeds cache A, and every case supplies coordinates.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("network blocked");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const ALICE = "a11ce000-0000-4000-8000-000000000001";
const BOB   = "b0b00000-0000-4000-8000-000000000002";
const USERS = { "alice-token": ALICE, "bob-token": BOB };
const KEY   = "miami:for_you:10";
const Q     = "destination=Miami&lat=25.77&lng=-80.19";

const SERVE_LOG_ON = { discovery_serve_log_enabled: { enabled: true } };
const PDE_ALL = {
  ...SERVE_LOG_ON,
  DISCOVERY_ENGINE_MODE: { enabled: true, metadata: { mode: "pde", cohort: { kind: "all" } } },
  disable_discovery_pde: { enabled: false },
};

function place(id: string, savedCount: number): DiscoveryPlace {
  return {
    id: `db/${id}`, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1.0, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}
const FOUR = () => [place("p1", 1), place("p2", 2), place("p3", 3), place("p4", 500)];

let server: Server;
let base = "";
let db: ReturnType<typeof makeTelemetryDb>;

function install(opts: Parameters<typeof makeTelemetryDb>[0]) {
  db = makeTelemetryDb({ users: USERS, ...opts });
  _setTestClient(db.client as any, true);
  _setTestServiceClient(db.client as any);
}

async function getDiscovery(token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/discovery?${Q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

async function postOutcome(token: string | null, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/rank-events/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function postDirect(token: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/rank-events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Every serve-log write lands AFTER res.json. Poll for it; never guess. */
async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}
const quiesce = () => new Promise((r) => setTimeout(r, 120));

function idsOf(body: any): string[] {
  return (body.places ?? []).map((p: any) => p.recommendationId);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", discoveryRouter);
  app.use("/api", rankEventsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  globalThis.fetch = _originalFetch;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  invalidateServeLogFlagCache();
  invalidateDiscoveryEngineModeCache();
  invalidateFlagsCache();
  _resetRecommendationIdSchemaLatch();
  _resetServeRequestTableLatch();
  _clearTestCompassCache();
});

afterEach(() => {
  _clearTestCacheEntry(KEY);
  _setTestDbPlacesOverride(null);
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});

// ═════════════════════════════════════════════════════════════════════════════
// SERVE → RESPONSE → STORE: the id on the response IS the id on the row
// ═════════════════════════════════════════════════════════════════════════════

describe("§48 DV-40/46 — the id a response carries is the id the store holds, on every serve path", () => {
  it("S1. cache-A (legacy, signed-in): response id === row id at every position, column and features alike", async () => {
    install({ flags: SERVE_LOG_ON });
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    const r = await getDiscovery("alice-token");
    assert.equal(r.status, 200);
    const ids = idsOf(r.body);
    assert.equal(ids.length, 4, "every served item carries an id on the response");
    const rows = await until(() => db.impressions(), (x) => x.length >= 4);
    assert.equal(rows[0].features.servePoint, DiscoveryServePoint.CACHE_A_L1, "precondition: the cache-A L1 serve point wrote these");
    for (const row of rows) {
      assert.equal(row.recommendation_id, ids[row.position], `position ${row.position}: the column is the response's id`);
      assert.equal(row.features.recommendationId, ids[row.position], "and features.recommendationId is the same token");
      assert.equal(row.schema_version, 1, "DV-38 — the version is WRITTEN, not left to a default");
      assert.equal(row.privacy_class, "raw_behavioral_event", "DV-39 — the row's class is written");
      assert.equal(row.features.servedCount, 4, "DV-06 — the exposure carries its REQUEST's denominator");
    }
    const req = await until(() => db.serveRequests(), (x) => x.length >= 1);
    assert.equal(req.length, 1, "DV-06 — one per-request row");
    assert.equal(req[0].served_count, 4);
    assert.equal(rows[0].features.serveId, req[0].id, "every exposure names its request");
  });

  it("S6-1. serve point 6 (cold fetch, PDE-ranked, signed-in): response id === row id — RED before §48", async () => {
    install({ flags: SERVE_LOG_ON });
    _setTestDbPlacesOverride(async () => FOUR());
    const r = await getDiscovery("alice-token");
    assert.equal(r.status, 200);
    assert.equal(r.body?.meta?.cacheLevel, "miss", "precondition: this is the cold fetch");
    const ids = idsOf(r.body);
    assert.equal(ids.length, 4);
    const rows = await until(() => db.impressions(), (x) => x.length >= 4);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].features.servePoint, DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, "precondition: serve point 6 wrote these");
    assert.equal(rows[0].features.rankedInRequest, true, "precondition: the ranked branch (lib/rankLog.logImpression)");
    for (const row of rows) {
      assert.equal(
        row.recommendation_id, ids[row.position],
        "serve point 6 used to mint its own session and clock: the id the client held joined to NO row",
      );
      assert.equal(row.features.modelVersion, DISCOVERY_PDE_MODEL_VERSION, "the PDE model ordered this page, and the row says so");
      assert.ok(Array.isArray(row.features.reasonCodes), "reason codes present (possibly empty), never missing");
    }
    const req = await until(() => db.serveRequests(), (x) => x.length >= 1);
    assert.equal(req[0].serve_point, DiscoveryServePoint.COLD_FETCH_LEGACY_RANK);
    assert.equal(req[0].viewer_class, "signed_in");
  });

  it("S1-PDE. cache-A PDE cohort: response id === row id — RED before §48", async () => {
    install({ flags: PDE_ALL });
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    const r = await getDiscovery("alice-token");
    const ids = idsOf(r.body);
    assert.notEqual(r.body.places[0].id, "db/p1", "precondition: PDE re-ranked, so this is the logImpression branch");
    const rows = await until(() => db.impressions(), (x) => x.length >= 4);
    assert.equal(rows[0].features.rankedInRequest, true);
    for (const row of rows) {
      assert.equal(row.recommendation_id, ids[row.position], "the PDE cohort's rows name the ids its response handed out");
      assert.equal(r.body.places[row.position].id, row.item_id, "and the position is the SERVED position");
    }
  });

  it("A1. an ANONYMOUS serve: every item has an id, no user-keyed row exists, and the per-request row recovers every id", async () => {
    install({ flags: SERVE_LOG_ON });
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    const r = await getDiscovery();
    const ids = idsOf(r.body);
    assert.equal(ids.length, 4, "04 §5: every served item must have a recommendation_id — anonymous included");
    assert.ok(ids.every((i) => typeof i === "string" && i.length === 22));
    const req = await until(() => db.serveRequests(), (x) => x.length >= 1);
    await quiesce();
    assert.deepEqual(db.impressions(), [], "no rank_events row: an anonymous exposure is attributed to nobody");
    assert.equal(req.length, 1);
    assert.equal(req[0].user_id, null);
    assert.equal(req[0].viewer_class, "anonymous");
    assert.deepEqual(req[0].item_ids, r.body.places.map((p: any) => p.id));
    assert.deepEqual(
      recommendationRecordsFromServeRequest(req[0]).map((x) => x.recommendation_id), ids,
      "the durable record of an anonymous serve reproduces exactly the ids the response carried",
    );
  });

  it("A2. an anonymous COLD fetch (serve point 6) is recorded too — before §48 it wrote nothing at all", async () => {
    install({ flags: SERVE_LOG_ON });
    _setTestDbPlacesOverride(async () => FOUR());
    const r = await getDiscovery();
    assert.equal(r.body?.meta?.cacheLevel, "miss");
    const req = await until(() => db.serveRequests(), (x) => x.length >= 1);
    assert.equal(req.length, 1);
    assert.equal(req[0].serve_point, DiscoveryServePoint.COLD_FETCH_LEGACY_RANK);
    assert.deepEqual(recommendationRecordsFromServeRequest(req[0]).map((x) => x.recommendation_id), idsOf(r.body));
  });

  it("A3. with the serve-log flag absent nothing is written, anonymous or not — no production write this lane did not already have", async () => {
    install({ flags: {} });
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    await getDiscovery();
    await getDiscovery("alice-token");
    await quiesce();
    assert.deepEqual(db.serveRequests(), []);
    assert.deepEqual(db.impressions(), []);
  });

  it("A4. where 3376 is not applied the per-request writer latches off, and the item rows still land", async () => {
    install({ flags: SERVE_LOG_ON, serveRequestRpc: false });
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    await getDiscovery("alice-token");
    const rows = await until(() => db.impressions(), (x) => x.length >= 4);
    assert.equal(rows.length, 4, "the older signal does not depend on the newer table");
    await getDiscovery("alice-token");
    await quiesce();
    assert.equal(db.rpcCount("record_discovery_serve_request"), 1, "after one PGRST202 the writer stops asking");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT OUTCOME → BINDING → STORE
// ═════════════════════════════════════════════════════════════════════════════

async function servedToAlice(): Promise<{ ids: string[]; items: string[] }> {
  _setTestDbPlacesOverride(async () => []);
  _injectTestCacheEntry(KEY, FOUR());
  const r = await getDiscovery("alice-token");
  await until(() => db.impressions(), (x) => x.length >= 4);
  return { ids: idsOf(r.body), items: r.body.places.map((p: any) => p.id) };
}

describe("§48 DV-46 — an outcome carrying the served id binds to THAT exposure and no other", () => {
  it("O1. served → client event → rank_events: the row with that id moves, and the analytics row carries the same id", async () => {
    install({ flags: SERVE_LOG_ON });
    const { ids, items } = await servedToAlice();
    const o = await postOutcome("alice-token", { item_id: items[2], surface: "discovery", outcome: "tap", recommendation_id: ids[2] });
    assert.equal(o.status, 200);
    assert.deepEqual(o.body, { ok: true });
    const row = db.impressions().find((x) => x.recommendation_id === ids[2])!;
    assert.equal(row.outcome, "tap", "the exposure the id names is the one that moved");
    assert.equal(row.user_id, ALICE);
    assert.ok(row.outcome_at, "outcome_at is set");
    const others = db.impressions().filter((x) => x.recommendation_id !== ids[2]);
    assert.ok(others.every((x) => x.outcome === "impression"), "no other exposure moved");
    const an = await until(() => db.analytics(), (x) => x.length >= 1);
    assert.equal(an[0].recommendation_id, ids[2], "the analytics row is part of the same exposure");
    const rec = recommendationRecordFromRankEventsRow(row)!;
    assert.equal(rec.recommendation_id, ids[2], "the nine-field record is recoverable from the moved row");
    assert.equal(rec.rank_position, 2);
  });

  it("O2. another viewer replaying Alice's id is NOT credited: 404, and Alice's row is untouched", async () => {
    install({ flags: SERVE_LOG_ON });
    const { ids, items } = await servedToAlice();
    const o = await postOutcome("bob-token", { item_id: items[0], surface: "discovery", outcome: "save", recommendation_id: ids[0] });
    assert.equal(o.status, 404);
    await quiesce();
    assert.ok(db.impressions().every((x) => x.outcome === "impression"), "nothing moved");
    assert.deepEqual(db.analytics(), [], "no analytics row was credited to anybody");
  });

  it("O3. an ANONYMOUS id presented by a signed-in viewer binds nothing", async () => {
    install({ flags: SERVE_LOG_ON });
    _setTestDbPlacesOverride(async () => []);
    _injectTestCacheEntry(KEY, FOUR());
    const anon = await getDiscovery();
    const o = await postOutcome("alice-token", {
      item_id: anon.body.places[0].id, surface: "discovery", outcome: "tap", recommendation_id: idsOf(anon.body)[0],
    });
    assert.equal(o.status, 404, `an id minted under '${ANONYMOUS_VIEWER_KEY}' names no signed-in exposure`);
  });

  it("O4. a STALE id (the exposure already moved past this outcome) is refused and moves nothing", async () => {
    install({ flags: SERVE_LOG_ON });
    const { ids, items } = await servedToAlice();
    assert.equal((await postOutcome("alice-token", { item_id: items[1], surface: "discovery", outcome: "save", recommendation_id: ids[1] })).status, 200);
    const o = await postOutcome("alice-token", { item_id: items[1], surface: "discovery", outcome: "tap", recommendation_id: ids[1] });
    assert.equal(o.status, 404);
    assert.match(String(o.body?.message), /stale/);
    assert.equal(db.impressions().find((x) => x.recommendation_id === ids[1])!.outcome, "save", "never downgraded");
  });

  it("O5. an id naming a DIFFERENT item or surface than the event is refused 409", async () => {
    install({ flags: SERVE_LOG_ON });
    const { ids, items } = await servedToAlice();
    const wrongItem = await postOutcome("alice-token", { item_id: items[3], surface: "discovery", outcome: "tap", recommendation_id: ids[0] });
    assert.equal(wrongItem.status, 409);
    const wrongSurface = await postOutcome("alice-token", { item_id: items[0], surface: "pulse", outcome: "tap", recommendation_id: ids[0] });
    assert.equal(wrongSurface.status, 409);
    assert.ok(db.impressions().every((x) => x.outcome === "impression"));
  });

  it("O6. an unknown id, a malformed id, an unknown viewer and no viewer are refused without a write", async () => {
    install({ flags: SERVE_LOG_ON });
    const { items } = await servedToAlice();
    assert.equal((await postOutcome("alice-token", { item_id: items[0], surface: "discovery", outcome: "tap", recommendation_id: "AAAAAAAAAAAAAAAAAAAAAA" })).status, 404);
    assert.equal((await postOutcome("alice-token", { item_id: items[0], surface: "discovery", outcome: "tap", recommendation_id: "not an id" })).status, 400);
    assert.equal((await postOutcome("mallory-token", { item_id: items[0], surface: "discovery", outcome: "tap" })).status, 401);
    assert.equal((await postOutcome(null, { item_id: items[0], surface: "discovery", outcome: "tap" })).status, 401);
    await quiesce();
    assert.ok(db.impressions().every((x) => x.outcome === "impression"));
    assert.deepEqual(db.analytics(), []);
  });

  it("O6b. an unknown schema_version is refused 400; 1 and absent are accepted", async () => {
    install({ flags: SERVE_LOG_ON });
    const { ids, items } = await servedToAlice();
    const v2 = await postOutcome("alice-token", { item_id: items[0], surface: "discovery", outcome: "tap", recommendation_id: ids[0], schema_version: 2 });
    assert.equal(v2.status, 400);
    assert.match(String(v2.body?.message), /unsupported_schema_version/);
    assert.equal(db.impressions().find((x) => x.recommendation_id === ids[0])!.outcome, "impression", "a refused version stored nothing");
    const v1 = await postOutcome("alice-token", { item_id: items[0], surface: "discovery", outcome: "tap", recommendation_id: ids[0], schema_version: 1 });
    assert.equal(v1.status, 200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DV-37 — idempotent where retried
// ═════════════════════════════════════════════════════════════════════════════

describe("§48 DV-37 — retried, concurrent and half-failed outcome reports converge", () => {
  it("O7. a duplicate retry of a dismiss is answered 200 duplicate and counts ONCE in the negative-signal statistic", async () => {
    install({ flags: SERVE_LOG_ON });
    const { ids, items } = await servedToAlice();
    const body = { item_id: items[0], surface: "discovery", outcome: "dismiss", recommendation_id: ids[0] };
    const first = await postOutcome("alice-token", body);
    const second = await postOutcome("alice-token", body);
    assert.deepEqual(first.body, { ok: true });
    assert.deepEqual(second.body, { ok: true, duplicate: true }, "a replay of a recorded outcome is the success it was, not a 404");
    await quiesce();
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 1, "a cross-viewer statistic must not count one dismissal twice");
  });

  it("O8. two CONCURRENT identical reports: exactly one moves the row, the other is a duplicate, the counter moves once", async () => {
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => { release = r; });
    install({
      flags: SERVE_LOG_ON,
      // Hold every rank_events read until two have arrived, so both requests
      // see the row at 'impression' before either writes — the race itself.
      beforeRankEventsRead: async () => {
        arrived += 1;
        if (arrived === 2) release();
        await Promise.race([bothRead, new Promise((r) => setTimeout(r, 500))]);
      },
    });
    const { ids, items } = await servedToAlice();
    arrived = 0;
    const body = { item_id: items[1], surface: "discovery", outcome: "dismiss", recommendation_id: ids[1] };
    const [a, b] = await Promise.all([postOutcome("alice-token", body), postOutcome("alice-token", body)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const dupes = [a.body, b.body].filter((x) => x?.duplicate === true).length;
    assert.equal(dupes, 1, `exactly one of two concurrent reports is the duplicate: ${JSON.stringify([a.body, b.body])}`);
    await quiesce();
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 1, "compare-and-set: the loser moves no counter");
  });

  it("O8b. the same race WITHOUT an id (the legacy item lookup) is guarded by the same compare-and-set", async () => {
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => { release = r; });
    install({
      flags: SERVE_LOG_ON,
      beforeRankEventsRead: async () => {
        arrived += 1;
        if (arrived === 2) release();
        await Promise.race([bothRead, new Promise((r) => setTimeout(r, 500))]);
      },
    });
    const { items } = await servedToAlice();
    arrived = 0;
    const body = { item_id: items[2], surface: "discovery", outcome: "dismiss" };
    const [a, b] = await Promise.all([postOutcome("alice-token", body), postOutcome("alice-token", body)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal([a.body, b.body].filter((x) => x?.duplicate === true).length, 1);
    await quiesce();
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 1);
  });

  it("O9. partial failure then retry: the analytics row that died with the first attempt lands on the retry, once", async () => {
    install({
      flags: SERVE_LOG_ON,
      failUpserts: { rank_events: { times: 1, error: { code: "57014", message: "canceling statement due to statement timeout" } } },
    });
    const { ids, items } = await servedToAlice();
    const body = { item_id: items[3], surface: "discovery", outcome: "save", recommendation_id: ids[3] };
    assert.equal((await postOutcome("alice-token", body)).status, 200, "the funnel moved; its fire-and-forget analytics row did not");
    await quiesce();
    assert.deepEqual(db.analytics(), [], "precondition: the first attempt half-failed");
    const retry = await postOutcome("alice-token", body);
    assert.deepEqual(retry.body, { ok: true, duplicate: true });
    const an = await until(() => db.analytics(), (x) => x.length >= 1);
    assert.equal(an.length, 1, "the retry completed the half the first attempt lost");
    assert.equal(an[0].recommendation_id, ids[3]);
    const again = await postOutcome("alice-token", body);
    assert.equal(again.status, 200);
    await quiesce();
    assert.equal(db.analytics().length, 1, "and a third report still converges on one analytics row");
  });

  it("O10. partial failure the other way: the funnel update fails (500), the retry moves the row", async () => {
    install({
      flags: SERVE_LOG_ON,
      failUpdates: { rank_events: { times: 1, error: { code: "08006", message: "connection failure" } } },
    });
    const { ids, items } = await servedToAlice();
    const body = { item_id: items[0], surface: "discovery", outcome: "tap", recommendation_id: ids[0] };
    assert.equal((await postOutcome("alice-token", body)).status, 500, "a failed write is never answered as a success");
    assert.equal(db.impressions().find((x) => x.recommendation_id === ids[0])!.outcome, "impression");
    const retry = await postOutcome("alice-token", body);
    assert.deepEqual(retry.body, { ok: true }, "the retry is the FIRST success, not a duplicate");
    assert.equal(db.impressions().find((x) => x.recommendation_id === ids[0])!.outcome, "tap");
  });

  it("D1. a direct impression the client NAMED is written once however often it is retried; an unnamed one is not deduplicated", async () => {
    install({ flags: SERVE_LOG_ON });
    const keyed = { event_type: "place_view", entity_type: "place", entity_id: "place-1", client_event_id: "9f1b8d2e-0000-4000-8000-00000000abcd" };
    for (let i = 0; i < 3; i++) assert.equal((await postDirect("alice-token", keyed)).status, 200);
    await quiesce();
    const living = () => db.impressions().filter((x) => x.surface === "living_page" && x.item_id === "place-1");
    assert.equal(living().length, 1, "three retries of one named event are one exposure");
    const unkeyed = { event_type: "place_view", entity_type: "place", entity_id: "place-2" };
    await postDirect("alice-token", unkeyed);
    await new Promise((r) => setTimeout(r, 5));
    await postDirect("alice-token", unkeyed);
    await quiesce();
    assert.equal(
      db.impressions().filter((x) => x.item_id === "place-2").length, 2,
      "BOUNDARY, pinned so it is not forgotten: without client_event_id a retry cannot be told from a second view",
    );
  });

  it("D2. a keyed batch replayed after a lost response lands nothing new and says so", async () => {
    install({ flags: SERVE_LOG_ON });
    const batch = { events: [
      { event_type: "place_view", entity_type: "place", entity_id: "b-1", client_event_id: "9f1b8d2e-0000-4000-8000-000000000001" },
      { event_type: "place_view", entity_type: "place", entity_id: "b-2", client_event_id: "9f1b8d2e-0000-4000-8000-000000000002" },
    ] };
    const first = await postDirect("alice-token", batch);
    assert.deepEqual(first.body, { ok: true, accepted: 2, duplicates: 0 });
    const replay = await postDirect("alice-token", batch);
    assert.deepEqual(replay.body, { ok: true, accepted: 0, duplicates: 2 }, "a replay is answered, not 500'd");
    assert.equal(db.impressions().filter((x) => x.surface === "living_page").length, 2);
  });

  it("D3. an unknown schema_version refuses a direct event, and one in a batch refuses the WHOLE batch", async () => {
    install({ flags: SERVE_LOG_ON });
    const single = await postDirect("alice-token", { event_type: "place_view", entity_type: "place", entity_id: "v-1", schema_version: 9 });
    assert.equal(single.status, 400);
    const batch = await postDirect("alice-token", { events: [
      { event_type: "place_view", entity_type: "place", entity_id: "v-2" },
      { event_type: "place_view", entity_type: "place", entity_id: "v-3", schema_version: 9 },
    ] });
    assert.equal(batch.status, 400);
    assert.match(String(batch.body?.message), /events\.1\.schema_version/);
    await quiesce();
    assert.deepEqual(db.impressions().filter((x) => x.surface === "living_page"), [], "nothing from a refused version reached storage");
  });
});
