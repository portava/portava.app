/**
 * census-discovery §94 (lane W11-X2), §91.7 item 1 — the three output kinds
 * are LOGGED as every other Discovery serve point is.
 *
 * `GET /v1/discovery/recommendations/:kind` (routes/discoveryOutputKinds.ts,
 * §91 / D-W10-I-4) served Trails, Shared Moments and emerging discoveries and
 * wrote nothing: 3376's per-request CHECK admitted serve points 1–12, so no
 * `recommendation_id` was minted and D-W10-I-A1 held the flag until a logging
 * migration and a logging call landed. 3491 widens the CHECK to 13; this pins
 * the call.
 *
 *   L1  a served Trails page writes one impression per item — serve point 13,
 *       ranked in the request, `trail/<id>` with a NULL kind — and one
 *       per-request row with the page's size
 *   L2  every served item carries the recommendation id its impression row
 *       carries, at the same position (DV-40)
 *   L3  an empty page is still a request: the per-request row, served_count 0,
 *       and no impression
 *   L4  a refused read (503) writes nothing
 *   L5  the serve log flag OFF: nothing is written (the flag's own contract)
 *   L6  flag OFF (3483): 404 and nothing written — unchanged
 *   M1  the item mapping for all three kinds: Trails and Shared Moments are
 *       namespaced with a NULL kind; an emerging discovery is its place
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryOutputKindsServeLog.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import outputKindsRouter from "../routes/discoveryOutputKinds.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateServeLogFlagCache, SERVE_REQUEST_RPC, DiscoveryServePoint } from "../lib/discoveryServeLog.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { invalidateRankDesignFlagCache } from "../lib/discoveryRankFlags.js";
import { makeFakeCandidateDb, flagRow, type Row } from "./helpers/fakeCandidateDb.js";

const TOK = "tok-kinds-viewer";
const VIEWER = "d1010000-0000-4000-8000-000000000001";
const T_OLD = "55555555-5555-4555-8555-555555555501";
const T_NEW = "55555555-5555-4555-8555-555555555502";
const trailRow = (id: string, daysAgo: number): Row => ({
  id, slug: `slug-${id.slice(-2)}`, title: `Trail ${id.slice(-2)}`, description: null, destination: "miami", destination_key: "miami", place_scope: null,
  parent_trail_id: null, review_state: "approved", lifecycle_status: "active", created_by: null,
  created_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), updated_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
});
const asServiceClient = (c: object) => c as unknown as Parameters<typeof _setTestServiceClient>[0];

function db(opts: { kindsOn?: boolean; logOn?: boolean; trails?: Row[]; erroring?: string[] } = {}) {
  const flags = [
    ...(opts.kindsOn ?? true ? [flagRow("discovery_output_kinds_enabled", true)] : []),
    ...(opts.logOn ?? true ? [flagRow("discovery_serve_log_enabled", true)] : []),
  ];
  const d = makeFakeCandidateDb({
    feature_flags: flags,
    trails: opts.trails ?? [trailRow(T_OLD, 90), trailRow(T_NEW, 1)],
    content_trails: [{ trail_id: T_OLD, source_type: "place", source_id: "p", relationship: "signal", signal: "rooftop", created_at: new Date().toISOString() }],
    trail_follows: Array.from({ length: 30 }, (_, i) => ({ trail_id: T_OLD, user_id: `f-${i}` })),
    profiles: [{ id: VIEWER, account_status: "active" }],
    compass_user_preferences: [{ user_id: VIEWER, interests: ["rooftop"], category_weights: null }],
    user_follows: [], rank_events: [], ranking_config: [],
  }, { erroring: opts.erroring ?? [] });
  const client = Object.assign(d, { auth: { getUser: async (t: string) => (t === TOK ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid token" } }) } });
  _setTestServiceClient(asServiceClient(client)); _setTestClient(client, true);
  return d;
}

let server: Server;
let base = "";
before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(outputKindsRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { invalidateServeLogFlagCache(); invalidateRankDesignFlagCache(); _resetStopConditionsForTest(); });

async function get(path: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOK}` } });
  return { status: res.status, body: await res.json() as any };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const impressions = (d: ReturnType<typeof db>) => d.writes.filter((w) => w.table === "rank_events" && Array.isArray(w.payload)).flatMap((w) => w.payload as any[]);
const requests = (d: ReturnType<typeof db>) => d.writes.filter((w) => w.table === `rpc:${SERVE_REQUEST_RPC}`).map((w) => (w.payload as any).p_row);

const TRAILS = "/v1/discovery/recommendations/trails?destination=Miami";

describe("§94 — the output kinds are logged as a serve point (§91.7 item 1)", () => {
  it("L1 a served Trails page writes one impression per item at serve point 13, and one per-request row", async () => {
    const d = db();
    const r = await get(TRAILS);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    const rows = impressions(d);
    assert.deepEqual(rows.map((x) => x.item_id), r.body.items.map((t: any) => `trail/${t.id}`), "one impression per served Trail, in served order");
    for (const [i, x] of rows.entries()) {
      assert.equal(x.position, i);
      assert.equal(x.item_kind, null, "a Trail is none of 0153's six kinds: NULL, never an invented kind");
      assert.equal(x.surface, "discovery");
      assert.equal(x.features.servePoint, DiscoveryServePoint.OUTPUT_KINDS);
      assert.equal(x.features.servePoint, 13);
      assert.equal(x.features.rankedInRequest, true);
      assert.equal(x.features.route, "GET /v1/discovery/recommendations/:kind");
      assert.equal(x.features.type, "trails");
    }
    const req = requests(d);
    assert.equal(req.length, 1);
    assert.equal(req[0].serve_point, 13);
    assert.equal(req[0].served_count, 2);
  });

  it("L2 every served item carries the recommendation id its impression row carries, at the same position", async () => {
    const d = db();
    const r = await get(TRAILS);
    await settle();
    const rows = impressions(d);
    assert.equal(rows.length, r.body.items.length);
    r.body.items.forEach((t: any, i: number) => {
      assert.equal(typeof t.recommendationId, "string");
      assert.equal(t.recommendationId, rows[i].features.recommendationId, `position ${i}`);
    });
  });

  it("L3 an empty page is still a request: the per-request row with served_count 0, and no impression", async () => {
    const d = db({ trails: [] });
    const r = await get(TRAILS);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
    await settle();
    assert.equal(impressions(d).length, 0);
    const req = requests(d);
    assert.equal(req.length, 1);
    assert.equal(req[0].serve_point, 13);
    assert.equal(req[0].served_count, 0);
  });

  it("L4 a refused read (503) writes nothing", async () => {
    const d = db({ erroring: ["trails"] });
    const r = await get(TRAILS);
    assert.equal(r.status, 503);
    await settle();
    assert.equal(impressions(d).length, 0);
    assert.equal(requests(d).length, 0);
  });

  it("L5 CONTROL: the serve log flag OFF — nothing is written", async () => {
    const d = db({ logOn: false });
    const r = await get(TRAILS);
    assert.equal(r.status, 200);
    await settle();
    assert.equal(impressions(d).length, 0);
    assert.equal(requests(d).length, 0);
  });

  it("L6 CONTROL: 3483 OFF — 404, and nothing is written", async () => {
    const d = db({ kindsOn: false });
    const r = await get(TRAILS);
    assert.equal(r.status, 404);
    await settle();
    assert.equal(d.writes.length, 0);
  });

  it("M1 the served-item mapping for all three kinds", async () => {
    const { outputKindServedItems } = await import("../routes/discoveryOutputKinds.js");
    assert.deepEqual(outputKindServedItems("trails", [{ id: "t1" }, { id: "t2" }]), [{ id: "trail/t1", kind: null }, { id: "trail/t2", kind: null }]);
    assert.deepEqual(outputKindServedItems("shared_moments", [{ id: "m1" }]), [{ id: "moment/m1", kind: null }]);
    assert.deepEqual(outputKindServedItems("emerging_discoveries", [{ place: { id: "db/abc" } }, { place: { id: "node/9" } }]), [{ id: "db/abc" }, { id: "node/9" }],
      "an emerging discovery is a place: its id, and the kind the serve log infers for every place (gem / place)");
  });
});
