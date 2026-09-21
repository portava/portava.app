/**
 * census-discovery §41.1's hazard, made measurable — `lib/rankEventsProvenance`
 * and the two `routes/rankEvents.ts` write paths that use it.
 *
 * THE DEFECT CLASS
 * ================
 * `2893_rank_events_retire_writerless_surfaces.sql`'s header and §41.1 both
 * record it: EVERY `rank_events` writer in this codebase is fire-and-forget. A
 * row refused by a CHECK constraint produces a `warn` and a 200, and nothing
 * else. That is the right response-shape choice and the wrong observability
 * one, and the repository has already paid for it twice:
 *
 *   • `0202_rank_events_live_page_watch_feed_surfaces.sql` was written because
 *     `living_page` and `watch_feed` impressions had been refused by the surface
 *     CHECK for an unknown period, with the loss visible nowhere.
 *   • It is TRUE RIGHT NOW for `trip_add`. `2894_rank_events_trip_add_outcome.sql`
 *     admits it to the outcome CHECK and is unapplied on every database, while
 *     `travel-buddy-standalone/src/components/PlanPickerController.tsx` posts
 *     that outcome today. Every one of those posts is refused, silently.
 *
 * WHAT IS ASSERTED
 * ================
 *   T1–T4  the constraint name is recovered from every shape Postgres and
 *          PostgREST use, and `null` when the error names none
 *   T5–T7  refusals accumulate per (writer, constraint, code) and count ROWS
 *   T8     one findable warn shape, carrying no row data
 *   T9     the reporter never throws, even on a hostile logger
 *   R1     a refused direct `POST /rank-events` insert is counted, still 200
 *   R2     a refused outcome UPDATE is counted while STILL answering 500 — the
 *          response shape of a path that was never fire-and-forget is unchanged
 *   R3     the LIVE `trip_add` case — 2894 unapplied — is countable and names
 *          `rank_events_outcome_check`. `trip_add` has no entry in
 *          `OUTCOME_TO_ANALYTICS_EVENT`, so it never reaches the analytics
 *          writer: the refusal happens on the funnel UPDATE, the route answers
 *          500, and `useRankOutcome`'s `.catch(() => {})` discards it. Silent
 *          end to end, which is why counting it is the whole point.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/rankEventsRejectionTelemetry.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import {
  constraintNameFrom,
  recordRankEventsRejection,
  rankEventsRejectionSnapshot,
  rankEventsRejectedRows,
  reportRankEventsRejection,
  _resetRankEventsRejections,
  _resetRecommendationIdSchemaLatch,
  RANK_EVENTS_REJECTED_MSG,
} from "../lib/rankEventsProvenance.js";

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const ITEM_ID  = "item1111-1111-1111-1111-111111111111";
const ROW_ID   = "row00000-0000-0000-0000-000000000001";

/** Exactly what Postgres says when the outcome CHECK refuses `trip_add`. */
const OUTCOME_REFUSED = {
  code: "23514",
  message:
    'new row for relation "rank_events" violates check constraint "rank_events_outcome_check"',
};

interface LogLine { ctx: any; msg: string }

beforeEach(() => {
  _resetRankEventsRejections();
  _resetRecommendationIdSchemaLatch();
});

// ── T1–T4 · naming what refused the row ──────────────────────────────────────

describe("constraintNameFrom — the refusing constraint is recovered, or honestly absent", () => {
  it("T1. a CHECK violation message", () => {
    assert.equal(constraintNameFrom(OUTCOME_REFUSED), "rank_events_outcome_check");
  });

  it("T2. a UNIQUE violation message", () => {
    assert.equal(
      constraintNameFrom({
        code: "23505",
        message: 'duplicate key value violates unique constraint "rank_events_recommendation_idempotency_idx"',
      }),
      "rank_events_recommendation_idempotency_idx",
    );
  });

  it("T3. a driver that supplies the name as a field beats the message", () => {
    assert.equal(
      constraintNameFrom({ constraint: "rank_events_surface_check", message: 'constraint "wrong"' }),
      "rank_events_surface_check",
      "the structured field is the authority; parsing prose when a field exists is how a " +
      "locale or a message change silently renames a counter's key",
    );
  });

  it("T4. an error that names no constraint returns null, not a guess", () => {
    for (const e of [
      { code: "57014", message: "canceling statement due to statement timeout" },
      { message: "fetch failed" },
      null,
      undefined,
      "boom",
    ]) {
      assert.equal(
        constraintNameFrom(e), null,
        "'refused by a constraint' and 'the write never reached the database' are different " +
        "findings and must not collapse into one bucket",
      );
    }
  });
});

