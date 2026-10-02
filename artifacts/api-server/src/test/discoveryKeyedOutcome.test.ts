/**
 * census-discovery §62 — DV-37: POST /rank-events/outcome with `client_event_id`.
 *
 * The harness suite (db/discoveryVerifyChain V7) proves the arbitration on a
 * real PostgreSQL with migration 3420's trigger. These cases run the REAL route
 * over src/test/helpers/fakeDiscoveryTelemetryDb.ts (which has no trigger) to
 * pin the route's own branches, each of which the database cannot show:
 *
 *   K1  the key is validated exactly as POST /rank-events validates it
 *   K2  a keyless outcome reads no receipt and writes no key (its retry
 *       inside the window is a duplicate since §82, D-W10-O-5)
 *   K3  a keyed outcome writes its key on the compare-and-set UPDATE
 *   K4  a key that already landed: 200 duplicate, NO row moves, no negative
 *       signal, no Compass link — even when another upgradable exposure exists
 *   K5  a landed key whose exposure still holds the outcome re-drives its
 *       analytics row (convergence); one a stronger outcome moved does not
 *   K6  a key re-used for a different item or outcome is refused 409, and
 *       moves nothing
 *   K7  the UPDATE refused by the receipt's key (a racing copy that picked
 *       another exposure): 200 duplicate, no side effect, no analytics row
 *   K8  3420 absent at the receipt read (42P01): said once, latched, recorded
 *       KEYLESS — and the next keyed request does not read the receipt again
 *   K9  3420 absent at the UPDATE (PGRST204 naming the key column): retried
 *       WITHOUT the key and recorded — and 2891's latch is NOT set by it
 *   K10 a receipt read that fails for any other reason: 500, nothing moves
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryKeyedOutcome.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rankEventsRouter, {
  _resetRecommendationIdSchemaLatch, canStampOutcomeKey, isMissingOutcomeKeySchema, isOutcomeReceiptCollision,
  canStampExposureToken,
} from "../routes/rankEvents.js";
import { NEGATIVE_SIGNAL_RPC } from "../services/ranking/DiscoveryRankingService.js";
import { recommendationIdSchemaAbsent } from "../lib/rankEventsProvenance.js";
import { makeTelemetryDb } from "./helpers/fakeDiscoveryTelemetryDb.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000062";
const KEY_A = "6262a000-0000-4000-8000-000000000001";
const KEY_B = "6262b000-0000-4000-8000-000000000002";
const ITEM = "node/6262";

let server: Server;
let base = "";
let db: ReturnType<typeof makeTelemetryDb>;
let warns: string[] = [];

function install(opts: Parameters<typeof makeTelemetryDb>[0] = {}) {
  db = makeTelemetryDb({ users: { "alice-token": ALICE }, flags: {}, ...opts });
  _setTestClient(db.client as any, true);
  _setTestServiceClient(db.client as any);
}

/** Two exposures of ITEM, the second newer: the shape V7 needs (one item served twice). */
function seedTwoExposures(): { older: any; newer: any } {
  const t0 = Date.parse("2026-09-27T10:00:00Z");
  const mk = (id: string, ms: number) => ({
    id, user_id: ALICE, item_id: ITEM, surface: "discovery", outcome: "impression", position: 0,
    session_id: null, served_at: new Date(ms).toISOString().replace("Z", "+00:00"), features: {},
  });
  const older = mk("e0000000-0000-4000-8000-000000000001", t0);
  const newer = mk("e0000000-0000-4000-8000-000000000002", t0 + 60_000);
  db.tables["rank_events"]!.push(older, newer);
  return { older, newer };
}

async function post(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/rank-events/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer alice-token" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const quiesce = () => new Promise((r) => setTimeout(r, 80));
const outcomes = () => db.impressions().filter((r) => r.item_id === ITEM).map((r) => [r.id.slice(-1), r.outcome]).sort();
/** SELECTs of the receipts table (the double does not capture reads; countReceiptSelects wraps it). */
let receiptSelects = 0;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = pino({ level: "silent" });
    const l = (req as any).log;
    l.warn = (ctx: unknown, msg?: string) => { warns.push(`${msg ?? ""} ${JSON.stringify(ctx)}`); };
    next();
  });
  app.use("/api", rankEventsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});
beforeEach(() => { warns = []; receiptSelects = 0; _resetRecommendationIdSchemaLatch(); });

/** Count SELECTs of the receipts table by wrapping the double's `from`. */
function countReceiptSelects() {
  const from = db.client.from.bind(db.client);
  (db.client as any).from = (table: string) => {
    const b = from(table);
    if (table !== "rank_event_outcome_receipts") return b;
    const sel = b.select.bind(b);
    b.select = (...a: any[]) => { receiptSelects += 1; return sel(...a); };
    return b;
  };
}

