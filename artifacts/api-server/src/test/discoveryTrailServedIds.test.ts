/**
 * The Trails reads of `rank_events`, fed the id shape the Discovery writers
 * ACTUALLY produce.
 *
 * THE DEFECT THIS FILE EXISTS FOR (census-discovery §51)
 * =====================================================
 * `content_trails.source_id` is a bare uuid (2910, `source_id uuid NOT NULL`).
 * `GET /discovery` serves — and its serve log writes to `rank_events.item_id` —
 * a DB-backed place as `db/<uuid>` (routes/discovery.ts, queryDbPlaces and
 * queryCanonicalPlaces; lib/discoveryServeLog.ts writes `item.id` verbatim).
 * `GET /discovery/community` serves the same `discovery_places` row BARE.
 *
 * Every Trails read of `rank_events` asked `.in("item_id", <source_id>)`, so
 * only the community exposures were ever counted. The fixtures of every Trails
 * suite seeded bare ids, which is why none of them could see it:
 *   - §9 exposure denominators (DV-22): a place served 600 times by the main
 *     feed read as never exposed and kept re-qualifying for an exploration slot
 *     it had long since had;
 *   - `trending_now` (DV-21) and the per-item order of GET …/trending (DC-21);
 *   - Trail momentum (DV-25), both the `trending` boolean and the momentum
 *     scale on the affinity the ranker receives.
 *
 * Every fixture below uses `db/<uuid>` — the writer's shape — and every case
 * was RED before the fix. The "never double-counted" case pins the other half
 * of the obligation: the SAME content under two ids is one item, and one row is
 * one event.
 *
 * It also pins a second, related staleness: the momentum loader's 10-minute
 * cache was keyed `trail:<id>` by BOTH getTrailModules (place members only) and
 * trailTrending (every member), so whichever ran first decided the corpus the
 * other read for ten minutes.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import {
  getTrailModules, trailTrending, loadViewerTrailModifier,
  servedIdsForMember, memberIdForServedId, MAX_TRAIL_EVENT_ROWS,
} from "../services/trails/TrailService.js";
import { _resetLocalMomentumCacheForTest } from "../lib/discoveryLocalMomentum.js";
import { TRAIL_EXPLORATION_IMPRESSION_CEILING } from "../lib/discoveryTrailHealth.js";

const USER = "11111111-1111-4111-8111-1111111111d1";
const OTHER = "11111111-1111-4111-8111-1111111111d2";
const T = "22222222-2222-4222-8222-2222222222d1";
const P_HOT = "33333333-3333-4333-8333-3333333333d1";
const P_COLD = "33333333-3333-4333-8333-3333333333d2";
const POST = "33333333-3333-4333-8333-3333333333d3";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Row = Record<string, any>;

/**
 * A PostgREST-shaped fake that PAGES (`.range`) and compares timestamps with
 * `gte`, because both the momentum kernel's reads and the exposure read do. A
 * fake without `.range` silently turns every momentum read into the loader's
 * catch branch — `discoveryTrailProvenance.test.ts` records that trap.
 */
function makeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {
    trails: [], content_trails: [], trail_follows: [], trail_reports: [],
    trail_health_snapshots: [], trail_edges: [], rank_events: [], blocks: [],
    profiles: [USER, OTHER].map((id) => ({ id, account_status: "active" })),
    ...seed,
  };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    const store = () => (tables[table] ??= []);
    const rows = () => {
      let out = store().filter((r) => filters.every((f) => f(r)));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt(c: string, v: any) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      or() { return b; },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      insert() {
        const settled = { data: null, error: null };
        const r: any = { select: () => r, maybeSingle: () => Promise.resolve(settled), then: (res: any) => Promise.resolve(settled).then(res) };
        return r;
      },
      then(res: (r: any) => any, rej?: (e: any) => any) {
        return Promise.resolve({ data: rows(), error: null }).then(res, rej);
      },
    };
    return b;
  }
  const auth = {
    async getUser(token: string) {
      return tables.profiles!.some((p) => p.id === token)
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  return { from, auth, _tables: tables };
}

const trail = (over: Row = {}): Row => ({
  id: T, slug: "bangkok-after-dark", title: "Bangkok After Dark", description: null,
  destination: "bangkok", place_scope: null, parent_trail_id: null,
  review_state: "approved",
  lifecycle_status: "active", created_by: USER,
  created_at: iso(86_400_000), updated_at: iso(86_400_000), ...over,
});

const member = (id: string, over: Row = {}): Row => ({
  id, trail_id: T, source_type: "place", source_id: P_HOT,
  relationship: "primary", signal: null, source: "user", confidence: 0.8,
  contributor_id: USER, content_state: "just_arrived", created_at: iso(3_600_000), ...over,
});

/** `n` rows on `itemId` exactly as the Discovery serve log writes them. */
const served = (itemId: string, n: number, outcome = "impression", surface = "discovery"): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `re-${itemId}-${outcome}-${surface}-${i}`,
    surface, item_id: itemId, outcome,
    served_at: iso(3_600_000 + i * 1_000),
    outcome_at: outcome === "impression" ? null : iso(3_500_000 + i * 1_000),
  }));