// ── T5–T7 · the counter ──────────────────────────────────────────────────────

describe("the rejection counter — rows lost, grouped by what refused them", () => {
  it("T5. counts ROWS, not statements", () => {
    recordRankEventsRejection({ writer: "w", err: OUTCOME_REFUSED, rows: 20 });
    recordRankEventsRejection({ writer: "w", err: OUTCOME_REFUSED, rows: 5 });
    const [only] = rankEventsRejectionSnapshot();
    assert.equal(only!.count, 2, "two refused statements");
    assert.equal(only!.rows, 25, "twenty-five lost rows — the number an operator cares about");
    assert.equal(rankEventsRejectedRows(), 25);
  });

  it("T6. different constraints are different classes", () => {
    recordRankEventsRejection({ writer: "w", err: OUTCOME_REFUSED });
    recordRankEventsRejection({
      writer: "w",
      err: { code: "23514", message: 'violates check constraint "rank_events_surface_check"' },
    });
    assert.equal(
      rankEventsRejectionSnapshot().length, 2,
      "an outcome the vocabulary refuses and a surface the vocabulary refuses are different " +
      "migrations to apply; one bucket would hide whichever is rarer",
    );
  });

  it("T7. the snapshot is a copy — a reader cannot mutate the counter", () => {
    recordRankEventsRejection({ writer: "w", err: OUTCOME_REFUSED });
    const snap = rankEventsRejectionSnapshot();
    (snap[0] as any).rows = 9999;
    assert.equal(rankEventsRejectionSnapshot()[0]!.rows, 1);
  });
});

// ── T8–T9 · the warn ─────────────────────────────────────────────────────────

describe("reportRankEventsRejection — one findable line, and it cannot break its caller", () => {
  it("T8. names the constraint, carries the totals, and carries NO row", () => {
    const logs: LogLine[] = [];
    reportRankEventsRejection(
      { warn: (ctx, msg) => logs.push({ ctx, msg: msg ?? "" }) },
      { writer: "routes/rankEvents.ts", err: OUTCOME_REFUSED, rows: 1,
        extra: { outcome: "trip_add", migration: "2894_rank_events_trip_add_outcome.sql" } },
    );
    assert.equal(logs.length, 1);
    assert.equal(
      logs[0]!.msg, RANK_EVENTS_REJECTED_MSG,
      "the existing warns say 'insert rejected', 'direct insert failed (non-fatal)' and " +
      "'analytics insert failed (non-fatal)' — three spellings of one event, none findable " +
      "from the other two",
    );
    assert.equal(logs[0]!.ctx.constraint, "rank_events_outcome_check");
    assert.equal(logs[0]!.ctx.code, "23514");
    assert.equal(logs[0]!.ctx.writer, "routes/rankEvents.ts");
    assert.equal(logs[0]!.ctx.rejectedRows, 1);
    assert.equal(logs[0]!.ctx.migration, "2894_rank_events_trip_add_outcome.sql");
    const serialized = JSON.stringify(logs[0]!.ctx);
    assert.ok(
      !serialized.includes(ALICE_ID) && !serialized.includes(ITEM_ID),
      "rank_events rows are behavioural data under 04 §11's retention tiers; a telemetry " +
      "line holding user_id or item_id would be a second uncontrolled copy of them",
    );
  });

  it("T8b. an error naming no constraint still reports, with constraint null", () => {
    const logs: LogLine[] = [];
    reportRankEventsRejection(
      { warn: (ctx, msg) => logs.push({ ctx, msg: msg ?? "" }) },
      { writer: "w", err: { code: "57014", message: "timeout" } },
    );
    assert.equal(logs[0]!.ctx.constraint, null,
      "an absent key would read as 'not looked for'; null says 'looked, found none'");
  });

  it("T9. a logger that throws does not take the caller down with it", () => {
    assert.doesNotThrow(() => reportRankEventsRejection(
      { warn: () => { throw new Error("transport down"); } },
      { writer: "w", err: OUTCOME_REFUSED },
    ), "an instrument must never break the thing it instruments");
  });
});

// ── R1–R3 · the routes ───────────────────────────────────────────────────────

