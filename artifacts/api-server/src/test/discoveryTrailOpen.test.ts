/**
 * DV-78 — `04` §4 trail_open, the server half (census-discovery §133).
 *
 * POST /api/rank-events/trail-open runs the REAL router against the enforcing
 * fake (test/helpers/fakeDiscoveryTelemetryDb.ts: 2891's unique arbiter, ON
 * CONFLICT DO NOTHING).
 *
 * Pinned:
 *   O1  flag OFF, absent or unreadable ⇒ 404 feature_disabled; the flag is the
 *       only read (no Trail, no rank_events), nothing is written
 *   O2  signed out ⇒ 401, nothing written
 *   O3  an approved Trail, or the viewer's own pending one ⇒ one row, shaped for
 *       2890/2891/3375: event_type trail_open, outcome analytics, item trail/<id>,
 *       every column classified
 *   O4  a retry of the same open writes nothing more; a new open does
 *   O5  D-66: another's pending or rejected Trail, an archived one, or none ⇒
 *       404, nothing written; trailOpenAllowed agrees with trailVisibleTo
 *   O6  malformed bodies (and unknown fields) are refused whole
 *   O7  a database that cannot say whether a Trail is approved (no review_state)
 *       writes nothing (503); without 2891's arbiter nothing is written either
 *   O8  the row is no exposure and no funnel outcome: every reader's exclusion
 *       (`outcome = 'analytics'`, `event_type IS NULL`) holds for it
 *   O9  wired: the route is appended at the tail behind requireUser, and 3923
 *       seeds the flag FALSE
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rankEventsRouter, { _resetRecommendationIdSchemaLatch } from "../routes/rankEvents.js";
import {
  TRAIL_OPEN_FLAG, TRAIL_OPEN_EVENT_TYPE, trailOpenAllowed, trailOpenItemId, trailOpenRowFor, trailOpenTokenFor,
} from "../lib/discoveryTrailOpen.js";
import { unclassifiedColumns } from "../lib/discoveryRecommendationRecord.js";
import { trailVisibleTo } from "../services/trails/TrailService.js";
import { makeTelemetryDb } from "./helpers/fakeDiscoveryTelemetryDb.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

const ALICE = "a11ce000-0000-4000-8000-000000000001";
const BOB   = "b0b00000-0000-4000-8000-000000000002";
const USERS = { "alice-token": ALICE, "bob-token": BOB };
const CEID  = "0f0f0f0f-1111-4222-8333-444444444444";
const CEID2 = "0f0f0f0f-1111-4222-8333-555555555555";
const T_APPROVED = "7a000000-0000-4000-8000-000000000001";
const T_BOB_PENDING = "7a000000-0000-4000-8000-000000000002";
const T_BOB_REJECTED = "7a000000-0000-4000-8000-000000000003";
const T_ARCHIVED = "7a000000-0000-4000-8000-000000000004";
const T_ABSENT = "7a000000-0000-4000-8000-000000000005";
const TRAILS = [
  { id: T_APPROVED, created_by: BOB, review_state: "approved", lifecycle_status: "proposed" },
  { id: T_BOB_PENDING, created_by: BOB, review_state: "pending", lifecycle_status: "proposed" },
  { id: T_BOB_REJECTED, created_by: BOB, review_state: "rejected", lifecycle_status: "proposed" },
  { id: T_ARCHIVED, created_by: ALICE, review_state: "approved", lifecycle_status: "archived" },
];

let server: Server;
let base = "";
let db: ReturnType<typeof makeTelemetryDb>;
let rankEventReads = 0;

function install(opts: Parameters<typeof makeTelemetryDb>[0]) {
  rankEventReads = 0;
  db = makeTelemetryDb({ users: USERS, beforeRankEventsRead: async () => { rankEventReads += 1; }, ...opts });
  db.tables["trails"] = TRAILS.map((t) => ({ ...t }));
  _setTestClient(db.client as any, true);
  _setTestServiceClient(db.client as any);
  _resetRecommendationIdSchemaLatch();
}

async function post(token: string | null, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/rank-events/trail-open`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const openBody = (trailId: string, over: Record<string, unknown> = {}) => ({ trail_id: trailId, client_event_id: CEID, ...over });
const opens = () => db.rankEvents().filter((r) => r.event_type === TRAIL_OPEN_EVENT_TYPE);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", rankEventsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => install({ flags: { [TRAIL_OPEN_FLAG]: { enabled: true } } }));

describe("DV-78 — trail_open on POST /rank-events/trail-open", () => {
  it("O1. flag OFF, absent or unreadable ⇒ 404 feature_disabled; nothing but the flag is read, nothing written", async () => {
    for (const state of ["off", "absent", "unreadable"] as const) {
      const flags: Record<string, { enabled: boolean }> = state === "off" ? { [TRAIL_OPEN_FLAG]: { enabled: false } } : {};
      install(state === "unreadable" ? { flags, failReads: { feature_flags: { code: "57014", message: "timeout" } } } : { flags });
      let trailReads = 0;
      const from = db.client.from.bind(db.client);
      (db.client as any).from = (t: string) => { if (t === "trails") trailReads += 1; return from(t); };
      const r = await post("alice-token", openBody(T_APPROVED));
      assert.equal(r.status, 404, state);
      assert.equal(r.body?.error, "feature_disabled", state);
      assert.equal(trailReads, 0, `${state}: no Trail read`);
      assert.equal(rankEventReads, 0, `${state}: no rank_events read`);
      assert.equal(opens().length, 0, state);
    }
  });

  it("O2. signed out ⇒ 401 and nothing written", async () => {
    const r = await post(null, openBody(T_APPROVED));
    assert.equal(r.status, 401);
    assert.equal(opens().length, 0);
  });

  it("O3. an approved Trail, or the viewer's own pending one: one row, shaped for the table's CHECKs", async () => {
    const r = await post("alice-token", openBody(T_APPROVED.toUpperCase(), { session_id: "5e550000-0000-4000-8000-00000000000A" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, recorded: 1, duplicate: false });
    const [row] = opens();
    assert.ok(row);
    assert.equal(row.event_type, "trail_open");
    assert.equal(row.outcome, "analytics", "the sentinel every funnel, momentum and trend reader excludes");
    assert.equal(row.item_id, `trail/${T_APPROVED}`);
    assert.equal(row.item_kind, null, "item_kind's CHECK has no 'trail'");
    assert.equal(row.surface, "discovery");
    assert.equal(row.user_id, ALICE);
    assert.equal(row.session_id, "5e550000-0000-4000-8000-00000000000a");
    assert.equal(row.schema_version, 1);
    assert.equal(row.privacy_class, "raw_behavioral_event");
    assert.match(String(row.recommendation_id), /^[A-Za-z0-9_-]{22}$/, "2891's shape CHECK");
    assert.equal(row.recommendation_id, trailOpenTokenFor(ALICE, CEID, T_APPROVED));
    assert.deepEqual(unclassifiedColumns(trailOpenRowFor(ALICE, { trail_id: T_APPROVED, client_event_id: CEID }, new Date().toISOString())), [],
      "every column this writer sends is classified");
    // Bob opens his own pending Trail: his to see, so recorded.
    assert.equal((await post("bob-token", openBody(T_BOB_PENDING))).status, 200);
    assert.equal(opens().length, 2);
  });

  it("O4. a retry of the same open writes nothing more; a new open does", async () => {
    assert.equal((await post("alice-token", openBody(T_APPROVED))).body?.recorded, 1);
    const again = await post("alice-token", openBody(T_APPROVED));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true, recorded: 0, duplicate: true });
    assert.equal(opens().length, 1);
    assert.equal((await post("alice-token", openBody(T_APPROVED, { client_event_id: CEID2 }))).body?.recorded, 1);
    assert.equal(opens().length, 2);
    assert.notEqual(trailOpenTokenFor(ALICE, CEID, T_APPROVED), trailOpenTokenFor(BOB, CEID, T_APPROVED), "the token is per viewer");
  });

  it("O5. D-66: another's pending or rejected Trail, an archived Trail, or none ⇒ 404 and nothing written", async () => {
    for (const t of [T_BOB_PENDING, T_BOB_REJECTED, T_ARCHIVED, T_ABSENT]) {
      const r = await post("alice-token", openBody(t));
      assert.equal(r.status, 404, t);
      assert.equal(r.body?.error, "not_found", t);
    }
    assert.equal(opens().length, 0);
    for (const t of TRAILS.filter((x) => x.lifecycle_status !== "archived")) {
      for (const viewer of [ALICE, BOB]) assert.equal(trailOpenAllowed(t, viewer), trailVisibleTo(t, viewer), `${t.id} ${viewer}`);
    }
    assert.equal(trailOpenAllowed({ id: "x", created_by: ALICE, review_state: "approved", lifecycle_status: "archived" }, ALICE), false);
    assert.equal(trailOpenAllowed({ id: "x", created_by: ALICE }, BOB), false, "no review_state: not public");
  });

  it("O6. malformed bodies are refused whole", async () => {
    for (const body of [{}, { trail_id: "not-a-uuid", client_event_id: CEID }, { trail_id: T_APPROVED }, { trail_id: T_APPROVED, client_event_id: "x" },
      { ...openBody(T_APPROVED), session_id: "nope" }, { ...openBody(T_APPROVED), schema_version: 9 }, { ...openBody(T_APPROVED), user_id: BOB }]) {
      const r = await post("alice-token", body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(opens().length, 0);
  });

  it("O7. no review_state, or no 2891 arbiter: nothing is written", async () => {
    install({ flags: { [TRAIL_OPEN_FLAG]: { enabled: true } }, failReads: { trails: { code: "42703", message: "column trails.review_state does not exist" } } });
    const r = await post("alice-token", openBody(T_APPROVED));
    assert.equal(r.status, 503);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(opens().length, 0);
    install({ flags: { [TRAIL_OPEN_FLAG]: { enabled: true } }, failUpserts: { rank_events: { times: 1, error: { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" } } } });
    const r2 = await post("alice-token", openBody(T_APPROVED));
    assert.equal(r2.status, 503, JSON.stringify(r2.body));
    assert.equal(opens().length, 0);
  });

  it("O8. the row is no exposure and no funnel outcome", () => {
    const row = trailOpenRowFor(ALICE, { trail_id: T_APPROVED, client_event_id: CEID }, "2026-10-23T12:00:00.000Z");
    assert.equal(row.outcome, "analytics");
    assert.notEqual(row.event_type, null, "the serve corpus is event_type IS NULL");
    assert.ok(!/^db\//.test(row.item_id) && trailOpenItemId(T_APPROVED).startsWith("trail/"), "never a place key: no trend context or window can join it");
    // The readers' own exclusions, as they are written.
    const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");
    assert.match(read("lib/discoveryLocalMomentum.ts"), /\.neq\("outcome", "analytics"\)/);
    assert.match(read("migrations/3920_discovery_trend_canonical_place_context.sql"), /r\.outcome <> 'analytics'/);
  });

  it("O9. wired: appended at the tail of routes/rankEvents.ts behind requireUser; 3923 seeds the flag FALSE", () => {
    const route = readFileSync(resolve(SRC, "routes/rankEvents.ts"), "utf8");
    const at = route.indexOf('router.post("/rank-events/trail-open"');
    assert.ok(at > route.indexOf("export default router"), "below the default export, so no cited line moved");
    assert.match(route.slice(at, at + 300), /requireUser\(req, res\);\s*if \(!auth\) return;\s*await acceptTrailOpen\(getServiceClient\(\), req, res, auth\.user\.id\);/);
    const mig = readFileSync(resolve(SRC, "migrations/3923_discovery_trail_open_telemetry_flag.sql"), "utf8");
    assert.match(mig, /\(\s*'discovery_trail_open_telemetry_enabled',\s*false,/);
    assert.match(mig, /ON CONFLICT \(flag\) DO NOTHING;/);
  });
});
