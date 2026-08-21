/**
 * Phase 14 — Outcome Learning tests.
 *
 * Covers:
 *   - end-to-end outcome chain recording tied to the originating
 *     compass_served_recommendations row (token + organic item link)
 *   - dedupe: one row per user + recommendation + stage
 *   - no phantom records when the item was never recommended
 *   - predicted-vs-actual fit: realized score from the chain, fit delta vs
 *     the persisted compassMatch prediction
 *   - ranking feedback: a significant delta nudges the user's category
 *     weight (the surface the ranking pipeline reads) in the delta's direction
 *   - value-delivered aggregate: stage counts, value points, prediction
 *     calibration; admin-only access; outcome-chain basis (no time proxies)
 *   - route validation + auth
 *
 * Runtime: node:test + node:assert (no vitest, no real DB, no network)
 * Run: node --import tsx/esm --test src/test/compass-outcome-learning.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import compassOutcomesRouter from "../routes/compassOutcomes.js";
import {
  recordOutcome,
  linkOutcomeSignal,
  computeRealizedScore,
  computeFitDelta,
  computeValueDelivered,
  STAGE_FIT_VALUE,
  STAGE_VALUE_POINTS,
} from "../compass/CompassOutcomeEngine.js";

const USER_ID  = "00000000-0000-0000-0000-000000000001";
const ADMIN_ID = "00000000-0000-0000-0000-000000000002";

/* ── Fake Supabase client (autopilot pattern + count support) ─────────────── */
type Row = Record<string, unknown>;

let idCounter = 0;

function makeFakeClient(store: Record<string, Row[]> = {}) {
  function tbl(name: string): Row[] {
    if (!store[name]) store[name] = [];
    return store[name]!;
  }

  function builder(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _limit: number | null = null;
    let _lastWritten: Row[] | null = null;
    let _order: { key: string; asc: boolean } | null = null;

    function rows(): Row[] {
      let out = tbl(tableName).filter((r) => filters.every((f) => f(r)));
      if (_order) {
        const { key, asc } = _order;
        out = [...out].sort((a, b) => {
          const av = String(a[key] ?? ""), bv = String(b[key] ?? "");
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (_limit !== null) out = out.slice(0, _limit);
      return out;
    }

    function result(): Row[] {
      return _lastWritten ?? rows();
    }

    const passthrough = new Set(["select", "or", "like", "ilike", "not", "filter", "match"]);

    const b: any = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === "then") {
          return (resolve: Function) =>
            resolve({ data: result(), error: null, count: result().length });
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve({ data: result()[0] ?? null, error: null });
        }
        if (prop === "order") {
          return (key: string, opts?: { ascending?: boolean }) => {
            _order = { key, asc: opts?.ascending !== false };
            return b;
          };
        }
        if (prop === "limit") return (n: number) => { _limit = n; return b; };
        if (prop === "eq")  return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "gte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") >= String(v)); return b; };
        if (prop === "insert") {
          return (payload: Row | Row[]) => {
            const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
              id: `20000000-0000-0000-0000-${String(++idCounter).padStart(12, "0")}`,
              occurred_at: new Date().toISOString(),
              created_at:  new Date().toISOString(),
              ...r,
            }));
            tbl(tableName).push(...arr);
            _lastWritten = arr;
            return b;
          };
        }
        if (prop === "upsert") {
          return (payload: Row | Row[], opts?: { onConflict?: string }) => {
            const keys = (opts?.onConflict ?? "id").split(",");
            const arr = Array.isArray(payload) ? payload : [payload];
            for (const r of arr) {
              const existing = tbl(tableName).find((e) => keys.every((k) => e[k] === r[k]));
              if (existing) Object.assign(existing, r);
              else tbl(tableName).push({ ...r });
            }
            _lastWritten = arr;
            return b;
          };
        }
        if (passthrough.has(prop)) return (..._a: unknown[]) => b;
        return (..._a: unknown[]) => b;
      },
    });
    return b;
  }

  return {
    fakeClient: {
      from: (name: string) => builder(name),
      auth: {
        getUser: (token: string) =>
          token === "valid-token"
            ? Promise.resolve({ data: { user: { id: USER_ID } }, error: null })
            : token === "admin-token"
            ? Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null })
            : Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
      },
    } as any,
    store,
  };
}