function makeClient(o: { rankEventsError?: unknown; rows?: any[] }) {
  const db: Record<string, any[]> = {
    profiles:    [{ id: ALICE_ID, account_status: "active" }],
    rank_events: o.rows ?? [],
  };
  const fail = () => (o.rankEventsError !== undefined
    ? { data: null, error: o.rankEventsError }
    : { data: null, error: null });

  function selectBuilder(table: string) {
    let filtered = [...(db[table] ?? [])];
    const b: any = {
      eq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] === v); return b; },
      in: (c: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(r[c])); return b; },
      order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: [...filtered], error: null }),
    };
    return b;
  }

  return {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => ({
      select: () => selectBuilder(table),
      update: () => ({ eq: () => Promise.resolve(table === "rank_events" ? fail() : { data: null, error: null }) }),
      insert: () => Promise.resolve(table === "rank_events" ? fail() : { data: null, error: null }),
      upsert: () => Promise.resolve(table === "rank_events" ? fail() : { data: null, error: null }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

async function makeApp(logs: LogLine[]): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = {
      warn:  (ctx: any, msg?: string) => logs.push({ ctx, msg: msg ?? String(ctx) }),
      error: (ctx: any, msg?: string) => logs.push({ ctx, msg: msg ?? String(ctx) }),
      info:  () => {},
    };
    next();
  });
  const { default: rankEventsRouter } = await import("../routes/rankEvents.js");
  app.use("/api", rankEventsRouter);
  return app;
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => srv.close(() => res(undefined))),
      });
    });
  });
}

describe("routes/rankEvents.ts — a refused write leaves a countable trace", () => {
  let url: string; let close: () => Promise<void>; let logs: LogLine[];
  before(async () => { logs = []; ({ url, close } = await startServer(await makeApp(logs))); });
  after(async () => { await close(); _setTestClient(null as any, false); });

  it("R1. a refused direct impression insert is counted, and the request still succeeds", async () => {
    logs.length = 0;
    _resetRankEventsRejections();
    _setTestClient(makeClient({ rankEventsError: OUTCOME_REFUSED }) as any, true);

    const r = await fetch(`${url}/api/rank-events`, {
      method: "POST",
      headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "place_view", entity_type: "place", entity_id: ITEM_ID }),
    });
    assert.equal(r.status, 200, "observability must not convert fire-and-forget into a blocking write");
    assert.deepEqual(await r.json(), { ok: true });

    const seen = rankEventsRejectionSnapshot();
    assert.equal(seen.length, 1, "the living_page impression was refused and nothing counted it");
    assert.equal(seen[0]!.constraint, "rank_events_outcome_check");
    assert.equal(seen[0]!.writer, "routes/rankEvents.ts");
    assert.ok(
      logs.some((l) => l.msg === RANK_EVENTS_REJECTED_MSG),
      `the findable warn shape must be used. logs: ${JSON.stringify(logs.map((l) => l.msg))}`,
    );
  });

  it("R2/R3. the LIVE trip_add case — 2894 unapplied — is countable by constraint", async () => {
    logs.length = 0;
    _resetRankEventsRejections();
    _setTestClient(makeClient({
      rankEventsError: OUTCOME_REFUSED,
      rows: [{
        id: ROW_ID, user_id: ALICE_ID, item_id: ITEM_ID, surface: "discovery",
        outcome: "save", position: 0, features: {}, served_at: "2026-09-01T10:00:00.000Z",
        session_id: null, outcome_at: null, recommendation_id: null,
      }],
    }) as any, true);

    const r = await fetch(`${url}/api/rank-events/outcome`, {
      method: "POST",
      headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: ITEM_ID, surface: "discovery", outcome: "trip_add" }),
    });
    assert.equal(
      r.status, 500,
      "R2: the outcome UPDATE was never fire-and-forget and must not become quieter — " +
      "counting the refusal is ADDITIVE to the 500, not a replacement for it",
    );

    const seen = rankEventsRejectionSnapshot();
    assert.equal(
      seen.length, 1,
      "until 2894 is applied this is the shape every PlanPickerController trip_add arrives " +
      "in, and the client discards the 500, so nothing anywhere records that it happened",
    );
    assert.equal(
      seen[0]!.constraint, "rank_events_outcome_check",
      "this is the sentence 2894 is waiting on: the vocabulary, not the network, refused it",
    );
    assert.equal(seen[0]!.code, "23514");
    assert.equal(seen[0]!.writer, "routes/rankEvents.ts");
    assert.ok(
      logs.some((l) => l.msg === RANK_EVENTS_REJECTED_MSG),
      `the findable warn shape must be used. logs: ${JSON.stringify(logs.map((l) => l.msg))}`,
    );
    assert.ok(
      logs.some((l) => /update failed/i.test(l.msg)),
      "and the pre-existing error line stays — this path did not get quieter",
    );
  });
});
