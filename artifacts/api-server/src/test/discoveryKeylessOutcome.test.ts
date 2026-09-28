/**
 * census-discovery §82 (lane W10-O) — DV-37 / D-9: a KEYLESS outcome is
 * accepted, marked unkeyed, and a retry of it lands once.
 *
 * Decision D-W10-O-5 (docs/architecture/discovery-decision-register.md): every
 * client build shipped before §62's H1 sends outcomes with no
 * `client_event_id`. They are ACCEPTED (refusing them would lose every outcome
 * those builds record), they are MARKED unkeyed (the exposure's
 * `outcome_client_event_id` stays NULL — 3420's column is the mark), and a
 * keyless outcome that would move a SECOND exposure of the same (viewer, item,
 * surface[, session]) while the same outcome — or one that subsumes it —
 * landed on another exposure within KEYLESS_OUTCOME_RETRY_WINDOW_MS is answered
 * `duplicate` and moves nothing.
 *
 *   L1  V7's defect, closed for keyless: a retried "Not interested" after a
 *       second serve moves ONE exposure and sends ONE negative signal.
 *   L2  a retried tap after the first exposure was upgraded to save: duplicate.
 *   L3  the same outcome OUTSIDE the window is a new action and moves the
 *       second exposure (the keyless path is not made permanently lossy).
 *   L4  a landing on ANOTHER item, or on another surface, does not count.
 *   L5  with a session_id, only a landing in that session counts.
 *   L6  a keyed request never takes this path (the key is the arbiter), and a
 *       keyless request reads nothing extra when there is no second exposure.
 *   L7  the landing read failing is a 500 and nothing moves (a guess could
 *       double-count the very retry this exists to recognise).
 *   L8  the window is a named value, and the unkeyed mark is the NULL key.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryKeylessOutcome.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rankEventsRouter, { _resetRecommendationIdSchemaLatch, _resetOutcomeKeyLatch, KEYLESS_OUTCOME_RETRY_WINDOW_MS, keylessLandingOutcomesFor } from "../routes/rankEvents.js";
import { NEGATIVE_SIGNAL_RPC } from "../services/ranking/DiscoveryRankingService.js";
import { makeTelemetryDb } from "./helpers/fakeDiscoveryTelemetryDb.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000082";
const KEY_A = "8282a000-0000-4000-8000-000000000001";
const ITEM = "node/8282";
const SESSION_1 = "5e550000-0000-4000-8000-000000000001";
const SESSION_2 = "5e550000-0000-4000-8000-000000000002";

let server: Server;
let base = "";
let db: ReturnType<typeof makeTelemetryDb>;

function install(opts: Parameters<typeof makeTelemetryDb>[0] = {}) {
  db = makeTelemetryDb({ users: { "alice-token": ALICE }, flags: {}, ...opts });
  _setTestClient(db.client, true);
  _setTestServiceClient(db.client as unknown as SupabaseClient);
}

function exposure(id: string, ms: number, extra: Record<string, unknown> = {}) {
  return {
    id, user_id: ALICE, item_id: ITEM, surface: "discovery", outcome: "impression", position: 0,
    session_id: null, served_at: new Date(ms).toISOString().replace("Z", "+00:00"), features: {}, ...extra,
  };
}
/** Two exposures of ITEM, the second newer — the shape V7 needs (one item served twice). */
function seedTwo(extraOlder: Record<string, unknown> = {}, extraNewer: Record<string, unknown> = {}) {
  const t0 = Date.now() - 120_000;
  const older = exposure("e0000000-0000-4000-8000-000000000001", t0, extraOlder);
  const newer = exposure("e0000000-0000-4000-8000-000000000002", t0 + 60_000, extraNewer);
  db.tables["rank_events"]!.push(older, newer);
  return { older, newer };
}