/* ── Mini express app ─────────────────────────────────────────────────────── */

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.log = pino({ level: "silent" });
  next();
});
testApp.use("/api", compassOutcomesRouter);

let server: Server;
let base: string;

before(async () => {
  server = createServer(testApp);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestServiceClient(null);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

async function api(method: string, path: string, body?: unknown, token = "valid-token") {
  const resp = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

/* ── Seed helpers ─────────────────────────────────────────────────────────── */

let fake: ReturnType<typeof makeFakeClient>;

function seed(): Record<string, Row[]> {
  fake = makeFakeClient({
    profiles: [
      { id: USER_ID,  role: "user" },
      { id: ADMIN_ID, role: "admin" },
    ],
  });
  _setTestClient(fake.fakeClient, true);
  _setTestServiceClient(fake.fakeClient);
  return fake.store;
}

function seedServedRec(
  store: Record<string, Row[]>,
  opts: { recId?: string; itemId?: string; itemType?: string; compassMatch?: number | null; createdAt?: string } = {},
): string {
  const recId = opts.recId ?? `rec-${++idCounter}`;
  if (!store.compass_served_recommendations) store.compass_served_recommendations = [];
  store.compass_served_recommendations.push({
    user_id:           USER_ID,
    recommendation_id: recId,
    explanation_key:   "test",
    item_id:           opts.itemId ?? "item-1",
    item_type:         opts.itemType ?? "event",
    section_name:      "for_you",
    created_at:        opts.createdAt ?? new Date().toISOString(),
    ranking_factors:
      opts.compassMatch === null
        ? null
        : { compassMatch: opts.compassMatch ?? 80, communityScore: 50, factors: [] },
  });
  return recId;
}

/* ── Pure scoring functions ───────────────────────────────────────────────── */

describe("realized score + fit delta", () => {
  it("realized score is the max stage value reached", () => {
    assert.equal(computeRealizedScore([]), 0);
    assert.equal(computeRealizedScore(["viewed"]), STAGE_FIT_VALUE.viewed);
    assert.equal(
      computeRealizedScore(["viewed", "saved", "went"]),
      STAGE_FIT_VALUE.went,
    );
    assert.equal(computeRealizedScore(["returned", "viewed"]), 100);
  });

  it("fit delta is realized − predicted; null without a prediction", () => {
    assert.equal(computeFitDelta(80, 15), -65);
    assert.equal(computeFitDelta(20, 100), 80);
    assert.equal(computeFitDelta(null, 50), null);
    assert.equal(computeFitDelta(undefined, 50), null);
  });
});

/* ── Outcome recording ────────────────────────────────────────────────────── */

describe("recordOutcome — chain recording tied to the recommendation", () => {
  beforeEach(() => seed());

  it("records a stage via the recommendation token, with prediction snapshot", async () => {
    const store = fake.store;
    const recId = seedServedRec(store, { compassMatch: 80 });

    const result = await recordOutcome(fake.fakeClient, USER_ID, {
      recommendationId: recId, stage: "viewed", source: "test",
    });

    assert.equal(result.recorded, true);
    assert.equal(result.recommendationId, recId);
    assert.equal(result.predictedMatch, 80);
    assert.equal(result.realizedScore, STAGE_FIT_VALUE.viewed);
    assert.equal(result.fitDelta, STAGE_FIT_VALUE.viewed - 80);

    const rows = store.compass_outcome_events ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.recommendation_id, recId);
    assert.equal(rows[0]!.stage, "viewed");
    assert.equal(rows[0]!.predicted_match, 80);
    assert.equal(rows[0]!.stage_value, STAGE_VALUE_POINTS.viewed);
  });

  it("links an organic signal by item id to the most recent served rec", async () => {
    const store = fake.store;
    seedServedRec(store, {
      recId: "older",
      itemId: "evt-9",
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    const newer = seedServedRec(store, {
      recId: "newer",
      itemId: "evt-9",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const result = await recordOutcome(fake.fakeClient, USER_ID, {
      itemId: "evt-9", stage: "went", source: "route:event_rsvp",
    });
    assert.equal(result.recorded, true);
    assert.equal(result.recommendationId, newer);
  });

  it("no-ops when the item was never recommended (no phantom rows)", async () => {
    const result = await recordOutcome(fake.fakeClient, USER_ID, {
      itemId: "never-recommended", stage: "saved",
    });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "no_recommendation");
    assert.equal((fake.store.compass_outcome_events ?? []).length, 0);
  });

  it("dedupes per user + recommendation + stage", async () => {
    const recId = seedServedRec(fake.store, {});
    const first  = await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: recId, stage: "saved" });
    const second = await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: recId, stage: "saved" });
    assert.equal(first.recorded, true);
    assert.equal(second.recorded, false);
    assert.equal(second.reason, "duplicate");
    assert.equal((fake.store.compass_outcome_events ?? []).length, 1);
  });

  it("records the full chain end to end against one recommendation", async () => {
    const recId = seedServedRec(fake.store, { compassMatch: 60 });
    for (const stage of ["viewed", "saved", "went", "made_memory"] as const) {
      const r = await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: recId, stage });
      assert.equal(r.recorded, true, `stage ${stage} should record`);
    }
    const rows = fake.store.compass_outcome_events ?? [];
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.recommendation_id === recId));
    // Realized score after the chain = made_memory (95)
    const last = await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: recId, stage: "returned" });
    assert.equal(last.realizedScore, 100);
  });

  it("linkOutcomeSignal never throws and no-ops on null item / null db", async () => {
    await linkOutcomeSignal(null, USER_ID, "x", "saved", "test");
    await linkOutcomeSignal(fake.fakeClient, USER_ID, null, "saved", "test");
    assert.equal((fake.store.compass_outcome_events ?? []).length, 0);
  });
});