describe("POST /rank-events/outcome — client_event_id (census-discovery §62, DV-37)", () => {
  it("K1. the key is validated exactly as POST /rank-events validates it", async () => {
    install();
    seedTwoExposures();
    const bad = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: "not-a-uuid" });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /client_event_id must be a UUID/, "the same message POST /rank-events gives");
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "impression"]], "a refused body moves nothing");
  });

  it("K2. a KEYLESS outcome reads no receipt and writes no key (its retry: §82)", async () => {
    install();
    countReceiptSelects();
    seedTwoExposures();
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss" });
    assert.deepEqual(r.body, { ok: true });
    assert.equal(receiptSelects, 0);
    const upd = db.captured.filter((c) => c.table === "rank_events" && c.op === "update");
    assert.ok(upd.length >= 1 && upd.every((c) => !("outcome_client_event_id" in (c.payload as any))), "no key on a keyless UPDATE");
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "dismiss"]]);
    // Restated (census-discovery §82, D-W10-O-5): a second keyless dismissal of the
    // same item INSIDE the retry window is a retry — answered duplicate, nothing
    // moves. A genuine later action (outside the window) still counts:
    // discoveryKeylessOutcome.test.ts L3.
    const again = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss" });
    assert.deepEqual(again.body, { ok: true, duplicate: true });
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "dismiss"]]);
  });

  it("K3. a keyed outcome carries its key on the compare-and-set UPDATE of the exposure it moves", async () => {
    install();
    countReceiptSelects();
    seedTwoExposures();
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_A });
    assert.deepEqual(r.body, { ok: true });
    assert.equal(receiptSelects, 1, "the receipt is looked up first");
    const moved = db.impressions().find((x) => x.outcome === "dismiss")!;
    assert.equal(moved.outcome_client_event_id, KEY_A);
    assert.equal(moved.id.slice(-1), "2", "the most recent upgradable exposure, as for a keyless outcome");
    await quiesce();
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 1);
  });

  it("K4. a key that already landed: 200 duplicate, NO row moves, no negative signal — though another exposure is upgradable", async () => {
    install();
    const { newer } = seedTwoExposures();
    newer.outcome = "dismiss"; newer.outcome_client_event_id = KEY_A;
    db.tables["rank_event_outcome_receipts"] = [{ user_id: ALICE, client_event_id: KEY_A, rank_event_id: newer.id, item_id: ITEM, surface: "discovery", outcome: "dismiss" }];
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_A });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, duplicate: true });
    await quiesce();
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "dismiss"]], "the older exposure did NOT move (this is V7's defect, closed)");
    assert.equal(db.captured.filter((c) => c.table === "rank_events" && c.op === "update").length, 0, "no UPDATE was even attempted");
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 0, "one 'Not interested' is one negative signal");
    // Twice more: still a duplicate, still nothing.
    for (let i = 0; i < 2; i++) assert.deepEqual((await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_A })).body, { ok: true, duplicate: true });
    await quiesce();
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 0);
  });

  it("K5. convergence: a landed key re-drives its analytics row while its exposure holds the outcome; not once a stronger one moved it", async () => {
    install();
    const { newer } = seedTwoExposures();
    newer.outcome = "tap"; newer.outcome_client_event_id = KEY_A;
    db.tables["rank_event_outcome_receipts"] = [{ user_id: ALICE, client_event_id: KEY_A, rank_event_id: newer.id, item_id: ITEM, surface: "discovery", outcome: "tap" }];
    assert.deepEqual((await post({ item_id: ITEM, surface: "discovery", outcome: "tap", client_event_id: KEY_A })).body, { ok: true, duplicate: true });
    await quiesce();
    assert.equal(db.analytics().length, 1, "the half a first attempt could have lost is re-driven, once");
    const token = db.analytics()[0]!.recommendation_id;
    assert.ok(typeof token === "string" && canStampExposureToken(token), "on the exposure's own token");
    newer.outcome = "save";   // a stronger outcome moved the row since
    const before = JSON.stringify(db.analytics());
    assert.deepEqual((await post({ item_id: ITEM, surface: "discovery", outcome: "tap", client_event_id: KEY_A })).body, { ok: true, duplicate: true });
    await quiesce();
    assert.equal(JSON.stringify(db.analytics()), before, "the save owns the analytics row; a tap retry does not downgrade it");
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "save"]], "and the older exposure never takes the retried tap");
  });

  it("K6. a key re-used for a different item or outcome is refused 409 and moves nothing", async () => {
    install();
    const { newer } = seedTwoExposures();
    newer.outcome = "dismiss";
    db.tables["rank_event_outcome_receipts"] = [{ user_id: ALICE, client_event_id: KEY_A, rank_event_id: newer.id, item_id: ITEM, surface: "discovery", outcome: "dismiss" }];
    const otherItem = await post({ item_id: "node/9", surface: "discovery", outcome: "dismiss", client_event_id: KEY_A });
    assert.equal(otherItem.status, 409, JSON.stringify(otherItem.body));
    assert.match(JSON.stringify(otherItem.body), /different item/);
    const otherOutcome = await post({ item_id: ITEM, surface: "discovery", outcome: "tap", client_event_id: KEY_A });
    assert.equal(otherOutcome.status, 409);
    assert.match(JSON.stringify(otherOutcome.body), /different outcome/);
    await quiesce();
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "dismiss"]]);
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 0);
  });

  it("K7. the UPDATE refused by the receipt's key (a racing copy on another exposure): 200 duplicate, no signal, no analytics row", async () => {
    install({
      failUpdates: { rank_events: { times: 1, error: { code: "23505", message: 'duplicate key value violates unique constraint "rank_event_outcome_receipts_pkey"', details: `Key (user_id, client_event_id)=(${ALICE}, ${KEY_A}) already exists.` } } },
    });
    seedTwoExposures();
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_A });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, duplicate: true });
    await quiesce();
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 0, "the refused copy moved nothing, so it counts nothing");
    assert.equal(db.analytics().length, 0, "and writes no analytics row for an exposure it did not move");
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "impression"]]);
  });

  it("K8. 3420 absent at the receipt read (42P01): said once, latched, recorded KEYLESS; the next keyed request reads no receipt", async () => {
    install({ failReads: { rank_event_outcome_receipts: { code: "42P01", message: 'relation "public.rank_event_outcome_receipts" does not exist' } } });
    countReceiptSelects();
    seedTwoExposures();
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_A });
    assert.deepEqual(r.body, { ok: true }, "the outcome is recorded — never a 500 on the signal endpoint");
    assert.equal(canStampOutcomeKey(), false);
    const upd = db.captured.filter((c) => c.table === "rank_events" && c.op === "update");
    assert.ok(upd.every((c) => !("outcome_client_event_id" in (c.payload as any))), "no key is sent once 3420 is known absent");
    assert.equal(warns.filter((w) => /3420 is not applied/.test(w)).length, 1, "said once");
    await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_B });
    assert.equal(receiptSelects, 1, "latched: the second keyed request does not read the missing table");
    assert.equal(warns.filter((w) => /3420 is not applied/.test(w)).length, 1, "and is not said again");
    assert.deepEqual(outcomes(), [["1", "dismiss"], ["2", "dismiss"]], "without 3420 a key protects nothing — stated, not hidden");
  });

  it("K9. 3420 absent at the UPDATE (PGRST204 on the key column): retried without the key and recorded; 2891's latch is untouched", async () => {
    install({
      failUpdates: { rank_events: { times: 1, error: { code: "PGRST204", message: "Could not find the 'outcome_client_event_id' column of 'rank_events' in the schema cache" } } },
    });
    seedTwoExposures();
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_A });
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "dismiss"]]);
    assert.equal(canStampOutcomeKey(), false, "3420 latched absent");
    assert.equal(recommendationIdSchemaAbsent(), false, "a missing KEY column is not misread as a missing 2891");
    const moved = db.impressions().find((x) => x.outcome === "dismiss")!;
    assert.equal(typeof moved.recommendation_id, "string", "so the retried UPDATE still stamps the exposure token");
  });

  it("K10. a receipt read that fails for any other reason is a 500, and nothing moves", async () => {
    install({ failReads: { rank_event_outcome_receipts: { code: "57014", message: "canceling statement due to statement timeout" } } });
    seedTwoExposures();
    const r = await post({ item_id: ITEM, surface: "discovery", outcome: "dismiss", client_event_id: KEY_A });
    assert.equal(r.status, 500);
    assert.equal(canStampOutcomeKey(), true, "a timeout is not '3420 absent'");
    await quiesce();
    assert.deepEqual(outcomes(), [["1", "impression"], ["2", "impression"]]);
    assert.equal(db.rpcCount(NEGATIVE_SIGNAL_RPC), 0);
  });

  it("K11. the predicates: only 3420's objects are '3420 absent', only the receipt's key is a collision", () => {
    assert.equal(isMissingOutcomeKeySchema({ code: "42703", message: 'column "outcome_client_event_id" of relation "rank_events" does not exist' }), true);
    assert.equal(isMissingOutcomeKeySchema({ code: "PGRST205", message: "Could not find the table 'public.rank_event_outcome_receipts' in the schema cache" }), true);
    assert.equal(isMissingOutcomeKeySchema({ code: "42703", message: 'column "recommendation_id" does not exist' }), false, "2891's absence is 2891's");
    assert.equal(isMissingOutcomeKeySchema({ code: "57014", message: "rank_event_outcome_receipts timeout" }), false);
    assert.equal(isOutcomeReceiptCollision({ code: "23505", message: 'duplicate key value violates unique constraint "rank_event_outcome_receipts_pkey"' }), true);
    assert.equal(isOutcomeReceiptCollision({ code: "23505", message: 'duplicate key value violates unique constraint "rank_events_recommendation_idempotency_idx"' }), false);
    assert.equal(isOutcomeReceiptCollision(null), false);
  });
});