async function post(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/api/rank-events/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer alice-token" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const quiesce = () => new Promise((r) => setTimeout(r, 80));
const outcomes = () => db.impressions().filter((r) => r.item_id === ITEM).map((r) => [r.id.slice(-1), r.outcome]).sort();
const updates = () => db.captured.filter((c) => c.table === "rank_events" && c.op === "update");
type Builder = Record<string, unknown>;
/** Wrap the double's `from` so a case can observe or perturb one table's builder. */
function wrapFrom(f: (table: string, b: Builder) => Builder): void {
  const client = db.client as unknown as { from: (t: string) => Builder };
  const from = client.from.bind(client);
  client.from = (t: string) => f(t, from(t));
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { log: pino({ level: "silent" }) }); next(); });
  app.use("/api", rankEventsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
beforeEach(() => { _resetRecommendationIdSchemaLatch(); _resetOutcomeKeyLatch(); });

describe("POST /rank-events/outcome — a keyless retry lands once (census-discovery §82, DV-37, D-W10-O-5)", () => {
  it("L1. a keyless 'Not interested', retried after a second serve, moves ONE exposure and sends ONE negative signal", async () => {
    install();
    seedTwo();
    assert.deepEqual((await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss" })).body, { ok: true });
    await quiesce();
    const retry = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss" });
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, { ok: true, duplicate: true }, "the retry is answered as the success it was");
    await quiesce();
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "dismiss"]], "the OLDER exposure did not take the retry (V7, closed for keyless)");
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 1, "one 'Not interested' is one negative signal");
    assert.equal(updates().length, 1, "the retry attempted no UPDATE");
  });

  it("L2. a keyless tap retried after its exposure was upgraded to save is a duplicate", async () => {
    install();
    seedTwo({}, { outcome: "save", outcome_at: new Date(Date.now() - 30_000).toISOString() });
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "tap" });
    assert.deepEqual(r.body, { ok: true, duplicate: true });
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "save"]]);
  });

  it("L3. the same outcome OUTSIDE the window is a new action: the second exposure moves", async () => {
    install();
    const old = new Date(Date.now() - KEYLESS_OUTCOME_RETRY_WINDOW_MS - 60_000).toISOString();
    seedTwo({}, { outcome: "tap", outcome_at: old });
    // The newer exposure already holds `tap` from long ago; a tap now moves the older impression.
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "tap" });
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(outcomes(), [["1", "tap"], ["2", "tap"]]);
  });

  it("L4. a landing on another item or another surface does not count", async () => {
    install();
    seedTwo();
    const now = new Date().toISOString();
    db.tables["rank_events"]!.push(
      { ...exposure("e0000000-0000-4000-8000-000000000003", Date.now() - 50_000), item_id: "node/other", outcome: "dismiss", outcome_at: now },
      { ...exposure("e0000000-0000-4000-8000-000000000004", Date.now() - 50_000), surface: "events", outcome: "dismiss", outcome_at: now },
    );
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss" });
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(outcomes().filter(([id]) => id === "1" || id === "2"), [["1", "impression"], ["2", "dismiss"]]);
  });

  it("L5. with a session_id, only a landing in THAT session counts", async () => {
    install();
    seedTwo({ session_id: SESSION_1 }, { session_id: SESSION_2, outcome: "dismiss", outcome_at: new Date().toISOString() });
    const other = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", session_id: SESSION_1 });
    assert.deepEqual(other.body, { ok: true }, "a landing in session 2 is not a retry of an action in session 1");
    assert.deepEqual(outcomes(), [["1", "dismiss"], ["2", "dismiss"]]);
  });

  it("L6. a keyed request never takes this path; a keyless one with no second exposure reads nothing extra", async () => {
    install();
    seedTwo({}, { outcome: "dismiss", outcome_at: new Date().toISOString() });
    const keyed = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_A });
    assert.deepEqual(keyed.body, { ok: true }, "a NEW key is a new action, and the key — not the window — is its arbiter");
    assert.deepEqual(outcomes(), [["1", "dismiss"], ["2", "dismiss"]]);

    install();
    db.tables["rank_events"]!.push(exposure("e0000000-0000-4000-8000-000000000001", Date.now() - 60_000, { outcome: "dismiss", outcome_at: new Date().toISOString() }));
    let reads = 0;
    wrapFrom((t, b) => { if (t === "rank_events") reads += 1; return b; });
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss" });
    assert.equal(r.status, 404, "no upgradable exposure: 404 exactly as before");
    assert.equal(reads, 1, "only the upgradable lookup ran");
  });

  it("L7. the landing read failing is a 500, and nothing moves", async () => {
    install();
    seedTwo();
    let n = 0;
    wrapFrom((t, b) => {
      if (t !== "rank_events") return b;
      n += 1;
      if (n === 2) b["then"] = (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "57014", message: "statement timeout" } }).then(onF);
      return b;
    });
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss" });
    assert.equal(r.status, 500);
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "impression"]]);
  });

  it("L8. the window is a named value; the landing set is the outcome and what subsumes it; the unkeyed mark is the NULL key", async () => {
    assert.equal(KEYLESS_OUTCOME_RETRY_WINDOW_MS, 10 * 60_000);
    assert.deepEqual([...keylessLandingOutcomesFor("dismiss")], ["dismiss"]);
    assert.deepEqual([...keylessLandingOutcomesFor("tap")].sort(), ["attended", "join", "rsvp", "save", "tap", "trip_add"]);
    assert.deepEqual([...keylessLandingOutcomesFor("save")].sort(), ["attended", "save", "trip_add"]);
    assert.deepEqual([...keylessLandingOutcomesFor("trip_add")].sort(), ["attended", "trip_add"]);
    install();
    seedTwo();
    await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss" });
    assert.ok(updates().every((c) => !("outcome_client_event_id" in (c.payload as Record<string, unknown>))), "a keyless outcome writes no key: NULL is the mark");
  });
});
