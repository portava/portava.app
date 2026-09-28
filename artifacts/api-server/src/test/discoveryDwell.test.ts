/**
 * DV-41 — `04` §7 dwell quality, the server half (census-discovery §55).
 *
 * POST /api/rank-events/dwell runs the REAL router against the enforcing fake
 * (test/helpers/fakeDiscoveryTelemetryDb.ts: 2891's unique arbiter, ON CONFLICT
 * DO NOTHING, PostgREST's '+00:00' read-back). Exposures are written by the REAL
 * serve-log writer (lib/discoveryServeLog.ts), so every row a dwell binds to has
 * the shape production writes.
 *
 * Pinned:
 *   D1  flag off or absent ⇒ 404 feature_disabled, rank_events never read, nothing written
 *   D2  signed out ⇒ 401, nothing written
 *   D3  a bound emission writes one attention row per kind, shaped for 2890/2891
 *   D4  a retry of the same emission writes nothing more; a new emission does
 *   D5  only the caller's own exposure binds: another viewer's, anonymous, unknown ⇒ 404; other item ⇒ 409
 *   D6  malformed emissions are refused whole
 *   D7  a dwell never moves the funnel, and the outcome route never binds to a dwell row
 *   D8  only `active` is interest; idle and passive-foreground never are
 *   D9  without 2891's arbiter nothing is written (never a non-idempotent dwell)
 *   D10 the vocabulary is the migrations' and the client's
 *   D11 the per-(emission, kind) token is deterministic and in its own domain
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
import { invalidateServeLogFlagCache, logDiscoveryServe, DiscoveryServePoint, _resetServeRequestTableLatch } from "../lib/discoveryServeLog.js";
import {
  DWELL_KINDS, DISCOVERY_DWELL_FLAG, DISCOVERY_DWELL_EVENT_TYPE, dwellCountsAsInterest, dwellTokenFor, bindDwellToExposure,
} from "../lib/discoveryDwell.js";
import { mintServeExposure, servedRecommendationId, unclassifiedColumns } from "../lib/discoveryRecommendationRecord.js";
import { makeTelemetryDb } from "./helpers/fakeDiscoveryTelemetryDb.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");

const ALICE = "a11ce000-0000-4000-8000-000000000001";
const BOB   = "b0b00000-0000-4000-8000-000000000002";
const USERS = { "alice-token": ALICE, "bob-token": BOB };
const CEID  = "0f0f0f0f-1111-4222-8333-444444444444";
const CEID2 = "0f0f0f0f-1111-4222-8333-555555555555";

const FLAGS_ON  = { discovery_serve_log_enabled: { enabled: true }, [DISCOVERY_DWELL_FLAG]: { enabled: true } };
const FLAGS_OFF = { discovery_serve_log_enabled: { enabled: true }, [DISCOVERY_DWELL_FLAG]: { enabled: false } };

let server: Server;
let base = "";
let db: ReturnType<typeof makeTelemetryDb>;
let rankEventReads = 0;

function install(opts: Parameters<typeof makeTelemetryDb>[0]) {
  rankEventReads = 0;
  db = makeTelemetryDb({
    users: USERS, beforeRankEventsRead: async () => { rankEventReads += 1; },
    rpc: { increment_distribution_stats: () => ({ data: null, error: null }) },   // the serve log's denominator RPC; not under test
    ...opts,
  });
  _setTestClient(db.client as any, true);
  _setTestServiceClient(db.client as any);
  invalidateServeLogFlagCache();
  _resetServeRequestTableLatch();
  _resetRecommendationIdSchemaLatch();
}

/** Serve `items` to `userId` through the real serve-log writer; returns each item's exposure id. */
async function serve(userId: string, items: string[]): Promise<string[]> {
  const e = mintServeExposure(userId);
  await logDiscoveryServe(db.client, {
    userId, servePoint: DiscoveryServePoint.CACHE_A_L1, items: items.map((id) => ({ id })),
    sessionId: e.sessionId, servedAt: e.servedAt, context: { destination: "Miami", category: "for_you" },
  });
  return items.map((id, i) => servedRecommendationId(e, i, id));
}