const db = (seed: Record<string, Row[]>) => { _resetLocalMomentumCacheForTest(); return makeDb(seed); };

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${USER}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("the served id space — one member, the ids it is exposed under", () => {
  it("a place member is exposed bare (community) AND as `db/<uuid>` (GET /discovery); other kinds only bare", () => {
    assert.deepEqual(servedIdsForMember("place", P_HOT), [P_HOT, `db/${P_HOT}`]);
    assert.deepEqual(servedIdsForMember("post", POST), [POST]);
    assert.equal(memberIdForServedId(`db/${P_HOT}`), P_HOT);
    assert.equal(memberIdForServedId(P_HOT), P_HOT);
    // An OSM serve id is not a Trail member id and is returned unchanged.
    assert.equal(memberIdForServedId("node/12345"), "node/12345");
  });
});

describe("DV-22 — §9's exposure denominator counts the `db/` exposures GET /discovery writes", () => {
  it("a place served past the ceiling as `db/<uuid>` has HAD its opportunity — no reserved slot", async () => {
    const sc = db({
      trails: [trail()],
      content_trails: [
        member("m-hot", { source_id: P_HOT, created_at: iso(60_000) }),
        member("m-cold", { source_id: P_COLD, contributor_id: OTHER, created_at: iso(120_000) }),
      ],
      rank_events: served(`db/${P_HOT}`, 600),
    });
    const r = await getTrailModules(sc, T, { pageSize: 8, nowMs: NOW });
    const ja = r.modules.find((m) => m.key === "just_arrived")!;
    assert.deepEqual(ja.explorationSlots, ["m-cold"],
      "600 main-feed impressions were invisible to the denominator, so the hot place kept re-qualifying");
  });

  it("the two id spaces are SUMMED for one item and no row is counted twice", async () => {
    const at = (bare: number, prefixed: number) => db({
      trails: [trail()],
      content_trails: [
        member("m-hot", { source_id: P_HOT, created_at: iso(60_000) }),
        member("m-cold", { source_id: P_COLD, contributor_id: OTHER, created_at: iso(120_000) }),
      ],
      rank_events: [...served(P_HOT, bare), ...served(`db/${P_HOT}`, prefixed)],
    });
    const half = TRAIL_EXPLORATION_IMPRESSION_CEILING / 2;
    // One short of the ceiling across the two spaces: still new.
    const under = await getTrailModules(at(half - 1, half), T, { pageSize: 8, nowMs: NOW });
    assert.deepEqual(under.modules[0]!.explorationSlots, ["m-hot"],
      "counting each row once under each id would double it past the ceiling");
    // Exactly the ceiling across the two spaces: no longer new.
    const at500 = await getTrailModules(at(half, half), T, { pageSize: 8, nowMs: NOW });
    assert.deepEqual(at500.modules[0]!.explorationSlots, ["m-cold"],
      "counting only one id space leaves the item below the ceiling forever");
  });

  it("GET …/modules publishes the corrected slot to a client", async () => {
    _setTestClient(db({
      trails: [trail()],
      content_trails: [
        member("m-hot", { source_id: P_HOT, created_at: iso(60_000) }),
        member("m-cold", { source_id: P_COLD, contributor_id: OTHER, created_at: iso(120_000) }),
      ],
      rank_events: served(`db/${P_HOT}`, 600).map((r) => ({ ...r, served_at: new Date(Date.now() - 3_600_000).toISOString() })),
    }), true);
    const r = await get(`/v1/discovery/trails/${T}/modules`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.modules.find((m: any) => m.key === "just_arrived").explorationSlots, ["m-cold"]);
  });
});