/* ── Ranking feedback ─────────────────────────────────────────────────────── */

describe("ranking responds to outcome deltas", () => {
  beforeEach(() => seed());

  it("large negative delta (overprediction) nudges the category weight down", async () => {
    const recId = seedServedRec(fake.store, { compassMatch: 90, itemType: "event" });
    const r = await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: recId, stage: "viewed" });
    assert.equal(r.weightAdjusted, true);
    const prefs = (fake.store.compass_user_preferences ?? [])[0];
    assert.ok(prefs, "prefs row upserted");
    assert.equal((prefs!.category_weights as any).event, -1);
  });

  it("large positive delta (underprediction) nudges the category weight up", async () => {
    const recId = seedServedRec(fake.store, { compassMatch: 20, itemType: "buddy" });
    const r = await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: recId, stage: "returned" });
    assert.equal(r.fitDelta, 80);
    assert.equal(r.weightAdjusted, true);
    const prefs = (fake.store.compass_user_preferences ?? [])[0];
    assert.equal((prefs!.category_weights as any).buddy, 1);
  });

  it("small delta leaves ranking weights untouched", async () => {
    const recId = seedServedRec(fake.store, { compassMatch: 30, itemType: "event" });
    const r = await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: recId, stage: "saved" });
    assert.equal(r.fitDelta, 5);
    assert.equal(r.weightAdjusted, false);
    assert.equal((fake.store.compass_user_preferences ?? []).length, 0);
  });

  it("no prediction persisted → outcome recorded, no weight change", async () => {
    const recId = seedServedRec(fake.store, { compassMatch: null });
    const r = await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: recId, stage: "returned" });
    assert.equal(r.recorded, true);
    assert.equal(r.predictedMatch, null);
    assert.equal(r.fitDelta, null);
    assert.equal(r.weightAdjusted, false);
  });
});