async function post(path: string, token: string | null, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const dwellBody = (rid: string, itemId: string, over: Record<string, unknown> = {}) => ({
  item_id: itemId, surface: "discovery", recommendation_id: rid, client_event_id: CEID,
  dwell: [{ kind: "active", ms: 4200 }, { kind: "passive_foreground", ms: 9000 }, { kind: "idle", ms: 60000 }],
  ...over,
});

const attentionRows = () => db.rankEvents().filter((r) => r.event_type === DISCOVERY_DWELL_EVENT_TYPE);
const exposureRows  = () => db.rankEvents().filter((r) => r.event_type === undefined || r.event_type === null);

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
beforeEach(() => install({ flags: FLAGS_ON }));

describe("DV-41 — dwell acceptance on POST /rank-events/dwell", () => {
  it("D1. flag OFF or ABSENT ⇒ 404 feature_disabled; rank_events is never read and nothing is written", async () => {
    for (const state of ["off", "absent"] as const) {
      // One flags object, mutated in place: the fake reads it on every flag query.
      const flags: Record<string, { enabled: boolean }> = { ...FLAGS_OFF };
      if (state === "absent") delete flags[DISCOVERY_DWELL_FLAG];
      install({ flags });
      const [rid] = await serve(ALICE, ["db/p1"]);
      const before = db.rankEvents().length;
      const writesBefore = db.captured.filter((c) => c.table === "rank_events").length;
      rankEventReads = 0;
      const r = await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1"));
      assert.equal(r.status, 404, state);
      assert.equal(r.body?.error, "feature_disabled", state);
      assert.equal(rankEventReads, 0, `${state}: with the flag off nothing but the flag may be read`);
      assert.equal(db.rankEvents().length, before, state);
      assert.equal(db.captured.filter((c) => c.table === "rank_events").length, writesBefore, state);
      // The same emission is accepted the moment the flag is on: the refusal was the flag, not the body.
      flags[DISCOVERY_DWELL_FLAG] = { enabled: true };
      assert.equal((await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1"))).status, 200, state);
    }
  });

  it("D2. signed out ⇒ 401 and nothing written", async () => {
    const [rid] = await serve(ALICE, ["db/p1"]);
    const before = db.rankEvents().length;
    const r = await post("/rank-events/dwell", null, dwellBody(rid!, "db/p1"));
    assert.equal(r.status, 401);
    assert.equal(db.rankEvents().length, before);
    assert.equal(attentionRows().length, 0);
  });

  it("D3. a bound emission writes ONE attention row per kind, bound to the exposure, shaped for 2890/2891", async () => {
    const [rid] = await serve(ALICE, ["db/p1", "node/2"]).then((ids) => [ids[1]!]);
    const exposure = exposureRows().find((r) => r.item_id === "node/2")!;
    const r = await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "node/2"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, recorded: 3, duplicates: 0 });
    const rows = attentionRows();
    assert.deepEqual(rows.map((x) => [x.dwell_kind, x.dwell_ms]), [["active", 4200], ["passive_foreground", 9000], ["idle", 60000]]);
    for (const row of rows) {
      assert.equal(row.outcome, "analytics", "never a funnel rung");
      assert.equal(row.surface, "discovery");
      assert.equal(row.user_id, ALICE);
      assert.equal(row.item_id, "node/2");
      assert.equal(row.item_kind, exposure.item_kind);
      assert.equal(row.position, exposure.position);
      assert.equal(row.session_id, exposure.session_id);
      assert.equal(Date.parse(row.served_at), Date.parse(exposure.served_at), "the attention row sits in its exposure's window");
      assert.equal(row.schema_version, 1);
      assert.equal(row.privacy_class, "raw_behavioral_event");
      assert.deepEqual(row.features, { recommendationId: rid }, "names the exposure it measured");
      assert.match(row.recommendation_id, /^[A-Za-z0-9_-]{22}$/);
      assert.notEqual(row.recommendation_id, rid, "its own token, never the exposure's");
      assert.ok(Number.isInteger(row.dwell_ms) && row.dwell_ms >= 0, "2890 dwell_ms_check");
      assert.ok((DWELL_KINDS as readonly string[]).includes(row.dwell_kind), "2890 dwell_kind_check");
      const { id: _id, ...written } = row;
      assert.deepEqual(unclassifiedColumns(written), [], "every column is privacy-classified");
    }
    assert.equal(exposure.outcome, "impression", "the exposure's outcome is untouched");
    assert.equal(exposure.dwell_ms, undefined);
    assert.equal(exposure.dwell_kind, undefined);
  });

  it("D4. a RETRY of the same emission writes nothing more; a new emission does", async () => {
    const [rid] = await serve(ALICE, ["db/p1"]);
    const first = await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1"));
    assert.deepEqual(first.body, { ok: true, recorded: 3, duplicates: 0 });
    const again = await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1"));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true, recorded: 0, duplicates: 3 });
    assert.equal(attentionRows().length, 3, "no double write");
    // The client event id is case-insensitive in the token: an uppercased retry is the same event.
    const upper = await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1", { client_event_id: CEID.toUpperCase() }));
    assert.deepEqual(upper.body, { ok: true, recorded: 0, duplicates: 3 });
    const next = await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1", { client_event_id: CEID2, dwell: [{ kind: "idle", ms: 5 }] }));
    assert.deepEqual(next.body, { ok: true, recorded: 1, duplicates: 0 });
    assert.equal(attentionRows().length, 4);
  });

  it("D5. only the caller's OWN exposure binds: another viewer's, an anonymous or an unknown id ⇒ 404; another item ⇒ 409", async () => {
    const [bobRid] = await serve(BOB, ["db/p1"]);
    const [aliceRid] = await serve(ALICE, ["db/p1", "db/p2"]);
    const anon = servedRecommendationId(mintServeExposure(null), 0, "db/p1");
    assert.equal((await post("/rank-events/dwell", "alice-token", dwellBody(bobRid!, "db/p1"))).status, 404, "another viewer's exposure");
    assert.equal((await post("/rank-events/dwell", "alice-token", dwellBody(anon, "db/p1"))).status, 404, "an anonymous id binds nothing");
    assert.equal((await post("/rank-events/dwell", "alice-token", dwellBody("AAAAAAAAAAAAAAAAAAAAAA", "db/p1"))).status, 404, "unknown");
    const other = await post("/rank-events/dwell", "alice-token", dwellBody(aliceRid!, "db/p2"));
    assert.equal(other.status, 409, "the id names db/p1, the dwell claims db/p2");
    assert.equal(attentionRows().length, 0);
    // The binding refuses an analytics row and another owner even if a lookup lost its filter.
    assert.deepEqual(bindDwellToExposure({ callerUserId: ALICE, body: { item_id: "x", surface: "discovery" },
      row: { id: "r", user_id: BOB, item_id: "x", surface: "discovery", outcome: "impression", event_type: null } }), { kind: "not_found" });
    assert.deepEqual(bindDwellToExposure({ callerUserId: ALICE, body: { item_id: "x", surface: "discovery" },
      row: { id: "r", user_id: ALICE, item_id: "x", surface: "discovery", outcome: "analytics", event_type: DISCOVERY_DWELL_EVENT_TYPE } }), { kind: "not_found" });
  });

  it("D6. a malformed emission is refused WHOLE (400) and writes nothing", async () => {
    const [rid] = await serve(ALICE, ["db/p1"]);
    const bad: Array<[string, Record<string, unknown>]> = [
      ["an invented kind", { dwell: [{ kind: "bored", ms: 10 }] }],
      ["a kind twice", { dwell: [{ kind: "idle", ms: 10 }, { kind: "idle", ms: 20 }] }],
      ["a zero-length episode", { dwell: [{ kind: "active", ms: 0 }] }],
      ["a negative duration", { dwell: [{ kind: "active", ms: -1 }] }],
      ["a fractional duration", { dwell: [{ kind: "active", ms: 1.5 }] }],
      ["beyond the integer column", { dwell: [{ kind: "idle", ms: 2_147_483_648 }] }],
      ["no measurement", { dwell: [] }],
      ["another surface", { surface: "pulse" }],
      ["no client event id", { client_event_id: undefined }],
      ["a malformed exposure id", { recommendation_id: "short" }],
      ["an unknown schema version", { schema_version: 2 }],
    ];
    for (const [why, over] of bad) {
      const r = await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1", over));
      assert.equal(r.status, 400, why);
    }
    assert.equal(attentionRows().length, 0);
  });

  it("D7. a dwell never moves the funnel, and the outcome route never binds to a dwell row", async () => {
    const [rid] = await serve(ALICE, ["db/p1"]);
    await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1"));
    const tap = await post("/rank-events/outcome", "alice-token", { item_id: "db/p1", surface: "discovery", outcome: "tap", recommendation_id: rid });
    assert.equal(tap.status, 200);
    const exposure = exposureRows().find((r) => r.item_id === "db/p1")!;
    assert.equal(exposure.outcome, "tap", "the outcome landed on the EXPOSURE");
    for (const row of attentionRows()) assert.equal(row.outcome, "analytics", "no attention row was upgraded");
    // Without an id the item lookup finds the exposure too, never an attention row.
    const save = await post("/rank-events/outcome", "alice-token", { item_id: "db/p1", surface: "discovery", outcome: "save" });
    assert.equal(save.status, 200);
    assert.equal(exposure.outcome, "save");
    assert.equal(attentionRows().length, 3);
  });

  it("D8. only ACTIVE dwell is interest: idle and passive-foreground never are, nor any unknown value", () => {
    assert.equal(dwellCountsAsInterest("active"), true);
    assert.equal(dwellCountsAsInterest("idle"), false);
    assert.equal(dwellCountsAsInterest("passive_foreground"), false);
    for (const v of [undefined, null, "", "ACTIVE", "bored", 1]) assert.equal(dwellCountsAsInterest(v), false);
  });

  it("D9. without 2891's arbiter (42P10) nothing is written — never a dwell a retry could double", async () => {
    install({ flags: FLAGS_ON, failUpserts: { rank_events: { times: 1, error: { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" } } } });
    const [rid] = await serve(ALICE, ["db/p1"]);   // the serve log inserts; only the dwell upsert fails
    const r = await post("/rank-events/dwell", "alice-token", dwellBody(rid!, "db/p1"));
    assert.equal(r.status, 503);
    assert.equal(attentionRows().length, 0);
  });

  it("D10. the vocabulary is the migrations' and the client's", () => {
    const m2890 = readFileSync(resolve(REPO, "artifacts/api-server/src/migrations/2890_rank_events_behavior_engine_columns.sql"), "utf8");
    const check = /ADD CONSTRAINT rank_events_dwell_kind_check[\s\S]*?ARRAY\[([\s\S]*?)\]::text\[\]/.exec(m2890);
    assert.ok(check, "2890's dwell_kind CHECK");
    const kinds = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    assert.deepEqual(kinds, [...DWELL_KINDS]);
    const m3395 = readFileSync(resolve(REPO, "artifacts/api-server/src/migrations/3395_discovery_dwell_telemetry_flag.sql"), "utf8");
    assert.match(m3395, new RegExp(`'${DISCOVERY_DWELL_FLAG}',\\s*false,`), "3395 seeds the flag FALSE");
    const client = readFileSync(resolve(REPO, "travel-buddy-standalone/src/services/discoveryDwell.ts"), "utf8");
    assert.match(client, new RegExp(`DISCOVERY_DWELL_FLAG = '${DISCOVERY_DWELL_FLAG}'`));
    assert.match(client, /DWELL_KINDS = \['active', 'passive_foreground', 'idle'\] as const/);
    assert.match(client, /\/api\/rank-events\/dwell/);
  });

  it("D11. the token is deterministic per (caller, emission, kind, item) and in its own domain", () => {
    const t = dwellTokenFor(ALICE, CEID, "active", "db/p1");
    assert.equal(t, dwellTokenFor(ALICE, CEID.toUpperCase(), "active", "db/p1"));
    assert.match(t, /^[A-Za-z0-9_-]{22}$/);
    const variants = [
      dwellTokenFor(BOB, CEID, "active", "db/p1"),
      dwellTokenFor(ALICE, CEID2, "active", "db/p1"),
      dwellTokenFor(ALICE, CEID, "idle", "db/p1"),
      dwellTokenFor(ALICE, CEID, "active", "db/p2"),
    ];
    assert.equal(new Set([t, ...variants]).size, 5);
  });
});