describe("DV-21 / DC-21 / DV-25 — momentum reads the `db/` activity too", () => {
  const surge = () => served(`db/${P_HOT}`, 8, "save");

  it("`trending_now` orders a place whose ONLY activity is `db/<uuid>` (DV-21)", async () => {
    const sc = db({ trails: [trail()], content_trails: [member("m-hot")], rank_events: surge() });
    const r = await getTrailModules(sc, T, { nowMs: NOW });
    const tn = r.modules.find((m) => m.key === "trending_now")!;
    assert.deepEqual(tn.items.map((i) => i.id), ["m-hot"],
      "the main feed's saves never reached the Trail's momentum module");
    assert.ok(r.momentumProvenance, "the reading that ordered the module carries its window (DC-17)");
  });

  it("GET …/trending says `trending: true` on `db/` activity alone, and lists the member (DC-21, DV-25)", async () => {
    _setTestClient(db({
      trails: [trail()], content_trails: [member("m-hot")],
      rank_events: surge().map((r, i) => ({
        ...r,
        served_at: new Date(Date.now() - 3_600_000 - i * 1_000).toISOString(),
        outcome_at: new Date(Date.now() - 3_500_000 - i * 1_000).toISOString(),
      })),
    }), true);
    const r = await get(`/v1/discovery/trails/${T}/trending`);
    assert.equal(r.status, 200);
    assert.equal(r.body.trending, true, "user behaviour on the Trail's place did not move the Trail's momentum");
    assert.deepEqual(r.body.items.map((i: any) => i.id), ["m-hot"]);
  });

  it("the affinity the ranker receives is SCALED by `db/` activity on a followed Trail (DV-25)", async () => {
    const seed = (events: Row[]) => db({
      trails: [trail()],
      trail_follows: [{ trail_id: T, user_id: USER }],
      content_trails: [member("m-hot")],
      rank_events: events,
    });
    const hot = await loadViewerTrailModifier(seed(surge()), USER, [P_HOT], { nowMs: NOW });
    const cold = await loadViewerTrailModifier(seed([]), USER, [P_HOT], { nowMs: NOW });
    assert.ok(hot.trailAffinity[P_HOT]! > cold.trailAffinity[P_HOT]!,
      `behaviour must move Trail momentum: hot ${hot.trailAffinity[P_HOT]} vs cold ${cold.trailAffinity[P_HOT]}`);
  });

  it("`analytics` rows cannot crowd real activity out of the bounded read", async () => {
    // Ranker bookkeeping — one `analytics` row per CANDIDATE — served more
    // recently than the saves and in greater number than the read's ceiling.
    // Filtered after the read, they fill every page and the saves never arrive.
    const sc = db({
      trails: [trail()], content_trails: [member("m-hot")],
      rank_events: [
        ...Array.from({ length: MAX_TRAIL_EVENT_ROWS }, (_, i) => ({
          id: `an-${i}`, surface: "discovery", item_id: `db/${P_HOT}`, outcome: "analytics",
          served_at: iso(1_000 + i), outcome_at: null,
        })),
        ...surge(),
      ],
    });
    const r = await trailTrending(sc, T, NOW);
    assert.ok((r.momentum ?? 0) > 0, "the eight saves must be read past the analytics rows");
  });
});

describe("stale corpus — one Trail's two momentum reads no longer share a cache entry", () => {
  it("a post's momentum reaches GET …/trending even right after …/modules read the Trail", async () => {
    const sc = db({
      trails: [trail()],
      content_trails: [
        member("m-place", { source_id: P_HOT }),
        member("m-post", { source_type: "post", source_id: POST, contributor_id: OTHER }),
      ],
      // The post exists and is public: a Trail serves only what its source
      // still lets a stranger read (TrailService.servableMembers).
      posts: [{ id: POST, author_id: OTHER, visibility: "public", status: "active", post_status: "published" }],
      rank_events: served(POST, 8, "save"),
    });
    // The modules read first (it used to cache a PLACE-ONLY corpus under `trail:<id>`)…
    await getTrailModules(sc, T, { nowMs: NOW });
    // …then trending, inside the old cache's ten minutes.
    const r = await trailTrending(sc, T, NOW + 60_000);
    assert.deepEqual(r.items.map((i) => i.id), ["m-post"],
      "trending read a corpus another function had chosen, without the post in it");
  });
});