/* ── Routes ───────────────────────────────────────────────────────────────── */

describe("POST /api/compass/outcomes", () => {
  beforeEach(() => seed());

  it("requires auth", async () => {
    const r = await api("POST", "/compass/outcomes", { itemId: "x", stage: "viewed" }, "bad-token");
    assert.equal(r.status, 401);
  });

  it("rejects a payload with neither recommendationId nor itemId", async () => {
    const r = await api("POST", "/compass/outcomes", { stage: "viewed" });
    assert.equal(r.status, 400);
  });

  it("rejects an unknown stage", async () => {
    const r = await api("POST", "/compass/outcomes", { itemId: "x", stage: "clicked" });
    assert.equal(r.status, 400);
  });

  it("records a stage for a served recommendation", async () => {
    const recId = seedServedRec(fake.store, { compassMatch: 70 });
    const r = await api("POST", "/compass/outcomes", { recommendationId: recId, stage: "saved" });
    assert.equal(r.status, 200);
    assert.equal(r.json.recorded, true);
    assert.equal(r.json.predictedMatch, 70);
  });

  it("returns recorded:false when the item was never recommended", async () => {
    const r = await api("POST", "/compass/outcomes", { itemId: "ghost", stage: "saved" });
    assert.equal(r.status, 200);
    assert.equal(r.json.recorded, false);
    assert.equal(r.json.reason, "no_recommendation");
  });
});

/* ── Value delivered ──────────────────────────────────────────────────────── */

describe("value-delivered aggregate", () => {
  beforeEach(() => seed());

  it("aggregates stage counts, value points, and prediction calibration", async () => {
    const store = fake.store;
    // Rec A: predicted 80, chain viewed → saved (realized 35, delta −45 → overpredicted)
    const a = seedServedRec(store, { recId: "a", itemId: "i-a", compassMatch: 80 });
    await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: a, stage: "viewed" });
    await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: a, stage: "saved" });
    // Rec B: predicted 30, chain returned (realized 100, delta +70 → underpredicted)
    const b = seedServedRec(store, { recId: "b", itemId: "i-b", itemType: "buddy", compassMatch: 30 });
    await recordOutcome(fake.fakeClient, USER_ID, { recommendationId: b, stage: "returned" });
    // Rec C: served, no outcomes
    seedServedRec(store, { recId: "c", itemId: "i-c" });

    const report = await computeValueDelivered(fake.fakeClient, { days: 30 });

    assert.equal(report.basis, "outcome_chain");
    assert.equal(report.served_recommendations, 3);
    assert.equal(report.recommendations_with_outcomes, 2);
    assert.equal(report.stage_counts.viewed, 1);
    assert.equal(report.stage_counts.saved, 1);
    assert.equal(report.stage_counts.returned, 1);
    assert.equal(
      report.value_points_total,
      STAGE_VALUE_POINTS.viewed + STAGE_VALUE_POINTS.saved + STAGE_VALUE_POINTS.returned,
    );
    assert.equal(report.prediction.with_prediction, 2);
    assert.equal(report.prediction.avg_predicted, 55);   // (80+30)/2
    assert.equal(report.prediction.avg_realized, 67.5);  // (35+100)/2
    assert.equal(report.prediction.overpredicted, 1);
    assert.equal(report.prediction.underpredicted, 1);
    assert.equal(report.by_item_type.event.outcomes, 2);
    assert.equal(report.by_item_type.buddy.outcomes, 1);
    // North-star excludes time proxies: no session/chat fields exist
    assert.ok(!("session_time" in report));
    assert.ok(!("chat_length" in report));
  });

  it("GET /api/compass/value-delivered is admin-only", async () => {
    const denied = await api("GET", "/compass/value-delivered");
    assert.equal(denied.status, 403);
    const ok = await api("GET", "/compass/value-delivered?days=7", undefined, "admin-token");
    assert.equal(ok.status, 200);
    assert.equal(ok.json.period_days, 7);
    assert.equal(ok.json.basis, "outcome_chain");
  });
});
